$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await-Result($operation, $resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(2500)) { throw 'Media session timeout' }
  return $task.Result
}
$manager = Await-Result ($managerType::RequestAsync()) $managerType
$cachedTitle = ''; $cachedArtist = ''; $lastPropertiesAt = [DateTime]::MinValue
while ($true) {
  try {
    $session = @($manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -match 'bilibili' }) | Select-Object -First 1
    if ($session) {
      if (((Get-Date) - $lastPropertiesAt).TotalSeconds -gt 5) {
        $properties = Await-Result ($session.TryGetMediaPropertiesAsync()) $propertiesType
        $cachedTitle = $properties.Title; $cachedArtist = $properties.Artist; $lastPropertiesAt = Get-Date
      }
      $timeline = $session.GetTimelineProperties()
      $playback = $session.GetPlaybackInfo()
      $playing = [string]$playback.PlaybackStatus -eq 'Playing'
      $position = $timeline.Position.TotalSeconds
      if ($playing) { $position += [Math]::Max(0, [Math]::Min(8, ([DateTimeOffset]::Now - $timeline.LastUpdatedTime).TotalSeconds)) }
      $duration = $timeline.EndTime.TotalSeconds
      if ($duration -gt 0) { $position = [Math]::Min($position, $duration) }
      $row = @{ok=$true; title=$cachedTitle; artist=$cachedArtist; playing=$playing; position=[Math]::Max(0,$position); duration=$duration; timestamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
    } else { $row = @{ok=$false; timestamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} }
    [Console]::WriteLine(($row | ConvertTo-Json -Compress))
  } catch { [Console]::WriteLine('{"ok":false}') }
  Start-Sleep -Milliseconds 1800
}
