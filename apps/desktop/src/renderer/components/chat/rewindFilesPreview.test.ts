import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope, TurnDiffSummary } from "../../../shared/types";
import { buildRewindPreviewFiles, deriveRewindDiffSummaries } from "./rewindFilesPreview";

function envelope(sequence: number, timestamp: string, event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp,
    sequence,
    event,
  };
}

function summary(turnId: string, filePath: string, beforeSha: string, afterSha: string): TurnDiffSummary {
  return {
    turnId,
    beforeSha,
    afterSha,
    files: [{ path: filePath, additions: 8, deletions: 3, status: "M" }],
    totalAdditions: 8,
    totalDeletions: 3,
  };
}

describe("rewindFilesPreview", () => {
  it("keeps turn diff summaries after the selected user message", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope(1, "2026-05-12T10:00:00Z", {
        type: "user_message",
        messageId: "before",
        text: "before",
      }),
      envelope(2, "2026-05-12T10:01:00Z", {
        type: "turn_diff_summary",
        ...summary("turn-before", "src/before.ts", "a", "b"),
      }),
      envelope(3, "2026-05-12T10:02:00Z", {
        type: "user_message",
        messageId: "target",
        text: "target",
      }),
      envelope(4, "2026-05-12T10:03:00Z", {
        type: "turn_diff_summary",
        ...summary("turn-after", "src/after.ts", "b", "c"),
      }),
    ];

    expect(deriveRewindDiffSummaries(events, { messageId: "target", timestamp: "2026-05-12T10:02:00Z" }))
      .toEqual([summary("turn-after", "src/after.ts", "b", "c")]);
  });

  it("aggregates per-file diff ranges and preserves checkpoint-only files", () => {
    const files = buildRewindPreviewFiles(
      { filesChanged: ["/repo/src/auth.ts", "src/unknown.ts"] },
      [
        summary("turn-1", "src/auth.ts", "base", "mid"),
        summary("turn-2", "src/auth.ts", "mid", "head"),
      ],
    );

    expect(files).toEqual([
      {
        path: "src/auth.ts",
        additions: 8,
        deletions: 3,
        status: "M",
        beforeSha: "base",
        afterSha: "head",
        diffAvailable: true,
      },
      {
        path: "src/unknown.ts",
        additions: 0,
        deletions: 0,
        status: "M",
        diffAvailable: false,
      },
    ]);
  });
});
