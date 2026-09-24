import { describe, expect, it } from "vitest";
import {
  effectiveImportRules,
  importRejectionReason,
  planImport,
} from "./externalSessionPolicy";
import type {
  ExternalSessionCapabilities,
  ExternalSessionHome,
  ExternalSessionProvider,
} from "./types/externalSessions";

const FULL: ExternalSessionCapabilities = {
  resumeInPlace: true,
  resumeInDifferentCwd: false,
  fork: true,
  forkIntoDifferentCwd: true,
  importToChat: true,
};

const APPLE: ExternalSessionHome = {
  kind: "lane",
  laneId: "apple",
  laneName: "Apple Sim Preview",
  branchRef: "refs/heads/ade/apple",
  color: null,
  laneType: "worktree",
  atLaneRoot: true,
};

function session(
  provider: ExternalSessionProvider,
  overrides: Partial<{
    capabilities: ExternalSessionCapabilities;
    home: ExternalSessionHome | null;
    possiblyActive: boolean;
    messageCount: number | null;
    cwdMatchesRequestedLane: boolean | null;
  }> = {},
) {
  return {
    provider,
    capabilities: overrides.capabilities ?? FULL,
    home: overrides.home === undefined ? APPLE : overrides.home,
    possiblyActive: overrides.possiblyActive ?? false,
    messageCount: overrides.messageCount === undefined ? 12 : overrides.messageCount,
    cwdMatchesRequestedLane: overrides.cwdMatchesRequestedLane ?? null,
  };
}

