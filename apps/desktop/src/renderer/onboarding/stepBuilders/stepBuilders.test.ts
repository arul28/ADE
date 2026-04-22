import { describe, expect, it } from "vitest";
import {
  buildCreateLaneDialogWalkthrough,
  buildPrCreateModalWalkthrough,
  buildGitActionsPaneWalkthrough,
  buildManageLaneDialogWalkthrough,
} from "./index";
import type { TourCtx } from "../registry";

const VALID_DOCS_PREFIX = "https://www.ade-app.dev/";
const TARGET_PATTERN = /^\[data-tour="[a-zA-Z][a-zA-Z0-9.]*"\]$/;

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

const builders = [
  ["createLaneDialog", buildCreateLaneDialogWalkthrough],
  ["prCreateModal", buildPrCreateModalWalkthrough],
  ["gitActionsPane", buildGitActionsPaneWalkthrough],
  ["manageLaneDialog", buildManageLaneDialogWalkthrough],
] as const;

describe("step builders", () => {
  for (const [name, build] of builders) {
    describe(name, () => {
      const steps = build();

      it("returns at least one step", () => {
        expect(steps.length).toBeGreaterThan(0);
      });

      it("every step has a non-empty title and body", () => {
        for (const step of steps) {
          expect(step.title.trim().length).toBeGreaterThan(0);
          expect(step.body.trim().length).toBeGreaterThan(0);
        }
      });

      it("every step has a stable id", () => {
        for (const step of steps) {
          expect(step.id, `step missing id (${step.target})`).toBeDefined();
          expect(step.id!.length).toBeGreaterThan(0);
        }
        const ids = steps.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("every target is empty (hero) or [data-tour=...]", () => {
        for (const step of steps) {
          if (step.target === "") continue;
          expect(step.target).toMatch(TARGET_PATTERN);
        }
      });

      it("every docUrl points at ade-app.dev without /docs/", () => {
        for (const step of steps) {
          if (!step.docUrl) continue;
          expect(step.docUrl.startsWith(VALID_DOCS_PREFIX)).toBe(true);
          expect(step.docUrl).not.toContain("/docs/");
        }
      });

      it("bodyTemplate (when present) returns a string", () => {
        const ctx = fakeCtx({ laneName: "my-lane" });
        for (const step of steps) {
          if (!step.bodyTemplate) continue;
          const r = step.bodyTemplate(ctx);
          expect(typeof r).toBe("string");
          expect(r.length).toBeGreaterThan(0);
        }
      });

      it("beforeEnter (when present) returns valid StepAction[]", async () => {
        for (const step of steps) {
          if (!step.beforeEnter) continue;
          const result = await step.beforeEnter();
          if (result == null) continue;
          expect(Array.isArray(result)).toBe(true);
          for (const action of result) {
            expect([
              "navigate",
              "openDialog",
              "closeDialog",
              "ipc",
              "focus",
            ]).toContain(action.type);
          }
        }
      });
    });
  }

  describe("createLaneDialog specifics", () => {
    it("opens the 'lanes.create' dialog via beforeEnter on the first step", async () => {
      const steps = buildCreateLaneDialogWalkthrough();
      const open = await steps[0].beforeEnter?.();
      expect(Array.isArray(open)).toBe(true);
      expect(open).toEqual([{ type: "openDialog", id: "lanes.create" }]);
    });

    it("has a waitForSelector on the Create step", () => {
      const steps = buildCreateLaneDialogWalkthrough();
      const create = steps.find((s) => s.id === "createLane.create");
      expect(create?.waitForSelector).toBe('[data-tour="lanes.laneTab"]');
    });
  });

  describe("prCreateModal specifics", () => {
    it("opens the 'prs.create' dialog via beforeEnter", async () => {
      const steps = buildPrCreateModalWalkthrough();
      const open = await steps[0].beforeEnter?.();
      expect(open).toEqual([{ type: "openDialog", id: "prs.create" }]);
    });
  });

  describe("manageLaneDialog specifics", () => {
    it("opens the 'lanes.manage' dialog via beforeEnter", async () => {
      const steps = buildManageLaneDialogWalkthrough();
      const open = await steps[0].beforeEnter?.();
      expect(open).toEqual([{ type: "openDialog", id: "lanes.manage" }]);
    });
  });
});
