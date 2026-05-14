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
const STATE_PATH = path.join(STATE_DIR, "ade-code-state.json");

export function loadAdeCodeState(): AdeCodeState {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    return normalizeAdeCodeState(JSON.parse(raw));
  } catch {
    return emptyAdeCodeState();
  }
}

export function saveAdeCodeState(state: AdeCodeState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
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
  saveAdeCodeState(current);
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
