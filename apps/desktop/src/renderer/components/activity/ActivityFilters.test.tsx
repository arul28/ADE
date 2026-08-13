// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ATTENTION_CONTRACT_VERSION, type AttentionItem } from "../../../shared/types";
import {
  ActivityFilters,
  activityFiltersAreEmpty,
  applyActivityFilters,
  EMPTY_ACTIVITY_FILTERS,
} from "./ActivityFilters";

function item(id: string, patch: Partial<AttentionItem> = {}): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id,
    revision: 1,
    fingerprint: `fingerprint-${id}`,
    kind: "agent",
    eventKind: "agent_running",
    phase: "running",
    machine: { machineKey: "studio", name: "Studio Mac", online: true, lastSeenAt: null },
    project: { projectId: "ade", name: "ADE", rootPath: "/repo/ade" },
    provider: "codex",
    model: "GPT-5",
    title: `Task ${id}`,
    preview: "",
    privacyPreview: "",
    destination: { kind: "session", sessionId: `session-${id}` },
    actions: [],
    occurredAt: "2026-07-28T14:00:00.000Z",
    updatedAt: "2026-07-28T14:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...patch,
  };
}

afterEach(cleanup);

describe("applyActivityFilters", () => {
  const studio = item("studio");
  const laptop = item("laptop", {
    machine: { machineKey: "laptop", name: "MacBook", online: true, lastSeenAt: null },
    model: "Claude Opus 5",
  });
  const pr = item("pr", {
    kind: "pull_request",
    model: null,
    provider: null,
    machine: { machineKey: "cloud", name: "Cloud Mac", online: true, lastSeenAt: null },
  });
  const items = [studio, laptop, pr];

  it("treats an empty axis as everything", () => {
    expect(activityFiltersAreEmpty(EMPTY_ACTIVITY_FILTERS)).toBe(true);
    expect(applyActivityFilters(items, EMPTY_ACTIVITY_FILTERS)).toHaveLength(3);
  });

  it("intersects across axes and unions within one", () => {
    expect(
      applyActivityFilters(items, { ...EMPTY_ACTIVITY_FILTERS, machineKeys: ["studio", "laptop"] })
        .map((entry) => entry.id),
    ).toEqual(["studio", "laptop"]);

    expect(
      applyActivityFilters(items, {
        machineKeys: ["laptop"],
        projects: [],
        kinds: ["agent"],
        models: [],
        stateGroup: null,
      }).map((entry) => entry.id),
    ).toEqual(["laptop"]);
  });

  /**
   * The account-wide feed spans every recently-opened project while the Work
   * sidebar shows one, so the totals can never agree without a way to say
   * "just this repo". Narrowing what the publisher sends would delete the other
   * machines' work instead — this is a presentation facet on purpose.
   */
  it("filters to one project across every machine reporting it", () => {
    const otherRepoSameMachine = item("other", {
      project: { projectId: "notes", name: "Notes", rootPath: "/repo/notes" },
    });
    const sameRepoOtherMachine = item("mirror", {
      machine: { machineKey: "laptop", name: "MacBook", online: true, lastSeenAt: null },
      // A different machine mints a different `projectId` for the same repo, so
      // matching on it would split one project into two options.
      project: {
        projectId: "9f2c-random-uuid",
        canonicalId: "project_ade",
        name: "ADE",
        rootPath: "/repo/ade",
      },
    });
    const withCanonical = item("studio-canonical", {
      project: {
        projectId: "ade",
        canonicalId: "project_ade",
        name: "ADE",
        rootPath: "/repo/ade",
      },
    });

    expect(
      applyActivityFilters(
        [withCanonical, sameRepoOtherMachine, otherRepoSameMachine],
        { ...EMPTY_ACTIVITY_FILTERS, projects: ["project_ade"] },
      ).map((entry) => entry.id),
    ).toEqual(["studio-canonical", "mirror"]);

    // An older publisher sends no canonical id; the root path still resolves.
    expect(
      applyActivityFilters(items, { ...EMPTY_ACTIVITY_FILTERS, projects: ["/repo/ade"] })
        .map((entry) => entry.id),
    ).toEqual(["studio", "laptop", "pr"]);
  });

  /**
   * The state axis is the one the strip drives, so its AND-ing with the older
   * axes is what keeps "MacBook · Needs you" from silently meaning "MacBook".
   */
  it("narrows to one state group and intersects with the other axes", () => {
    const needsYou = item("needs-you", {
      phase: "needs_you",
      eventKind: "agent_needs_you",
    });
    const laptopNeedsYou = item("laptop-needs-you", {
      phase: "needs_you",
      eventKind: "agent_needs_you",
      machine: { machineKey: "laptop", name: "MacBook", online: true, lastSeenAt: null },
    });
    const running = item("running");
    const pool = [needsYou, laptopNeedsYou, running];

    expect(
      applyActivityFilters(pool, { ...EMPTY_ACTIVITY_FILTERS, stateGroup: "needs-you" })
        .map((entry) => entry.id),
    ).toEqual(["needs-you", "laptop-needs-you"]);

    expect(
      applyActivityFilters(pool, {
        ...EMPTY_ACTIVITY_FILTERS,
        stateGroup: "needs-you",
        machineKeys: ["laptop"],
      }).map((entry) => entry.id),
    ).toEqual(["laptop-needs-you"]);
  });

  /**
   * A quiet session and a finished one are different facts, and the filter has
   * to keep them apart or `done` becomes the bucket every stale row falls into
   * — the complaint the sixth group was added to answer.
   */
  it("files a gone-quiet session under idle rather than done", () => {
    const stale = item("stale", { phase: "stale", eventKind: "agent_running" });
    const finished = item("finished", { phase: "completed", eventKind: "agent_completed" });

    expect(
      applyActivityFilters([stale, finished], {
        ...EMPTY_ACTIVITY_FILTERS,
        stateGroup: "idle",
      }).map((entry) => entry.id),
    ).toEqual(["stale"]);
    expect(
      applyActivityFilters([stale, finished], {
        ...EMPTY_ACTIVITY_FILTERS,
        stateGroup: "done",
      }).map((entry) => entry.id),
    ).toEqual(["finished"]);
  });

  it("excludes items with no model from a model filter", () => {
    // "Which model is running" is a claim an item without one cannot make, so
    // it must not sneak through as a wildcard match.
    expect(
      applyActivityFilters(items, { ...EMPTY_ACTIVITY_FILTERS, models: ["GPT-5"] })
        .map((entry) => entry.id),
    ).toEqual(["studio"]);
  });
});

