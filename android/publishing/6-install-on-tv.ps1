[CmdletBinding()]
param(
    [string]$TvAddress = '',
    [string]$PairAddress = '',
    [string]$Serial = '',
    [string]$Apk = '',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$adb = Join-Path (Resolve-AndroidSdk) 'platform-tools\adb.exe'
$savedTarget = Join-Path $script:SecretsDir 'tv-device.json'
$package = "$script:BasePackage.sideload"

if (-not $Apk) {
    if ($SkipBuild) { $Apk = Join-Path $script:ReleasesDir 'boom-buds-tv.apk' }
    else { $built = & (Join-Path $PSScriptRoot '0-build-sideload-apk.ps1') -PassThru; $Apk = $built.Apk }
}
if (-not (Test-Path -LiteralPath $Apk)) { throw "APK not found: $Apk. Run 0-build-sideload-apk.bat first." }
$Apk = (Resolve-Path -LiteralPath $Apk).Path

if ($PairAddress) {
    # adb prompts interactively for the pairing code; never store it.
    Invoke-Checked $adb @('pair', $PairAddress)
}
if (-not $TvAddress -and -not $Serial -and (Test-Path $savedTarget)) {
    $saved = Get-Content $savedTarget -Raw | ConvertFrom-Json
    $Serial = [string]$saved.serial
    $TvAddress = [string]$saved.address
}
if ($TvAddress) {
    if ($TvAddress -notmatch ':') { $TvAddress = "${TvAddress}:5555" }
    Invoke-Checked $adb @('connect', $TvAddress)
    $Serial = $TvAddress
}

$deviceLines = @(& $adb devices)
if ($LASTEXITCODE -ne 0) { throw 'Could not list Android devices.' }
$online = @($deviceLines | ForEach-Object { if ($_ -match '^(\S+)\s+device\s*$') { $Matches[1] } })
if (-not $Serial -and $online.Count -eq 0) {
    Write-Host 'First connection: enable TV debugging and put the PC/TV on the same network.' -ForegroundColor Cyan
    Write-Host 'Wireless debugging has separate pairing and connection ports. See android/README.md.'
    $firstPair = Read-Host 'Pairing IP:PORT (Enter if already paired, USB, or direct network debugging)'
    if ($firstPair) { Invoke-Checked $adb @('pair', $firstPair) }
    $firstAddress = Read-Host 'TV connection IP:PORT (Enter to recheck USB/automatic connection)'
    if ($firstAddress) {
        $TvAddress = if ($firstAddress -match ':') { $firstAddress } else { "${firstAddress}:5555" }
        Invoke-Checked $adb @('connect', $TvAddress)
        $Serial = $TvAddress
    }
    $deviceLines = @(& $adb devices)
    if ($LASTEXITCODE -ne 0) { throw 'Could not list Android devices.' }
    $online = @($deviceLines | ForEach-Object { if ($_ -match '^(\S+)\s+device\s*$') { $Matches[1] } })
}
if (-not $Serial -and $online.Count -eq 1) { $Serial = $online[0] }
if (-not $Serial -and $online.Count -gt 1) {
    Write-Host "Connected devices: $($online -join ', ')"
    $Serial = Read-Host 'Enter the TV serial/address from this list'
}
if (-not $Serial -or $Serial -notin $online) {
    Write-Host ($deviceLines -join "`n")
    throw 'TV not connected/authorized. Enable debugging, approve the computer on the TV, then use -TvAddress IP:PORT or -Serial SERIAL. See android/README.md.'
}
$features = (& $adb -s $Serial shell pm list features | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Unable to query the selected device.' }
if ($features -notmatch 'android.software.leanback') { throw 'The selected device is not an Android TV device. Select your Google TV Streamer or a TV emulator.' }

Write-Host "Installing $(Split-Path -Leaf $Apk) on $Serial" -ForegroundColor Cyan
Write-Host 'Updates preserve saved controls. Signature or downgrade errors stop here; this script never uninstalls your app.'
Invoke-Checked $adb @('-s', $Serial, 'install', '-r', $Apk)
Invoke-Checked $adb @('-s', $Serial, 'shell', 'am', 'start', '-n', "$package/$script:BasePackage.MainActivity")
New-Item -ItemType Directory -Path $script:SecretsDir -Force | Out-Null
@{ serial = $Serial; address = $TvAddress } | ConvertTo-Json | Set-Content -LiteralPath $savedTarget -Encoding UTF8
Write-Host 'Boom Buds is installed and launched. This TV is remembered for the next install.' -ForegroundColor Green
