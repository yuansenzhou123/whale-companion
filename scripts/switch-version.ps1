param([ValidateSet('v2','v3')][string]$Target='v3',[switch]$CheckOnly)
$ErrorActionPreference='Stop'
$v3Root=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$manifest=Get-Content -LiteralPath (Join-Path $v3Root 'data\v2-backup-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$v2Root=[IO.Path]::GetFullPath($manifest.source)
if($v3Root -ne [IO.Path]::GetFullPath($manifest.v3) -or $v2Root -eq $v3Root){throw '版本路径校验失败。'}
$chosenRoot=if($Target -eq 'v3'){$v3Root}else{$v2Root}
$otherRoot=if($Target -eq 'v3'){$v2Root}else{$v3Root}
foreach($item in @($chosenRoot,$otherRoot)){if(-not (Test-Path -LiteralPath (Join-Path $item 'server.js'))){throw '版本文件不完整。'}}
$python=Join-Path $v3Root 'runtime\python\python.exe'
$helper=Join-Path $v3Root 'scripts\stop_version_processes.py'
if($CheckOnly){& $python $helper --root $otherRoot --check-only;if($LASTEXITCODE -ne 0){throw '进程检查失败'};Write-Output ('Ready: '+$Target+' / '+$chosenRoot);exit 0}
$mutex=New-Object Threading.Mutex($false,'Local\WhaleGirlVersionSwitch')
$owned=$false
try{
  try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
  if(-not $owned){throw '另一个版本切换仍在进行，请稍等。'}
  # Stop only the explicitly identified other version. Never terminate WeChat.
  & $python $helper --root $otherRoot
  if($LASTEXITCODE -ne 0){throw '旧版本尚未完全退出，取消启动以免两个桥接争用。'}
  # A preview backend must restart without the dry-run environment before activation.
  $cfg=Get-Content -LiteralPath (Join-Path $chosenRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $endpoint='http://127.0.0.1:'+([int]$cfg.server.port)
  $health=$null
  try{$health=Invoke-RestMethod ($endpoint+'/healthz') -TimeoutSec 2}catch{}
  if($health -and $health.root -and [IO.Path]::GetFullPath($health.root) -ne $chosenRoot){throw '目标端口被其他项目占用。'}
  if($health.actionDryRun){& $python $helper --root $chosenRoot --server-only;if($LASTEXITCODE -ne 0){throw '预览服务未退出。'}}
  Remove-Item Env:WHALE_ACTION_DRY_RUN -ErrorAction SilentlyContinue
  Remove-Item Env:PORT -ErrorAction SilentlyContinue
  $env:WHALE_BOT_URL=$endpoint+'/webhook/wechat'
  $shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $start=Join-Path $chosenRoot 'scripts\start-companion.ps1'
  & $shell -NoProfile -ExecutionPolicy Bypass -File $start
  if($LASTEXITCODE -ne 0){throw '桌宠未能启动，请检查运行日志。'}
  $bridge=Join-Path $chosenRoot 'scripts\start-wechat-from-pet.ps1'
  Start-Process -FilePath $shell -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$bridge+'"') -WorkingDirectory $chosenRoot -WindowStyle Hidden | Out-Null
  Write-Output ('已切换到 '+$Target+'。微信需要保持登录。')
}finally{if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}
