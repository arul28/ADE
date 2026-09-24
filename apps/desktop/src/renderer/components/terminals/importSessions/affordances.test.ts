import { describe, expect, it } from "vitest";
import { shortenCwd } from "./affordances";
import { shortenExternalSessionCwd, formatExternalSessionSize } from "../../../../shared/externalSessionAffordances";
import { sessionAnchors, sessionHeading } from "./sessionPresentation";
import type { ExternalSessionCapabilities, ExternalSessionSummary } from "./contract";
import type { AgentChatEventEnvelope } from "../../../../shared/types/chat";
import {
  laneFilterKey,
  matchesSearch,
  OTHER_FOLDERS_ID,
  sessionPlace,
  spliceNewestPage,
} from "./importBrowserModel";

const NO_CAPS: ExternalSessionCapabilities = {
  resumeInPlace: false,
  resumeInDifferentCwd: false,
  fork: false,
  forkIntoDifferentCwd: false,
  importToChat: false,
};

function session(
  overrides: Partial<Omit<ExternalSessionSummary, "capabilities">> & {
    capabilities?: Partial<ExternalSessionCapabilities>;
  } = {},
): ExternalSessionSummary {
  const { capabilities, ...rest } = overrides;
  return {
    provider: "claude",
    id: "s1",
    cwd: "/Users/dev/project",
    title: "Fix login",
    preview: "…",
    createdAt: Date.parse("2026-07-01T00:00:00.000Z"),
    updatedAt: Date.parse("2026-07-01T00:00:00.000Z"),
    messageCount: 12,
    alreadyImported: false,
    possiblyActive: false,
    cwdMatchesRequestedLane: true,
    ...rest,
    capabilities: { ...NO_CAPS, ...capabilities },
  };
}


describe("shortenCwd", () => {
  it("keeps short paths intact", () => {
    expect(shortenCwd("/a/b")).toBe("/a/b");
  });

  it("truncates deep paths to a recognizable tail", () => {
    expect(shortenCwd("/Users/dev/work/repo/packages/app")).toBe("…/repo/packages/app");
  });

  it("falls back to a readable label when the path is missing", () => {
    expect(shortenCwd("")).toBe("its original folder");
    expect(shortenCwd(null)).toBe("its original folder");
  });

  /**
   * A Windows path is one segment when split on "/", so the length check
   * always passed and the full path went out untouched — to be clipped from
   * the right by CSS, which is where the identifying repo folder lives. Every
   * row read `C:\Users\arul2\Doc…`.
   */
  it("shortens Windows paths and keeps their separator", () => {
    // Outside the home directory on purpose: `abbreviateHome` reads the
    // ambient USERPROFILE, and this case is about the split, not about `~`.
    expect(shortenCwd("D:\\work\\Documents\\Programming\\ADE"))
      .toBe("…\\Documents\\Programming\\ADE");
    expect(shortenCwd("D:\\work\\Documents\\Programming\\ADE", 2))
      .toBe("…\\Programming\\ADE");
  });

  it("leaves a Windows path alone when it is already short enough", () => {
    expect(shortenCwd("D:\\dev\\ade")).toBe("D:\\dev\\ade");
  });

  it("honours an injected home abbreviation", () => {
    expect(shortenExternalSessionCwd("C:\\Users\\me\\dev\\monorepo\\apps\\desktop", {
      abbreviateHome: (value) => value.replace("C:\\Users\\me", "~"),
    })).toBe("…\\monorepo\\apps\\desktop");
    expect(shortenExternalSessionCwd("C:\\Users\\me\\dev", {
      abbreviateHome: (value) => value.replace("C:\\Users\\me", "~"),
    })).toBe("~\\dev");
  });
});

