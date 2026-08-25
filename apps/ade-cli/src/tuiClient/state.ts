import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AdeCodeDraftKind = "chat" | "cli";

/**
 * Provider-scoped chat settings remembered per project. New chats and the
 * /model wizard's settings step pre-fill from the last time that provider was
 * used *in this project*, so switching provider restores the permission /
 * effort / fast / interface combination the user last chose for it instead of
 * resetting to registry defaults.
 *
 * Every field is a plain string/boolean (never a union imported from the chat
 * types) so a value written by a newer build round-trips through an older one
 * unchanged, and normalization never has to drop an unknown mode.
 */
export type AdeCodeProviderSettingsMemory = {
  reasoningEffort: string | null;
  fastMode: boolean;
  interfaceMode: AdeCodeDraftKind;
  permissionMode: string;
  interactionMode: string;
  claudePermissionMode: string;
  codexApprovalPolicy: string;
  codexSandbox: string;
  codexConfigSource: string;
  opencodePermissionMode: string;
  droidPermissionMode: string;
  cursorModeId: string | null;
};

/** Last model + settings actually used for a chat in a project. */
export type AdeCodeModelMemory = AdeCodeProviderSettingsMemory & {
  provider: string;
  modelId: string | null;
  model: string;
  displayName: string;
};

export type AdeCodeState = {
  lastChatByLane: Record<string, string>;
  lastChatByProjectLane: Record<string, Record<string, string>>;
  lastLaneId: string | null;
  lastLaneByProject: Record<string, string>;
  draftKind: AdeCodeDraftKind;
  draftKindByProject: Record<string, AdeCodeDraftKind>;
  /** projectRoot → last model + settings used to start a chat. */
  lastModelByProject: Record<string, AdeCodeModelMemory>;
  /** projectRoot → provider → last settings used for that provider. */
  providerSettingsByProject: Record<string, Record<string, AdeCodeProviderSettingsMemory>>;
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

/** Last model + settings used to start a chat in this project (null when none). */
export function scopedAdeCodeModelMemory(
  state: AdeCodeState,
  projectRoot: string,
): AdeCodeModelMemory | null {
  // Defensive: callers (and test doubles) can hand us a state object written by
  // an older build that predates these maps.
  return state.lastModelByProject?.[normalizeProjectKey(projectRoot)] ?? null;
}

/** Last settings used for one provider in this project (null when none). */
export function scopedAdeCodeProviderSettings(
  state: AdeCodeState,
  projectRoot: string,
  provider: string,
): AdeCodeProviderSettingsMemory | null {
  return state.providerSettingsByProject?.[normalizeProjectKey(projectRoot)]?.[provider] ?? null;
}

/**
 * Record the model + settings a chat was started (or retargeted) with. Writes
 * both the project's "last model" and the per-provider settings slot, under the
 * same cross-process lock the lane/chat memory uses.
 */
export function saveAdeCodeModelMemory(projectRoot: string, memory: AdeCodeModelMemory): void {
  void saveAdeCodeModelMemoryAsync(projectRoot, memory);
}

export function saveAdeCodeModelMemoryAsync(
  projectRoot: string,
  memory: AdeCodeModelMemory,
): Promise<void> {
  return enqueueStateWrite(() => withStateLock(async () => {
    const current = await readAdeCodeStateUnlocked();
    const projectKey = normalizeProjectKey(projectRoot);
    const normalized = normalizeModelMemory(memory);
    if (!normalized) return;
    current.lastModelByProject[projectKey] = normalized;
    const byProvider = current.providerSettingsByProject[projectKey] ?? {};
    byProvider[normalized.provider] = providerSettingsFromModelMemory(normalized);
    current.providerSettingsByProject[projectKey] = byProvider;
    await writeAdeCodeStateUnlocked(current);
  }));
}

export function providerSettingsFromModelMemory(
  memory: AdeCodeModelMemory | AdeCodeProviderSettingsMemory,
): AdeCodeProviderSettingsMemory {
  return {
    reasoningEffort: memory.reasoningEffort,
    fastMode: memory.fastMode,
    interfaceMode: memory.interfaceMode,
    permissionMode: memory.permissionMode,
    interactionMode: memory.interactionMode,
    claudePermissionMode: memory.claudePermissionMode,
    codexApprovalPolicy: memory.codexApprovalPolicy,
    codexSandbox: memory.codexSandbox,
    codexConfigSource: memory.codexConfigSource,
    opencodePermissionMode: memory.opencodePermissionMode,
    droidPermissionMode: memory.droidPermissionMode,
    cursorModeId: memory.cursorModeId,
  };
}

export function flushAdeCodeStateWrites(): Promise<void> {
  return stateWriteQueue;
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
    lastModelByProject: normalizeModelMemoryRecord(parsed.lastModelByProject),
    providerSettingsByProject: normalizeProviderSettingsRecord(parsed.providerSettingsByProject),
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
    lastModelByProject: {},
    providerSettingsByProject: {},
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

function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeProviderSettings(value: unknown): AdeCodeProviderSettingsMemory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Partial<AdeCodeProviderSettingsMemory>;
  return {
    reasoningEffort: nullableString(parsed.reasoningEffort),
    fastMode: parsed.fastMode === true,
    interfaceMode: normalizeDraftKind(parsed.interfaceMode),
    permissionMode: optionalString(parsed.permissionMode, "default"),
    interactionMode: optionalString(parsed.interactionMode, "default"),
    claudePermissionMode: optionalString(parsed.claudePermissionMode, "default"),
    codexApprovalPolicy: optionalString(parsed.codexApprovalPolicy, "on-request"),
    codexSandbox: optionalString(parsed.codexSandbox, "workspace-write"),
    codexConfigSource: optionalString(parsed.codexConfigSource, "flags"),
    opencodePermissionMode: optionalString(parsed.opencodePermissionMode, "edit"),
    droidPermissionMode: optionalString(parsed.droidPermissionMode, "auto-low"),
    cursorModeId: nullableString(parsed.cursorModeId),
  };
}

function normalizeModelMemory(value: unknown): AdeCodeModelMemory | null {
  const settings = normalizeProviderSettings(value);
  if (!settings) return null;
  const parsed = value as Partial<AdeCodeModelMemory>;
  const provider = typeof parsed.provider === "string" ? parsed.provider.trim() : "";
  if (!provider) return null;
  return {
    ...settings,
    provider,
    modelId: nullableString(parsed.modelId),
    model: optionalString(parsed.model, ""),
    displayName: optionalString(parsed.displayName, ""),
  };
}

function normalizeModelMemoryRecord(value: unknown): Record<string, AdeCodeModelMemory> {
  const normalized: Record<string, AdeCodeModelMemory> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
  for (const [key, entry] of Object.entries(value)) {
    const memory = normalizeModelMemory(entry);
    if (memory) normalized[key] = memory;
  }
  return normalized;
}

function normalizeProviderSettingsRecord(
  value: unknown,
): Record<string, Record<string, AdeCodeProviderSettingsMemory>> {
  const normalized: Record<string, Record<string, AdeCodeProviderSettingsMemory>> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
  for (const [projectKey, providers] of Object.entries(value)) {
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue;
    const child: Record<string, AdeCodeProviderSettingsMemory> = {};
    for (const [provider, settings] of Object.entries(providers)) {
      const parsed = normalizeProviderSettings(settings);
      if (parsed) child[provider] = parsed;
    }
    if (Object.keys(child).length > 0) normalized[projectKey] = child;
  }
  return normalized;
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
