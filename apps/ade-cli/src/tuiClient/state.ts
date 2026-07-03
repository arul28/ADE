import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AdeCodeDraftKind = "chat" | "cli";

export type AdeCodeState = {
  lastChatByLane: Record<string, string>;
  lastChatByProjectLane: Record<string, Record<string, string>>;
  lastLaneId: string | null;
  lastLaneByProject: Record<string, string>;
  draftKind: AdeCodeDraftKind;
  draftKindByProject: Record<string, AdeCodeDraftKind>;
};

const STATE_DIR = path.join(os.homedir(), ".ade");
const STATE_FILE = "ade-code-state.json";
const STATE_LOCK_FILE = `${STATE_FILE}.lock`;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_RETRY_MS = 25;

let stateWriteQueue: Promise<void> = Promise.resolve();

export function loadAdeCodeState(): AdeCodeState {
  try {
    const raw = fs.readFileSync(getStatePath(), "utf8");
    return normalizeAdeCodeState(JSON.parse(raw));
  } catch {
    return emptyAdeCodeState();
  }
}

export function saveAdeCodeState(state: AdeCodeState): void {
  void saveAdeCodeStateAsync(state);
}

export function saveAdeCodeStateAsync(state: AdeCodeState): Promise<void> {
  return enqueueStateWrite(() => withStateLock(async () => {
    await writeAdeCodeStateUnlocked(state);
  }));
}

async function writeAdeCodeStateUnlocked(state: AdeCodeState): Promise<void> {
  try {
    const { dir, path: statePath } = getStatePaths();
    await fs.promises.mkdir(dir, { recursive: true });
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await fs.promises.rename(tempPath, statePath);
  } catch {
    // best-effort persistence; ignore
  }
}

async function readAdeCodeStateUnlocked(): Promise<AdeCodeState> {
  try {
    const raw = await fs.promises.readFile(getStatePath(), "utf8");
    return normalizeAdeCodeState(JSON.parse(raw));
  } catch {
    return emptyAdeCodeState();
  }
}

export function scopedAdeCodeState(
  state: AdeCodeState,
  projectRoot: string,
): Pick<AdeCodeState, "lastChatByLane" | "lastLaneId" | "draftKind"> {
  const projectKey = normalizeProjectKey(projectRoot);
  return {
    lastChatByLane: state.lastChatByProjectLane[projectKey] ?? state.lastChatByLane,
    lastLaneId: state.lastLaneByProject[projectKey] ?? state.lastLaneId,
    draftKind: state.draftKindByProject[projectKey] ?? state.draftKind,
  };
}

export function saveAdeCodeProjectState(
  projectRoot: string,
  projectState: Pick<AdeCodeState, "lastChatByLane" | "lastLaneId" | "draftKind">,
): void {
  void saveAdeCodeProjectStateAsync(projectRoot, projectState);
}

export function saveAdeCodeProjectStateAsync(
  projectRoot: string,
  projectState: Pick<AdeCodeState, "lastChatByLane" | "lastLaneId" | "draftKind">,
): Promise<void> {
  return enqueueStateWrite(() => withStateLock(async () => {
    const current = await readAdeCodeStateUnlocked();
    const projectKey = normalizeProjectKey(projectRoot);
    current.lastChatByProjectLane[projectKey] = { ...projectState.lastChatByLane };
    if (projectState.lastLaneId) {
      current.lastLaneByProject[projectKey] = projectState.lastLaneId;
    } else {
      delete current.lastLaneByProject[projectKey];
    }
    current.draftKindByProject[projectKey] = projectState.draftKind;
    current.lastChatByLane = { ...projectState.lastChatByLane };
    current.lastLaneId = projectState.lastLaneId;
    current.draftKind = projectState.draftKind;
    await writeAdeCodeStateUnlocked(current);
  }));
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
    draftKind: normalizeDraftKind(parsed.draftKind),
    draftKindByProject: normalizeDraftKindRecord(parsed.draftKindByProject),
  };
}

function emptyAdeCodeState(): AdeCodeState {
  return {
    lastChatByLane: {},
    lastChatByProjectLane: {},
    lastLaneId: null,
    lastLaneByProject: {},
    draftKind: "chat",
    draftKindByProject: {},
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

function enqueueStateWrite(write: () => Promise<void>): Promise<void> {
  const run = stateWriteQueue.then(write, write);
  stateWriteQueue = run.catch(() => undefined);
  return run;
}

async function withStateLock(write: () => Promise<void>): Promise<void> {
  const { dir, lockPath } = getStatePaths();
  let handle: fs.promises.FileHandle | null = null;
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    while (handle === null) {
      try {
        handle = await fs.promises.open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        await removeStaleStateLock(lockPath);
        if (Date.now() >= deadline) return;
        await delay(STATE_LOCK_RETRY_MS);
      }
    }
    await write();
  } catch {
    // best-effort persistence; ignore
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
      try {
        await fs.promises.unlink(lockPath);
      } catch {
        // ignore
      }
    }
  }
}

async function removeStaleStateLock(lockPath: string): Promise<void> {
  try {
    const stat = await fs.promises.stat(lockPath);
    if (Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
      await fs.promises.unlink(lockPath);
    }
  } catch {
    // ignore
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function normalizeDraftKind(value: unknown): AdeCodeDraftKind {
  return value === "cli" ? "cli" : "chat";
}

function normalizeDraftKindRecord(value: unknown): Record<string, AdeCodeDraftKind> {
  const normalized: Record<string, AdeCodeDraftKind> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === "chat" || entry === "cli") {
      normalized[key] = entry;
    }
  }
  return normalized;
}
