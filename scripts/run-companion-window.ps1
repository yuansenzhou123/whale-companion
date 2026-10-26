param([string]$Endpoint = 'http://127.0.0.1:8787')
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
& (Join-Path $projectDir 'runtime\python\python.exe') (Join-Path $projectDir 'companion\desktop\live2d_pet.py') --endpoint $Endpoint
exit $LASTEXITCODE
