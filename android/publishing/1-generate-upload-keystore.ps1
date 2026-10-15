[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
New-AppSigningKey 'upload'
New-AppSigningKey 'sideload'
Write-Host 'Keep a secure backup of secrets/. The upload key and sideload key belong only to Boom Buds.'
