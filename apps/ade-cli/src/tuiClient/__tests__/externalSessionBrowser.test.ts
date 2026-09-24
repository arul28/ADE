import { describe, expect, it } from "vitest";
import type {
  ExternalSessionHome,
  ExternalSessionSummary,
} from "../../../../desktop/src/shared/types/externalSessions";
import {
  EXTERNAL_SESSION_PROVIDER_FILTERS,
  clampExternalSessionBrowserContent,
  externalSessionAnchors,
  externalSessionBrowserActions,
  externalSessionLaneLabel,
  externalSessionProviderLabel,
  externalSessionRowTitle,
  isImportEntry,
  nextExternalSessionProviderFilter,
  nextExternalSessionTargetLane,
  normalizeExternalSessionListResult,
  visibleExternalSessions,
  withReloadedExternalSessions,
  type ExternalSessionImportEntry,
} from "../externalSessionBrowser";
import type { RightPaneContent } from "../types";

const APPLE: ExternalSessionHome = {
  kind: "lane",
  laneId: "apple",
  laneName: "Apple Sim Preview",
  branchRef: "refs/heads/ade/apple",
  color: "#ff8800",
  laneType: "worktree",
  atLaneRoot: true,
};

function importLabels(actions: ReturnType<typeof externalSessionBrowserActions>): string[] {
  return actions.map((action) => action.label);
}

function session(overrides: Partial<ExternalSessionSummary>): ExternalSessionSummary {
  return {
    provider: "claude",
    id: "s1",
    cwd: "/repo",
    title: "Session",
    preview: null,
    createdAt: 100,
    updatedAt: 100,
    messageCount: 1,
    alreadyImported: false,
    possiblyActive: false,
    cwdMatchesRequestedLane: true,
    capabilities: {
      resumeInPlace: true,
      resumeInDifferentCwd: false,
      fork: true,
      forkIntoDifferentCwd: false,
      importToChat: true,
    },
    ...overrides,
  };
}

