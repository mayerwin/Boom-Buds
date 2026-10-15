[CmdletBinding()]
param([int]$VersionCode = 0, [string]$VersionName = '')
# Explicit production entry point: the same build goes to closed testing and production.
& (Join-Path $PSScriptRoot '4-publish-to-play.ps1') -Tracks @('alpha','production') -Status completed -VersionCode $VersionCode -VersionName $VersionName
