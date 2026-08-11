import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathsEqual } from "../shared/pathCompare";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return nonEmpty(env.USERPROFILE) ?? nonEmpty(env.HOME) ?? os.homedir();
}

export function piAgentDirectoryForEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(nonEmpty(env.PI_CODING_AGENT_DIR) ?? path.join(homeDir(env), ".pi", "agent"));
}

function expandHome(value: string, env: NodeJS.ProcessEnv): string {
  if (value === "~") return homeDir(env);
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homeDir(env), value.slice(2));
  return value;
}

/**
 * Read the session directory the user configured in Pi's own global settings.
 *
 * Deliberately only the profile-level `settings.json`. Pi's `SettingsManager`
 * also merges a checkout's `.pi/settings.json`, but that file belongs to a
 * repository ADE has not vouched for — honouring it here would let any cloned
 * repo redirect where ADE authorizes and leases Pi sessions.
 */
function configuredSessionDir(env: NodeJS.ProcessEnv): string | null {
  try {
    const raw = fs.readFileSync(path.join(piAgentDirectoryForEnvironment(env), "settings.json"), "utf8");
    const value = nonEmpty((JSON.parse(raw) as Record<string, unknown>).sessionDir);
    if (!value) return null;
    const expanded = expandHome(value, env);
    return path.isAbsolute(expanded) ? path.resolve(expanded) : null;
  } catch {
    return null;
  }
}

/**
 * A `sessionDir` set by the checkout's own `.pi/settings.json`.
 *
 * ADE never honours it — see `configuredSessionDir` — but Pi's CLI merges
 * project settings, so a tracked `pi` terminal launched in such a repository
 * writes somewhere ADE does not authorize. Detecting it lets the launch say so
 * instead of failing with a generic "could not be verified" message.
 */
export function repositoryOverridesPiSessionDir(cwd: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(path.resolve(cwd), ".pi", "settings.json"), "utf8");
    return Boolean(nonEmpty((JSON.parse(raw) as Record<string, unknown>).sessionDir));
  } catch {
    return false;
  }
}

export type PiSessionStore = {
  /** Root that every native Pi session file for this profile must live under. */
  root: string;
  /**
   * Directory Pi itself must be told to write into, or `null` when Pi should
   * use its own per-cwd default beneath the agent directory.
   *
   * Pi only nests sessions per cwd (`<agentDir>/sessions/<encoded-cwd>/`) when
   * no directory is supplied; an explicit directory is used flat and verbatim.
   * Passing `root` to Pi would therefore scatter files directly into
   * `<agentDir>/sessions`, where Pi's own subdirectory-only discovery can never
   * find them again.
   */
  storageDir: string | null;
};

/**
 * Resolve the one native Pi session store shared by ADE chat, tracked Pi CLI
 * terminals, and external-session discovery.
 *
 * Precedence mirrors Pi's own CLI (`--session-dir` > env > settings > default);
 * ADE never passes `--session-dir`, so the env variable is the top of the list.
 */
export function piSessionStoreForEnvironment(env: NodeJS.ProcessEnv = process.env): PiSessionStore {
  // Pi expands `~` in this variable, so `~/pi-sessions` is a setting a user can
  // really have. Ignoring it here would put Pi's writes and ADE's authorization
  // in different directories — exactly the split this store exists to close.
  const explicit = nonEmpty(env.PI_CODING_AGENT_SESSION_DIR);
  const expandedExplicit = explicit ? expandHome(explicit, env) : null;
  const configured = expandedExplicit && path.isAbsolute(expandedExplicit)
    ? path.resolve(expandedExplicit)
    : configuredSessionDir(env);
  if (configured) return { root: configured, storageDir: configured };
  return { root: path.join(piAgentDirectoryForEnvironment(env), "sessions"), storageDir: null };
}