describe("externalSessionBrowser helpers", () => {
  it("normalizes list action responses", () => {
    const row = session({ id: "one" });
    expect(normalizeExternalSessionListResult([row])).toEqual([row]);
    expect(normalizeExternalSessionListResult({ sessions: [row] })).toEqual([row]);
    expect(normalizeExternalSessionListResult(null)).toEqual([]);
  });

  it("filters by provider and typed query, then sorts newest first", () => {
    const older = session({ id: "older", provider: "claude", title: "Budget notes", updatedAt: 10 });
    const newest = session({ id: "newest", provider: "claude", title: "Release plan", updatedAt: 50 });
    const otherProvider = session({ id: "cursor", provider: "cursor", title: "Release plan", updatedAt: 100 });

    expect(visibleExternalSessions([older, newest, otherProvider], "claude", "plan").map((row) => row.id))
      .toEqual(["newest"]);
    expect(visibleExternalSessions([older, newest, otherProvider], "all", "release").map((row) => row.id))
      .toEqual(["cursor", "newest"]);
  });

  it("searches the sampled conversation, not just the title", () => {
    const rows = [
      session({ id: "titled", title: "Release plan", updatedAt: 50 }),
      session({
        id: "sampled",
        title: null,
        preview: "look at the checkout flow",
        updatedAt: 40,
        messages: [
          { role: "user", text: "look at the checkout flow", at: 1 },
          { role: "assistant", text: "The regression is in the coupon validator.", at: 2 },
        ],
      }),
    ];

    expect(visibleExternalSessions(rows, "all", "coupon").map((row) => row.id)).toEqual(["sampled"]);
    // Rows without a message sample still match on the legacy fields only.
    expect(visibleExternalSessions(rows, "all", "release").map((row) => row.id)).toEqual(["titled"]);
  });

  it("names titleless rows by their opening prompt and never repeats it as an anchor", () => {
    const titleless = session({
      title: null,
      preview: "look at\n  the checkout flow",
      messages: [
        { role: "user", text: "look at the checkout flow", at: 1 },
        { role: "assistant", text: "Found it:\nthe coupon validator", at: 2 },
      ],
    });

    expect(externalSessionRowTitle(titleless)).toBe("look at the checkout flow");
    expect(externalSessionAnchors(titleless)).toEqual({
      started: null,
      latest: "Found it: the coupon validator",
    });

    const titled = session({ title: "Checkout", preview: "look at the checkout flow" });
    // Older hosts send no `messages`; the opening prompt is then the only anchor.
    expect(externalSessionAnchors(titled)).toEqual({
      started: "look at the checkout flow",
      latest: null,
    });

    const singleTurn = session({
      title: "Checkout",
      preview: "look at the checkout flow",
      messages: [{ role: "user", text: "look at the checkout flow", at: 1 }],
    });
    expect(externalSessionAnchors(singleTurn)).toEqual({
      started: "look at the checkout flow",
      latest: null,
    });
  });

  it("clamps selection and action indexes after filter changes", () => {
    const content: Extract<RightPaneContent, { kind: "external-session-browser" }> = {
      kind: "external-session-browser",
      laneId: "apple",
      laneLabel: "Apple Sim Preview",
      providerFilter: "claude",
      query: "release",
      sessions: [
        session({ id: "one", title: "Release plan", home: APPLE }),
        session({ id: "two", title: "Other" }),
      ],
      loading: false,
      selectedIndex: 9,
      actionIndex: 99,
    };

    // Claude in its own root lane: chat Continue + Copy, CLI Continue + Copy.
    expect(clampExternalSessionBrowserContent(content)).toMatchObject({
      selectedIndex: 0,
      actionIndex: 3,
    });
  });

  it("drops the row's lane and action picks when a reload puts another session at that index", () => {
    const older = session({ id: "older", title: "Older", updatedAt: 10, home: APPLE });
    const content: Extract<RightPaneContent, { kind: "external-session-browser" }> = {
      kind: "external-session-browser",
      laneId: "apple",
      laneLabel: "Apple Sim Preview",
      providerFilter: "all",
      query: "",
      sessions: [older],
      loading: false,
      selectedIndex: 0,
      actionIndex: 2,
      targetLaneId: "other",
      targetLaneLabel: "Other lane",
      confirmKey: "claude:older:cli:resume",
    };

    // Same row still at the index: the picks stay.
    expect(withReloadedExternalSessions(content, [{ ...older, messageCount: 5 }])).toMatchObject({
      selectedIndex: 0,
      actionIndex: 2,
      targetLaneId: "other",
      confirmKey: "claude:older:cli:resume",
    });

    // A newer session now sorts first: Enter must not import it into the lane
    // picked for the old row.
    const newer = session({ id: "newer", title: "Newer", updatedAt: 50, home: APPLE });
    expect(withReloadedExternalSessions(content, [older, newer])).toMatchObject({
      selectedIndex: 0,
      actionIndex: 0,
      targetLaneId: null,
      targetLaneLabel: null,
      confirmKey: null,
    });
  });

  it("lists one entry per plan action and defaults the target to the home lane", () => {
    const row = session({ home: APPLE });
    const actions = externalSessionBrowserActions(row, { fallbackLaneId: "other" });
    expect(importLabels(actions)).toEqual([
      "ADE chat · Continue",
      "ADE chat · Copy",
      "CLI · Continue",
      "CLI · Copy",
    ]);
    const entries = actions.filter(isImportEntry);
    expect(entries.every((entry) => entry.laneId === "apple")).toBe(true);
    expect(entries.map((entry) => `${entry.action.target}:${entry.action.mode}`)).toEqual([
      "chat:resume",
      "chat:fork",
      "cli:resume",
      "cli:fork",
    ]);
  });

  it("turns a CLI import into another lane into a named copy", () => {
    const row = session({
      home: APPLE,
      capabilities: {
        resumeInPlace: true,
        resumeInDifferentCwd: false,
        fork: true,
        forkIntoDifferentCwd: true,
        importToChat: true,
      },
    });
    const actions = externalSessionBrowserActions(row, { fallbackLaneId: "apple", targetLaneId: "other" });
    const cli = actions.filter(isImportEntry).filter((entry) => entry.surface === "cli");
    expect(cli).toHaveLength(1);
    expect(cli[0]).toMatchObject({
      label: "CLI · Copy here",
      laneId: "other",
      laneLocked: false,
      note: "Original stays in Apple Sim Preview.",
    });
  });

  it("pins a locked surface to the home lane and carries the lock reason", () => {
    const cursor = session({
      provider: "cursor",
      home: APPLE,
      capabilities: {
        resumeInPlace: true,
        resumeInDifferentCwd: false,
        fork: false,
        forkIntoDifferentCwd: false,
        importToChat: false,
      },
    });
    const entries = externalSessionBrowserActions(cursor, { fallbackLaneId: "apple", targetLaneId: "other" })
      .filter(isImportEntry);
    const chat = entries.find((entry) => entry.surface === "chat");
    const cli = entries.find((entry) => entry.surface === "cli");
    expect(chat).toMatchObject({ label: "ADE chat · Open as ADE chat", laneId: "other", laneLocked: false });
    expect(cli).toMatchObject({
      label: "CLI · Continue",
      laneId: "apple",
      laneLocked: true,
      lockReason: "Cursor sessions stay in their own lane.",
    });
  });

  it("asks for a second Enter before continuing a live session", () => {
    const live = session({ home: APPLE, possiblyActive: true });
    const entries = externalSessionBrowserActions(live, { fallbackLaneId: "apple" }).filter(isImportEntry);
    const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry])) as Record<string, ExternalSessionImportEntry>;
    expect(byKey["cli:resume"]).toMatchObject({
      action: { confirmBeforeRun: true },
      note: "Open elsewhere — close it there first.",
    });
    expect(byKey["cli:fork"]).toMatchObject({ action: { confirmBeforeRun: false }, note: null });
  });

  it("makes Open existing the default and keeps only copies for imported sessions", () => {
    const imported = session({
      home: APPLE,
      alreadyImported: true,
      importedSessionRef: { kind: "chat", sessionId: "ade-chat-1" },
    });

    const actions = externalSessionBrowserActions(imported, { fallbackLaneId: "apple" });
    expect(importLabels(actions)).toEqual([
      "Open existing ADE session",
      "ADE chat · Copy",
      "CLI · Copy",
    ]);
    expect(clampExternalSessionBrowserContent({
      kind: "external-session-browser",
      laneId: "apple",
      laneLabel: "Apple Sim Preview",
      providerFilter: "all",
      query: "",
      sessions: [imported],
      loading: false,
      selectedIndex: 0,
      actionIndex: 99,
    })).toMatchObject({ actionIndex: 2 });
  });

  it("labels rows by lane, not folder", () => {
    expect(externalSessionLaneLabel(session({ home: APPLE, cwd: "/repo/.ade/worktrees/apple-sim" })))
      .toBe("Apple Sim Preview");
    expect(externalSessionLaneLabel(session({
      home: { ...APPLE, kind: "removed-lane", laneId: null, laneName: null },
      cwd: "/repo/.ade/worktrees/gone",
    }))).toBe("Removed lane");
    expect(externalSessionLaneLabel(session({
      home: { ...APPLE, kind: "outside", laneId: null, laneName: null, atLaneRoot: false },
      cwd: "/Users/me/dev/scratch/tool",
    }))).toBe("…/scratch/tool");
  });

  it("finds rows by lane name", () => {
    const rows = [session({ id: "a", title: "One", home: APPLE }), session({ id: "b", title: "Two" })];
    expect(visibleExternalSessions(rows, "all", "apple sim").map((row) => row.id)).toEqual(["a"]);
  });

  it("cycles through every provider, including the ACP ones", () => {
    expect(EXTERNAL_SESSION_PROVIDER_FILTERS).toEqual([
      "all", "claude", "codex", "cursor", "droid", "opencode", "pi", "qwen", "kimi", "grok", "copilot",
    ]);
    expect(nextExternalSessionProviderFilter("pi")).toBe("qwen");
    expect(nextExternalSessionProviderFilter("copilot")).toBe("all");
    expect(externalSessionProviderLabel("copilot")).toBe("Copilot");
  });

  it("cycles target lanes and wraps", () => {
    expect(nextExternalSessionTargetLane(["a", "b", "c"], "a")).toBe("b");
    expect(nextExternalSessionTargetLane(["a", "b", "c"], "c")).toBe("a");
    expect(nextExternalSessionTargetLane(["a", "b"], "gone")).toBe("a");
    expect(nextExternalSessionTargetLane([], "a")).toBeNull();
  });
});
