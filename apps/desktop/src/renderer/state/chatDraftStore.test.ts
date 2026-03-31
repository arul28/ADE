import { beforeEach, describe, expect, it } from "vitest";
import { useChatDraftStore, type ComposerDraftSnapshot } from "./chatDraftStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useChatDraftStore.setState({ snapshots: {}, draftsPerSession: {} });
}

function makeSnapshot(overrides: Partial<ComposerDraftSnapshot> = {}): ComposerDraftSnapshot {
  return {
    draft: "hello world",
    modelId: "openai/gpt-5.4-codex",
    reasoningEffort: "high",
    executionMode: "focused",
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "untrusted",
    codexSandbox: "read-only",
    codexConfigSource: "flags",
    unifiedPermissionMode: "plan",
    computerUsePolicy: { mode: "auto", allowLocalFallback: false, retainArtifacts: false, preferredBackend: null },
    attachments: [],
    includeProjectDocs: false,
    sendOnEnter: true,
    ...overrides,
  };
}

describe("chatDraftStore", () => {
  beforeEach(() => {
    resetStore();
  });

  // ─────────────────────────────────────────────────────────────
  // saveSnapshot + getSnapshot
  // ─────────────────────────────────────────────────────────────

  describe("saveSnapshot / getSnapshot", () => {
    it("round-trips a snapshot with a string sessionId", () => {
      const snap = makeSnapshot({ draft: "draft-a" });
      useChatDraftStore.getState().saveSnapshot("lane-1", "session-1", snap);
      const result = useChatDraftStore.getState().getSnapshot("lane-1", "session-1");
      expect(result).toEqual(snap);
    });

    it("round-trips a snapshot with a null sessionId (new chat)", () => {
      const snap = makeSnapshot({ draft: "new chat draft" });
      useChatDraftStore.getState().saveSnapshot("lane-1", null, snap);
      const result = useChatDraftStore.getState().getSnapshot("lane-1", null);
      expect(result).toEqual(snap);
    });

    it("returns undefined for a missing key", () => {
      const result = useChatDraftStore.getState().getSnapshot("lane-404", "session-404");
      expect(result).toBeUndefined();
    });

    it("distinguishes null sessionId from string sessionId", () => {
      const snapNew = makeSnapshot({ draft: "new" });
      const snapExisting = makeSnapshot({ draft: "existing" });
      useChatDraftStore.getState().saveSnapshot("lane-1", null, snapNew);
      useChatDraftStore.getState().saveSnapshot("lane-1", "session-1", snapExisting);

      expect(useChatDraftStore.getState().getSnapshot("lane-1", null)?.draft).toBe("new");
      expect(useChatDraftStore.getState().getSnapshot("lane-1", "session-1")?.draft).toBe("existing");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // clearSnapshot
  // ─────────────────────────────────────────────────────────────

  describe("clearSnapshot", () => {
    it("removes an existing snapshot", () => {
      const snap = makeSnapshot();
      useChatDraftStore.getState().saveSnapshot("lane-1", "session-1", snap);
      expect(useChatDraftStore.getState().getSnapshot("lane-1", "session-1")).toBeDefined();

      useChatDraftStore.getState().clearSnapshot("lane-1", "session-1");
      expect(useChatDraftStore.getState().getSnapshot("lane-1", "session-1")).toBeUndefined();
    });

    it("does not throw when clearing a non-existent key", () => {
      expect(() => {
        useChatDraftStore.getState().clearSnapshot("lane-404", "session-404");
      }).not.toThrow();
    });

    it("does not affect other snapshots when clearing one", () => {
      const snap1 = makeSnapshot({ draft: "one" });
      const snap2 = makeSnapshot({ draft: "two" });
      useChatDraftStore.getState().saveSnapshot("lane-1", "session-1", snap1);
      useChatDraftStore.getState().saveSnapshot("lane-1", "session-2", snap2);

      useChatDraftStore.getState().clearSnapshot("lane-1", "session-1");
      expect(useChatDraftStore.getState().getSnapshot("lane-1", "session-1")).toBeUndefined();
      expect(useChatDraftStore.getState().getSnapshot("lane-1", "session-2")).toEqual(snap2);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // saveDraftsMap / getDraftsMap
  // ─────────────────────────────────────────────────────────────

  describe("saveDraftsMap / getDraftsMap", () => {
    it("round-trips a map with null key and string keys", () => {
      const map = new Map<string | null, string>([
        [null, "new chat draft"],
        ["session-1", "draft for session 1"],
        ["session-2", "draft for session 2"],
      ]);
      useChatDraftStore.getState().saveDraftsMap("lane-1", map);
      const result = useChatDraftStore.getState().getDraftsMap("lane-1");

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(3);
      expect(result.get(null)).toBe("new chat draft");
      expect(result.get("session-1")).toBe("draft for session 1");
      expect(result.get("session-2")).toBe("draft for session 2");
    });

    it("returns an empty Map for an unknown laneId", () => {
      const result = useChatDraftStore.getState().getDraftsMap("lane-unknown");
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("overwrites a previous drafts map for the same lane", () => {
      const map1 = new Map<string | null, string>([[null, "old"]]);
      const map2 = new Map<string | null, string>([[null, "new"]]);
      useChatDraftStore.getState().saveDraftsMap("lane-1", map1);
      useChatDraftStore.getState().saveDraftsMap("lane-1", map2);

      const result = useChatDraftStore.getState().getDraftsMap("lane-1");
      expect(result.get(null)).toBe("new");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Cross-lane isolation
  // ─────────────────────────────────────────────────────────────

  describe("cross-lane isolation", () => {
    it("snapshots from different lanes do not interfere", () => {
      const snapA = makeSnapshot({ draft: "lane-A draft" });
      const snapB = makeSnapshot({ draft: "lane-B draft" });
      useChatDraftStore.getState().saveSnapshot("lane-A", "session-1", snapA);
      useChatDraftStore.getState().saveSnapshot("lane-B", "session-1", snapB);

      expect(useChatDraftStore.getState().getSnapshot("lane-A", "session-1")?.draft).toBe("lane-A draft");
      expect(useChatDraftStore.getState().getSnapshot("lane-B", "session-1")?.draft).toBe("lane-B draft");
    });

    it("drafts maps from different lanes do not interfere", () => {
      const mapA = new Map<string | null, string>([[null, "A new"]]);
      const mapB = new Map<string | null, string>([[null, "B new"]]);
      useChatDraftStore.getState().saveDraftsMap("lane-A", mapA);
      useChatDraftStore.getState().saveDraftsMap("lane-B", mapB);

      expect(useChatDraftStore.getState().getDraftsMap("lane-A").get(null)).toBe("A new");
      expect(useChatDraftStore.getState().getDraftsMap("lane-B").get(null)).toBe("B new");
    });

    it("clearing a snapshot in one lane does not affect another lane", () => {
      const snap = makeSnapshot({ draft: "keep me" });
      useChatDraftStore.getState().saveSnapshot("lane-A", "session-1", snap);
      useChatDraftStore.getState().saveSnapshot("lane-B", "session-1", makeSnapshot());

      useChatDraftStore.getState().clearSnapshot("lane-B", "session-1");
      expect(useChatDraftStore.getState().getSnapshot("lane-A", "session-1")?.draft).toBe("keep me");
    });
  });
});
