/**
 * Reads this machine's battery and wall-power state, on every platform ADE
 * runs on, without Electron.
 *
 * The brain has no `powerMonitor`, and Linux has no ADE desktop app at all
 * (`linux: false` in the build config), so every Linux power fact has to come
 * from here. The desktop main process shares this module rather than growing a
 * second macOS-only implementation.
 *
 * A machine with no battery reports `battery: undefined`, never 0% or 100%: a
 * Mac Studio showing "0%" would be a lie about hardware that does not exist.
 * Nothing here logs a reading — battery percentage is user telemetry, not
 * diagnostics.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeBatteryPercent,
  type MachineBattery,
  type MachinePower,
} from "../../../../desktop/src/shared/types/power";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";

/**
 * Bounded so a wedged `pmset` or a cold-starting PowerShell can never stall the
 * heartbeat that carries this reading. A timeout degrades to "unknown power",
 * which publishes as null rather than as a wrong number.
 */
const POSIX_READ_TIMEOUT_MS = 2_000;
/** PowerShell cold-starts; match the sync listener's Windows probe budget. */
const WINDOWS_READ_TIMEOUT_MS = 5_000;

const LINUX_POWER_SUPPLY_DIR = "/sys/class/power_supply";

export type MachinePowerReaderDeps = {
  platform?: NodeJS.Platform;
  execFileText?: (command: string, args: string[], timeoutMs: number) => Promise<string | null>;
  readTextFile?: (filePath: string) => string | null;
  readDir?: (dirPath: string) => string[] | null;
};

function defaultExecFileText(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        // Without this, every poll for the life of the brain flashes a console
        // window on Windows.
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(error ? null : String(stdout ?? ""));
      },
    );
  });
}

function defaultReadTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function defaultReadDir(dirPath: string): string[] | null {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return null;
  }
}

/**
 * A machine we could not read at all publishes NOTHING, not a guess.
 *
 * This used to be `{ onExternalPower: true }`, which reads as a confident
 * "plugged in" everywhere downstream — one `pmset` timeout was enough to
 * republish a 20%-on-battery MacBook as if it were on wall power. `null` is the
 * value the publisher and the directory are both already built for: the field
 * is dropped from the registration and `coalesce` leaves whatever was last
 * known in place.
 */
const UNKNOWN_POWER = null;

function withBattery(
  onExternalPower: boolean,
  battery: MachineBattery | null,
): MachinePower {
  return { ...(battery ? { battery } : {}), onExternalPower };
}

/**
 * Parse `pmset -g batt`. A MacBook prints
 * `Now drawing from 'Battery Power'` followed by a
 * ` -InternalBattery-0 (id=…)\t83%; discharging; 3:11 remaining present: true`
 * line; a Mac Studio prints the `AC Power` line and nothing else, which is
 * exactly how we tell "no battery" from "battery at 0%".
 */
