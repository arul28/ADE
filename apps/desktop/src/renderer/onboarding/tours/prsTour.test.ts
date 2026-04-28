/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { prsTour } from "./prsTour";

const FALLBACK_MS = 12_000;

function findStep(title: string) {
  const step = prsTour.steps.find((entry) => entry.title === title);
  expect(step, `expected a step titled ${title}`).toBeTruthy();
  return step!;
}

describe("prsTour", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers under /prs", () => {
    expect(prsTour.id).toBe("prs");
    expect(prsTour.route).toBe("/prs");
  });

  it("attaches a fallback skip path to every step that depends on a PR being selected", () => {
    // Steps that target conditional content under the detail drawer must offer
    // a fallback so the user can move on when no PR is selected. Steps
    // anchored to the always-visible list / create button do NOT need one.
    const detailDrawerStepTitles = [
      "Inside a PR",
      "What's blocking me?",
      "Automated tests",
      "Stacked PRs",
      "Closing the PR",
    ];
    for (const title of detailDrawerStepTitles) {
      const step = findStep(title);
      expect(step.fallbackAfterMs, `${title} fallbackAfterMs`).toBe(FALLBACK_MS);
      expect(step.fallbackNextLabel, `${title} fallbackNextLabel`).toBeTruthy();
      expect(step.fallbackNotice, `${title} fallbackNotice`).toBeTruthy();
    }
  });

  it("does not attach fallback fields to always-visible steps", () => {
    // The list and create-PR button are always rendered on /prs, so they must
    // not silently auto-skip — those are required steps.
    for (const title of ["Your PR list", "Open a new PR"]) {
      const step = findStep(title);
      expect(step.fallbackAfterMs, `${title} fallbackAfterMs`).toBeUndefined();
      expect(step.fallbackNextLabel, `${title} fallbackNextLabel`).toBeUndefined();
      expect(step.fallbackNotice, `${title} fallbackNotice`).toBeUndefined();
    }
  });

  it("uses comma-fallback selectors so detail-drawer steps spotlight the drawer when no PR is selected", () => {
    // Each step targeting a conditional element inside the drawer must list
    // [data-tour="prs.detailDrawer"] as a secondary fallback, so the spotlight
    // lands on the drawer container instead of failing to anchor.
    const stepsWithDrawerFallback = [
      "What's blocking me?",
      "Automated tests",
      "Stacked PRs",
      "Closing the PR",
    ];
    for (const title of stepsWithDrawerFallback) {
      const step = findStep(title);
      expect(step.target, `${title} target`).toContain('[data-tour="prs.detailDrawer"]');
      // Comma-separated list — the drawer must come after a primary anchor.
      const parts = step.target.split(",").map((part) => part.trim());
      expect(parts.length, `${title} should have at least 2 fallback selectors`).toBeGreaterThanOrEqual(2);
    }
  });

  it("dispatches ade:tour-pr-detail-tab with `convergence` when entering What's blocking me?", async () => {
    const step = findStep("What's blocking me?");
    expect(step.beforeEnter).toBeTruthy();

    const events: Array<{ type: string; detail: unknown }> = [];
    const handler = (event: Event) => {
      events.push({ type: event.type, detail: (event as CustomEvent).detail });
    };
    window.addEventListener("ade:tour-pr-detail-tab", handler);
    try {
      const actions = await step.beforeEnter!();
      expect(Array.isArray(actions)).toBe(true);
      const ipcAction = (actions as any[]).find((entry) => entry.type === "ipc");
      expect(ipcAction, "expected an ipc action").toBeTruthy();
      await ipcAction.call();
      expect(events).toEqual([
        { type: "ade:tour-pr-detail-tab", detail: "convergence" },
      ]);
    } finally {
      window.removeEventListener("ade:tour-pr-detail-tab", handler);
    }
  });

  it("dispatches ade:tour-pr-detail-tab with `checks` when entering Automated tests", async () => {
    const step = findStep("Automated tests");
    expect(step.beforeEnter).toBeTruthy();

    const events: Array<{ type: string; detail: unknown }> = [];
    const handler = (event: Event) => {
      events.push({ type: event.type, detail: (event as CustomEvent).detail });
    };
    window.addEventListener("ade:tour-pr-detail-tab", handler);
    try {
      const actions = await step.beforeEnter!();
      const ipcAction = (actions as any[]).find((entry) => entry.type === "ipc");
      expect(ipcAction).toBeTruthy();
      await ipcAction.call();
      expect(events).toEqual([
        { type: "ade:tour-pr-detail-tab", detail: "checks" },
      ]);
    } finally {
      window.removeEventListener("ade:tour-pr-detail-tab", handler);
    }
  });

  it("does not switch the detail tab from steps that do not own a tab", async () => {
    // Stacked PRs and Closing are conditional content elsewhere in the drawer
    // — switching the active tab from these steps would be wrong, so they
    // must not have a beforeEnter that fires the tab-switch event.
    for (const title of ["Stacked PRs", "Closing the PR", "Inside a PR"]) {
      const step = findStep(title);
      expect(step.beforeEnter, `${title} should not dispatch a tab switch`).toBeUndefined();
    }
  });
});
