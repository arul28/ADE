# Names what kept an ADE update from installing.
#
# The installer runs this (from its own temp folder, see installer.nsh) only
# after the old uninstaller has failed five times. That uninstaller fails when it
# cannot move a file out of the install folder, and the install check has
# already stopped every process whose program lives there, so whatever is left
# is a process from outside the folder holding one of its files open. On
# 2026-11-18 and 11-19 that was a development copy of ADE left running from a
# worktree; the update failed four times and nothing said why.
#
# Windows' Restart Manager answers "which processes have these files open", the
# same question Explorer's "file in use" dialog asks. A process whose command
# line names the folder is listed too (a shell started there, a tool pointed at
# it). The answer goes to <ADE home>\runtime\update-blocked.json, which the
# brain reports to other machines (the Machines card names it), and one line
# goes to install-steps.log beside the other install steps.
#
# Best effort and quiet: any failure here leaves the update result as it was.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$PackageChannel = "stable",
  [string]$TargetVersion = "",
  [string]$AdeHome = ""
)
$ErrorActionPreference = "Continue"

$channel = $PackageChannel.Trim().ToLowerInvariant()
if (@("stable", "beta", "alpha") -notcontains $channel) { $channel = "stable" }
if ([string]::IsNullOrWhiteSpace($AdeHome)) {
  $homeName = if ($channel -eq "stable") { ".ade" } else { ".ade-$channel" }
  $AdeHome = Join-Path ([Environment]::GetFolderPath("UserProfile")) $homeName
}
$runtimeDir = Join-Path $AdeHome "runtime"
$started = Get-Date
$installRoot = ([IO.Path]::GetFullPath($InstallDir)).TrimEnd('\') + '\'

$rmSource = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AdeRestartManager {
  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint handle, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nServices, string[] services);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] infos, ref uint rebootReasons);
  public static int[] Holders(string[] files) {
    uint handle;
    if (RmStartSession(out handle, 0, new StringBuilder(64)) != 0) return new int[0];
    try {
      if (RmRegisterResources(handle, (uint)files.Length, files, 0, null, 0, null) != 0) return new int[0];
      uint needed = 0, count = 0, reasons = 0;
      RM_PROCESS_INFO[] infos = null;
      // 234 (ERROR_MORE_DATA): the list grew between the size query and the
      // read, so size it again.
      for (int attempt = 0; attempt < 4; attempt++) {
        int result = RmGetList(handle, out needed, ref count, infos, ref reasons);
        if (result == 0) break;
        if (result != 234) return new int[0];
        infos = new RM_PROCESS_INFO[needed];
        count = needed;
      }
      if (infos == null) return new int[0];
      List<int> ids = new List<int>();
      for (int i = 0; i < count && i < infos.Length; i++) ids.Add(infos[i].Process.dwProcessId);
      return ids.ToArray();
    } finally {
      RmEndSession(handle);
    }
  }
}
"@

# pid -> how it was found: "open_file" (Restart Manager) or "command_line".
$holderIds = @{}
$selfId = $PID
# Why a pass found nothing, for the steps log line.
$problems = @()
try {
  Add-Type -TypeDefinition $rmSource -Language CSharp -ErrorAction Stop
  # The files a process keeps open: programs, libraries, native modules and the
  # app archive. Every file would be thousands of registrations for nothing.
  $files = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { @(".exe", ".dll", ".node", ".asar", ".pak", ".dat", ".bin") -contains $_.Extension.ToLowerInvariant() } |
    Select-Object -First 4000 |
    ForEach-Object { $_.FullName })
  if ($files.Count -gt 0) {
    foreach ($id in [AdeRestartManager]::Holders([string[]]$files)) {
      if ($id -ne $selfId) { $holderIds[$id] = "open_file" }
    }
  }
} catch {
  # The command-line pass below still runs; the steps line says why this failed.
  $problems += "restart_manager: $($_.Exception.Message)"
}

$processes = @{}
try {
  # The folder name must end where the match ends: "...\Programs\ADE" is also
  # the start of "...\Programs\ADE Beta" and "...\Programs\ADE Alpha", whose
  # processes are not in the way. An unquoted path ends at a space, so a space
  # ends the name too, unless the other channels' folder name follows it.
  $rootPattern = [regex]::Escape($installRoot.TrimEnd('\')) + '(?!\s+(?:Beta|Alpha)\b)(?=[\\"\s]|$)'
  # A stuck WMI service must not hold the silent update (the installer also
  # bounds this whole script).
  foreach ($process in @(Get-CimInstance Win32_Process -OperationTimeoutSec 15 -ErrorAction Stop)) {
    $processes[[int]$process.ProcessId] = $process
    if ([int]$process.ProcessId -eq $selfId) { continue }
    $commandLine = [string]$process.CommandLine
    if ($commandLine -and -not $holderIds.ContainsKey([int]$process.ProcessId) -and
      [regex]::IsMatch($commandLine, $rootPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
      $holderIds[[int]$process.ProcessId] = "command_line"
    }
  }
} catch {
  # Names fall back to Get-Process below.
  $problems += "processes: $($_.Exception.Message)"
}

$holders = @()
foreach ($id in $holderIds.Keys) {
  $process = $processes[$id]
  $name = if ($process) { [string]$process.Name } else { try { (Get-Process -Id $id -ErrorAction Stop).ProcessName + ".exe" } catch { "" } }
  if (-not $name) { continue }
  $path = if ($process) { [string]$process.ExecutablePath } else { "" }
  # A program from the install folder is ADE itself, which the install check
  # already stopped; one still here is listed, after the outsiders that are
  # the usual cause. An open file is a firmer answer than a command line.
  $inside = $path -and $path.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
  $rank = $(if ($inside) { 2 } else { 0 }) + $(if ($holderIds[$id] -eq "open_file") { 0 } else { 1 })
  $holders += [pscustomobject]@{ rank = $rank; pid = $id; name = $name; path = $path; via = $holderIds[$id] }
}
# No command lines: they can carry another program's tokens, and the name,
# path and pid are what the person needs to find it.
$holders = @($holders | Sort-Object rank, pid | Select-Object -First 8 | ForEach-Object {
  [ordered]@{ pid = $_.pid; name = $_.name; path = $_.path; via = $_.via }
})

try {
  if (-not (Test-Path -LiteralPath $runtimeDir -PathType Container)) {
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  }
  $report = [ordered]@{
    at = [DateTime]::UtcNow.ToString("o")
    installDir = $InstallDir
    targetVersion = $TargetVersion
    holders = $holders
  }
  $outFile = Join-Path $runtimeDir "update-blocked.json"
  $tempFile = "$outFile.$PID.tmp"
  [IO.File]::WriteAllText($tempFile, ($report | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tempFile -Destination $outFile -Force
} catch {
  # The steps log line below still records it.
  $problems += "report: $($_.Exception.Message)"
}

try {
  $names = if ($holders.Count) { ($holders | ForEach-Object { "$($_.name)($($_.pid))" }) -join "," } else { "unknown" }
  $why = if ($problems.Count) { " problems=" + (($problems -join "; ") -replace "[\r\n]+", " ") } else { "" }
  $line = "{0} install update_blocked {1:N2}s fail target={2} holders={3}{4}" -f `
    ([DateTime]::UtcNow.ToString("o")), ((Get-Date) - $started).TotalSeconds, $TargetVersion, $names, $why
  Add-Content -LiteralPath (Join-Path $runtimeDir "install-steps.log") -Value $line -Encoding UTF8
} catch {
  # Best effort only.
}
exit 0
