param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateRange(1, 240)][int]$DurationMinutes = 90,
    [ValidateRange(2, 30)][int]$IntervalSeconds = 2
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logicalCores = [Environment]::ProcessorCount
$totalMemoryMb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB, 1)
$counterPaths = @(
    '\Processor(_Total)\% Processor Time',
    '\Memory\Available MBytes',
    '\PhysicalDisk(*)\Disk Read Bytes/sec',
    '\PhysicalDisk(*)\Disk Write Bytes/sec',
    '\Network Interface(*)\Bytes Received/sec',
    '\Network Interface(*)\Bytes Sent/sec',
    '\GPU Engine(*)\Utilization Percentage',
    '\GPU Adapter Memory(*)\Dedicated Usage'
)
$previousCpu = @{}
$previousAt = Get-Date
$startedAt = $previousAt
$endAt = $startedAt.AddMinutes($DurationMinutes)
$sampleIndex = 0
$loadedModels = ''
$loadedModelVramMb = 0

function Get-ManagedPid {
    param([string]$Name)
    $path = Join-Path $root "run\$Name.pid"
    if (-not (Test-Path -LiteralPath $path)) { return 0 }
    $value = 0
    if ([int]::TryParse((Get-Content -LiteralPath $path -Raw).Trim(), [ref]$value)) { return $value }
    return 0
}

