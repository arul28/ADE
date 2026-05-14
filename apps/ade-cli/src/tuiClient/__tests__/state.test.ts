import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAdeCodeState, normalizeAdeCodeState, saveAdeCodeProjectState, scopedAdeCodeState } from "../state";

afterEach(() => {
  delete process.env.ADE_CODE_STATE_DIR;
});

describe("ade code persisted state", () => {
  it("prefers project-scoped lane and chat state over legacy global fallback", () => {
    const state = normalizeAdeCodeState({
      lastChatByLane: { main: "legacy-chat" },
      lastLaneId: "legacy-lane",
      lastChatByProjectLane: {
        "/repo-a": { main: "repo-a-chat" },
        "/repo-b": { main: "repo-b-chat" },
      },
      lastLaneByProject: {
        "/repo-a": "repo-a-lane",
        "/repo-b": "repo-b-lane",
      },
    });

    expect(scopedAdeCodeState(state, "/repo-b")).toEqual({
      lastChatByLane: { main: "repo-b-chat" },
      lastLaneId: "repo-b-lane",
    });
  });

  it("uses legacy state as a migration fallback for projects without scoped entries", () => {
    const state = normalizeAdeCodeState({
      lastChatByLane: { main: "legacy-chat" },
      lastLaneId: "legacy-lane",
      lastChatByProjectLane: {
        "/repo-a": { main: "repo-a-chat" },
      },
      lastLaneByProject: {
        "/repo-a": "repo-a-lane",
      },
    });

    expect(scopedAdeCodeState(state, "/repo-b")).toEqual({
      lastChatByLane: { main: "legacy-chat" },
      lastLaneId: "legacy-lane",
    });
  });

  it("ignores malformed persisted records", () => {
    const state = normalizeAdeCodeState({
      lastChatByLane: { main: "legacy-chat", bad: 1 },
      lastLaneId: 7,
      lastChatByProjectLane: {
        "/repo-a": { main: "repo-a-chat", bad: false },
        "/empty": { bad: false },
      },
      lastLaneByProject: {
        "/repo-a": "repo-a-lane",
        "/repo-b": null,
      },
    });

    expect(state).toEqual({
      lastChatByLane: { main: "legacy-chat" },
      lastChatByProjectLane: { "/repo-a": { main: "repo-a-chat" } },
      lastLaneId: null,
      lastLaneByProject: { "/repo-a": "repo-a-lane" },
    });
  });

  it("merges project-scoped saves with existing state under the shared state file", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-state-"));
    process.env.ADE_CODE_STATE_DIR = stateDir;

    saveAdeCodeProjectState("/repo-a", {
      lastChatByLane: { main: "repo-a-chat" },
      lastLaneId: "repo-a-lane",
    });
    saveAdeCodeProjectState("/repo-b", {
      lastChatByLane: { main: "repo-b-chat" },
      lastLaneId: "repo-b-lane",
    });

    const persisted = loadAdeCodeState();
    expect(persisted.lastChatByProjectLane).toEqual({
      [path.resolve("/repo-a")]: { main: "repo-a-chat" },
      [path.resolve("/repo-b")]: { main: "repo-b-chat" },
    });
    expect(persisted.lastLaneByProject).toEqual({
      [path.resolve("/repo-a")]: "repo-a-lane",
      [path.resolve("/repo-b")]: "repo-b-lane",
    });
    expect(fs.existsSync(path.join(stateDir, "ade-code-state.json.lock"))).toBe(false);
  });
});
