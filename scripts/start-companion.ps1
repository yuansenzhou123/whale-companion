param([string]$Preview = '', [string]$Expression = 'happy', [switch]$CompileOnly)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectDir 'runtime\python\python.exe'
$petPath = Join-Path $projectDir 'companion\desktop\live2d_pet.py'
$rendererPath = Join-Path $projectDir 'companion\desktop\live2d_renderer.py'
if ($CompileOnly) {
  & $pythonPath -m py_compile $petPath $rendererPath (Join-Path $projectDir 'companion\desktop\pet_controls.py') (Join-Path $projectDir 'companion\desktop\speech_bubble.py') (Join-Path $projectDir 'companion\desktop\pet_instance.py')
  if ($LASTEXITCODE -ne 0) { throw 'Live2D desktop check failed' }
  Write-Output 'Live2D desktop checked.'; exit 0
}
if ($Preview) {
  & $pythonPath $petPath --preview $Preview --expression $Expression
  exit $LASTEXITCODE
}
$instancePath = Join-Path $projectDir 'companion\desktop\pet_instance.py'
$existing = (& $pythonPath $instancePath | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw '桌宠窗口恢复失败，请查看上面的错误。' }
if ($existing.found) { Write-Output '桌宠已重新显示。'; exit 0 }
& $pythonPath (Join-Path $projectDir 'scripts\prepare-live2d-model.py')
if ($LASTEXITCODE -ne 0) { throw 'Live2D 鼠控模型准备失败，请检查 live2D 文件夹。' }
$config = Get-Content -LiteralPath (Join-Path $projectDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$port = if ($config.server.port) { [int]$config.server.port } else { 8787 }
$endpoint = 'http://127.0.0.1:' + $port
try { $status = Invoke-RestMethod ($endpoint + '/api/companion/bootstrap') -TimeoutSec 2 } catch {
  $nodePath = Join-Path $projectDir 'runtime\node.exe'
  Start-Process -FilePath $nodePath -ArgumentList @('server.js', '--no-browser') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectDir 'data\server-companion.stdout.log') -RedirectStandardError (Join-Path $projectDir 'data\server-companion.stderr.log') | Out-Null
  $status = $null
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    try { $status = Invoke-RestMethod ($endpoint + '/api/companion/bootstrap') -TimeoutSec 2; break } catch {}
  }
}
if (-not $status.token) { throw '陪看服务未启动；如果旧服务还开着，请先重启鲸鱼娘。' }
$pauseMarker = Join-Path $projectDir 'data\PAUSED'
if (Test-Path -LiteralPath $pauseMarker) { Remove-Item -LiteralPath $pauseMarker -Force }
Invoke-RestMethod -Uri ($endpoint + '/api/companion/settings') -Method Post -Headers @{Authorization=('Bearer ' + $status.token)} -ContentType 'application/json' -Body '{"enabled":true}' -TimeoutSec 3 | Out-Null
$startEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()/1000.0
$pet = Start-Process -FilePath $pythonPath -ArgumentList @(('"' + $petPath + '"'),'--endpoint',$endpoint) -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $projectDir 'data\live2d-pet.stdout.log') -RedirectStandardError (Join-Path $projectDir 'data\live2d-pet.stderr.log')
$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  Start-Sleep -Milliseconds 500
  $pet.Refresh()
  if ($pet.HasExited) {
    if ($pet.ExitCode -eq 0) {
      $existing = (& $pythonPath $instancePath | ConvertFrom-Json)
      if ($existing.found) { Write-Output '桌宠已重新显示。'; exit 0 }
    } else { throw 'Live2D 桌宠启动失败，请查看 data/live2d-pet-error.log。' }
  }
  try {
    $health = Get-Content -LiteralPath (Join-Path $projectDir 'data\live2d-pet-status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($health.pid -eq $pet.Id -and $health.loaded -and $health.time -ge $startEpoch) {$ready = $true; break}
  } catch {}
}
if (-not $ready) { throw 'Live2D 桌宠仍在加载，请查看 data/live2d-pet.stderr.log。' }
$capturePath = Join-Path $projectDir 'companion\desktop\capture_client.py'
Start-Process -FilePath $pythonPath -ArgumentList @(('"' + $capturePath + '"'),$endpoint,[string]$pet.Id) -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectDir 'data\companion-capture.stdout.log') -RedirectStandardError (Join-Path $projectDir 'data\companion-capture.stderr.log') | Out-Null
# Settings are available from the pet right-click menu.
