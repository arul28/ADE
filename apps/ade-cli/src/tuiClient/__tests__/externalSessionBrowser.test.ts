import { describe, expect, it } from "vitest";
import type { ExternalSessionSummary } from "../../../../desktop/src/shared/types/externalSessions";
import {
  clampExternalSessionBrowserContent,
  externalSessionBrowserActions,
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
