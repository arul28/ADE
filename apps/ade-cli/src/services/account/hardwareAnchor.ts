import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
 * THREE RULES GOVERN EVERYTHING BELOW.
 *
 * 1. The raw identifier NEVER leaves this process. What goes on the wire is
 *    `sha256("ade-machine-anchor-v2:" + userId + ":" + rawUuid + ":" + adeHome)`,
 *    salted with the account id, so the same computer signed into two accounts
 *    produces two unrelated values and no server-side join can correlate them.
 *    A raw platform UUID is a stable, cross-application device fingerprint; a
 *    per-account hash of one is not.
 * 2. An anchor identifies an ADE INSTALL, not a chassis. The platform UUID is
 *    shared by every ADE on the box — Stable in `~/.ade`, Beta in `~/.ade-beta`,
 *    a second OS user's `~/.ade` — and hashing it alone made all of them one
 *    machine that took turns superseding each other's directory row. Folding in
 *    the ADE home path separates them while preserving the north star: a wipe
 *    and reinstall lands on the SAME path, so it still reproduces the same
 *    anchor, which is the entire reason this file exists.
 * 3. It is OPTIONAL end to end. VMs with no platform UUID, hardened Linux
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
 * orphans every anchor already stored.
 *
 * `-v2` adds the ADE home path to the recipe. NO MIGRATION IS SHIPPED and none
 * is needed: a v1-hashed row simply stops matching anything this client sends,
 * so it dedups on `device_id` exactly as a pre-anchor client's row always did,
 * and ages out with the device or by the owner removing it. The cost of a
 * stale, unmatched anchor column is nil; the cost of two installs claiming one
 * row is the bug this bump fixes.
 */
export const HARDWARE_ANCHOR_DOMAIN = "ade-machine-anchor-v2";

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
 * Run the probe once with explicit dependencies, bypassing the cache.
 *
 * This is the test and diagnostics seam. It exists so `readHardwareAnchorUuid`
 * does not have to guess whether it is being called by a test — the previous
 * `Object.keys(deps).length === 0` check made "cached or not" a property of how
 * the caller happened to spell the argument, which is exactly the kind of
 * implicit mode a cache should never have.
 */
export function probeHardwareAnchorUuid(deps: HardwareAnchorDeps = {}): string | null {
  try {
    return probeAnchorUuid(deps);
  } catch {
    // The no-throw guarantee is the module's contract, not a property of the
    // individual probes: this sits on the account-publish path, and an anchor
    // this host cannot produce must never be the reason a machine stops
    // publishing. A throw is simply "no anchor".
    return null;
  }
}

/**
 * The raw per-machine identifier, or null when this host has none to give.
 *
 * Always cached, including the null. Product code wants `readAccountHardwareId`,
 * which is the only form allowed to leave the process.
 */
export function readHardwareAnchorUuid(): string | null {
  if (cachedAnchorUuid) return cachedAnchorUuid.value;
  const value = probeHardwareAnchorUuid();
  cachedAnchorUuid = { value };
  return value;
}

/**
 * The ADE home path as it goes into the hash.
 *
 * Resolved so `~/.ade`, `~/.ade/`, and a relative `ADE_HOME` all agree, and
 * lowercased on Windows because NTFS is case-insensitive: `C:\Users\Ada\.ade`
 * and `c:\users\ada\.ade` are one directory and must not be two machines.
 * Case is preserved everywhere else, where two spellings really are two paths.
 */
export function canonicalAdeHomePath(
  adeHomePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(adeHomePath);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * The wire value: this ADE install's anchor as seen by ONE account.
 *
 * Salting with the account id is what makes the field safe to send. The
 * directory can compare two registrations from the same user and see the same
 * install; it cannot compare two users and learn they share a computer, because
 * the two hashes have no relationship it can compute.
 */
export function hardwareAnchorId(
  userId: string,
  rawUuid: string,
  adeHomePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return createHash("sha256")
    .update(
      `${HARDWARE_ANCHOR_DOMAIN}:${userId}:${rawUuid}:${canonicalAdeHomePath(adeHomePath, platform)}`,
    )
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
 *
 * `adeHomePath` is the install this publisher speaks for. The caller already
 * knows it (it is the parent of the secrets directory every other credential
 * comes out of), so it is passed rather than re-derived from the environment —
 * a brain launched with a different `ADE_HOME` than the one it is serving would
 * otherwise anchor as the wrong install.
 */
export function readAccountHardwareId(
  userId: string | null | undefined,
  adeHomePath: string,
  /** Test seam: supply the raw identifier instead of probing (and caching) it. */
  readUuid: () => string | null = readHardwareAnchorUuid,
): string | null {
  const account = userId?.trim();
  if (!account) return null;
  const rawUuid = readUuid();
  return rawUuid ? hardwareAnchorId(account, rawUuid, adeHomePath) : null;
}
