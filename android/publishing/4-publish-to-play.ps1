[CmdletBinding()]
param(
    [string[]]$Tracks = @(),
    [ValidateSet('draft','completed')][string]$Status = 'completed',
    [int]$VersionCode = 0,
    [string]$VersionName = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$serviceAccountPath = Resolve-PlayServiceAccount
if (-not (Test-Path -LiteralPath $serviceAccountPath)) {
    throw 'Play credential not found. Set LocalPlayServiceAccountPath in local-config.ps1, set PLAY_SERVICE_ACCOUNT_FILE, or provide secrets/play-service-account.json. Grant the account access to this app first; see android/README.md.'
}
$Tracks = @(Resolve-PlayTracks -RequestedTracks $Tracks)
if ($Tracks.Count -eq 0) { throw 'At least one Play track is required.' }
foreach ($track in $Tracks) {
    if ($track -notmatch '^[A-Za-z0-9:_-]+$') { throw "Invalid track name: $track" }
}
if ($env:PLAY_RELEASE_STATUS -and -not $PSBoundParameters.ContainsKey('Status')) {
    $Status = $env:PLAY_RELEASE_STATUS.ToLowerInvariant()
    if ($Status -notin @('draft','completed')) { throw 'PLAY_RELEASE_STATUS must be draft or completed.' }
}
$notes = Join-Path $script:AndroidDir 'app\src\main\play\release-notes\en-US\default.txt'
if (-not (Test-Path $notes) -or -not (Get-Content $notes -Raw).Trim()) { throw "Release notes are missing: $notes" }
Write-Host "Build and upload once, then promote to tracks: $($Tracks -join ', ') ($Status)" -ForegroundColor Cyan
$previousTrack = $env:PLAY_TRACK
$previousStatus = $env:PLAY_RELEASE_STATUS
$previousCredentials = $env:PLAY_SERVICE_ACCOUNT_FILE
try {
    $env:PLAY_SERVICE_ACCOUNT_FILE = $serviceAccountPath
    $built = & (Join-Path $PSScriptRoot '3-build-play-aab.ps1') -VersionCode $VersionCode -VersionName $VersionName -PassThru
    Initialize-AndroidEnvironment
    $env:PLAY_TRACK = $Tracks[0]
    $env:PLAY_RELEASE_STATUS = $Status.ToUpperInvariant()
    Invoke-Gradle @('publishPlayReleaseBundle', "-PversionCode=$($built.Code)", "-PversionName=$($built.Name)")
    foreach ($track in @($Tracks | Select-Object -Skip 1)) {
        # Reuse the uploaded code: uploading it again is rejected by Google Play.
        Invoke-Gradle @('promotePlayReleaseArtifact', "--from-track=$($Tracks[0])", "--promote-track=$track",
            "--version-code=$($built.Code)", "-PversionCode=$($built.Code)", "-PversionName=$($built.Name)")
    }
} finally {
    $env:PLAY_TRACK = $previousTrack
    $env:PLAY_RELEASE_STATUS = $previousStatus
    $env:PLAY_SERVICE_ACCOUNT_FILE = $previousCredentials
}
Write-Host "Uploaded version $($built.Name) ($($built.Code)) to $($Tracks -join ', ') as $Status." -ForegroundColor Green
if ($Status -eq 'draft') { Write-Host 'Open Play Console to review and submit the drafts. Use -Status completed when you want immediate track rollout.' }