describe("planImport", () => {
  it("offers Claude continue plus copy in its own lane", () => {
    const plan = planImport(session("claude"), { surface: "chat", targetLaneId: "apple" });
    expect(plan.surfaces).toEqual(["chat", "cli"]);
    expect(plan.laneLocked).toBe(false);
    expect(plan.primary).toMatchObject({ target: "chat", mode: "resume", label: "Continue" });
    expect(plan.secondary).toMatchObject({ target: "chat", mode: "fork", label: "Copy", needsModel: true });
    expect(plan.note).toBeNull();
  });

  it("turns a Claude CLI import into another lane into an explicit copy", () => {
    // The 2026-09-23 incident: the target silently became another lane and the
    // continue action vanished. The plan must name the copy and where the original stays.
    const plan = planImport(session("claude"), { surface: "cli", targetLaneId: "chat-lane" });
    expect(plan.primary).toMatchObject({ target: "cli", mode: "fork", label: "Copy here" });
    expect(plan.secondary).toBeNull();
    expect(plan.note).toBe("Original stays in Apple Sim Preview.");
  });

  it("does not continue a Claude chat from a subfolder of the lane", () => {
    const plan = planImport(
      session("claude", { home: { ...APPLE, atLaneRoot: false } }),
      { surface: "chat", targetLaneId: "apple" },
    );
    expect(plan.primary).toMatchObject({ mode: "fork", label: "Open as ADE chat" });
  });

  it("locks the lane for Cursor CLI and says why", () => {
    const cursor = session("cursor", {
      capabilities: { ...FULL, fork: false, forkIntoDifferentCwd: false, importToChat: false },
    });
    const plan = planImport(cursor, { surface: "cli", targetLaneId: "other" });
    expect(plan.laneLocked).toBe(true);
    expect(plan.targetLaneId).toBe("apple");
    expect(plan.lockReason).toBe("Cursor sessions stay in their own lane.");
    expect(plan.primary).toMatchObject({ mode: "resume", label: "Continue" });
    expect(plan.secondary).toBeNull();
  });

  it("keeps chat mode open to any lane through the replay copy", () => {
    const plan = planImport(session("grok"), { surface: "chat", targetLaneId: "other" });
    expect(plan.laneLocked).toBe(false);
    expect(plan.primary).toMatchObject({ target: "chat", mode: "fork", label: "Open as ADE chat", needsModel: true });
  });

  it("lets Codex continue anywhere", () => {
    const codex = session("codex", { capabilities: { ...FULL, resumeInDifferentCwd: true } });
    const plan = planImport(codex, { surface: "cli", targetLaneId: "other" });
    expect(plan.laneLocked).toBe(false);
    expect(plan.primary).toMatchObject({ mode: "resume" });
    expect(plan.note).toBeNull();
  });

  it("lets a session outside every lane continue from any lane in its own folder", () => {
    const outside: ExternalSessionHome = { ...APPLE, kind: "outside", laneId: null, laneName: null, atLaneRoot: false };
    const plan = planImport(session("pi", { home: outside }), { surface: "cli", targetLaneId: "main" });
    expect(plan.laneLocked).toBe(false);
    expect(plan.primary).toMatchObject({ mode: "resume" });
    expect(plan.note).toBe("Runs in its original folder.");
  });

  it("tells an older host's CLI continue from another folder that it runs in its original folder", () => {
    const away = planImport(
      session("pi", { home: null, cwdMatchesRequestedLane: false }),
      { surface: "cli", targetLaneId: "main", originLaneId: "main" },
    );
    expect(away.primary).toMatchObject({ mode: "resume" });
    expect(away.note).toBe("Runs in its original folder.");
    const here = planImport(
      session("pi", { home: null, cwdMatchesRequestedLane: true }),
      { surface: "cli", targetLaneId: "main", originLaneId: "main" },
    );
    expect(here.note).toBeNull();
    // Unknown is not a match.
    const unknown = planImport(
      session("pi", { home: null, cwdMatchesRequestedLane: null }),
      { surface: "cli", targetLaneId: "main", originLaneId: "main" },
    );
    expect(unknown.note).toBe("Runs in its original folder.");
  });

  it("does not let an older host's folder match for the scanned lane vouch for another target lane", () => {
    const plan = planImport(
      session("pi", { home: null, cwdMatchesRequestedLane: true }),
      { surface: "cli", targetLaneId: "apple", originLaneId: "main" },
    );
    expect(plan.primary).toMatchObject({ mode: "resume" });
    expect(plan.note).toBe("Runs in its original folder.");
  });

  it("warns before continuing a live session", () => {
    const plan = planImport(session("claude", { possiblyActive: true }), { surface: "cli", targetLaneId: "apple" });
    expect(plan.note).toBe("Open elsewhere — close it there first.");
  });

  it("asks for confirmation only before continuing a live session", () => {
    const live = planImport(session("claude", { possiblyActive: true }), { surface: "chat", targetLaneId: "apple" });
    expect(live.primary).toMatchObject({ mode: "resume", confirmBeforeRun: true });
    // A copy leaves the original untouched, so it never needs the second press.
    expect(live.secondary).toMatchObject({ mode: "fork", confirmBeforeRun: false });
    const idle = planImport(session("claude"), { surface: "chat", targetLaneId: "apple" });
    expect(idle.primary).toMatchObject({ mode: "resume", confirmBeforeRun: false });
  });

  it("falls back to the first surface that has actions", () => {
    const noCli = session("kimi", {
      capabilities: { resumeInPlace: false, resumeInDifferentCwd: false, fork: false, forkIntoDifferentCwd: false, importToChat: false },
    });
    const plan = planImport(noCli, { surface: "cli", targetLaneId: "apple" });
    expect(plan.surfaces).toEqual(["chat"]);
    expect(plan.surface).toBe("chat");
  });

  it("offers only the chat copy when no CLI path is left", () => {
    const noCli = session("cursor", {
      capabilities: { resumeInPlace: false, resumeInDifferentCwd: false, fork: false, forkIntoDifferentCwd: false, importToChat: false },
    });
    const plan = planImport(noCli, { surface: "cli", targetLaneId: "apple" });
    expect(plan.surfaces).toEqual(["chat"]);
    expect(plan.primary).toMatchObject({ target: "chat", mode: "fork" });
  });
});

describe("effectiveImportRules", () => {
  it("narrows droid copy when the installed CLI has no --fork", () => {
    const rules = effectiveImportRules(session("droid", {
      capabilities: { ...FULL, fork: false, forkIntoDifferentCwd: false, importToChat: false },
    }));
    expect(rules.cliCopy).toBe("none");
    expect(rules.chatCopy).toBe("any");
  });
});

describe("importRejectionReason", () => {
  it("rejects a Cursor CLI continue outside its lane", () => {
    const cursor = session("cursor", {
      capabilities: { ...FULL, fork: false, forkIntoDifferentCwd: false, importToChat: false },
    });
    expect(importRejectionReason(cursor, { target: "cli", mode: "resume", laneId: "other" }))
      .toBe("This Cursor session can only do that in Apple Sim Preview.");
    expect(importRejectionReason(cursor, { target: "cli", mode: "fork", laneId: "apple" }))
      .toBe("This Cursor session can't be copied in a terminal.");
    expect(importRejectionReason(cursor, { target: "cli", mode: "resume", laneId: "apple" })).toBeNull();
  });
});
