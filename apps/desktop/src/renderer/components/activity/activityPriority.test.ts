import { describe, expect, it } from "vitest";
import {
  ATTENTION_CONTRACT_VERSION,
  type AttentionItem,
  type AttentionPhase,
} from "../../../shared/types/attention";
import {
  ACTIVITY_POPOVER_SECTION_IDS,
  ACTIVITY_SECTION_DESCRIPTORS,
  activityBadgeCount,
  ACTIVITY_SECTION_TONE,
  activityFeedOrder,
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
  it("always exposes every state group as a descriptor, in priority order", () => {
    expect(ACTIVITY_SECTION_DESCRIPTORS.map(({ id }) => id)).toEqual([
      "needs-you",
      "failed",
      "planning",
      "working",
      "done",
    ]);
    expect(activitySections([], NOW).map(({ id, items }) => [id, items])).toEqual([
      ["needs-you", []],
      ["failed", []],
      ["planning", []],
      ["working", []],
      ["done", []],
    ]);
  });

  /** Done is full-list only; everything live or actionable stays in the glance. */
  it("keeps done out of the popover section list and nothing else", () => {
    expect(ACTIVITY_POPOVER_SECTION_IDS).toEqual([
      "needs-you",
      "failed",
      "planning",
      "working",
    ]);
  });

  it("maps phases into the five state bands", () => {
    const sections = activitySections([
      activityItem("done", "completed"),
      activityItem("working", "running"),
      activityItem("broke", "failed"),
      activityItem("needs", "needs_you"),
      activityItem("quiet", "stale"),
      activityItem("planning", "running", { chatActivityMode: "planning" }),
    ], NOW);

    expect(sectionMap(sections)).toEqual({
      "needs-you": ["needs"],
      failed: ["broke"],
      planning: ["planning"],
      working: ["working", "quiet"],
      done: ["done"],
    });
  });

  /**
   * A publisher this build does not understand must not be able to invent a
   * state: anything but the one literal falls back to the phase.
   */
  it("refuses an unrecognized activity mode instead of inventing a band", () => {
    const sections = activitySections([
      activityItem("odd", "running", { chatActivityMode: "daydreaming" as never }),
    ], NOW);

    expect(sectionMap(sections).planning).toEqual([]);
    expect(sectionMap(sections).working).toEqual(["odd"]);
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

    expect(sectionMap(sections).working).toEqual([]);
    expect(sectionMap(sections).done).toEqual([
      "fresh-done",
      "idle-running",
      "idle-stale",
    ]);
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
    // The notch reads one ordering: agents first, notifications after.
    expect(activityFeedOrder(items, NOW).map((item) => item.id)).toEqual(["agent", "pr"]);
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
    expect(activityHeadline([activityItem("broke", "failed")], NOW)).toBe("1 failed");
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
    expect(ACTIVITY_SECTION_TONE["needs-you"]).toBe("amber");
  });

  /**
   * The headline, the tone and the trigger label are one table now, not three
   * ladders. They had already drifted: the headline folded `planning` into "N
   * working" while the trigger label reported it separately and the tone went
   * violet — a surface that said "working" in blue prose above a violet badge.
   * Planning is its own state group with its own hue and its own glyph, so it
   * is named in every sentence.
   */
  it("names planning in the headline, the tone and the trigger alike", () => {
    const planning = [
      activityItem("plan-a", "running", { chatActivityMode: "planning" }),
      activityItem("work-a", "running"),
    ];
    const summary = summarizeActivity(planning, NOW);

    expect(summary.planningCount).toBe(1);
    expect(summary.workingCount).toBe(1);
    expect(summary.tone).toBe("violet");
    expect(summary.headline).toBe("1 planning");
    expect(activityHeadline(planning, NOW)).toBe("1 planning");
    expect(activityTriggerLabel(summary)).toBe("Activity · 1 planning · 1 working");
  });

  /**
   * Failure outranks planning and working, and never wears amber: `needs_you`
   * is the only phase that may claim the reader's move.
   */
  it("leads with failed when nothing needs you", () => {
    const summary = summarizeActivity(
      [
        activityItem("broke", "failed"),
        activityItem("plan", "running", { chatActivityMode: "planning" }),
      ],
      NOW,
    );
    expect(summary.tone).toBe("red");
    expect(summary.headline).toBe("1 failed");
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

  it("says all agents are idle rather than enumerating zeroes", () => {
    expect(activityTriggerLabel(summarizeActivity([], NOW))).toBe(
      "Activity · all agents idle",
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
