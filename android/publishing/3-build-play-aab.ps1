[CmdletBinding()]
param([int]$VersionCode = 0, [string]$VersionName = '', [switch]$PassThru)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
Initialize-AndroidEnvironment
if (-not (Test-Path (Join-Path $script:SecretsDir 'keystore.properties'))) {
    throw 'Run 1-generate-upload-keystore.bat once before building a Play AAB.'
}
New-AppSigningKey 'sideload'
$version = Reserve-Version $VersionCode $VersionName
Invoke-Gradle @('bundlePlayRelease', 'assembleSideloadRelease', "-PversionCode=$($version.Code)", "-PversionName=$($version.Name)")
$stem = "boom-buds-v$($version.Name)-$($version.Code)"
$aab = Export-Artifact (Join-Path $script:AndroidDir 'app\build\outputs\bundle\playRelease\app-play-release.aab') "$stem-play.aab"
$apk = Export-Artifact (Join-Path $script:AndroidDir 'app\build\outputs\apk\sideload\release\app-sideload-release.apk') "$stem-tv.apk"
Copy-Item -LiteralPath $apk -Destination (Join-Path $script:ReleasesDir 'boom-buds-tv.apk') -Force
Write-Host 'Use the APK for direct TV installation. The AAB is for Google Play Console.'
if ($PassThru) { [PSCustomObject]@{ Aab = $aab; Apk = $apk; Code = $version.Code; Name = $version.Name } }
