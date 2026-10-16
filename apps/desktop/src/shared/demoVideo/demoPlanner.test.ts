import { describe, expect, it } from "vitest";
import type { DemoAnalysis, DemoTrack } from "./demoContract";
import { planDemo, planPlainDemo } from "./demoPlanner";

const analysis: DemoAnalysis = {
  version: 1,
  width: 1170,
  height: 2532,
  durationSeconds: 12,
  frames: [
    { t: 0, changed: 1 },
    { t: 12, changed: 0.2, box: [0.4, 0.4, 0.2, 0.2] },
  ],
};

describe("demo planner recording modes", () => {
  it("keeps a plain recording free of demo overlays", () => {
    const plan = planPlainDemo(analysis);

    expect(plan.segments).toEqual([
      { outputStart: 0, outputEnd: 12, sourceStart: 0, sourceEnd: 12 },
    ]);
    expect(plan.camera).toEqual([{ t: 0, zoom: 1, cx: 0.5, cy: 0.5 }]);
    expect(plan.cursor).toEqual([]);
    expect(plan.rings).toEqual([]);
    expect(plan.captions).toEqual([]);
    expect(plan.badges).toEqual([]);
  });

  it("keeps an Apple recording at one steady camera key unless zoom is requested", () => {
    const track: DemoTrack = {
      version: 1,
      surface: "apple",
      durationSeconds: 12,
      events: [{ t: 5, kind: "tap", x: 0.5, y: 0.5, by: "user" }],
      agentSpans: [],
      loadSpans: [],
    };

    const plan = planDemo({ track, analysis });

    expect(plan.camera).toEqual([{ t: 0, zoom: 1, cx: 0.5, cy: 0.5 }]);
  });
});
