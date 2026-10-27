param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
$projectDir=Split-Path -Parent $PSScriptRoot
$bridgePath=Join-Path $projectDir 'examples\wechatauto_bridge.py'
$launcher=Join-Path $projectDir '启动微信桥接.bat'
$pythonPath=Join-Path $projectDir 'runtime\python\python.exe'
$hashSource=[Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($projectDir).ToLowerInvariant())
$sha=[Security.Cryptography.SHA256]::Create()
try {$identity=([BitConverter]::ToString($sha.ComputeHash($hashSource))).Replace('-','').Substring(0,12)} finally {$sha.Dispose()}
$mutex=New-Object Threading.Mutex($false,('Local\WhaleGirlBridgeMenu-'+$identity))
$owned=$false
try {
  try {$owned=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$owned=$true}
  if(-not $owned) {Write-Output '{"status":"alreadyRunning"}';exit 0}
  $existing=@(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" | Where-Object {
    $_.CommandLine -and ($_.CommandLine.IndexOf($bridgePath,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or ($_.ExecutablePath -eq $pythonPath -and $_.CommandLine -match '(?:^|[\s"''])examples[\\/]wechatauto_bridge\.py(?:[\s"'']|$)'))
  })
  if($existing.Count -gt 0) {Write-Output '{"status":"alreadyRunning"}';exit 0}
  if(-not (Test-Path -LiteralPath $launcher)) {throw 'WeChat bridge launcher is missing.'}
  if($CheckOnly) {Write-Output '{"status":"ready"}';exit 0}
  New-Item -ItemType Directory -Path (Join-Path $projectDir 'data') -Force | Out-Null
  # A delayed menu launch cannot undo a newer user stop request.
  $stopMarker=Join-Path $projectDir 'data\WECHAT_STOPPED'
  $requestedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()/1000.0
  $parsedAt=0.0
  if([double]::TryParse($env:WHALE_BRIDGE_REQUESTED_AT,[Globalization.NumberStyles]::Float,[Globalization.CultureInfo]::InvariantCulture,[ref]$parsedAt)){$requestedAt=$parsedAt}
  if(Test-Path -LiteralPath $stopMarker){
    $stoppedAt=([DateTimeOffset](Get-Item -LiteralPath $stopMarker).LastWriteTimeUtc).ToUnixTimeMilliseconds()/1000.0
    if($stoppedAt -ge $requestedAt){Write-Output '{"status":"stopped"}';exit 0}
    Remove-Item -LiteralPath $stopMarker -Force
  }
  $env:WHALE_BRIDGE_MENU_START='1'
  # Keep the mutex while the original batch launcher handles bridge crash recovery.
  $child=Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /s /c ""'+$launcher+'""') -WorkingDirectory $projectDir -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $projectDir 'data\wechat-console.stdout.log') -RedirectStandardError (Join-Path $projectDir 'data\wechat-console.stderr.log')
  exit $child.ExitCode
} finally {
  if($owned) {$mutex.ReleaseMutex()}
  $mutex.Dispose()
}
