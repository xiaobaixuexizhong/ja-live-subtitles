param([ValidateRange(1, 240)][int]$DurationMinutes = 90)

$root = $PSScriptRoot
$run = Join-Path $root 'run'
$logs = Join-Path $root 'logs'
$statePath = Join-Path $run 'performance-monitor.json'
New-Item -ItemType Directory -Path $run, $logs -Force | Out-Null

if (Test-Path -LiteralPath $statePath) {
    $existing = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing.pid)" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -like '*monitor-performance.ps1*') {
        Write-Output "Performance monitor is already running (PID $($existing.pid))."
        Write-Output "CSV: $($existing.outputPath)"
        return
    }
    Remove-Item -LiteralPath $statePath
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$csvPath = Join-Path $logs "performance-$stamp.csv"
$scriptPath = Join-Path $root 'monitor-performance.ps1'
$powerShellCommand = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $powerShellCommand) {
    $powerShellCommand = Get-Command powershell.exe -ErrorAction Stop
}
$powerShell = $powerShellCommand.Source
$monitor = Start-Process -FilePath $powerShell -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-File', "`"$scriptPath`"",
    '-OutputPath', "`"$csvPath`"", '-DurationMinutes', "$DurationMinutes"
) -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs "performance-$stamp.out.log") `
    -RedirectStandardError (Join-Path $logs "performance-$stamp.err.log") -PassThru

@{ pid = $monitor.Id; outputPath = $csvPath; startedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($monitor.HasExited) { throw "Performance monitor exited. Check logs\performance-$stamp.err.log" }
    if ((Test-Path -LiteralPath $csvPath) -and (Get-Item -LiteralPath $csvPath).Length -gt 0) {
        Write-Output "Performance monitor is sampling (PID $($monitor.Id))."
        Write-Output "CSV: $csvPath"
        return
    }
    Start-Sleep -Milliseconds 500
}
throw "Performance monitor did not produce a sample. Check logs\performance-$stamp.err.log"
