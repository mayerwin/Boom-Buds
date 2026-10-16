[CmdletBinding()]
param(
    # also replace the Android TV screenshots with screenshots/*.png (made by android/tests/emulator-screenshots.cjs)
    [switch]$Screenshots,
    # only show where the tracks stand
    [switch]$Tracks,
    # check the texts and the access, change nothing
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$serviceAccountPath = Resolve-PlayServiceAccount
if (-not (Test-Path -LiteralPath $serviceAccountPath)) {
    throw 'Play credential not found. Set LocalPlayServiceAccountPath in local-config.ps1, set PLAY_SERVICE_ACCOUNT_FILE, or provide secrets/play-service-account.json.'
}
$tool = Join-Path $script:AndroidDir 'tools\play-listing.mjs'
$previous = $env:PLAY_SA
try {
    $env:PLAY_SA = $serviceAccountPath
    if ($Tracks) {
        Invoke-Checked 'node.exe' @($tool, 'tracks')
    } else {
        # store-listing.md is the source of the listing's texts: Play shows what this file says
        $arguments = @($tool, 'listing', (Join-Path $PSScriptRoot 'store-listing.md'))
        if ($Screenshots) { $arguments += (Join-Path $PSScriptRoot 'screenshots') }
        if ($DryRun) { $arguments += '--dry' }
        Invoke-Checked 'node.exe' $arguments
    }
} finally {
    $env:PLAY_SA = $previous
}
