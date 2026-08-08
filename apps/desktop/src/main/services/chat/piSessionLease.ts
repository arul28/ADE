import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
// The cross-process lease test loads this source file directly with Node's
// strip-types loader, which requires the explicit source extension.
// @ts-expect-error TS5097: the bundler resolves the sibling TypeScript module.
import { pathsEqual } from "../shared/pathCompare.ts";

export type PiSessionLeaseOwner = "sdk" | "cli";

type LeaseRecord = {
  version: 1 | 2;
  token: string;
  owner: PiSessionLeaseOwner;
  ownerId: string;
  pid: number;
  processStartedAt?: string;
  acquiredAt: string;
  sessionFile: string;
};

type ProcessIdentityLiveCheck = (pid: number, startedAt: string) => boolean;

export type PiSessionLease = {
  sessionFile: string;
  lockPath: string;
  token: string;
  owner: PiSessionLeaseOwner;
  release: () => void;
};

const localLeases = new Map<string, PiSessionLease>();

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return nonEmpty(env.USERPROFILE) ?? nonEmpty(env.HOME) ?? os.homedir();
}

/** Resolve the native Pi session tree used by both CLI and discovery paths. */
export function piSessionDirectoryForEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  fallbackDir?: string | null,
): string {
  const explicit = nonEmpty(env.PI_CODING_AGENT_SESSION_DIR);
  if (explicit && path.isAbsolute(explicit)) return path.resolve(explicit);
  if (fallbackDir && path.isAbsolute(fallbackDir)) return path.resolve(fallbackDir);
  const agentDir = nonEmpty(env.PI_CODING_AGENT_DIR) ?? path.join(homeDir(env), ".pi", "agent");
  return path.join(path.resolve(agentDir), "sessions");
}

function samePath(left: string, right: string): boolean {
  return pathsEqual(path.resolve(left), path.resolve(right));
}

function pathWithinDirectory(filePath: string, directoryPath: string): boolean {
  const relative = path.relative(directoryPath, filePath);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export type PiSessionHeader = {
  id: string;
  /** Normalized, non-empty native Pi working directory from the header. */
  cwd: string;
};

export function normalizePiSessionCwd(value: unknown): string | null {
  const clean = nonEmpty(value);
  return clean ? path.resolve(clean) : null;
}

/** Read a native Pi header. A session without a cwd is invalid for ADE use. */
export function readPiSessionHeader(filePath: string): PiSessionHeader | null {
  try {
    const line = fs.readFileSync(filePath, "utf8").split(/\r?\n/u, 1)[0] ?? "";
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const id = nonEmpty(parsed.id);
    const cwd = normalizePiSessionCwd(parsed.cwd);
    return parsed.type === "session" && id && cwd ? { id, cwd } : null;
  } catch {
    return null;
  }
}

export function piSessionHeaderMatchesCwd(
  header: Pick<PiSessionHeader, "cwd"> | null | undefined,
  requestedCwd: unknown,
): boolean {
  const expected = normalizePiSessionCwd(requestedCwd);
  return Boolean(header?.cwd && expected && samePath(header.cwd, expected));
}

function canonicalSessionFile(filePath: string): string | null {
  try {
    return fs.realpathSync(path.resolve(filePath));
  } catch {
    return null;
  }
}

export type PiSessionFile = {
  filePath: string;
  id: string;
};

/**
 * Snapshot every valid native Pi session under a configured root.
 *
 * This deliberately reads the header instead of trusting timestamp-prefixed
 * filenames, refuses symlinks, and requires an exact requested cwd. Callers
 * use it before an implicit/fork launch to distinguish a newly-created JSONL
 * from a recent session that was already present.
 */
export function listPiSessionFilesForCwd(args: {
  cwd: string;
  sessionDir?: string | null;
  env?: NodeJS.ProcessEnv;
}): PiSessionFile[] {
  const requestedCwd = normalizePiSessionCwd(args.cwd);
  if (!requestedCwd) return [];
  const root = nonEmpty(args.sessionDir) ?? piSessionDirectoryForEnvironment(args.env ?? process.env);
  const pendingDirectories = [path.resolve(root)];
  const files: PiSessionFile[] = [];
  const seenFiles = new Set<string>();

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (!directory) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pendingDirectories.push(candidate);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const resolved = canonicalSessionFile(candidate);
      if (!resolved || seenFiles.has(resolved)) continue;
      const header = readPiSessionHeader(resolved);
      if (!header || !piSessionHeaderMatchesCwd(header, requestedCwd)) continue;
      seenFiles.add(resolved);
      files.push({ filePath: resolved, id: header.id });
    }
  }
  return files;
}

