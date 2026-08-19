import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";

/**
 * The one piece of machine identity a reinstall cannot destroy.
 *
 * Both halves of ADE's machine identity live under `~/.ade/secrets` — the
 * machine key in `sync-cloud-relay.json`, the device id in `sync-device-id` —
 * so a user who deletes `~/.ade` and signs in again mints BOTH afresh. The
 * directory's device-supersede dedup then has nothing to match on, and the
 * account keeps a phantom row for a computer the user only owns once. That is
 * the whole remaining gap in "reinstall + sign in again heals everything".
 *
 * The operating system already knows this machine's name and will still know it
 * after the wipe: `IOPlatformUUID` on macOS, `MachineGuid` on Windows,
 * `/etc/machine-id` on Linux. Anchoring on that closes the gap without asking
 * the user for anything.
 *
 * TWO RULES GOVERN EVERYTHING BELOW.
 *
 * 1. The raw identifier NEVER leaves this process. What goes on the wire is
 *    `sha256("ade-machine-anchor-v1:" + userId + ":" + rawUuid)`, salted with
 *    the account id, so the same computer signed into two accounts produces two
 *    unrelated values and no server-side join can correlate them. A raw
 *    platform UUID is a stable, cross-application device fingerprint; a
 *    per-account hash of one is not.
 * 2. It is OPTIONAL end to end. VMs with no platform UUID, hardened Linux
 *    images with no machine-id, a sandbox that refuses to spawn `ioreg` — all
 *    of them return null and every caller carries on with exactly the behavior
 *    it had before this existed. An anchor is an improvement to dedup, never a
 *    precondition for registering a machine.
 */

/**
 * Domain separator baked into every hash.
 *
 * Versioned because the recipe is a wire contract with the directory: rows
 * carry the hash, so changing the salt, the separator, or the digest silently
 * orphans every anchor already stored. A future recipe gets a `-v2` and lands
 * as a deliberate migration, not as an edit to this string.
 */
export const HARDWARE_ANCHOR_DOMAIN = "ade-machine-anchor-v1";

/**
 * Where Linux keeps its stable machine identifier, in preference order.
 *
 * `/etc/machine-id` is the systemd location and the one that survives an ADE
 * reinstall; the dbus path is the older fallback that some images still ship as
 * the only populated file. A distro with neither simply has no anchor.
 */
export const LINUX_MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const;

/**
 * Hard bound on the identity probe.
 *
 * The probe runs on the account-publish path, and a `reg` or `ioreg` call that
 * hangs must cost the heartbeat a couple of seconds once, not block it. A
 * timeout is indistinguishable from "no anchor here" and is treated as such.
 */
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Overridable for tests, which feed captured command output instead of running commands. */
export type HardwareAnchorDeps = {
  platform?: NodeJS.Platform;
  /** Returns the command's stdout, or null for any failure at all. */
  runCommand?: (command: string, args: readonly string[]) => string | null;
  /** Returns the file's contents, or null when it does not exist or cannot be read. */
  readFile?: (filePath: string) => string | null;
};

/**
 * Process-lifetime cache, including the negative answer.
 *
 * The publisher asks for this on every 30-second heartbeat, and the answer
 * cannot change while the process runs — the identifier is a property of the
 * hardware and the OS install. Caching the null too is deliberate: a machine
 * with no anchor must not respawn `ioreg` twice a minute forever to keep
 * learning the same thing.
 */
let cachedAnchorUuid: { value: string | null } | null = null;

/** Test seam only. Nothing in the product invalidates this cache. */
export function resetHardwareAnchorCacheForTests(): void {
  cachedAnchorUuid = null;
}

/**
 * Accept only something that actually looks like a machine identifier.
 *
 * The three sources disagree on shape — a dashed UUID on macOS and Windows, 32
 * bare hex characters on Linux — so the check is a charset and length bound
 * rather than a UUID grammar. What it really exists to reject is the two ways
 * these lookups "succeed" while telling us nothing: an empty value, and the
 * all-zero sentinel that firmware and unprovisioned images report in place of
 * an identifier. An all-zero anchor would be shared by every such machine on
 * the account and would supersede rows that belong to different computers.
 */
export function normalizeHardwareAnchorUuid(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim().replace(/^\{/, "").replace(/\}$/, "").trim().toLowerCase();
  if (!/^[0-9a-f-]{16,64}$/.test(trimmed)) return null;
  const hex = trimmed.replace(/-/g, "");
  if (hex.length < 16 || /^0+$/.test(hex)) return null;
  return trimmed;
}

/**
 * Pull `IOPlatformUUID` out of `ioreg -rd1 -c IOPlatformExpertDevice`.
 *
 * The property sits in a plist-ish dump of one node, one `"key" = "value"` pair
 * per line, so a single quoted-value match is the whole parse. Written against
 * the text and not the surrounding format on purpose: the block's indentation
 * and neighbouring keys differ between Intel and Apple silicon, and the pair
 * itself does not.
 */
