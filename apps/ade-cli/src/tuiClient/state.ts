import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AdeCodeState = {
  lastChatByLane: Record<string, string>;
};

const STATE_DIR = path.join(os.homedir(), ".ade");
const STATE_PATH = path.join(STATE_DIR, "ade-code-state.json");

export function loadAdeCodeState(): AdeCodeState {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<AdeCodeState>;
    const lastChatByLane: Record<string, string> = {};
    if (parsed && typeof parsed.lastChatByLane === "object" && parsed.lastChatByLane) {
      for (const [laneId, sessionId] of Object.entries(parsed.lastChatByLane)) {
        if (typeof laneId === "string" && typeof sessionId === "string") {
          lastChatByLane[laneId] = sessionId;
        }
      }
    }
    return { lastChatByLane };
  } catch {
    return { lastChatByLane: {} };
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
