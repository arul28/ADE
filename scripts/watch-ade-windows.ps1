<#
.SYNOPSIS
  Sample resource use of a running ADE build on Windows and flag stalls.

.DESCRIPTION
  Writes one CSV row per second per ADE process, plus a live console line
  whenever something crosses a threshold worth looking at. Point it at a
  packaged channel build while you use the app; the CSV is the artifact to
  hand back for diagnosis.

  What each column is for:
    cpuPct        - per-process CPU across all cores. The Electron *main*
                    process pegging one core is the signature of synchronous
                    work blocking the UI, which on Windows is usually a
                    spawnSync of PowerShell (~900ms each).
    workingSetMB  - resident memory. Watch the trend, not the value.
    handles       - handle count. A number that only ever climbs is a leak.
    threads       - thread count. Sudden growth means something is spawning.
    tcp           - established TCP connections owned by the process. Spikes
                    here during UI lag point at remote/sync chattiness rather
                    than local work.
    gapMs         - wall time since this script's previous sample. The
                    sampler runs at a fixed cadence, so a gap far above the
                    interval means the whole machine stalled, not just ADE.

.EXAMPLE
  .\scripts\watch-ade-windows.ps1
  .\scripts\watch-ade-windows.ps1 -ProcessName 'ADE Alpha' -IntervalMs 500
#>
[CmdletBinding()]
param(
  # Matches the packaged executable name: "ADE", "ADE Alpha", "ADE Beta".
  [string] $ProcessName = 'ADE Alpha',
  [int]    $IntervalMs = 1000,
  [string] $OutFile,
  # Console-alert thresholds. Defaults are deliberately quiet.
  [double] $CpuAlertPct = 60,
  [int]    $GapAlertMs = 1500
)

$ErrorActionPreference = 'Stop'

if (-not $OutFile) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $OutFile = Join-Path $env:TEMP "ade-watch-$stamp.csv"
}

Write-Host "Watching processes named '$ProcessName' every ${IntervalMs}ms."
Write-Host "CSV: $OutFile"
Write-Host "Press Ctrl+C to stop, then send me that file.`n"

"timestamp,pid,role,cpuPct,workingSetMB,handles,threads,tcp,gapMs" |
  Out-File -FilePath $OutFile -Encoding utf8

# Per-pid CPU accounting: Get-Process reports cumulative processor seconds, so
# a usable percentage needs the delta over the sampling window, divided by the
# core count to express "share of the whole machine".
$prevCpu = @{}
$cores = [Environment]::ProcessorCount
$lastTick = [DateTime]::UtcNow
$sawAny = $false

while ($true) {
  $now = [DateTime]::UtcNow
  $gapMs = [int]($now - $lastTick).TotalMilliseconds
  $lastTick = $now
  $stampIso = $now.ToString('o')

  $procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) {
    if ($sawAny) { Write-Host "$stampIso  (no '$ProcessName' processes — app closed?)" -ForegroundColor DarkGray }
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }
  $sawAny = $true

  # One TCP query per tick rather than per process; grouping is cheap.
  $tcpByPid = @{}
  try {
    Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
      Group-Object -Property OwningProcess |
      ForEach-Object { $tcpByPid[[int]$_.Name] = $_.Count }
  } catch { }

  # The oldest process is the Electron main process; the rest are renderers,
  # GPU, and utility children. Main is the one whose CPU matters for UI lag.
  $mainPid = ($procs | Sort-Object StartTime | Select-Object -First 1).Id

  foreach ($p in $procs) {
    $cpuPct = 0.0
    try {
      $cpuSec = $p.CPU
      if ($null -ne $cpuSec) {
        if ($prevCpu.ContainsKey($p.Id)) {
          $deltaSec = $cpuSec - $prevCpu[$p.Id]
          $windowSec = [Math]::Max($gapMs, 1) / 1000.0
          $cpuPct = [Math]::Round(($deltaSec / $windowSec) * 100.0 / $cores, 1)
        }
        $prevCpu[$p.Id] = $cpuSec
      }
    } catch { }

    $role = if ($p.Id -eq $mainPid) { 'main' } else { 'child' }
    $wsMB = [Math]::Round($p.WorkingSet64 / 1MB, 1)
    $tcp = if ($tcpByPid.ContainsKey($p.Id)) { $tcpByPid[$p.Id] } else { 0 }

    "$stampIso,$($p.Id),$role,$cpuPct,$wsMB,$($p.HandleCount),$($p.Threads.Count),$tcp,$gapMs" |
      Out-File -FilePath $OutFile -Encoding utf8 -Append

    if ($role -eq 'main' -and $cpuPct -ge $CpuAlertPct) {
      Write-Host ("{0}  MAIN CPU {1}%  ws={2}MB handles={3} tcp={4}" -f `
        $now.ToString('HH:mm:ss'), $cpuPct, $wsMB, $p.HandleCount, $tcp) -ForegroundColor Yellow
    }
  }

  if ($gapMs -ge $GapAlertMs) {
    Write-Host ("{0}  SAMPLER GAP {1}ms — the machine itself stalled here" -f `
      $now.ToString('HH:mm:ss'), $gapMs) -ForegroundColor Red
  }

  Start-Sleep -Milliseconds $IntervalMs
}