describe("sessionHeading", () => {
  /**
   * Behavior change: this used to fall back to the folder name so the prompt was
   * not printed twice. Folder + time turned out to say nothing about the thread
   * ("ADE · 9m ago"), so the heading now leads with the opening prompt and the
   * duplicate is prevented by suppression instead — `sessionAnchors` drops
   * `started` when it matches the heading, and the row hides a preview equal to
   * it. The no-duplication invariant is preserved; the heading is just useful now.
   */
  it("uses an untitled session's opening prompt as the heading", () => {
    expect(sessionHeading(session({
      title: null,
      preview: "this is a test message",
      cwd: "/Users/dev/ADE",
      updatedAt: null,
    }))).toBe("this is a test message");
  });

  it("uses a sampled user message, then a plain label, when there is no title or prompt", () => {
    // The old "<folder> · 41d ago" fallback repeated the row's lane and time.
    expect(sessionHeading(session({
      title: null,
      preview: null,
      messages: [{ role: "assistant", text: "Done." , at: null }, { role: "user", text: "fix the lane sidebar", at: null }],
    }))).toBe("fix the lane sidebar");
    expect(sessionHeading(session({
      provider: "cursor",
      title: null,
      preview: null,
      cwd: "/Users/dev/ADE",
      messages: [],
    }))).toBe("Untitled Cursor chat");
  });

  it("prefers a real provider title over the prompt", () => {
    expect(sessionHeading(session({ title: "Ship the relay fix", preview: "anything" })))
      .toBe("Ship the relay fix");
  });

  it("collapses whitespace and clips a very long opening prompt", () => {
    const heading = sessionHeading(session({ title: null, preview: `${"word ".repeat(60)}end` }));
    expect(heading.length).toBeLessThanOrEqual(72);
    expect(heading.endsWith("\u2026")).toBe(true);
    expect(heading).not.toMatch(/\s{2,}/);
  });
});

describe("sessionAnchors", () => {
  it("returns the opening ask and the latest message", () => {
    const anchors = sessionAnchors(session({
      title: "Mobile chat truncation",
      preview: "text is cut mid-word",
      messages: [
        { role: "user", text: "text is cut mid-word", at: 1 },
        { role: "assistant", text: "Found it \u2014 byte-offset split.", at: 2 },
        { role: "user", text: "now shrink the logo", at: 3 },
      ],
    }));
    expect(anchors.started).toBe("text is cut mid-word");
    expect(anchors.latest?.text).toBe("now shrink the logo");
  });

  it("suppresses an anchor that would repeat the heading", () => {
    // Untitled single-message thread: heading === preview === that message, so
    // printing it again below reads as a rendering bug.
    const anchors = sessionAnchors(session({
      title: null,
      preview: "only one thing was ever said",
      messages: [{ role: "user", text: "only one thing was ever said", at: 1 }],
    }));
    expect(anchors.started).toBeNull();
    expect(anchors.latest).toBeNull();
  });

  it("suppresses a latest anchor that would repeat the started anchor", () => {
    // A titled single-message thread: heading is the title, so `latest` clears
    // the heading check but still duplicates `started`.
    const anchors = sessionAnchors(session({
      title: "Mobile chat truncation",
      preview: "text is cut mid-word",
      messages: [{ role: "user", text: "text is cut mid-word", at: 1 }],
    }));
    expect(anchors.started).toBe("text is cut mid-word");
    expect(anchors.latest).toBeNull();
  });

  it("has no latest anchor on an older host that sends no messages", () => {
    const anchors = sessionAnchors(session({ title: "Something", preview: "a preview" }));
    expect(anchors.started).toBe("a preview");
    expect(anchors.latest).toBeNull();
  });
});

describe("sessionDateGroup", () => {
  it("groups today, yesterday, and older dates", async () => {
    const { sessionDateGroup } = await import("./sessionPresentation");
    const now = new Date(2026, 7, 14, 15).getTime();
    const today = new Date(2026, 7, 14, 8).getTime();
    const yesterday = new Date(2026, 7, 13, 22).getTime();
    expect(sessionDateGroup(today, now)).toBe("Today");
    expect(sessionDateGroup(yesterday, now)).toBe("Yesterday");
    expect(sessionDateGroup(new Date(2026, 0, 2).getTime(), now)).toMatch(/Jan/);
    expect(sessionDateGroup(null, now)).toBe("Older");
  });
});

