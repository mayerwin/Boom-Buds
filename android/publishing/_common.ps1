# Shared helpers of the numbered build, release and install scripts.
$script:PublishingDir = $PSScriptRoot
$script:AndroidDir = Split-Path -Parent $PSScriptRoot
$script:RepoDir = Split-Path -Parent $script:AndroidDir
$script:SecretsDir = Join-Path $PSScriptRoot 'secrets'
$script:ReleasesDir = Join-Path $PSScriptRoot 'releases'
$script:BasePackage = 'com.github.boombuds'

function Resolve-Jdk {
    if (Test-Path (Join-Path $script:PublishingDir 'local-config.ps1')) {
        . (Join-Path $script:PublishingDir 'local-config.ps1')
    }
    $candidates = @($LocalJdkPath, $env:JAVA_HOME,
        "$env:ProgramFiles\Android\Android Studio\jbr",
        'D:\Program Files\Android\Android Studio\jbr',
        "$env:USERPROFILE\AppData\Local\Programs\Android Studio\jbr")
    $java = Get-Command java.exe -ErrorAction SilentlyContinue
    if ($java) { $candidates += Split-Path -Parent (Split-Path -Parent $java.Source) }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path (Join-Path $candidate 'bin\javac.exe'))) {
            return (Resolve-Path $candidate).Path
        }
    }
    throw 'JDK not found. Install Android Studio or set LocalJdkPath in android/publishing/local-config.ps1 (see example). JDK 17+ is required.'
}

function Resolve-AndroidSdk {
    if (Test-Path (Join-Path $script:PublishingDir 'local-config.ps1')) {
        . (Join-Path $script:PublishingDir 'local-config.ps1')
    }
    foreach ($candidate in @($LocalSdkPath, $env:ANDROID_HOME, $env:ANDROID_SDK_ROOT,
        "$env:LOCALAPPDATA\Android\Sdk", "$env:USERPROFILE\AppData\Local\Android\Sdk")) {
        if ($candidate -and (Test-Path (Join-Path $candidate 'platform-tools\adb.exe'))) {
            return (Resolve-Path $candidate).Path
        }
    }
    throw 'Android SDK not found. Install it using Android Studio, or set LocalSdkPath in android/publishing/local-config.ps1 (see example).'
}

function Resolve-PlayServiceAccount {
    if (Test-Path (Join-Path $script:PublishingDir 'local-config.ps1')) {
        . (Join-Path $script:PublishingDir 'local-config.ps1')
    }
    # Reuse an authorized existing credential without copying its private key.
    $candidate = if ($env:PLAY_SERVICE_ACCOUNT_FILE) { $env:PLAY_SERVICE_ACCOUNT_FILE }
        elseif ($LocalPlayServiceAccountPath) { $LocalPlayServiceAccountPath }
        else { Join-Path $script:SecretsDir 'play-service-account.json' }
    if (-not [IO.Path]::IsPathRooted($candidate)) {
        throw 'The Play service-account path must be absolute.'
    }
    return [IO.Path]::GetFullPath($candidate)
}

function Resolve-PlayTracks([string[]]$RequestedTracks = @()) {
    if (Test-Path (Join-Path $script:PublishingDir 'local-config.ps1')) {
        . (Join-Path $script:PublishingDir 'local-config.ps1')
    }
    $selected = if ($RequestedTracks.Count -gt 0) { $RequestedTracks }
        elseif ($env:PLAY_TRACKS) { @($env:PLAY_TRACKS) }
        elseif ($env:PLAY_TRACK) { @($env:PLAY_TRACK) }
        elseif ($LocalPlayTracks) { @($LocalPlayTracks) }
        else { @('alpha') }
    return @($selected | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } |
        Where-Object { $_ } | Select-Object -Unique)
}

function Initialize-AndroidEnvironment {
    $env:JAVA_HOME = Resolve-Jdk
    $env:ANDROID_HOME = Resolve-AndroidSdk
    $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
    $env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
    Write-Host "JDK: $env:JAVA_HOME"
    Write-Host "SDK: $env:ANDROID_HOME"
    # Gradle builds the game itself with the repository's `npm run build`.
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'Node.js (with npm) is required to build the game. Install Node 22 or later.'
    }
    if (-not (Test-Path (Join-Path $script:RepoDir 'node_modules'))) {
        Push-Location $script:RepoDir
        try { Invoke-Checked 'npm.cmd' @('ci') } finally { Pop-Location }
    }
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    try {
        # Native warnings on stderr are not failures in Windows PowerShell 5.1.
        $ErrorActionPreference = 'Continue'
        & $FilePath @Arguments | Out-Host
        $result = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($result -ne 0) { throw "$(Split-Path -Leaf $FilePath) failed (exit $result)." }
}

