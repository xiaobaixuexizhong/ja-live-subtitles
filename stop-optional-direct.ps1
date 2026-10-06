$listener = Get-NetTCPConnection -LocalPort 8767 -State Listen -ErrorAction SilentlyContinue
if (-not $listener) { Write-Output 'Direct Japanese speech translation is not running.'; return }
$servicePid = [int]$listener.OwningProcess
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid"
if ($process -and $process.Name -eq 'python.exe' -and
    $process.CommandLine -like '*uvicorn server:app*' -and
    $process.CommandLine -like '*whisper-ja-zh-base*') {
    Stop-Process -Id $servicePid
    Write-Output "Stopped direct Japanese speech translation (PID $servicePid)."
} else {
    throw 'Port 8767 is used by another process; no process was stopped.'
}
