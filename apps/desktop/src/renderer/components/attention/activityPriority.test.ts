import { describe, expect, it } from "vitest";
import {
  ATTENTION_CONTRACT_VERSION,
  type AttentionItem,
  type AttentionPhase,
} from "../../../shared/types/attention";
import {
  ACTIVITY_SECTION_DESCRIPTORS,
  activityBadgeCount,
  activityHeadline,
  activitySections,
} from "./activityPriority";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

function activityItem(
  id: string,
  phase: AttentionPhase,
  patch: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id,
    revision: 1,
    fingerprint: `fingerprint-${id}`,
    kind: "agent",
    eventKind: "agent_running",
    phase,
    machine: { machineKey: "studio", name: "Studio Mac", online: true, lastSeenAt: null },
    project: { projectId: "ade", name: "ADE" },
    title: id,
    preview: "preview",
    privacyPreview: "private preview",
    destination: { kind: "session", sessionId: id },
    actions: [],
    occurredAt: "2026-08-01T11:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...patch,
  };
}

describe("activity priority", () => {
  it("always exposes the three reusable descriptors in priority order", () => {
    expect(ACTIVITY_SECTION_DESCRIPTORS.map(({ id }) => id)).toEqual([
      "needs-you",
      "working",
      "done",
    ]);
    expect(activitySections([], NOW).map(({ id, items }) => [id, items])).toEqual([
      ["needs-you", []],
      ["working", []],
      ["done", []],
    ]);
  });

  it("maps phases into needs-you, working, and done bands", () => {
    const sections = activitySections([
      activityItem("done", "completed"),
      activityItem("working", "running"),
      activityItem("review", "review_requested"),
      activityItem("needs", "needs_you"),
      activityItem("open", "open"),
      activityItem("closed", "closed"),
    ], NOW);

    expect(sections.map((section) => [
      section.id,
      section.items.map((item) => item.id),
    ])).toEqual([
      ["needs-you", ["needs", "review"]],
      ["working", ["working", "open"]],
      ["done", ["done", "closed"]],
    ]);
  });

  it("files explicit idle rows in the done ambient tail", () => {
    const sections = activitySections([
      activityItem("idle-running", "running", { activityTier: "idle" }),
      activityItem("fresh-done", "completed", {
        updatedAt: "2026-08-01T10:00:00.000Z",
      }),
      activityItem("idle-stale", "stale", {
        activityTier: "idle",
        updatedAt: "2026-08-01T11:30:00.000Z",
      }),
    ], NOW);

    expect(sections[1]?.items).toEqual([]);
    expect(sections[2]?.items.map((item) => item.id)).toEqual([
      "fresh-done",
      "idle-running",
      "idle-stale",
    ]);
  });

  it("filters dismissed and expired rows before deriving badge and headline", () => {
    const items = {
      visible: activityItem("visible", "needs_you"),
      dismissed: activityItem("dismissed", "failed", {
        dismissedAt: "2026-08-01T11:30:00.000Z",
      }),
      expired: activityItem("expired", "needs_you", {
        expiresAt: "2026-08-01T11:59:00.000Z",
      }),
    };

    expect(activityBadgeCount(items, NOW)).toBe(1);
    expect(activityHeadline(items, NOW)).toBe("1 needs you");
    expect(activityHeadline([activityItem("work", "running")], NOW)).toBe("1 working");
    expect(activityHeadline([activityItem("done", "completed")], NOW)).toBe("1 done");
    expect(activityHeadline([], NOW)).toBe("All clear");
  });
});