function Get-CounterValue {
    param([array]$Samples, [string]$Suffix)
    $sample = $Samples | Where-Object { $_.Path.EndsWith($Suffix, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    if ($null -eq $sample) { return 0.0 }
    return [double]$sample.CookedValue
}

function Round-Measure {
    param([double]$Value)
    return [math]::Round($Value, 2)
}

while ((Get-Date) -lt $endAt) {
    $sampleError = ''
    $samples = @()
    try {
        $samples = @((Get-Counter -Counter $counterPaths -SampleInterval 1 -MaxSamples 1).CounterSamples)
    } catch {
        $sampleError = 'performance counter read failed'
    }

    $now = Get-Date
    $elapsed = [math]::Max(0.1, ($now - $previousAt).TotalSeconds)
    $previousAt = $now
    $asrPids = @(
        (Get-ManagedPid 'asr-ja'),
        (Get-ManagedPid 'asr-en'),
        (Get-ManagedPid 'chickenrice-asr'),
        (Get-ManagedPid 'chickenrice-translation')
    )
    $bridgePid = Get-ManagedPid 'bridge'
    $cpu = @{ asr = 0.0; bridge = 0.0; ollama = 0.0; browser = 0.0 }
    $memory = @{ asr = 0.0; bridge = 0.0; ollama = 0.0; browser = 0.0 }
    $gpu = @{ asr = 0.0; bridge = 0.0; ollama = 0.0; browser = 0.0 }
    $groupsByPid = @{}
    $nextCpu = @{}
    $topBrowserPid = 0
    $topBrowserCpu = 0.0
    foreach ($process in @(Get-Process -Name 'whisper-server','python','ollama*','llama-server','chrome','msedge' -ErrorAction SilentlyContinue)) {
        $group = if ($process.ProcessName -eq 'whisper-server' -or $process.Id -in $asrPids) {
            'asr'
        } elseif ($process.Id -eq $bridgePid) {
            'bridge'
        } elseif ($process.ProcessName -like 'ollama*' -or $process.ProcessName -like 'llama-server*') {
            'ollama'
        } elseif ($process.ProcessName -in @('chrome', 'msedge')) {
            'browser'
        } else {
            $null
        }
        if (-not $group) { continue }
        $processId = [int]$process.Id
        $groupsByPid[$processId] = $group
        $cpuSeconds = [double]$process.CPU
        $nextCpu[$processId] = $cpuSeconds
        if ($previousCpu.ContainsKey($processId)) {
            $processCpu = [math]::Max(0, ($cpuSeconds - $previousCpu[$processId]) / $elapsed / $logicalCores * 100)
            $cpu[$group] += $processCpu
            if ($group -eq 'browser' -and $processCpu -gt $topBrowserCpu) {
                $topBrowserPid = $processId
                $topBrowserCpu = $processCpu
            }
        }
        $memory[$group] += [double]$process.WorkingSet64 / 1MB
    }
    $previousCpu = $nextCpu

    $adapter = $samples | Where-Object { $_.Path -like '*\gpu adapter memory(*)\dedicated usage' } |
        Sort-Object CookedValue -Descending | Select-Object -First 1
    $adapterLuid = if ($adapter -and $adapter.Path -match '(luid_0x[0-9a-f]+_0x[0-9a-f]+_phys_\d+)') { $Matches[1].ToLowerInvariant() } else { '' }
    $gpuCompute = 0.0
    $gpu3d = 0.0
    $gpuVideoDecode = 0.0
    $diskRead = 0.0
    $diskWrite = 0.0
    $networkRx = 0.0
    $networkTx = 0.0
    foreach ($sample in $samples) {
        $path = $sample.Path.ToLowerInvariant()
        $value = [double]$sample.CookedValue
        if ($path -like '*\physicaldisk(*g:*)\disk read bytes/sec') { $diskRead += $value }
        if ($path -like '*\physicaldisk(*g:*)\disk write bytes/sec') { $diskWrite += $value }
        if ($path -like '*\network interface(*)\bytes received/sec') { $networkRx += $value }
        if ($path -like '*\network interface(*)\bytes sent/sec') { $networkTx += $value }
        if (-not $adapterLuid -or -not $path.Contains($adapterLuid) -or $path -notlike '*\gpu engine(*)\utilization percentage') { continue }
        $enginePid = if ($path -match 'pid_(\d+)') { [int]$Matches[1] } else { 0 }
        if ($enginePid -and $groupsByPid.ContainsKey($enginePid) -and $path -match 'engtype_(compute|high priority compute)') {
            $gpu[$groupsByPid[$enginePid]] += $value
        }
        if ($path -match 'engtype_(compute|high priority compute)') { $gpuCompute += $value }
        if ($path -match 'engtype_3d') { $gpu3d += $value }
        if ($path -match 'engtype_video decode') { $gpuVideoDecode += $value }
    }

    if ($sampleIndex % 10 -eq 0) {
        try {
            $models = @((Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/ps' -TimeoutSec 2).models)
            $loadedModels = ($models | ForEach-Object { $_.name }) -join ';'
            $loadedModelVramMb = ($models | Measure-Object -Property size_vram -Sum).Sum / 1MB
        } catch {
            $loadedModels = ''
            $loadedModelVramMb = 0
        }
    }

    $availableMb = Get-CounterValue $samples '\memory\available mbytes'
    $row = [pscustomobject][ordered]@{
        timestamp_local = $now.ToString('yyyy-MM-dd HH:mm:ss.fff')
        elapsed_seconds = Round-Measure ($now - $startedAt).TotalSeconds
        cpu_total_pct = Round-Measure (Get-CounterValue $samples '\processor(_total)\% processor time')
        ram_used_pct = if ($availableMb -gt 0) { Round-Measure (100 * ($totalMemoryMb - $availableMb) / $totalMemoryMb) } else { 0 }
        ram_available_mb = Round-Measure $availableMb
        gpu_compute_pct = Round-Measure ([math]::Min(100, $gpuCompute))
        gpu_3d_pct = Round-Measure ([math]::Min(100, $gpu3d))
        gpu_video_decode_pct = Round-Measure ([math]::Min(100, $gpuVideoDecode))
        gpu_dedicated_used_mb = if ($adapter) { Round-Measure ([double]$adapter.CookedValue / 1MB) } else { 0 }
        g_disk_read_mb_s = Round-Measure ($diskRead / 1MB)
        g_disk_write_mb_s = Round-Measure ($diskWrite / 1MB)
        network_rx_mb_s = Round-Measure ($networkRx / 1MB)
        network_tx_mb_s = Round-Measure ($networkTx / 1MB)
        asr_cpu_pct = Round-Measure $cpu.asr
        asr_ram_mb = Round-Measure $memory.asr
        asr_gpu_compute_pct = Round-Measure ([math]::Min(100, $gpu.asr))
        bridge_cpu_pct = Round-Measure $cpu.bridge
        bridge_ram_mb = Round-Measure $memory.bridge
        ollama_cpu_pct = Round-Measure $cpu.ollama
        ollama_ram_mb = Round-Measure $memory.ollama
        ollama_gpu_compute_pct = Round-Measure ([math]::Min(100, $gpu.ollama))
        ollama_model_vram_mb = Round-Measure $loadedModelVramMb
        ollama_loaded_models = $loadedModels
        browser_cpu_pct = Round-Measure $cpu.browser
        browser_ram_mb = Round-Measure $memory.browser
        browser_gpu_compute_pct = Round-Measure ([math]::Min(100, $gpu.browser))
        top_browser_pid = $topBrowserPid
        top_browser_cpu_pct = Round-Measure $topBrowserCpu
        sample_error = $sampleError
    }
    $row | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Append -Encoding UTF8
    $sampleIndex += 1
    $remaining = $IntervalSeconds - ($now - $startedAt).TotalSeconds % $IntervalSeconds
    if ($remaining -gt 0.1 -and (Get-Date).AddSeconds($remaining) -lt $endAt) {
        Start-Sleep -Milliseconds ([int]($remaining * 1000))
    }
}