/** Resolve the native Pi session tree used by both CLI and discovery paths. */
export function piSessionRootForEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return piSessionStoreForEnvironment(env).root;
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
  /** Epoch ms Pi created the session, or null when the header has no usable timestamp. */
  createdAt: number | null;
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
    const parsedAt = Date.parse(nonEmpty(parsed.timestamp) ?? "");
    const createdAt = Number.isFinite(parsedAt) ? parsedAt : null;
    return parsed.type === "session" && id && cwd ? { id, cwd, createdAt } : null;
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

/**
 * Canonical spelling of a path that exists, or `null`.
 *
 * `.native` throughout: on Windows it expands 8.3 short names and junction
 * spellings while the JS `realpathSync` preserves whatever it was given, so
 * mixing the two makes a path and its own parent directory fail a containment
 * test against each other.
 */
function canonicalSessionFile(filePath: string): string | null {
  try {
    return fs.realpathSync.native(path.resolve(filePath));
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
  sessionRoot?: string | null;
  env?: NodeJS.ProcessEnv;
}): PiSessionFile[] {
  const requestedCwd = normalizePiSessionCwd(args.cwd);
  if (!requestedCwd) return [];
  const root = nonEmpty(args.sessionRoot) ?? piSessionRootForEnvironment(args.env ?? process.env);
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
  sessionRoot?: string | null;
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
    const requestedSessionDir = nonEmpty(args.sessionRoot);
    if (requestedSessionDir) {
      let canonicalSessionDir: string;
      try {
        canonicalSessionDir = fs.realpathSync.native(path.resolve(requestedSessionDir));
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
    ...(args.sessionRoot ? { sessionRoot: args.sessionRoot } : {}),
    ...(args.env ? { env: args.env } : {}),
  }).find((session) => session.id === targetId)?.filePath ?? null;
}

/**
 * Canonicalize the deepest existing ancestor of a path that does not exist yet.
 *
 * Lexical containment alone would accept `<root>/link/new.jsonl` where `link`
 * is a symlink out of the store, so the surviving prefix is resolved and the
 * unresolved tail re-appended before the containment test runs.
 */
function canonicalPlannedFile(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  const tail: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export type PiSessionFileState =
  /** The file exists and its header matches the requested cwd and session id. */
  | "authorized"
  /** Inside the store, but Pi has not written it yet — no header to check. */
  | "pending"
  | "rejected";

export type PiSessionFileClassification =
  | { state: "rejected" }
  | { state: "authorized" | "pending"; filePath: string };

/**
 * Classify a native Pi session path that ADE is about to take ownership of.
 *
 * Pi does not create the JSONL file until the session's first assistant
 * message (`SessionManager` buffers everything before that), so a freshly
 * created session reports a concrete path that does not exist yet. That path
 * still has to be constrained to the authorized store before ADE leases it,
 * but it cannot be header-validated until Pi flushes — hence `pending`, which
 * callers resolve by re-classifying once the file appears.
 */
export function classifyPiSessionFile(args: {
  filePath: string;
  cwd: string;
  sessionId?: string | null;
  /** Required: confining the file to the store is the point of this function. */
  sessionRoot: string;
}): PiSessionFileClassification {
  const rejected = { state: "rejected" } as const;
  const requested = nonEmpty(args.filePath);
  if (!requested || !path.isAbsolute(requested)) return rejected;
  const targetId = nonEmpty(args.sessionId);
  // Canonicalized by the same walker as the candidate, so the two spellings
  // are always comparable.
  const storeRoot = canonicalPlannedFile(args.sessionRoot);
  if (!storeRoot) return rejected;

  const existing = canonicalSessionFile(requested);
  if (existing) {
    if (!pathWithinDirectory(existing, storeRoot)) return rejected;
    const header = readPiSessionHeader(existing);
    if (!header || !piSessionHeaderMatchesCwd(header, args.cwd)) return rejected;
    if (targetId && header.id !== targetId) return rejected;
    return { state: "authorized", filePath: existing };
  }

  const planned = canonicalPlannedFile(requested);
  if (!planned || !pathWithinDirectory(planned, storeRoot)) return rejected;
  return { state: "pending", filePath: planned };
}
