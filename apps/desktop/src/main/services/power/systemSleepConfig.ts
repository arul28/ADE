/**
 * Reads the platform's OWN idle-sleep configuration, and changes it when the
 * user asks.
 *
 * This is the half of "keep this machine awake" that ADE cannot win from
 * inside the app. macOS ships with a system sleep timer on wall power, and
 * Windows ships with one too; either one puts the machine down while an agent
 * is mid-turn, no matter which keep-awake level is selected. So the setting
 * reads the real configuration and says what it will do, rather than promising
 * something the OS is about to override.
 *
 * Linux is deliberately absent: no ADE desktop app ships for it (`linux:
 * false`), so there is nothing here to read on that platform.
 *
 * Every spawn passes `windowsHide: true` — a poll that flashes a console window
 * on Windows is the failure this repo has already been bitten by — and the
 * Windows tool is resolved through `resolveTrustedWindowsTool` so a poisoned
 * PATH cannot substitute its own `powercfg`.
 */

import { execFile } from "node:child_process";
import type { SystemSleepConfig } from "../../../shared/types/keepAwake";
import { resolveTrustedWindowsTool } from "../../../../../ade-cli/src/lib/trustedWindowsTools";

/** `pmset` answers instantly or it is wedged; never stall the settings read. */
const PMSET_TIMEOUT_MS = 3_000;
/** `powercfg` prints a large report and Defender may scan the spawn first. */
const POWERCFG_TIMEOUT_MS = 8_000;

export type SystemSleepDeps = {
  platform?: NodeJS.Platform;
  execFileText?: (
    command: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
};

/**
 * The one place this service actually spawns. Exported so the keep-awake
 * service's macOS controller shares it instead of growing a second `execFile`
 * call site that could forget `windowsHide`.
 */
export function execSystemText(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// macOS — `pmset -g custom`
// ---------------------------------------------------------------------------

/**
 * Pull the wall-power idle sleep timer out of `pmset -g custom`.
 *
 * The output is two indented blocks headed `Battery Power:` and `AC Power:`;
 * only the AC one matters, because a machine running agents on battery has a
 * much shorter problem than a sleep timer. Values can carry an annotation —
 * `sleep 1 (sleep prevented by coreaudiod)` — so only the leading integer is
 * read. Both the modern `sleep` key and the older `System Sleep Timer` label
 * are accepted; a machine that prints neither returns null rather than a
 * guessed zero, because "we could not read it" and "it never sleeps" are
 * different answers and only one of them is safe to show as reassurance.
 */
export function parsePmsetCustom(raw: string | null | undefined): number | null {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return null;
  let inAcSection = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*(AC Power|Battery Power)\s*:/i.exec(line);
    if (header) {
      inAcSection = /^ac/i.test(header[1] ?? "");
      continue;
    }
    if (!inAcSection) continue;
    const match = /^\s*(?:sleep|System Sleep Timer)\s+(-?\d+)/i.exec(line);
    if (match) {
      const minutes = Number.parseInt(match[1] ?? "", 10);
      // pmset never reports a negative timer, but a malformed line must not
      // become a negative "never sleeps" claim.
      return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Windows — `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`
// ---------------------------------------------------------------------------

/**
 * Pull the AC standby timeout out of a `powercfg /query` report.
 *
 * `Current AC Power Setting Index` is printed as a hex quantity in SECONDS, so
 * `0x00000708` is 30 minutes and `0x00000000` means never. The query is scoped
 * to the sleep subgroup, but the parser still refuses any report that does not
 * name STANDBYIDLE — an unscoped query prints a dozen `Current AC Power Setting
 * Index` lines (display, disk, hibernate) and taking the first one would report
 * the display timeout as the sleep timer.
 */
export function parsePowercfgQuery(raw: string | null | undefined): number | null {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/);
  let sawStandbyIdle = false;
  for (const line of lines) {
    if (/GUID Alias:\s*STANDBYIDLE/i.test(line)) {
      sawStandbyIdle = true;
      continue;
    }
    if (!sawStandbyIdle) continue;
    const match = /Current AC Power Setting Index:\s*(0x[0-9a-f]+|\d+)/i.exec(line);
    if (!match) continue;
    const token = match[1] ?? "";
    const seconds = token.toLowerCase().startsWith("0x")
      ? Number.parseInt(token.slice(2), 16)
      : Number.parseInt(token, 10);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    // Seconds → whole minutes. A 30-second timer is still "sleeps on you", so
    // round up rather than down; only a literal 0 means never.
    return seconds === 0 ? 0 : Math.max(1, Math.round(seconds / 60));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read + fix
// ---------------------------------------------------------------------------

export async function readSystemSleepConfig(
  deps: SystemSleepDeps = {},
): Promise<SystemSleepConfig | null> {
  const platform = deps.platform ?? process.platform;
  const run = deps.execFileText ?? execSystemText;

  if (platform === "darwin") {
    const result = await run("/usr/bin/pmset", ["-g", "custom"], PMSET_TIMEOUT_MS);
    if (!result.ok) return null;
    const minutes = parsePmsetCustom(result.stdout);
    if (minutes === null) return null;
    // `pmset -c sleep 0` writes to the system power settings, which is root-only.
    return { sleepMinutesOnAc: minutes, fixable: true, fixNeedsPassword: true };
  }

  if (platform === "win32") {
    let powercfg: string;
    try {
      powercfg = resolveTrustedWindowsTool("powercfg");
    } catch {
      return null;
    }
    const result = await run(
      powercfg,
      ["/query", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE"],
      POWERCFG_TIMEOUT_MS,
    );
    if (!result.ok) return null;
    const minutes = parsePowercfgQuery(result.stdout);
    if (minutes === null) return null;
    // `powercfg /change` edits the signed-in user's active scheme, so it needs
    // no elevation.
    return { sleepMinutesOnAc: minutes, fixable: true, fixNeedsPassword: false };
  }

  return null;
}

/**
 * Set the wall-power sleep timer to never.
 *
 * macOS routes through `osascript ... with administrator privileges` because
 * `pmset -c` is root-only; the user sees the standard system authorization
 * dialog. The pmset command embedded there is a fixed literal — nothing
 * user-supplied is ever interpolated into it.
 */
export async function disableSystemSleepOnAc(
  deps: SystemSleepDeps = {},
): Promise<{ ok: boolean; error: string | null }> {
  const platform = deps.platform ?? process.platform;
  const run = deps.execFileText ?? execSystemText;

  if (platform === "darwin") {
    const result = await run(
      "/usr/bin/osascript",
      [
        "-e",
        'do shell script "/usr/bin/pmset -c sleep 0" with administrator privileges',
      ],
      // Waits on a human at a password dialog.
      120_000,
    );
    if (result.ok) return { ok: true, error: null };
    return {
      ok: false,
      error: /User canceled|-128/i.test(result.stderr)
        ? "You cancelled the password prompt."
        : "macOS wouldn't change the sleep setting.",
    };
  }

  if (platform === "win32") {
    let powercfg: string;
    try {
      powercfg = resolveTrustedWindowsTool("powercfg");
    } catch {
      return { ok: false, error: "Windows wouldn't change the sleep setting." };
    }
    const result = await run(
      powercfg,
      ["/change", "standby-timeout-ac", "0"],
      POWERCFG_TIMEOUT_MS,
    );
    return result.ok
      ? { ok: true, error: null }
      : { ok: false, error: "Windows wouldn't change the sleep setting." };
  }

  return { ok: false, error: "ADE can't change this on this system." };
}