describe("import browser model", () => {
  function summary(overrides: Partial<ExternalSessionSummary> = {}): ExternalSessionSummary {
    return {
      provider: "claude",
      id: "s1",
      cwd: "/repo/.ade/worktrees/apple-sim-1a2b",
      title: "Title",
      preview: null,
      createdAt: null,
      updatedAt: null,
      messageCount: 1,
      alreadyImported: false,
      possiblyActive: false,
      cwdMatchesRequestedLane: null,
      capabilities: { resumeInPlace: true, resumeInDifferentCwd: false, fork: true, forkIntoDifferentCwd: false, importToChat: true },
      ...overrides,
    };
  }

  const HOME = {
    kind: "lane" as const,
    laneId: "lane-a",
    laneName: "Apple Sim",
    branchRef: "refs/heads/ade/apple-sim",
    color: "#abc",
    laneType: "worktree",
    atLaneRoot: true,
  };

  function env(timestamp: string, text: string): AgentChatEventEnvelope {
    return { sessionId: "x", timestamp, event: { type: "text", text } };
  }

  describe("importBrowserModel", () => {
    it("names the lane, never the worktree folder", () => {
      const lanes = new Map([["lane-a", { id: "lane-a", name: "Apple Sim (renamed)", color: "#def" }]]);
      expect(sessionPlace(summary({ home: HOME }), lanes)).toEqual({
        kind: "lane",
        laneId: "lane-a",
        name: "Apple Sim (renamed)",
        color: "#def",
        branch: "ade/apple-sim",
      });
      expect(sessionPlace(summary({ home: { ...HOME, kind: "removed-lane", laneId: null } }), lanes).name).toBe("Removed lane");
      expect(sessionPlace(summary({ cwd: "/repo/scripts", home: { ...HOME, kind: "outside", laneId: null } }), lanes).name).toBe("scripts");
    });

    it("buckets sessions outside live lanes under Other folders and leaves older hosts unbucketed", () => {
      expect(laneFilterKey(summary({ home: HOME }))).toBe("lane-a");
      expect(laneFilterKey(summary({ home: { ...HOME, kind: "outside", laneId: null } }))).toBe(OTHER_FOLDERS_ID);
      expect(laneFilterKey(summary())).toBeNull();
    });

    it("searches lane name and branch", () => {
      const row = summary({ home: HOME });
      const place = sessionPlace(row, new Map());
      expect(matchesSearch(row, place, "apple sim")).toBe(true);
      expect(matchesSearch(row, place, "ade/apple")).toBe(true);
      expect(matchesSearch(row, place, "nothing-like-this")).toBe(false);
    });

    it("keeps paged-back events when a newer page overlaps, and starts over when it does not", () => {
      const current = [env("t1", "a"), env("t2", "b"), env("t3", "c")];
      expect(spliceNewestPage(current, [env("t2", "b"), env("t3", "c"), env("t4", "d")])?.map((e) => e.timestamp))
        .toEqual(["t1", "t2", "t3", "t4"]);
      expect(spliceNewestPage(current, [env("t9", "z")])).toBeNull();
    });

    it("formats sizes compactly and hides unknown or zero sizes", () => {
      expect(formatExternalSessionSize(40 * 1024 * 1024)).toBe("40 MB");
      expect(formatExternalSessionSize(2.44 * 1024 * 1024)).toBe("2.4 MB");
      expect(formatExternalSessionSize(1536)).toBe("1.5 KB");
      expect(formatExternalSessionSize(512)).toBe("512 B");
      expect(formatExternalSessionSize(0)).toBe("");
      expect(formatExternalSessionSize(null)).toBe("");
      expect(formatExternalSessionSize(undefined)).toBe("");
    });
  });
});
