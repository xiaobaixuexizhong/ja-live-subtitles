$pidFile = Join-Path $PSScriptRoot 'run\bridge.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output 'No managed translation bridge process was found.'
    return
}
$servicePid = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid"
if ($process -and $process.Name -eq 'python.exe' -and $process.CommandLine -like '*uvicorn app:app*') {
    Stop-Process -Id $servicePid
    Write-Output "Stopped translation bridge (PID $servicePid)."
}
Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
