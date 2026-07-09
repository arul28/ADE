import { describe, expect, it } from "vitest";
import { importAffordancesFor, shortenCwd } from "./affordances";
import { sessionHeading } from "./sessionPresentation";
import type { ExternalSessionCapabilities, ExternalSessionSummary } from "./contract";

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

function kinds(summary: ExternalSessionSummary) {
  return importAffordancesFor(summary).map((a) => a.kind);
}

describe("importAffordancesFor", () => {
  it("cwd matches: offers resume-here + fork when both caps present", () => {
    const affs = importAffordancesFor(
      session({ cwdMatchesRequestedLane: true, capabilities: { resumeInPlace: true, fork: true } }),
    );
    expect(affs.map((a) => a.kind)).toEqual(["resume-here", "fork-into-lane"]);
    expect(affs.every((a) => a.enabled)).toBe(true);
    expect(affs.every((a) => a.target === "cli")).toBe(true);
  });

  it("cwd matches but no resumeInPlace: omits resume-here", () => {
    expect(kinds(session({ cwdMatchesRequestedLane: true, capabilities: { fork: true } }))).toEqual([
      "fork-into-lane",
    ]);
  });

  it("chat-capable session leads with the hero open-as-chat then fork-as-chat", () => {
    const affs = importAffordancesFor(
      session({ cwdMatchesRequestedLane: true, capabilities: { importToChat: true, resumeInPlace: true, fork: true } }),
    );
    expect(affs.map((a) => a.kind)).toEqual([
      "open-as-chat",
      "fork-as-chat",
      "resume-here",
      "fork-into-lane",
    ]);
    const hero = affs.find((a) => a.hero);
    expect(hero?.kind).toBe("open-as-chat");
    expect(hero?.target).toBe("chat");
    expect(hero?.mode).toBe("resume");
    expect(affs.find((a) => a.kind === "fork-as-chat")).toMatchObject({ target: "chat", mode: "fork", hero: false });
  });

  it("only open-as-chat is ever flagged hero", () => {
    const affs = importAffordancesFor(
      session({ capabilities: { importToChat: true, resumeInPlace: true, fork: true, resumeInDifferentCwd: true } }),
    );
    expect(affs.filter((a) => a.hero)).toHaveLength(1);
  });

  it("foreign cwd + cross-cwd resume (codex): resume-here enabled, fork added when forkAcross", () => {
    const affs = importAffordancesFor(
      session({
        provider: "codex",
        cwdMatchesRequestedLane: false,
        capabilities: { resumeInDifferentCwd: true, forkIntoDifferentCwd: true },
      }),
    );
    expect(affs.map((a) => a.kind)).toEqual(["resume-here", "fork-into-lane"]);
    expect(affs[0]).toMatchObject({ enabled: true, mode: "resume" });
    expect(affs[1]?.hint).toBeUndefined();
  });

  it("foreign cwd + cross-cwd resume only: no fork row", () => {
    expect(
      kinds(session({ cwdMatchesRequestedLane: false, capabilities: { resumeInDifferentCwd: true } })),
    ).toEqual(["resume-here"]);
  });

  it("foreign cwd, no cross-cwd resume but forkIntoDifferentCwd: fork substitutes with hint", () => {
    const affs = importAffordancesFor(
      session({ cwdMatchesRequestedLane: false, capabilities: { forkIntoDifferentCwd: true } }),
    );
    expect(affs.map((a) => a.kind)).toEqual(["fork-into-lane"]);
    expect(affs[0]).toMatchObject({ enabled: true, mode: "fork" });
    expect(affs[0]?.hint).toMatch(/another folder/i);
  });

  it("foreign cwd with forkIntoDifferentCwd and resumeInPlace offers both in priority order", () => {
    const affs = importAffordancesFor(
      session({
        cwdMatchesRequestedLane: false,
        cwd: "/Users/dev/other-project",
        capabilities: { resumeInPlace: true, forkIntoDifferentCwd: true },
      }),
    );
    expect(affs.map((a) => a.kind)).toEqual(["fork-into-lane", "resume-in-place"]);
    expect(affs[0]).toMatchObject({ mode: "fork", hint: expect.stringMatching(/another folder/i) });
    expect(affs[1]).toMatchObject({
      mode: "resume",
      label: "Continue in original folder",
      foreignCwd: "/Users/dev/other-project",
    });
  });

  it("foreign cwd, only resumeInPlace: offers resume-in-place carrying the foreign path", () => {
    const affs = importAffordancesFor(
      session({
        cwdMatchesRequestedLane: false,
        cwd: "/Users/dev/other-project",
        capabilities: { resumeInPlace: true },
      }),
    );
    expect(affs.map((a) => a.kind)).toEqual(["resume-in-place"]);
    expect(affs[0]?.foreignCwd).toBe("/Users/dev/other-project");
    expect(affs[0]?.label).toBe("Continue in original folder");
    expect(affs[0]?.mode).toBe("resume");
  });

  it("resume-in-place appears alongside fork but remains hidden behind cross-cwd resume-here", () => {
    expect(
      kinds(session({ cwdMatchesRequestedLane: false, capabilities: { resumeInPlace: true, forkIntoDifferentCwd: true } })),
    ).toEqual(["fork-into-lane", "resume-in-place"]);
    // resumeAcross wins over resume-in-place
    expect(
      kinds(session({ cwdMatchesRequestedLane: false, capabilities: { resumeInPlace: true, resumeInDifferentCwd: true } })),
    ).toEqual(["resume-here"]);
  });

  it("foreign cwd, no CLI caps: resume-here disabled with a provider-specific reason", () => {
    const affs = importAffordancesFor(
      session({ provider: "cursor", cwdMatchesRequestedLane: false, capabilities: {} }),
    );
    expect(affs.map((a) => a.kind)).toEqual(["resume-here"]);
    expect(affs[0]?.enabled).toBe(false);
    expect(affs[0]?.disabledReason).toContain("Cursor");
  });

  it("cross-folder Claude only offers a chat copy, never a misleading continuation", () => {
    const affs = importAffordancesFor(
      session({
        provider: "claude",
        cwdMatchesRequestedLane: false,
        capabilities: { importToChat: true, forkIntoDifferentCwd: true },
      }),
    );
    expect(affs.map((a) => a.kind)).toEqual(["fork-as-chat", "fork-into-lane"]);
    expect(affs[0]).toMatchObject({ label: "Copy as ADE chat", mode: "fork", hero: true });
  });

  it("no capabilities at all, cwd matches: yields nothing", () => {
    expect(importAffordancesFor(session({ cwdMatchesRequestedLane: true, capabilities: {} }))).toEqual([]);
  });

  it("uses explicit continue/copy labels, including original-folder continuation", () => {
    const summaries = [
      session({ cwdMatchesRequestedLane: true, capabilities: { importToChat: true, resumeInPlace: true, fork: true } }),
      session({ cwdMatchesRequestedLane: false, cwd: "/Users/dev/other", capabilities: { resumeInPlace: true, forkIntoDifferentCwd: true } }),
      session({ provider: "cursor", cwdMatchesRequestedLane: false, capabilities: {} }),
    ];
    const allowed = new Set([
      "Continue as ADE chat",
      "Copy as ADE chat",
      "Continue as CLI",
      "Copy as CLI",
      "Continue in original folder",
    ]);
    for (const summary of summaries) {
      for (const aff of importAffordancesFor(summary)) {
        expect(allowed.has(aff.label)).toBe(true);
      }
    }
  });

  it("every emitted affordance carries a non-empty meaning description", () => {
    const summaries = [
      session({ cwdMatchesRequestedLane: true, capabilities: { importToChat: true, resumeInPlace: true, fork: true } }),
      session({ cwdMatchesRequestedLane: false, capabilities: { resumeInDifferentCwd: true, forkIntoDifferentCwd: true } }),
      session({ cwdMatchesRequestedLane: false, cwd: "/Users/dev/other", capabilities: { resumeInPlace: true, forkIntoDifferentCwd: true } }),
      session({ provider: "cursor", cwdMatchesRequestedLane: false, capabilities: {} }),
    ];
    for (const summary of summaries) {
      for (const aff of importAffordancesFor(summary)) {
        expect(aff.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("the disabled resume-here description explains the cross-folder block", () => {
    const [aff] = importAffordancesFor(
      session({ provider: "cursor", cwdMatchesRequestedLane: false, capabilities: {} }),
    );
    expect(aff?.enabled).toBe(false);
    expect(aff?.description).toBe(aff?.disabledReason);
    expect(aff?.description).toContain("Cursor");
  });
});

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
});

describe("sessionHeading", () => {
  it("keeps an untitled session's prompt as preview instead of duplicating it as the title", () => {
    expect(sessionHeading(session({
      title: null,
      preview: "this is a test message",
      cwd: "/Users/dev/ADE",
      updatedAt: null,
    }))).toBe("ADE");
  });
});