export function parseIoregPlatformUuid(output: string): string | null {
  const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]*)"/);
  return match ? normalizeHardwareAnchorUuid(match[1]) : null;
}

/**
 * Pull `MachineGuid` out of `reg query ... /v MachineGuid`.
 *
 * `reg` answers with a blank line, the key path, then one indented
 * `<name>  <type>  <value>` line per value. Neither the value name nor the type
 * is localized, so matching on both is safe on any Windows UI language, and
 * anchoring the name means a future `/s` query that returns sibling values
 * cannot be misread. The value is taken as the rest of the line rather than a
 * token, because splitting on whitespace would truncate anything unexpected
 * into a plausible-looking prefix instead of rejecting it.
 */
export function parseWindowsMachineGuid(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*MachineGuid\s+REG_[A-Z_]+\s+(\S.*)$/);
    if (match) return normalizeHardwareAnchorUuid(match[1]);
  }
  return null;
}

function runProbe(command: string, args: readonly string[]): string | null {
  try {
    // Argument array, never a shell string: nothing here is user input today,
    // and the way that stops being true is someone interpolating a path into a
    // command line that a shell then re-parses.
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: PROBE_MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return null;
    return typeof result.stdout === "string" ? result.stdout : null;
  } catch {
    return null;
  }
}

function readProbeFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function probeAnchorUuid(deps: HardwareAnchorDeps): string | null {
  const platform = deps.platform ?? process.platform;
  const runCommand = deps.runCommand ?? runProbe;
  const readFile = deps.readFile ?? readProbeFile;

  if (platform === "darwin") {
    const output = runCommand("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    return output ? parseIoregPlatformUuid(output) : null;
  }
  if (platform === "win32") {
    let reg: string;
    try {
      // The GLOBALROOT-resolved reg.exe, not a bare "reg": PATH and cwd are
      // caller-controlled in a CLI launch, and a planted reg.exe would get to
      // choose this machine's identity.
      reg = resolveTrustedWindowsTool("reg");
    } catch {
      return null;
    }
    const output = runCommand(reg, [
      "query",
      String.raw`HKLM\SOFTWARE\Microsoft\Cryptography`,
      "/v",
      "MachineGuid",
    ]);
    return output ? parseWindowsMachineGuid(output) : null;
  }
  for (const filePath of LINUX_MACHINE_ID_PATHS) {
    const normalized = normalizeHardwareAnchorUuid(readFile(filePath));
    if (normalized) return normalized;
  }
  return null;
}

/**
 * The raw per-machine identifier, or null when this host has none to give.
 *
 * Exported for tests and diagnostics of the parsers; product code wants
 * `readAccountHardwareId`, which is the only form allowed to leave the process.
 */
export function readHardwareAnchorUuid(deps: HardwareAnchorDeps = {}): string | null {
  const useCache = Object.keys(deps).length === 0;
  if (useCache && cachedAnchorUuid) return cachedAnchorUuid.value;
  let value: string | null;
  try {
    value = probeAnchorUuid(deps);
  } catch {
    // The no-throw guarantee is the module's contract, not a property of the
    // individual probes: this sits on the account-publish path, and an anchor
    // this host cannot produce must never be the reason a machine stops
    // publishing. A throw is simply "no anchor", cached like any other.
    value = null;
  }
  if (useCache) cachedAnchorUuid = { value };
  return value;
}

/**
 * The wire value: this machine's anchor as seen by ONE account.
 *
 * Salting with the account id is what makes the field safe to send. The
 * directory can compare two registrations from the same user and see the same
 * machine; it cannot compare two users and learn they share a computer, because
 * the two hashes have no relationship it can compute.
 */
export function hardwareAnchorId(userId: string, rawUuid: string): string {
  return createHash("sha256")
    .update(`${HARDWARE_ANCHOR_DOMAIN}:${userId}:${rawUuid}`)
    .digest("hex");
}

/**
 * What the publisher sends, or null to send nothing.
 *
 * Null on two paths that are equally ordinary: no account id (the env-token
 * publisher never has one) and no obtainable anchor. Neither is an error and
 * neither is logged — the caller simply omits the field, and the directory
 * falls back to matching on device id exactly as it does for every client that
 * predates this.
 */
export function readAccountHardwareId(
  userId: string | null | undefined,
  deps: HardwareAnchorDeps = {},
): string | null {
  const account = userId?.trim();
  if (!account) return null;
  const rawUuid = readHardwareAnchorUuid(deps);
  return rawUuid ? hardwareAnchorId(account, rawUuid) : null;
}