export function parsePmsetBatteryOutput(raw: string | null): MachinePower | null {
  const text = raw?.trim();
  if (!text) return null;
  const onExternalPower = !/drawing from ['"]?battery/i.test(text);
  const percentMatch = /(\d{1,3})%/.exec(text);
  const percent = percentMatch ? normalizeBatteryPercent(Number(percentMatch[1])) : null;
  if (percent === null || !/present:\s*true/i.test(text)) {
    return { onExternalPower };
  }
  // "finishing charge" and "charging" both mean current is going in;
  // "discharging", "charged", and "AC attached" do not — and neither does
  // "not charging", which is what macOS prints under optimized battery
  // charging when a plugged-in Mac is deliberately holding at 80%.
  const charging = (/(?:^|[;\s])charging/i.test(text) && !/(?:^|[;\s])not\s+charging/i.test(text))
    || /finishing charge/i.test(text);
  return withBattery(onExternalPower, { percent, charging });
}

/**
 * PowerShell that reports battery percent, charge direction, and wall power in
 * a single invocation.
 *
 * `root/wmi`'s `BatteryStatus` carries the two booleans directly and is the
 * authoritative answer when present. `Win32_Battery` is the fallback: its
 * `BatteryStatus` is an enum where 1 is discharging and 6-9 are the charging
 * states, which is less precise but available on hosts where the `root/wmi`
 * class is not.
 *
 * "No battery" and "could not read the battery" are answered separately, and
 * that separation is the point. `$ErrorActionPreference = 'SilentlyContinue'`
 * turns a WMI hiccup into two nulls, which used to print `none` — a confident
 * "this is a desktop" that the whole-blob coalesce then wrote over the last good
 * laptop reading. Only `Win32_Battery` decides absence, because it is a standard
 * CIM class present on every Windows and simply returns no instances on a
 * machine with no battery; `root/wmi\BatteryStatus` genuinely does not exist on
 * many hosts, so its error proves nothing. If the `Win32_Battery` query itself
 * errored we say `unknown` and publish nothing.
 */
export function buildWindowsPowerQueryArgs(): string[] {
  const query = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$batteryError = $null",
    "$battery = @(Get-CimInstance -ClassName Win32_Battery -ErrorVariable batteryError)[0]",
    "$status = @(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus)[0]",
    "if ($null -eq $status -and $null -eq $battery)"
      + " { if ($batteryError -and $batteryError.Count -gt 0)"
      + " { [Console]::Out.Write('unknown') } else { [Console]::Out.Write('none') }; exit 0 }",
    "$percent = ''",
    "if ($null -ne $battery -and $null -ne $battery.EstimatedChargeRemaining)"
      + " { $percent = [string][int]$battery.EstimatedChargeRemaining }",
    "$charging = ''",
    "if ($null -ne $status -and $null -ne $status.Charging) { $charging = [string][bool]$status.Charging }",
    "elseif ($null -ne $battery) { $charging = [string](@(6,7,8,9) -contains [int]$battery.BatteryStatus) }",
    "$online = ''",
    "if ($null -ne $status -and $null -ne $status.PowerOnline) { $online = [string][bool]$status.PowerOnline }",
    "elseif ($null -ne $battery) { $online = [string]([int]$battery.BatteryStatus -ne 1) }",
    "[Console]::Out.Write(\"$percent|$charging|$online\")",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

function parseWindowsBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

export function parseWindowsPowerOutput(raw: string | null): MachinePower | null {
  const text = raw?.trim();
  if (!text) return null;
  // The query could not read this machine. Not the same statement as "no
  // battery", and it must not publish as one.
  if (text === "unknown") return UNKNOWN_POWER;
  // No battery hardware at all: a desktop or a server, permanently on mains.
  if (text === "none") return { onExternalPower: true };
  const [rawPercent, rawCharging, rawOnline] = text.split("|");
  const online = parseWindowsBoolean(rawOnline);
  const onExternalPower = online ?? true;
  const percent = normalizeBatteryPercent(Number(rawPercent));
  // Reaching here means one of the two classes returned an instance, so this
  // machine HAS a battery — a poll that merely failed to read the percentage
  // must not answer `{ onExternalPower }`, which is the battery-less shape. Say
  // nothing instead and let the coalesce keep the last known reading, rather
  // than turning a laptop into a desktop for one poll.
  if (rawPercent?.trim() === "" || percent === null) return UNKNOWN_POWER;
  return withBattery(onExternalPower, {
    percent,
    charging: parseWindowsBoolean(rawCharging) ?? false,
  });
}

/**
 * Read `/sys/class/power_supply`, which every mainstream Linux exposes without
 * a process spawn: each supply directory carries a `type`, plus `capacity` and
 * `status` for batteries and `online` for mains. A host with only mains
 * supplies (a server, a desktop) yields no battery, which is the correct
 * answer rather than a missing one.
 */
function readLinuxPower(
  deps: Required<Pick<MachinePowerReaderDeps, "readTextFile" | "readDir">>,
): MachinePower | null {
  const entries = deps.readDir(LINUX_POWER_SUPPLY_DIR);
  if (!entries || entries.length === 0) return UNKNOWN_POWER;
  const read = (entry: string, file: string): string | null =>
    deps.readTextFile(path.posix.join(LINUX_POWER_SUPPLY_DIR, entry, file))?.trim() ?? null;

  let battery: MachineBattery | null = null;
  let batteryStatus = "";
  let mainsOnline: boolean | null = null;
  for (const entry of entries) {
    const type = read(entry, "type")?.toLowerCase() ?? null;
    if (type === "mains" || type === "usb") {
      // Any supply reporting itself online is wall power for our purposes: a
      // USB-PD charger powers the machine exactly as a barrel jack does.
      if (read(entry, "online") === "1") mainsOnline = true;
      else if (mainsOnline === null) mainsOnline = false;
      continue;
    }
    if (type !== "battery" || battery) continue;
    const percent = normalizeBatteryPercent(Number(read(entry, "capacity")));
    if (percent === null) continue;
    batteryStatus = read(entry, "status")?.toLowerCase() ?? "";
    battery = { percent, charging: batteryStatus === "charging" };
  }
  // With a battery present but no AC supply exposed, the battery's own status
  // is the only evidence: "Discharging" means we are off mains, and anything
  // else (charging, full, unknown) means we are not.
  const onExternalPower = mainsOnline ?? (battery ? batteryStatus !== "discharging" : true);
  return withBattery(onExternalPower, battery);
}

/**
 * Best-effort current power state, or `null` when this machine could not be
 * read. Never throws and never rejects.
 *
 * `null` is the whole point of the signature: a timed-out `pmset`, a PowerShell
 * that never came back, and a platform ADE has no reader for are all "we do not
 * know", and every one of them used to answer "plugged in".
 */
export async function readMachinePower(
  deps: MachinePowerReaderDeps = {},
): Promise<MachinePower | null> {
  const platform = deps.platform ?? process.platform;
  const execFileText = deps.execFileText ?? defaultExecFileText;
  try {
    if (platform === "darwin") {
      const raw = await execFileText("/usr/bin/pmset", ["-g", "batt"], POSIX_READ_TIMEOUT_MS);
      return parsePmsetBatteryOutput(raw) ?? UNKNOWN_POWER;
    }
    if (platform === "win32") {
      const powershell = resolveTrustedWindowsTool("powershell");
      const raw = await execFileText(
        powershell,
        buildWindowsPowerQueryArgs(),
        WINDOWS_READ_TIMEOUT_MS,
      );
      return parseWindowsPowerOutput(raw) ?? UNKNOWN_POWER;
    }
    if (platform === "linux") {
      return readLinuxPower({
        readTextFile: deps.readTextFile ?? defaultReadTextFile,
        readDir: deps.readDir ?? defaultReadDir,
      });
    }
  } catch {
    return UNKNOWN_POWER;
  }
  return UNKNOWN_POWER;
}
