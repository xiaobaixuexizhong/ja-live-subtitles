param(
    [Parameter(Mandatory = $true)][ValidateSet('ja', 'en')][string]$Language,
    [switch]$Stop
)

$root = $PSScriptRoot
$port = if ($Language -eq 'ja') { 8766 } else { 8768 }
$modelName = if ($Language -eq 'ja') { 'ggml-small.bin' } else { 'ggml-small.en.bin' }
$model = Join-Path $root "models\$modelName"
$binary = Join-Path $root 'bin\whisper-1.8.4-windows-x64\whisper-server.exe'
$run = Join-Path $root 'run'
$logs = Join-Path $root 'logs'
$pidFile = Join-Path $run "asr-$Language.pid"

if ($Stop) {
    if (-not (Test-Path -LiteralPath $pidFile)) {
        Write-Output "No managed $Language ASR process was found."
        return
    }
    $servicePid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid"
    if ($process -and $process.Name -eq 'whisper-server.exe' -and
        $process.CommandLine -like "*--port $port*") {
        Stop-Process -Id $servicePid
        Write-Output "Stopped $Language ASR (PID $servicePid)."
    }
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
    return
}

if (-not (Test-Path -LiteralPath $binary)) { throw "Whisper server missing: $binary" }
if (-not (Test-Path -LiteralPath $model) -or (Get-Item -LiteralPath $model).Length -lt 400MB) {
    throw "ASR model missing or incomplete: $model"
}
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Write-Output "$Language ASR port $port is already in use (PID $($listener.OwningProcess))."
    return
}
New-Item -ItemType Directory -Path $run, $logs -Force | Out-Null
$arguments = @('--host', '127.0.0.1', '--port', "$port",
    '--inference-path', '/v1/audio/transcriptions', '-m', ('"' + $model + '"'),
    '-l', $Language, '-dev', '0', '-t', '4')
$process = Start-Process -FilePath $binary -ArgumentList $arguments -WorkingDirectory $root `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "asr-$Language.out.log") `
    -RedirectStandardError (Join-Path $logs "asr-$Language.err.log") -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($process.HasExited) { throw "$Language ASR exited. Check logs\asr-$Language.err.log" }
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 2
        if ([int]$response.StatusCode -lt 500) {
            Write-Output "$Language ASR ready on http://127.0.0.1:$port (PID $($process.Id))."
            return
        }
    } catch {}
    Start-Sleep -Milliseconds 500
}
throw "$Language ASR did not become ready. Check logs\asr-$Language.err.log"
