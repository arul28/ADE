import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AdeCodeState = {
  lastChatByLane: Record<string, string>;
  lastChatByProjectLane: Record<string, Record<string, string>>;
  lastLaneId: string | null;
  lastLaneByProject: Record<string, string>;
};

const STATE_DIR = path.join(os.homedir(), ".ade");
const STATE_FILE = "ade-code-state.json";
const STATE_LOCK_FILE = `${STATE_FILE}.lock`;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_RETRY_MS = 25;

export function loadAdeCodeState(): AdeCodeState {
  try {
    const raw = fs.readFileSync(getStatePath(), "utf8");
    return normalizeAdeCodeState(JSON.parse(raw));
  } catch {
    return emptyAdeCodeState();
  }
}

export function saveAdeCodeState(state: AdeCodeState): void {
  withStateLock(() => writeAdeCodeStateUnlocked(state));
}

function writeAdeCodeStateUnlocked(state: AdeCodeState): void {
  try {
    const { dir, path: statePath } = getStatePaths();
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tempPath, statePath);
  } catch {
    // best-effort persistence; ignore
  }
}

export function scopedAdeCodeState(
  state: AdeCodeState,
  projectRoot: string,
): Pick<AdeCodeState, "lastChatByLane" | "lastLaneId"> {
  const projectKey = normalizeProjectKey(projectRoot);
  return {
    lastChatByLane: state.lastChatByProjectLane[projectKey] ?? state.lastChatByLane,
    lastLaneId: state.lastLaneByProject[projectKey] ?? state.lastLaneId,
  };
}

export function saveAdeCodeProjectState(
  projectRoot: string,
  projectState: Pick<AdeCodeState, "lastChatByLane" | "lastLaneId">,
): void {
  withStateLock(() => {
    const current = loadAdeCodeState();
    const projectKey = normalizeProjectKey(projectRoot);
    current.lastChatByProjectLane[projectKey] = { ...projectState.lastChatByLane };
    if (projectState.lastLaneId) {
      current.lastLaneByProject[projectKey] = projectState.lastLaneId;
    } else {
      delete current.lastLaneByProject[projectKey];
    }
    current.lastChatByLane = { ...projectState.lastChatByLane };
    current.lastLaneId = projectState.lastLaneId;
    writeAdeCodeStateUnlocked(current);
  });
}

export function normalizeAdeCodeState(value: unknown): AdeCodeState {
  const parsed = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<AdeCodeState>
    : {};
  return {
    lastChatByLane: normalizeStringRecord(parsed.lastChatByLane),
    lastChatByProjectLane: normalizeNestedStringRecord(parsed.lastChatByProjectLane),
    lastLaneId: typeof parsed.lastLaneId === "string" ? parsed.lastLaneId : null,
    lastLaneByProject: normalizeStringRecord(parsed.lastLaneByProject),
  };
}

function emptyAdeCodeState(): AdeCodeState {
  return {
    lastChatByLane: {},
    lastChatByProjectLane: {},
    lastLaneId: null,
    lastLaneByProject: {},
  };
}

function normalizeProjectKey(projectRoot: string): string {
  return path.resolve(projectRoot);
}

function getStatePaths(): { dir: string; path: string; lockPath: string } {
  const dir = process.env.ADE_CODE_STATE_DIR || STATE_DIR;
  return {
    dir,
    path: path.join(dir, STATE_FILE),
    lockPath: path.join(dir, STATE_LOCK_FILE),
  };
}

function getStatePath(): string {
  return getStatePaths().path;
}

function withStateLock(write: () => void): void {
  const { dir, lockPath } = getStatePaths();
  let fd: number | null = null;
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  try {
    fs.mkdirSync(dir, { recursive: true });
    while (fd === null) {
      try {
        fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        removeStaleStateLock(lockPath);
        if (Date.now() >= deadline) return;
        sleepSync(STATE_LOCK_RETRY_MS);
      }
    }
    write();
  } catch {
    // best-effort persistence; ignore
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
  }
}

function removeStaleStateLock(lockPath: string): void {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === "string" && typeof entry === "string") {
      normalized[key] = entry;
    }
  }
  return normalized;
}

function normalizeNestedStringRecord(value: unknown): Record<string, Record<string, string>> {
  const normalized: Record<string, Record<string, string>> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
  for (const [key, entry] of Object.entries(value)) {
    const child = normalizeStringRecord(entry);
    if (Object.keys(child).length > 0) normalized[key] = child;
  }
  return normalized;
}
