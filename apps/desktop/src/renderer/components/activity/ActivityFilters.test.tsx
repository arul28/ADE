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
        kinds: ["agent"],
        models: [],
      }).map((entry) => entry.id),
    ).toEqual(["laptop"]);
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
