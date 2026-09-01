/* @vitest-environment jsdom */

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomationIngressStatus, AutomationTrigger } from "../../../../shared/types";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../../test/builtinSurfaces";
import { TriggerCard } from "./TriggerCard";

/**
 * ADE's compiled Linear trigger source, and what `ade-linear` does to it.
 *
 * The plugin declares five automation triggers of its own — `issue_created`,
 * `issue_updated`, `issue_assigned`, `issue_status_changed`, `issue_labeled` —
 * so a machine that has it would otherwise offer two Linear sources for one
 * feature. What the gate must NOT do is take away a rule the user already
 * saved, which is the case pinned at the bottom of this file: the source stays
 * offered and its filter editor stays on screen whenever Linear is the trigger
 * the rule already has.
 *
 * Every case states its registry, because hiding the compiled Linear UI takes a
 * positive "the plugin is here" and nothing less.
 */

/** Registry resolved, no plugins installed — a normal ADE machine. */
function seedNoPlugins(): void {
  seedBuiltinSurfacePlugins([]);
}

function ingressWithLinearNotReady(): AutomationIngressStatus {
  const notReady = { ready: false, via: null, setupError: null };
  const ready = { ready: true, via: null, setupError: null };
  return {
    delivery: {
      github: ready,
      githubWebhook: ready,
      webhook: ready,
      linear: notReady,
      cursor: ready,
    },
  } as unknown as AutomationIngressStatus;
}

function renderCard(
  trigger: AutomationTrigger,
  ingressStatus: AutomationIngressStatus | null = null,
): void {
  render(
    <MemoryRouter>
      <TriggerCard trigger={trigger} ingressStatus={ingressStatus} onChange={vi.fn()} />
    </MemoryRouter>,
  );
}

const DELIVERY_WARNING = "Events for this trigger can't be delivered yet.";

/**
 * Publish the Linear ingress IPC this host offers. Adds to whatever `window.ade`
 * already holds, so a plugin roster seeded before it survives.
 */
function mockLinearIngress(): void {
  const existing = (window as unknown as { ade?: Record<string, unknown> }).ade;
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: { ...(existing ?? {}), automations: { linearIngress: { setup: vi.fn() } } },
  });
}

beforeEach(() => {
  // A bare host each time. The ingress IPC is per-case here — one callout path
  // needs it and one needs its absence — and `window` outlives a single test.
  Object.defineProperty(window, "ade", { configurable: true, writable: true, value: {} });
  resetBuiltinSurfacePlugins();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBuiltinSurfacePlugins();
});

describe("TriggerCard source picker", () => {
  it("offers Linear on a machine without the plugin", () => {
    seedNoPlugins();
    renderCard({ type: "schedule", cron: "0 9 * * 1-5" });
    expect(screen.getByRole("button", { name: "Linear" })).toBeTruthy();
  });

  it("keeps offering Linear while the plugin registry has not resolved", () => {
    // A superseded surface reads the unknown the other way from a gated one:
    // blinking the Linear source out of the picker on every launch of a machine
    // that has no plugin at all would be the regression, not the fix.
    renderCard({ type: "schedule", cron: "0 9 * * 1-5" });
    expect(screen.getByRole("button", { name: "Linear" })).toBeTruthy();
  });

  it("drops Linear once ade-linear is installed and enabled", () => {
    seedBuiltinSurfacePlugins(["linear"]);
    renderCard({ type: "schedule", cron: "0 9 * * 1-5" });
    expect(screen.queryByRole("button", { name: "Linear" })).toBeNull();
  });

  it("leaves the other sources alone when ade-linear is installed", () => {
    seedBuiltinSurfacePlugins(["linear"]);
    renderCard({ type: "schedule", cron: "0 9 * * 1-5" });
    expect(screen.getByRole("button", { name: "GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cursor Cloud" })).toBeTruthy();
  });
});

describe("TriggerCard on a rule that already uses a Linear trigger", () => {
  it("keeps Linear offered so the saved rule shows the source it has", () => {
    seedBuiltinSurfacePlugins(["linear"]);
    renderCard({ type: "linear.issue_created" });
    expect(screen.getByRole("button", { name: "Linear" })).toBeTruthy();
  });

  it("keeps the Linear filter editor, so no saved filter is blanked out", () => {
    seedBuiltinSurfacePlugins(["linear"]);
    renderCard({ type: "linear.issue_labeled", team: "ENG", labels: ["agent"] });
    expect(screen.getByDisplayValue("ENG")).toBeTruthy();
    expect(screen.getByDisplayValue("agent")).toBeTruthy();
  });
});

describe("TriggerCard Linear delivery callout", () => {
  it("offers Connect Linear on a machine without the plugin", () => {
    seedNoPlugins();
    mockLinearIngress();
    renderCard({ type: "linear.issue_created" }, ingressWithLinearNotReady());
    expect(screen.getByRole("button", { name: "Connect Linear" })).toBeTruthy();
  });

  it("offers the settings link when this host has no Linear ingress IPC", () => {
    seedNoPlugins();
    renderCard({ type: "linear.issue_created" }, ingressWithLinearNotReady());
    expect(screen.getByRole("button", { name: "Open Linear settings" })).toBeTruthy();
  });

  it("keeps the callout offered while the plugin registry has not resolved", () => {
    renderCard({ type: "linear.issue_created" }, ingressWithLinearNotReady());
    expect(screen.getByRole("button", { name: "Open Linear settings" })).toBeTruthy();
  });

  it("drops both buttons once ade-linear is installed, and keeps the warning", () => {
    // The warning is still true for a rule saved before the install, so only
    // the actions go: one writes a token the plugin's credential handoff owns,
    // and the other navigates to a settings card that now renders null.
    seedBuiltinSurfacePlugins(["linear"]);
    mockLinearIngress();
    renderCard({ type: "linear.issue_created" }, ingressWithLinearNotReady());
    expect(screen.queryByRole("button", { name: "Connect Linear" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Linear settings" })).toBeNull();
    expect(screen.getByText(DELIVERY_WARNING)).toBeTruthy();
  });
});