/** Resolve a native Pi JSONL file without importing Pi. */
export function resolvePiSessionFile(args: {
  cwd: string;
  sessionId: string;
  sessionFile?: string | null;
  sessionDir?: string | null;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const targetId = args.sessionId.trim();
  const explicit = nonEmpty(args.sessionFile);
  if (!targetId && !explicit) return null;
  if (explicit) {
    // Use the filesystem's canonical spelling so macOS aliases such as
    // /var -> /private/var cannot produce two sidecars for one JSONL file.
    const resolved = canonicalSessionFile(explicit);
    if (!resolved) return null;
    const requestedSessionDir = nonEmpty(args.sessionDir);
    if (requestedSessionDir) {
      let canonicalSessionDir: string;
      try {
        canonicalSessionDir = fs.realpathSync(path.resolve(requestedSessionDir));
      } catch {
        return null;
      }
      if (!pathWithinDirectory(resolved, canonicalSessionDir)) return null;
    }
    const header = readPiSessionHeader(resolved);
    if (header && (!targetId || header.id === targetId) && piSessionHeaderMatchesCwd(header, args.cwd)) return resolved;
    return null;
  }
  if (!targetId) return null;
  return listPiSessionFilesForCwd({
    cwd: args.cwd,
    ...(args.sessionDir ? { sessionDir: args.sessionDir } : {}),
    ...(args.env ? { env: args.env } : {}),
  }).find((session) => session.id === targetId)?.filePath ?? null;
}

function lockPathFor(sessionFile: string): string {
  return `${sessionFile}.ade-lease`;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function leaseOwnerIsLive(record: LeaseRecord, isProcessIdentityLive?: ProcessIdentityLiveCheck): boolean {
  if (!processIsAlive(record.pid)) return false;
  const startedAt = nonEmpty(record.processStartedAt);
  // Version-one sidecars predate process identity tracking. Keep their
  // conservative PID-only behavior so an older ADE process can still block a
  // newer runtime rather than risk two writers opening the same JSONL file.
  return !startedAt || !isProcessIdentityLive || isProcessIdentityLive(record.pid, startedAt);
}

function readLease(lockPath: string): LeaseRecord | null {
  try {
    return parseLease(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function parseLease(contents: string): LeaseRecord | null {
  try {
    const parsed = JSON.parse(contents) as Partial<LeaseRecord>;
    if ((parsed.version !== 1 && parsed.version !== 2)
      || !nonEmpty(parsed.token)
      || (parsed.owner !== "sdk" && parsed.owner !== "cli")
      || !nonEmpty(parsed.sessionFile)
      || (parsed.processStartedAt !== undefined && parsed.processStartedAt !== null && !nonEmpty(parsed.processStartedAt))) return null;
    return parsed as LeaseRecord;
  } catch {
    return null;
  }
}

function writeLease(lockPath: string, record: LeaseRecord): boolean {
  const stagingPath = `${lockPath}.new-${randomUUID()}`;
  try {
    // Write the full JSON before publishing it. A direct wx write exposes a
    // partially written sidecar to another process, which could mistake it for
    // a stale lease and reclaim a live writer. A same-directory hard link is
    // create-only and therefore gives us an atomic no-clobber publication on
    // the filesystems ADE supports (APFS, ext4, and NTFS).
    fs.writeFileSync(stagingPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.linkSync(stagingPath, lockPath);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(stagingPath); } catch { /* the link owns the content */ }
  }
}

function restoreClaimedLease(lockPath: string, claimedPath: string, record: LeaseRecord | null): void {
  if (!record) {
    try { fs.unlinkSync(claimedPath); } catch { /* best effort */ }
    return;
  }
  // Never rename over a lock that another writer acquired while this process
  // temporarily claimed the old sidecar. If the path is occupied, keep the
  // claim as a visible blocker until its owner releases it; deleting it here
  // would let a third writer acquire the main path while the claimed owner is
  // still writing without an adjacent sidecar.
  if (!fs.existsSync(lockPath)) {
    if (writeLease(lockPath, record)) {
      try { fs.unlinkSync(claimedPath); } catch { /* best effort */ }
    }
    return;
  }
}

function liveReclaimClaim(lockPath: string, isProcessIdentityLive?: ProcessIdentityLiveCheck): LeaseRecord | null {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.reclaim-`;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const claimPath = path.join(directory, entry.name);
    const record = readLease(claimPath);
    if (!record) {
      try { fs.unlinkSync(claimPath); } catch { /* best effort */ }
      continue;
    }
    if (leaseOwnerIsLive(record, isProcessIdentityLive)) return record;
    try { fs.unlinkSync(claimPath); } catch { /* best effort */ }
  }
  return null;
}

/**
 * Atomically move the current sidecar out of the contested path. Once the
 * move succeeds, another process may create a replacement lock, but it can no
 * longer be removed by this reclaim attempt. This closes the stale-sidecar
 * race where two processes both observed a dead PID and one unlinked the
 * other's newly acquired lease.
 */
function reclaimStaleLease(
  lockPath: string,
  observed: LeaseRecord | null,
  isProcessIdentityLive?: ProcessIdentityLiveCheck,
): boolean {
  const claimedPath = `${lockPath}.reclaim-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, claimedPath);
  } catch {
    return false;
  }

  const claimed = readLease(claimedPath);
  const replacedSinceObservation = Boolean(observed && (!claimed || claimed.token !== observed.token));
  if (replacedSinceObservation || (claimed && leaseOwnerIsLive(claimed, isProcessIdentityLive))) {
    restoreClaimedLease(lockPath, claimedPath, claimed);
    return false;
  }
  try { fs.unlinkSync(claimedPath); } catch { /* best effort */ }
  return true;
}

function releaseLease(lockPath: string, token: string): void {
  const claimedPath = `${lockPath}.release-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, claimedPath);
  } catch {
    return;
  }
  const claimed = readLease(claimedPath);
  if (claimed?.token === token) {
    try { fs.unlinkSync(claimedPath); } catch { /* best effort */ }
  } else {
    restoreClaimedLease(lockPath, claimedPath, claimed);
  }

  // A stale-sidecar contender may have temporarily moved this owner's lock
  // into a reclaim claim. Remove only claims bearing our token; never touch a
  // replacement owner or an unrelated contender.
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.reclaim-`;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const claimPath = path.join(directory, entry.name);
      if (readLease(claimPath)?.token === token) {
        try { fs.unlinkSync(claimPath); } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }
}

/**
 * Reserve one native Pi session for either the ADE SDK or a tracked CLI.
 * The sidecar is intentionally adjacent to Pi's JSONL file so independent ADE
 * runtimes and the desktop's PTY service converge on the same lock without
 * sharing secrets or requiring Pi changes.
 */
export function acquirePiSessionLease(args: {
  sessionFile: string;
  owner: PiSessionLeaseOwner;
  ownerId: string;
  processStartedAt?: string | null;
  isProcessIdentityLive?: ProcessIdentityLiveCheck;
}): PiSessionLease {
  const sessionFile = path.resolve(args.sessionFile);
  const lockPath = lockPathFor(sessionFile);
  if (localLeases.has(lockPath)) {
    throw new Error(`Pi session is already owned by another ${args.owner === "sdk" ? "ADE chat" : "CLI"} writer.`);
  }
  const record: LeaseRecord = {
    version: 2,
    token: randomUUID(),
    owner: args.owner,
    ownerId: args.ownerId.trim() || randomUUID(),
    pid: process.pid,
    ...(nonEmpty(args.processStartedAt) ? { processStartedAt: nonEmpty(args.processStartedAt) ?? undefined } : {}),
    acquiredAt: new Date().toISOString(),
    sessionFile,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reclaimClaim = liveReclaimClaim(lockPath, args.isProcessIdentityLive);
    if (reclaimClaim) {
      throw new Error(`Pi session is already being reclaimed by ${reclaimClaim.owner === "sdk" ? "ADE chat" : "Pi CLI"}. Stop that writer or fork the session before continuing.`);
    }
    if (writeLease(lockPath, record)) break;
    const current = readLease(lockPath);
    if (current && leaseOwnerIsLive(current, args.isProcessIdentityLive)) {
      throw new Error(`Pi session is already owned by ${current.owner === "sdk" ? "ADE chat" : "Pi CLI"}. Stop that writer or fork the session before continuing.`);
    }
    if (reclaimStaleLease(lockPath, current, args.isProcessIdentityLive)) {
      if (writeLease(lockPath, record)) break;
    }
    if (attempt === 2) throw new Error("Pi session ownership could not be acquired safely.");
  }

  const lease: PiSessionLease = {
    sessionFile,
    lockPath,
    token: record.token,
    owner: args.owner,
    release: () => {
      releaseLease(lockPath, record.token);
      localLeases.delete(lockPath);
    },
  };
  localLeases.set(lockPath, lease);
  return lease;
}

export function piSessionLeasePath(sessionFile: string): string {
  return lockPathFor(path.resolve(sessionFile));
}

/** Synthetic target used to serialize ADE-created sessions before Pi writes its first JSONL file. */
export function piSessionCreationLeaseTarget(sessionDir: string): string {
  return path.join(path.resolve(sessionDir), ".ade-session-create");
}
