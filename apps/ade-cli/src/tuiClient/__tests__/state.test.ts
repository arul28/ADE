import { describe, expect, it } from "vitest";
import { normalizeAdeCodeState, scopedAdeCodeState } from "../state";

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
});
