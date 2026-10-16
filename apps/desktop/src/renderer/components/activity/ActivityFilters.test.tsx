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
