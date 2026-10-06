$statePath = Join-Path $PSScriptRoot 'run\performance-monitor.json'
if (-not (Test-Path -LiteralPath $statePath)) {
    Write-Output 'No managed performance monitor was found.'
    return
}

$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)" -ErrorAction SilentlyContinue
if ($process -and $process.CommandLine -like '*monitor-performance.ps1*') {
    Stop-Process -Id $state.pid
    Write-Output "Stopped performance monitor (PID $($state.pid))."
}
Remove-Item -LiteralPath $statePath
Write-Output "CSV: $($state.outputPath)"
