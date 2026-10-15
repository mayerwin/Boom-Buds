[CmdletBinding()]
param([string]$TvAddress = '', [string]$PairAddress = '', [string]$Serial = '', [switch]$SkipBuild)
& (Join-Path $PSScriptRoot '6-install-on-tv.ps1') -TvAddress $TvAddress -PairAddress $PairAddress -Serial $Serial -SkipBuild:$SkipBuild
