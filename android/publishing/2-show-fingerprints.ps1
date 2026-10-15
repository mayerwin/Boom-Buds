$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$keytool = Join-Path (Resolve-Jdk) 'bin\keytool.exe'
foreach ($kind in @('upload', 'sideload')) {
    $props = Join-Path $script:SecretsDir $(if ($kind -eq 'upload') { 'keystore.properties' } else { 'sideload.properties' })
    if (-not (Test-Path $props)) { Write-Host "$kind key has not been generated."; continue }
    $values = @{}
    Get-Content $props | ForEach-Object {
        if ($_ -match '^(storeFile|storePassword|keyAlias)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
    }
    $env:BB_TEMP_SIGNING_PASSWORD = $values.storePassword
    try {
        Write-Host "`n$kind certificate" -ForegroundColor Cyan
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $output = & $keytool -list -v -keystore (Join-Path $script:SecretsDir $values.storeFile) -alias $values.keyAlias -storepass:env BB_TEMP_SIGNING_PASSWORD 2>&1
        $result = $LASTEXITCODE
        $ErrorActionPreference = $previousPreference
        if ($result -ne 0) { throw "Could not read $kind certificate (keytool exit $result)." }
        $output | Select-String -Pattern 'Owner:|Valid from:|SHA1:|SHA256:' | ForEach-Object { Write-Host $_.Line.Trim() }
    } finally { Remove-Item Env:\BB_TEMP_SIGNING_PASSWORD -ErrorAction SilentlyContinue }
}
