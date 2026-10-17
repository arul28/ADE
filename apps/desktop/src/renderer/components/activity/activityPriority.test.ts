import { describe, expect, it } from "vitest";
import {
  ATTENTION_CONTRACT_VERSION,
  type AttentionItem,
  type AttentionPhase,
} from "../../../shared/types/attention";
import {
  ACTIVITY_SECTION_DESCRIPTORS,
  activityBadgeCount,
  ACTIVITY_SECTION_TONE,
  activityFooterLine,
  activityHeadline,
  activityNotificationItems,
  activityOfflineMachines,
  activitySections,
  activityTriggerLabel,
  summarizeActivity,
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

function sectionMap(sections: ReturnType<typeof activitySections>) {
  return Object.fromEntries(
    sections.map((section) => [section.id, section.items.map((item) => item.id)]),
  );
}

describe("activity priority", () => {
  it("always exposes the four board columns as descriptors, in board order", () => {
    expect(ACTIVITY_SECTION_DESCRIPTORS.map(({ id, label }) => [id, label])).toEqual([
      ["needs_you", "Needs you"],
      ["working", "Working"],
      ["waiting", "Waiting"],
      ["done", "Done"],
    ]);
    expect(activitySections([], NOW).map(({ id, items }) => [id, items])).toEqual([
      ["needs_you", []],
      ["working", []],
      ["waiting", []],
      ["done", []],
    ]);
  });

  /**
   * The columns are the Work board's. A failure is the user's move, planning
   * is work, a session gone quiet is resting, and Waiting is whatever the
   * publishing brain said waits.
   */
  it("files every agent under its board column", () => {
    const sections = activitySections([
      activityItem("done", "completed"),
      activityItem("working", "running"),
      activityItem("broke", "failed"),
      activityItem("needs", "needs_you"),
      activityItem("planning", "running", { chatActivityMode: "planning" }),
      activityItem("quiet", "running", { activityTier: "idle" }),
      activityItem("ci", "running", { boardColumn: "waiting", waitingReason: "ci" }),
      activityItem("snoozed", "stale", { boardColumn: "waiting", waitingReason: "snoozed" }),
    ], NOW);

    // Membership only: order within a column is the shared priority sorter's.
    const membership = Object.fromEntries(
      Object.entries(sectionMap(sections)).map(([id, ids]) => [id, [...ids].sort()]),
    );
    expect(membership).toEqual({
      needs_you: ["broke", "needs"],
      working: ["planning", "working"],
      waiting: ["ci", "snoozed"],
      done: ["done", "quiet"],
    });
  });

  /**
   * The duplicate-lane bug: a lane with an open pull request produced two rows,
   * one for the agent and one for the PR. Activity is an agent feed now, and
   * the pull request belongs to the notification side.
   */
  it("keeps pull requests out of the session sections and in notifications", () => {
    const items = [
      activityItem("agent", "running"),
      activityItem("pr", "checks_failing", {
        kind: "pull_request",
        eventKind: "pr_checks_failing",
      }),
    ];

    expect(activitySections(items, NOW).flatMap((section) =>
      section.items.map((item) => item.id))).toEqual(["agent"]);
    expect(activityNotificationItems(items, NOW).map((item) => item.id)).toEqual(["pr"]);
    expect(summarizeActivity(items, NOW).counts).toEqual({ needs_you: 0, working: 1, waiting: 0, done: 0 });
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
    // A failure is the user's move: it counts toward the badge.
    expect(activityBadgeCount([activityItem("broke", "failed")], NOW)).toBe(1);
    expect(activityHeadline([activityItem("work", "running")], NOW)).toBe("1 working");
    expect(activityHeadline([activityItem("done", "completed")], NOW)).toBe("1 done");
    expect(activityHeadline([], NOW)).toBe("All clear");
  });
});

describe("activity header summary", () => {
  it("derives counts, machine presence, and the trigger label from one pass", () => {
    const summary = summarizeActivity(
      [
        activityItem("needs", "needs_you"),
        activityItem("work", "running"),
        activityItem("done", "completed"),
        activityItem("offline", "running", {
          machine: {
            machineKey: "laptop",
            name: "MacBook Pro",
            online: false,
            lastSeenAt: "2026-08-01T10:00:00.000Z",
          },
        }),
      ],
      NOW,
    );

    expect(summary.needsYouCount).toBe(1);
    expect(summary.workingCount).toBe(2);
    expect(summary.doneCount).toBe(1);
    expect(summary.trackedCount).toBe(4);
    expect(summary.machinesOnline).toBe(1);
    expect(summary.machinesTotal).toBe(2);
    expect(summary.staleMachineCount).toBe(1);
    expect(summary.offlineMachines.map((machine) => machine.name)).toEqual(["MacBook Pro"]);
    expect(summary.tone).toBe("amber");
    expect(activityTriggerLabel(summary)).toBe(
      "Activity · 1 needs you · 2 working · 1 done",
    );
  });

  /**
   * "N sessions" is a claim about chats, and it used to count pull requests
   * too — which is why it never matched the number of chats anyone had.
   */
  it("counts sessions and notifications apart", () => {
    const summary = summarizeActivity(
      [
        activityItem("agent", "running"),
        activityItem("pr", "merge_ready", {
          kind: "pull_request",
          eventKind: "pr_merge_ready",
        }),
        activityItem("checks", "checks_failing", {
          kind: "pull_request",
          eventKind: "pr_checks_failing",
        }),
      ],
      NOW,
    );

    expect(summary.trackedCount).toBe(1);
    expect(summary.notificationCount).toBe(2);
  });

  /**
   * A machine whose every row the user dismissed is not a machine Activity is
   * still reporting; counting it made "3 machines" outlive the work naming it.
   */
  it("drops a machine from the roster once its last row is dismissed", () => {
    const summary = summarizeActivity(
      [
        activityItem("here", "running"),
        activityItem("gone", "completed", {
          dismissedAt: "2026-08-01T11:30:00.000Z",
          machine: {
            machineKey: "retired",
            name: "Old Mac",
            online: false,
            lastSeenAt: "2026-07-01T10:00:00.000Z",
          },
        }),
      ],
      NOW,
    );

    expect(summary.machinesTotal).toBe(1);
    expect(summary.offlineMachines).toEqual([]);
  });

  it("names the offline machines and when each was last seen", () => {
    const machines = activityOfflineMachines(
      [
        activityItem("a", "running", {
          machine: {
            machineKey: "laptop",
            name: "MacBook Pro",
            online: false,
            lastSeenAt: "2026-08-01T10:00:00.000Z",
          },
        }),
        activityItem("b", "completed", {
          machine: {
            machineKey: "laptop",
            name: "MacBook Pro",
            online: false,
            lastSeenAt: "2026-08-01T10:00:00.000Z",
          },
        }),
        activityItem("c", "running"),
      ],
      NOW,
    );

    expect(machines).toEqual([
      {
        machineKey: "laptop",
        name: "MacBook Pro",
        lastSeenAt: "2026-08-01T10:00:00.000Z",
        itemCount: 2,
      },
    ]);
  });

  /**
   * Amber is the badge's only colour, and it may only mean "your move". Work in
   * motion is blue and a finished run is emerald — neither may borrow it.
   */
  it("reserves amber for needs-you and falls back through working then done", () => {
    expect(summarizeActivity([activityItem("work", "running")], NOW).tone).toBe("blue");
    expect(summarizeActivity([activityItem("done", "completed")], NOW).tone).toBe("emerald");
    expect(summarizeActivity([], NOW).tone).toBe("neutral");
    expect(ACTIVITY_SECTION_TONE.needs_you).toBe("amber");
  });

  /**
   * A failure sits under Needs you, so it is amber and counted in the badge,
   * and the summary still knows how many of those raised hands are failures.
   */
  it("counts a failure as needing you, and separately as failed", () => {
    const summary = summarizeActivity(
      [
        activityItem("broke", "failed"),
        activityItem("asks", "needs_you"),
        activityItem("plan", "running", { chatActivityMode: "planning" }),
      ],
      NOW,
    );
    expect(summary.needsYouCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.workingCount).toBe(1);
    expect(summary.tone).toBe("amber");
    expect(summary.headline).toBe("2 need you");
    expect(activityTriggerLabel(summary)).toBe("Activity · 2 need you · 1 working");
  });

  /**
   * One footer sentence for the pane and the popover. They used to be composed
   * separately, in different orders, and the popover's all-online case dropped
   * the word "online" — so the same account read two ways depending on which
   * surface you opened.
   */
  it("composes one footer line, work first and the fleet last", () => {
    const summary = summarizeActivity(
      [activityItem("one", "running"), activityItem("two", "needs_you")],
      NOW,
    );
    expect(activityFooterLine(summary)).toBe("2 sessions · 1 machine online");
    // Nothing filed at all still explains the machine roster's silence rather
    // than rendering an empty strip or a bare "0 sessions".
    expect(activityFooterLine(summarizeActivity([], NOW)))
      .toBe("No machines reporting yet");
  });

  it("says nothing is running rather than enumerating zeroes", () => {
    expect(activityTriggerLabel(summarizeActivity([], NOW))).toBe(
      "Activity · nothing running",
    );
  });

  it("counts a dismissed row out of tracked while still knowing its machine", () => {
    const summary = summarizeActivity(
      [
        activityItem("visible", "needs_you"),
        activityItem("dismissed", "failed", { dismissedAt: "2026-08-01T11:30:00.000Z" }),
      ],
      NOW,
    );

    expect(summary.trackedCount).toBe(1);
    expect(summary.needsYouCount).toBe(1);
    expect(summary.machinesTotal).toBe(1);
  });
});
