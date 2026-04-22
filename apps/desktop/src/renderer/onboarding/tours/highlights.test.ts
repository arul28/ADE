/* @vitest-environment jsdom */
import { describe, it, expect, beforeAll } from "vitest";
import "./index";
import { getTour, listTours } from "../registry";

const HIGHLIGHT_TAB_IDS = [
  "lanes",
  "work",
  "lane-work-pane",
  "files",
  "run",
  "prs",
  "automations",
  "settings",
  "graph",
  "history",
  "cto",
] as const;

describe("highlights variants", () => {
  beforeAll(() => {
    // The barrel import above registers every tour on first load.
  });

  for (const id of HIGHLIGHT_TAB_IDS) {
    it(`${id}: highlights variant is registered with ~3 steps`, () => {
      const tour = getTour(id, "highlights");
      expect(tour, `${id} highlights must register`).toBeDefined();
      if (!tour) return;
      expect(tour.variant).toBe("highlights");
      expect(tour.steps.length).toBeGreaterThanOrEqual(2);
      expect(tour.steps.length).toBeLessThanOrEqual(4);
    });
  }

  it("highlights tours have no drawer-opening StepActions or ghost cursors", () => {
    const highlights = listTours("highlights");
    expect(highlights.length).toBeGreaterThanOrEqual(HIGHLIGHT_TAB_IDS.length);
    for (const tour of highlights) {
      for (const step of tour.steps) {
        expect(
          step.ghostCursor,
          `${tour.id} highlights must not use ghost cursor: ${step.id}`,
        ).toBeUndefined();
        expect(
          typeof step.beforeEnter,
          `${tour.id} highlights must not declare beforeEnter: ${step.id}`,
        ).not.toBe("function");
      }
    }
  });

  it("every highlight step has a non-empty title", () => {
    for (const tour of listTours("highlights")) {
      for (const step of tour.steps) {
        expect(typeof step.title).toBe("string");
        expect(step.title.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("every docUrl on highlight steps points to ade-app.dev without /docs/", () => {
    for (const tour of listTours("highlights")) {
      for (const step of tour.steps) {
        if (!step.docUrl) continue;
        expect(step.docUrl).toMatch(/^https:\/\/www\.ade-app\.dev/);
        expect(step.docUrl).not.toContain("/docs/");
      }
    }
  });
});
