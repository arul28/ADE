import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdeError } from "./errors.js";

/**
 * POSIX `sun_path` is 104 bytes on macOS/BSD and 108 on Linux. A unix socket
 * path over the limit fails at `bind()` with ENAMETOOLONG, and an app that puts
 * its ADE home under a deep Application Support path hits this easily — so the
 * derivation falls back to a short hashed path in the temp dir instead of
 * handing the runtime a path it cannot bind.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 100;

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * Identity of the user this process runs as, folded into endpoint derivation.
 *
 * Two places need it, for two different reasons:
 *
 *  - the tmpdir fallback below lands in a world-writable directory (`/tmp`) on
 *    Linux, so its parent must be a per-user directory this user owns;
 *  - Windows named pipes live in one flat machine-wide namespace, and two
 *    users pointing at the same home path (a shared machine-wide profile
 *    directory, a redirected home) would otherwise derive one pipe name and
 *    collide.
 *
 * Parameterized so both branches are unit-testable from any platform.
 */
export function currentUserIdentity(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    const domain = env.USERDOMAIN?.trim() ?? "";
    const user = env.USERNAME?.trim() ?? "";
    if (user) return `${domain}\\${user}`.toLowerCase();
    return safeUserName().toLowerCase();
  }
  // The numeric uid is the identity the filesystem actually enforces, so it is
  // preferred over a display name that can repeat across directories.
  const uid = process.getuid?.();
  if (typeof uid === "number") return String(uid);
  return safeUserName();
}

function safeUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    // A container with no passwd entry. An empty identity is still a stable
    // one; the ownership check below is what actually protects the directory.
    return "";
  }
}

/**
 * Keeps a username out of the shell/filesystem edge cases of a path segment.
 *
 * Separators become dashes (so the result is always exactly one segment), and
 * leading dots go with them — a segment of `..` would be a traversal and a
 * leading dot makes a directory the user cannot see.
 */
export function sanitizeIdentitySegment(identity: string): string {
  const cleaned = identity
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  return (cleaned || "anon").slice(0, 32);
}

/**
 * Stable per-home endpoint for the SDK's sidecar runtime.
 *
 * Pure and platform-parameterized so the Windows branch is unit-testable from
 * macOS. Mirrors `resolveAdeRuntimeIpcPath` in
 * `apps/desktop/src/shared/adeRuntimeIpc.ts`: a hashed `\\.\pipe\` name on
 * Windows (named pipes are a flat kernel namespace, not a filesystem), a real
 * socket file elsewhere. The `ade-sdk-` prefix keeps an SDK sidecar from ever
 * colliding with the machine brain's own `ade-` pipe.
 *
 * The tmpdir fallback goes into a per-user subdirectory rather than straight
 * into the temp root: on Linux `/tmp` is shared and world-writable, and a
 * predictable `ade-sdk-<hash-of-home>.sock` there can be pre-created by another
 * local user, who then answers the SDK's connect. `ensurePrivateSocketDirectory`
 * creates that subdirectory 0700 and refuses one this user does not own.
 */
export function resolveRuntimeSocketPath(
  home: string,
  platform: NodeJS.Platform = process.platform,
  tempDir: string = os.tmpdir(),
  identity: string = currentUserIdentity(platform),
): string {
  const id = homeId(home, platform, identity);
  if (platform === "win32") {
    return `${WINDOWS_PIPE_PREFIX}ade-sdk-${id}`;
  }
  const preferred = path.join(path.resolve(home), "sock", "ade.sock");
  if (Buffer.byteLength(preferred, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES) {
    return preferred;
  }
  return path.join(tempDir, `ade-sdk-${sanitizeIdentitySegment(identity)}`, `${id}.sock`);
}

/**
 * Creates the directory a unix socket will be bound in, 0700, and refuses to
 * hand it back if it is not this user's.
 *
 * The refusal matters only for the shared-tmpdir case, but is applied to every
 * POSIX socket directory: an attacker who can pre-create the directory can
 * pre-create the socket inside it, and the sidecar would then "connect to the
 * runtime" and hand its RPC session to a stranger. A mode that grants group or
 * other access is tightened rather than rejected — we own it, so we can fix it.
 */
export async function ensurePrivateSocketDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform === "win32") return;
  const uid = process.getuid?.();
  if (typeof uid !== "number") return;
  const stat = await fs.promises.lstat(directory);
  if (stat.uid !== uid) {
    throw new AdeError(
      "connect_failed",
      `The socket directory ${directory} is owned by uid ${stat.uid}, not by this user (uid ${uid}). ` +
        `Refusing to bind an ADE runtime socket in a directory somebody else controls.`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    await fs.promises.chmod(directory, 0o700);
  }
}

/** True for a Windows named-pipe endpoint, in either slash spelling. */
export function isNamedPipePath(value: string): boolean {
  const normalized = value.replace(/\//g, "\\").toLowerCase();
  return normalized.startsWith("\\\\.\\pipe\\");
}

/**
 * Windows named pipe names are case-insensitive, and `\\.\pipe\` and
 * `//./pipe/` name the same object. Collapse both onto one comparison key so
 * two spellings of one endpoint are never treated as two runtimes.
 */
export function endpointComparisonKey(value: string): string {
  if (!isNamedPipePath(value)) return path.resolve(value);
  return value.replace(/\//g, "\\").toLowerCase();
}

function homeId(home: string, platform: NodeJS.Platform, identity: string): string {
  // Windows paths are compared case-insensitively by the filesystem, so the
  // hash input is lowercased there and left alone on case-sensitive platforms.
  const resolved =
    platform === "win32"
      ? path.win32.resolve(home).replace(/\//g, "\\").toLowerCase()
      : path.resolve(home);
  // The identity is folded in on Windows ONLY. Named pipes are machine-wide, so
  // two users must never derive one name. POSIX sockets are already separated
  // by the per-user directory above, and adding the uid there would change
  // every existing endpoint name for no security gain.
  const input = platform === "win32" ? `${resolved}\n${identity.toLowerCase()}` : resolved;
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}
