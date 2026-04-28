/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../shared/types";
import { formatSessionBundleMarkdown, triggerBrowserDownload } from "./transcriptExport";

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-chat",
    laneId: "lane-main",
    laneName: "Main lane",
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: "Explain the failing tests",
    toolType: "codex-chat",
    title: "Debug test failures",
    status: "completed",
    startedAt: "2026-04-23T10:00:00.000Z",
    endedAt: "2026-04-23T10:12:00.000Z",
    exitCode: 0,
    transcriptPath: ".ade/transcripts/session-chat.chat.jsonl",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "exited",
    resumeCommand: null,
    ...overrides,
  };
}

describe("formatSessionBundleMarkdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T14:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes chat and terminal kinds plus session metadata, goal, dates, and tool", () => {
    const markdown = formatSessionBundleMarkdown([
      makeSession(),
      makeSession({
        id: "session-terminal",
        laneId: "lane-shell",
        laneName: "Shell lane",
        goal: "Run the deploy smoke check",
        toolType: "shell",
        title: "Deploy smoke",
        status: "failed",
        startedAt: "2026-04-23T11:00:00.000Z",
        endedAt: "2026-04-23T11:03:00.000Z",
      }),
    ]);

    expect(markdown).toContain("# ADE session bundle");
    expect(markdown).toContain("Exported: 2026-04-24T14:30:00.000Z");
    expect(markdown).toContain("Sessions: 2");
    expect(markdown).toContain("## Debug test failures");
    expect(markdown).toContain("- **Kind:** Chat");
    expect(markdown).toContain("- **Session ID:** `session-chat`");
    expect(markdown).toContain("- **Lane:** Main lane");
    expect(markdown).toContain("- **Status:** completed");
    expect(markdown).toContain("- **Started:** 2026-04-23T10:00:00.000Z");
    expect(markdown).toContain("- **Ended:** 2026-04-23T10:12:00.000Z");
    expect(markdown).toContain("- **Tool:** codex-chat");
    expect(markdown).toContain("**Goal:** Explain the failing tests");
    expect(markdown).toContain("## Deploy smoke");
    expect(markdown).toContain("- **Kind:** Terminal");
    expect(markdown).toContain("- **Lane:** Shell lane");
    expect(markdown).toContain("- **Status:** failed");
    expect(markdown).toContain("- **Tool:** shell");
    expect(markdown).toContain("**Goal:** Run the deploy smoke check");
  });

  it("falls back to the session id when the title is empty and omits blank optional fields", () => {
    const markdown = formatSessionBundleMarkdown([
      makeSession({
        id: "session-empty-title",
        laneId: "",
        laneName: "",
        goal: "   ",
        title: "   ",
        endedAt: null,
      }),
    ]);

    expect(markdown).toContain("## session-empty-title");
    expect(markdown).not.toContain("- **Lane:**");
    expect(markdown).not.toContain("- **Ended:**");
    expect(markdown).not.toContain("**Goal:**");
  });

  it("normalizes multiline metadata so exported markdown keeps one field per line", () => {
    const markdown = formatSessionBundleMarkdown([
      makeSession({
        title: "Debug\n  multiline\t title",
        laneName: "Main\nlane",
        goal: "First line\nsecond line",
        toolType: "codex-chat",
      }),
    ]);

    expect(markdown).toContain("## Debug multiline title");
    expect(markdown).toContain("- **Lane:** Main lane");
    expect(markdown).toContain("- **Tool:** codex-chat");
    expect(markdown).toContain("**Goal:** First line second line");
  });
});

describe("triggerBrowserDownload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a markdown Blob link, clicks it, removes it, and schedules URL revoke", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ade-session-bundle");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const appendChild = vi.spyOn(document.body, "appendChild");
    const removeChild = vi.spyOn(document.body, "removeChild");

    triggerBrowserDownload("ade-sessions.md", "# Exported sessions");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/markdown;charset=utf-8");
    expect(blob.size).toBe("# Exported sessions".length);

    const anchor = appendChild.mock.calls[0][0] as HTMLAnchorElement;
    expect(anchor.tagName).toBe("A");
    expect(anchor.href).toBe("blob:ade-session-bundle");
    expect(anchor.download).toBe("ade-sessions.md");
    expect(click).toHaveBeenCalledTimes(1);
    expect(removeChild).toHaveBeenCalledWith(anchor);

    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:ade-session-bundle");
  });
});
