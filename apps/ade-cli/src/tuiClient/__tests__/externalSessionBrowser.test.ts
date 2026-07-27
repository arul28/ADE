import { describe, expect, it } from "vitest";
import type { ExternalSessionSummary } from "../../../../desktop/src/shared/types/externalSessions";
import {
  clampExternalSessionBrowserContent,
  externalSessionAnchors,
  externalSessionBrowserActions,
  externalSessionRowTitle,
  normalizeExternalSessionListResult,
  visibleExternalSessions,
} from "../externalSessionBrowser";
import type { RightPaneContent } from "../types";

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
      laneId: "lane-1",
      laneLabel: "Lane",
      providerFilter: "claude",
      query: "release",
      sessions: [
        session({ id: "one", title: "Release plan" }),
        session({ id: "two", title: "Other" }),
      ],
      loading: false,
      selectedIndex: 9,
      actionIndex: 99,
    };

    expect(clampExternalSessionBrowserContent(content)).toMatchObject({
      selectedIndex: 0,
      actionIndex: 3,
    });
  });

  it("keeps copy actions and resume-in-original without cross-folder chat continuation", () => {
    const content: Extract<RightPaneContent, { kind: "external-session-browser" }> = {
      kind: "external-session-browser",
      laneId: "lane-1",
      laneLabel: "Lane",
      providerFilter: "claude",
      query: "",
      sessions: [
        session({
          id: "foreign",
          cwd: "/repo/other",
          cwdMatchesRequestedLane: false,
          capabilities: {
            resumeInPlace: true,
            resumeInDifferentCwd: false,
            fork: true,
            forkIntoDifferentCwd: true,
            importToChat: true,
          },
        }),
      ],
      loading: false,
      selectedIndex: 0,
      actionIndex: 99,
    };

    expect(clampExternalSessionBrowserContent(content)).toMatchObject({
      selectedIndex: 0,
      actionIndex: 2,
    });
  });

  it("makes Open existing the default and suppresses Continue for imported sessions", () => {
    const imported = session({
      alreadyImported: true,
      importedSessionRef: { kind: "chat", sessionId: "ade-chat-1" },
    });

    const actions = externalSessionBrowserActions(imported);
    expect(actions.map((action) => action.kind)).toEqual([
      "open-existing",
      "fork-as-chat",
      "fork-into-lane",
    ]);
    expect(clampExternalSessionBrowserContent({
      kind: "external-session-browser",
      laneId: "lane-1",
      laneLabel: "Lane",
      providerFilter: "all",
      query: "",
      sessions: [imported],
      loading: false,
      selectedIndex: 0,
      actionIndex: 99,
    })).toMatchObject({ actionIndex: 2 });
  });
});
