$root = $PSScriptRoot
$listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Write-Output "Translation bridge port 8765 is already in use (PID $($listener.OwningProcess))."
    return
}
$run = Join-Path $root 'run'
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $run, $logs -Force | Out-Null
$python = (Get-Command python -ErrorAction Stop).Source
$process = Start-Process -FilePath $python -ArgumentList '-B', '-m', 'uvicorn', 'app:app',
    '--host', '127.0.0.1', '--port', '8765', '--workers', '1' -WorkingDirectory $root `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'bridge.out.log') `
    -RedirectStandardError (Join-Path $logs 'bridge.err.log') -PassThru
Set-Content -LiteralPath (Join-Path $run 'bridge.pid') -Value $process.Id
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($process.HasExited) { throw 'Translation bridge exited. Check logs\bridge.err.log' }
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2
        if ($health.ready -eq $true) {
            Write-Output "Translation bridge ready on http://127.0.0.1:8765 (PID $($process.Id))."
            return
        }
    } catch {}
    Start-Sleep -Milliseconds 500
}
throw 'Translation bridge did not become ready. Check logs\bridge.err.log'