function Invoke-Gradle([string[]]$Arguments) {
    Push-Location $script:AndroidDir
    try { Invoke-Checked (Join-Path $script:AndroidDir 'gradlew.bat') ($Arguments + @('--console=plain')) }
    finally { Pop-Location }
}

function Read-Version {
    $values = @{}
    Get-Content (Join-Path $script:AndroidDir 'version.properties') | ForEach-Object {
        if ($_ -match '^\s*(versionCode|versionName)\s*=\s*(.+?)\s*$') { $values[$Matches[1]] = $Matches[2] }
    }
    if (-not $values.versionName -or -not $values.versionCode) { throw 'android/version.properties needs versionName and versionCode.' }
    return $values
}

function Reserve-Version([int]$RequestedCode = 0, [string]$RequestedName = '') {
    $version = Read-Version
    $stateFile = Join-Path $script:SecretsDir 'release-state.json'
    $lastCode = 0
    if (Test-Path $stateFile) { $lastCode = [int](Get-Content $stateFile -Raw | ConvertFrom-Json).lastVersionCode }
    if ($RequestedCode -gt 0) {
        if ($RequestedCode -le $lastCode) { throw "VersionCode must exceed the last reserved code ($lastCode). Use a new code; Play does not allow reuse." }
        $code = $RequestedCode
    } else { $code = [math]::Max([int]$version.versionCode, $lastCode + 1) }
    if ($code -gt 2100000000) { throw 'VersionCode exceeds the Google Play limit.' }
    $name = if ($RequestedName) { $RequestedName } else { $version.versionName }
    if ($name -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]{0,49}$') { throw 'VersionName must be a short filename-safe version such as 1.0.0.' }
    New-Item -ItemType Directory -Path $script:SecretsDir -Force | Out-Null
    @{ lastVersionCode = $code; versionName = $name; reservedAtUtc = [DateTime]::UtcNow.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    return @{ Code = $code; Name = $name }
}

function Export-Artifact([string]$Source, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Source)) { throw "Build did not create the expected artifact: $Source" }
    New-Item -ItemType Directory -Path $script:ReleasesDir -Force | Out-Null
    $destination = Join-Path $script:ReleasesDir $Name
    Copy-Item -LiteralPath $Source -Destination $destination -Force
    $sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$destination.sha256", "$sha256  $Name`n", [Text.UTF8Encoding]::new($false))
    Write-Host "Created: $destination" -ForegroundColor Green
    return $destination
}

function New-AppSigningKey([ValidateSet('sideload','upload')][string]$Kind) {
    $keyFile = Join-Path $script:SecretsDir "$Kind.keystore"
    $propsFile = Join-Path $script:SecretsDir $(if ($Kind -eq 'upload') { 'keystore.properties' } else { 'sideload.properties' })
    if ((Test-Path $keyFile) -or (Test-Path $propsFile)) {
        if ((Test-Path $keyFile) -and (Test-Path $propsFile)) { Write-Host "$Kind signing key already exists; keeping it."; return }
        throw "Incomplete $Kind signing files in secrets/. Restore the missing file from backup. Existing files are never overwritten."
    }
    New-Item -ItemType Directory -Path $script:SecretsDir -Force | Out-Null
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $secret = [Convert]::ToBase64String($bytes)
    $alias = "boombuds-$Kind"
    $env:BB_TEMP_SIGNING_PASSWORD = $secret
    try {
        Invoke-Checked (Join-Path (Resolve-Jdk) 'bin\keytool.exe') @(
            '-genkeypair', '-noprompt', '-storetype', 'PKCS12', '-keystore', $keyFile,
            '-alias', $alias, '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
            '-dname', 'CN=Boom Buds', '-storepass:env', 'BB_TEMP_SIGNING_PASSWORD',
            '-keypass:env', 'BB_TEMP_SIGNING_PASSWORD')
        $properties = "# Private per-app signing configuration. Back up this directory securely.`nstoreFile=$Kind.keystore`nstorePassword=$secret`nkeyAlias=$alias`nkeyPassword=$secret`n"
        [IO.File]::WriteAllText($propsFile, $properties, [Text.UTF8Encoding]::new($false))
    } finally {
        Remove-Item Env:\BB_TEMP_SIGNING_PASSWORD -ErrorAction SilentlyContinue
        $secret = $null
    }
    Write-Host "Created private $Kind signing files in android/publishing/secrets/. Back up both files securely." -ForegroundColor Green
}
