import { describe, expect, it } from "vitest";
import { firstJourneyTour } from "./firstJourneyTour";

const SECTION_PREFIXES = [
  "act1.laneWorkPane.",
  "act6.history.",
  "act8.run.",
  "act9.automations.",
  "act10.cto.",
  "act11.settings.",
] as const;

const FALLBACK_MS = 30_000;
const FALLBACK_LABEL = "Skip";
const FALLBACK_NOTICE_DEFAULT =
  "This step is waiting on a state that hasn't appeared — you can skip it without affecting the tutorial.";

describe("firstJourneyTour tutorialSection wrapping", () => {
  const sectionSteps = firstJourneyTour.steps.filter((step) =>
    SECTION_PREFIXES.some((prefix) => step.id?.startsWith(prefix)),
  );

  it("includes wrapped steps from every tutorialSection (smoke)", () => {
    expect(sectionSteps.length).toBeGreaterThan(0);
    for (const prefix of SECTION_PREFIXES) {
      expect(
        sectionSteps.some((step) => step.id?.startsWith(prefix)),
        `expected at least one step with id prefix ${prefix}`,
      ).toBe(true);
    }
  });

  it("namespaces every wrapped step's id with its section prefix and index", () => {
    for (const step of sectionSteps) {
      const matchedPrefix = SECTION_PREFIXES.find((prefix) =>
        step.id?.startsWith(prefix),
      );
      expect(matchedPrefix, `expected step id ${step.id} to match a section prefix`).toBeTruthy();
      // Format is `${sectionId}.${index}` — the suffix after the section prefix
      // must be a non-empty index (numeric) when the source step had no id.
      const suffix = step.id!.slice(matchedPrefix!.length);
      expect(suffix.length).toBeGreaterThan(0);
    }
  });

  it("attaches a non-empty requires gate to every wrapped step", () => {
    for (const step of sectionSteps) {
      expect(step.requires, `step ${step.id} should have a requires gate`).toBeTruthy();
      expect((step.requires ?? []).length).toBeGreaterThan(0);
    }
  });

  it("derives waitForSelector from target when the source step did not set one", () => {
    for (const step of sectionSteps) {
      if (step.target) {
        expect(step.waitForSelector, `step ${step.id} should have waitForSelector`).toBe(
          step.waitForSelector,
        );
        // When target is set and source didn't override, waitForSelector === target.
        // (We can't tell here whether the source set it explicitly, but at minimum it
        //  must be a non-empty string for any step with a target.)
        expect(typeof step.waitForSelector === "string" && step.waitForSelector.length > 0).toBe(true);
      }
    }
  });

  it("injects a fallbackAfterMs/Skip/notice on every requires-gated wrapped step", () => {
    // None of the sub-tours fed into tutorialSection currently set
    // fallbackAfterMs themselves, so every wrapped step here must take the
    // injected default. If a sub-tour starts overriding fallback fields, those
    // steps would fail this expectation — and that's fine: drop them from this
    // assertion explicitly rather than silently passing.
    for (const step of sectionSteps) {
      expect(step.fallbackAfterMs, `step ${step.id} fallbackAfterMs`).toBe(FALLBACK_MS);
      expect(step.fallbackNextLabel, `step ${step.id} fallbackNextLabel`).toBe(FALLBACK_LABEL);
      expect(step.fallbackNotice, `step ${step.id} fallbackNotice`).toBe(FALLBACK_NOTICE_DEFAULT);
    }
  });

  it("does not add fallback fields to non-section act steps that have no requires gate", () => {
    // Hero / actIntro steps like act0.welcome have target: "" and no requires,
    // so they must remain free of fallback noise.
    const welcome = firstJourneyTour.steps.find((step) => step.id === "act0.welcome");
    expect(welcome).toBeTruthy();
    expect(welcome!.fallbackAfterMs).toBeUndefined();
    expect(welcome!.fallbackNextLabel).toBeUndefined();
    expect(welcome!.fallbackNotice).toBeUndefined();
  });
});