describe("ActivityFilters", () => {
  it("offers only options the snapshot actually contains", () => {
    render(
      <ActivityFilters
        items={[item("only")]}
        filters={EMPTY_ACTIVITY_FILTERS}
        onChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter by machine" }));
    expect(screen.getAllByRole("menuitemcheckbox").map((node) => node.textContent))
      .toEqual(["Studio Mac"]);
  });

  it("offers one project option per repo, however many machines report it", () => {
    render(
      <ActivityFilters
        items={[
          item("a"),
          item("b", {
            machine: { machineKey: "laptop", name: "MacBook", online: true, lastSeenAt: null },
          }),
          item("c", {
            project: { projectId: "notes", name: "Notes", rootPath: "/repo/notes" },
          }),
        ]}
        filters={EMPTY_ACTIVITY_FILTERS}
        onChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
    expect(screen.getAllByRole("menuitemcheckbox").map((node) => node.textContent))
      .toEqual(["ADE", "Notes"]);
  });

  it("hides an axis with nothing to choose from", () => {
    render(
      <ActivityFilters
        items={[item("no-model", { model: null })]}
        filters={EMPTY_ACTIVITY_FILTERS}
        onChange={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Filter by model" })).toBeNull();
  });

  it("toggles a value on and back off", () => {
    const onChange = vi.fn();
    const items = [item("studio")];
    const { rerender } = render(
      <ActivityFilters items={items} filters={EMPTY_ACTIVITY_FILTERS} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter by machine" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Studio Mac" }));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_ACTIVITY_FILTERS, machineKeys: ["studio"] });

    onChange.mockClear();
    rerender(
      <ActivityFilters
        items={items}
        filters={{ ...EMPTY_ACTIVITY_FILTERS, machineKeys: ["studio"] }}
        onChange={onChange}
      />,
    );
    // The menu is still open from the first click — reopening would close it.
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Studio Mac" }));
    expect(onChange).toHaveBeenCalledWith(EMPTY_ACTIVITY_FILTERS);
  });

  it("shows the clear affordance only while something is filtered", () => {
    const { rerender } = render(
      <ActivityFilters
        items={[item("studio")]}
        filters={EMPTY_ACTIVITY_FILTERS}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();

    rerender(
      <ActivityFilters
        items={[item("studio")]}
        filters={{ ...EMPTY_ACTIVITY_FILTERS, machineKeys: ["studio"] }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
  });
});

describe("ActivityFilters state strip", () => {
  const strip = () => screen.getByTestId("activity-state-strip");
  const pips = () =>
    [...strip().querySelectorAll("[data-activity-state-pip]")].map((node) => ({
      group: node.getAttribute("data-activity-state-pip"),
      active: node.getAttribute("data-active"),
      label: node.getAttribute("aria-label"),
    }));

  const mixed = [
    item("needs-a", { phase: "needs_you", eventKind: "agent_needs_you" }),
    item("needs-b", { phase: "needs_you", eventKind: "agent_needs_you" }),
    item("broke", { phase: "failed", eventKind: "agent_failed" }),
    item("running"),
    item("done", { phase: "completed", eventKind: "agent_completed" }),
  ];

  it("renders only the groups that have rows, in priority order", () => {
    render(
      <ActivityFilters items={mixed} filters={EMPTY_ACTIVITY_FILTERS} onChange={() => {}} />,
    );

    // No `planning` and no `idle` pip: six glyphs where two mean zero is noise
    // pretending to be a status line.
    expect(pips().map((pip) => pip.group)).toEqual([
      "needs-you",
      "failed",
      "working",
      "done",
    ]);
    expect(pips().map((pip) => pip.label)).toEqual([
      "2 need you",
      "1 failed",
      "1 working",
      "1 done",
    ]);
  });

  /**
   * One name for the whole strip, so the account reads as a sentence rather
   * than as six counters a screen reader has to walk and reassemble.
   */
  it("announces every state as one element", () => {
    render(
      <ActivityFilters items={mixed} filters={EMPTY_ACTIVITY_FILTERS} onChange={() => {}} />,
    );

    expect(
      screen.getByRole("group", { name: "2 need you, 1 failed, 1 working, 1 done" }),
    ).toBeTruthy();
  });

  it("selects one group and clears it when the lit one is pressed again", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ActivityFilters items={mixed} filters={EMPTY_ACTIVITY_FILTERS} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "1 failed" }));
    expect(onChange).toHaveBeenCalledWith({
      ...EMPTY_ACTIVITY_FILTERS,
      stateGroup: "failed",
    });

    onChange.mockClear();
    rerender(
      <ActivityFilters
        items={mixed}
        filters={{ ...EMPTY_ACTIVITY_FILTERS, stateGroup: "failed" }}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("button", { name: "1 failed" }).getAttribute("aria-pressed"))
      .toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "1 failed" }));
    expect(onChange).toHaveBeenCalledWith(EMPTY_ACTIVITY_FILTERS);
  });

  /**
   * Single-select, because the strip is a status display first: two lit glyphs
   * read as "these two states are happening", not as "I am looking at these
   * two", and a status line that lies is worse than a filter that is narrow.
   */
  it("replaces the selection rather than adding to it", () => {
    const onChange = vi.fn();
    render(
      <ActivityFilters
        items={mixed}
        filters={{ ...EMPTY_ACTIVITY_FILTERS, stateGroup: "failed" }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2 need you" }));
    expect(onChange).toHaveBeenCalledWith({
      ...EMPTY_ACTIVITY_FILTERS,
      stateGroup: "needs-you",
    });
    expect(pips().filter((pip) => pip.active === "true").map((pip) => pip.group))
      .toEqual(["failed"]);
  });

  /**
   * The counts describe the account, not the current selection. A facet that
   * recounts itself after narrowing shows the chosen group's number beside a
   * row of zeroes, and the zeroes are the only way back out.
   */
  it("keeps counting groups the active filter is hiding", () => {
    render(
      <ActivityFilters
        items={mixed}
        filters={{ ...EMPTY_ACTIVITY_FILTERS, stateGroup: "needs-you" }}
        onChange={() => {}}
      />,
    );

    expect(pips().map((pip) => pip.label)).toEqual([
      "2 need you",
      "1 failed",
      "1 working",
      "1 done",
    ]);
  });

  it("counts only agents, so a pull request cannot inflate a state", () => {
    render(
      <ActivityFilters
        items={[
          item("running"),
          item("pr", { kind: "pull_request", phase: "checks_failing", model: null }),
        ]}
        filters={EMPTY_ACTIVITY_FILTERS}
        onChange={() => {}}
      />,
    );

    expect(pips().map((pip) => pip.group)).toEqual(["working"]);
  });

  /**
   * The last row of the group you filtered to can finish while you are reading
   * it. Dropping the pip then would strand the filter with no way back through
   * the control that set it.
   */
  it("keeps the selected pip after its last row leaves the group", () => {
    render(
      <ActivityFilters
        items={[item("running")]}
        filters={{ ...EMPTY_ACTIVITY_FILTERS, stateGroup: "failed" }}
        onChange={() => {}}
      />,
    );

    expect(pips()).toEqual([
      { group: "failed", active: "true", label: "0 failed" },
      { group: "working", active: "false", label: "1 working" },
    ]);
  });

  it("renders nothing at all when the account is empty", () => {
    render(
      <ActivityFilters items={[]} filters={EMPTY_ACTIVITY_FILTERS} onChange={() => {}} />,
    );

    expect(screen.queryByTestId("activity-state-strip")).toBeNull();
  });
});
