import { describe, expect, it } from "vitest";
import { firstJourneyTour } from "./firstJourneyTour";
import { getTour } from "../registry";
import type { TourCtx } from "../registry";
import { useAppStore } from "../../state/appStore";

const VALID_DOCS_PREFIX = "https://www.ade-app.dev/";
// A valid target is either an empty string (hero-only step) or a
// `[data-tour="..."]` selector. Every step's target must match one of these.
// Anchor naming: segments are alphanumeric, separated by dots; hyphens
// allowed inside a segment (e.g. `history.column-settings`).
const TARGET_PATTERN = /^\[data-tour="[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)*"\]$/;

function fakeCtx(values: Record<string, unknown> = {}): TourCtx {
  const store: Record<string, unknown> = { ...values };
  return {
    values: store,
    set(k, v) {
      store[k] = v;
    },
    get<T = unknown>(k: string): T | undefined {
      return store[k] as T | undefined;
    },
  };
}

describe("firstJourneyTour", () => {
  it("registers with id 'first-journey' under the 'full' variant", () => {
    expect(firstJourneyTour.id).toBe("first-journey");
    expect(firstJourneyTour.variant).toBe("full");
    const fromRegistry = getTour("first-journey", "full");
    expect(fromRegistry?.id).toBe("first-journey");
  });

  it("starts on /lanes", () => {
    expect(firstJourneyTour.route).toBe("/lanes");
  });

  it("has at least 30 steps across the 13 acts", () => {
    expect(firstJourneyTour.steps.length).toBeGreaterThanOrEqual(30);
  });

  it("every step has a non-empty title", () => {
    for (const step of firstJourneyTour.steps) {
      expect(
        step.title.trim().length,
        `title for step ${step.id ?? step.target}`,
      ).toBeGreaterThan(0);
    }
  });

  it("every docUrl starts with https://www.ade-app.dev/", () => {
    for (const step of firstJourneyTour.steps) {
      if (step.docUrl === undefined) continue;
      expect(
        step.docUrl.startsWith(VALID_DOCS_PREFIX),
        `docUrl for step ${step.id ?? step.target}: ${step.docUrl}`,
      ).toBe(true);
      expect(step.docUrl).not.toContain("/docs/");
    }
  });

  it("every target is either empty (hero) or a [data-tour=\"...\"] selector", () => {
    for (const step of firstJourneyTour.steps) {
      if (step.target === "") continue;
      expect(
        step.target,
        `target for step ${step.id ?? "(no id)"}: ${step.target}`,
      ).toMatch(TARGET_PATTERN);
    }
  });

  it("every bodyTemplate returns a string when called with a TourCtx", () => {
    const ctx = fakeCtx({ laneName: "my-lane" });
    for (const step of firstJourneyTour.steps) {
      if (!step.bodyTemplate) continue;
      const result = step.bodyTemplate(ctx);
      expect(
        typeof result,
        `bodyTemplate for step ${step.id ?? step.target}`,
      ).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("bodyTemplate falls back gracefully when ctx is empty", () => {
    const ctx = fakeCtx({});
    for (const step of firstJourneyTour.steps) {
      if (!step.bodyTemplate) continue;
      expect(() => step.bodyTemplate!(ctx)).not.toThrow();
      const result = step.bodyTemplate!(ctx);
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("ctxInit seeds a default laneName", () => {
    expect(firstJourneyTour.ctxInit).toBeDefined();
    const initial = firstJourneyTour.ctxInit?.();
    expect(initial).toBeDefined();
    expect(initial?.laneName).toBeTruthy();
  });

  it("every step that declares an id has a unique id", () => {
    const ids = firstJourneyTour.steps
      .map((s) => s.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("includes intros for Acts 1 through 12", () => {
    const ids = new Set(firstJourneyTour.steps.map((s) => s.id));
    for (const n of [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]) {
      expect(ids.has(`act${n}.intro`), `missing act${n}.intro`).toBe(true);
    }
    // Act 12's finale lives under `act12.finale` rather than intro.
    expect(ids.has("act12.finale")).toBe(true);
  });

  it("branches(ctx) on the PR-close step skips Act 7's close when noRemote is set", () => {
    const closeStep = firstJourneyTour.steps.find((s) => s.id === "act7.close");
    expect(closeStep).toBeDefined();
    expect(closeStep?.branches).toBeDefined();
    const ctx = fakeCtx({ noRemote: true });
    expect(closeStep?.branches?.(ctx)).toBe("act8.intro");
    const linearCtx = fakeCtx({});
    expect(closeStep?.branches?.(linearCtx)).toBeNull();
  });

  it("branches(ctx) on Act 5 intro jumps to History when dryRun is set", () => {
    const act5 = firstJourneyTour.steps.find((s) => s.id === "act5.intro");
    expect(act5).toBeDefined();
    expect(act5?.branches).toBeDefined();
    const ctx = fakeCtx({ dryRun: true });
    expect(act5?.branches?.(ctx)).toBe("act6.intro");
  });

  it("act0.openProject only skips when a project is active", () => {
    const openProject = firstJourneyTour.steps.find((s) => s.id === "act0.openProject");
    expect(openProject?.branches).toBeDefined();

    useAppStore.setState({ project: null });
    expect(openProject?.branches?.(fakeCtx())).toBeNull();

    useAppStore.setState({
      project: {
        rootPath: "/Users/arul/ADE",
        displayName: "ADE",
        baseRef: "main",
      },
    });
    expect(openProject?.branches?.(fakeCtx())).toBe("act1.intro");
    useAppStore.setState({ project: null });
  });

  it("route-changing steps require an open project", async () => {
    for (const step of firstJourneyTour.steps) {
      if (!step.beforeEnter) continue;
      const result = await step.beforeEnter(fakeCtx());
      const hasNavigate = Array.isArray(result) && result.some((action) => action.type === "navigate");
      if (!hasNavigate) continue;
      expect(
        step.requires?.includes("projectOpen"),
        `${step.id ?? step.title} has navigate action without projectOpen`,
      ).toBe(true);
    }
  });

  it("every beforeEnter action returns a valid StepAction[]", async () => {
    for (const step of firstJourneyTour.steps) {
      if (!step.beforeEnter) continue;
      const result = await step.beforeEnter();
      if (result == null) continue;
      expect(Array.isArray(result)).toBe(true);
      for (const action of result) {
        expect(
          ["navigate", "openDialog", "closeDialog", "ipc", "focus"],
        ).toContain(action.type);
      }
    }
  });
});
