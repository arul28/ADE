import { describe, expect, it } from "vitest";
import {
  emptySlowLinkMeasure,
  noteSlowLinkDrop,
  noteSlowLinkRtt,
  slowLinkStatus,
  type SlowLinkMeasure,
  type SlowLinkPreference,
} from "./slowLinkMode";

type Step = number | "drop" | { wait: number };

/** Plays measurements in order, one round trip each 30 s (the maintenance ping). */
function play(steps: Step[]): { measure: SlowLinkMeasure; trail: boolean[]; farTrail: boolean[] } {
  let measure = emptySlowLinkMeasure();
  let now = 1_000_000;
  const trail: boolean[] = [];
  const farTrail: boolean[] = [];
  for (const step of steps) {
    if (typeof step === "object") {
      now += step.wait;
      continue;
    }
    now += 30_000;
    measure = step === "drop" ? noteSlowLinkDrop(measure, now) : noteSlowLinkRtt(measure, step, now);
    trail.push(measure.slow);
    farTrail.push(measure.far);
  }
  return { measure, trail, farTrail };
}

describe("slow-connection mode for one machine", () => {
  it.each<{ name: string; steps: Step[]; trail: boolean[] }>([
    {
      name: "a good link never turns it on",
      steps: [40, 60, 380, 50, 399],
      trail: [false, false, false, false, false],
    },
    {
      name: "one slow round trip is not enough; two of three are",
      steps: [80, 700, 90, 650, 720],
      trail: [false, false, false, true, true],
    },
    {
      name: "it stays on near the line, and goes off after five good round trips",
      steps: [700, 700, 300, 240, 240, 240, 240, 240],
      trail: [false, true, true, true, true, true, true, false],
    },
    {
      name: "one slow round trip among good ones holds it on",
      steps: [700, 700, 100, 100, 100, 100, 700, 100, 100, 100, 100, 100],
      trail: [false, true, true, true, true, true, true, true, true, true, true, false],
    },
    {
      name: "two drops in five minutes turn it on, on a fast link too",
      steps: [30, "drop", 30, "drop"],
      trail: [false, false, false, true],
    },
    {
      name: "drops far apart do not",
      steps: ["drop", { wait: 6 * 60_000 }, "drop"],
      trail: [false, false],
    },
    {
      name: "after drops it goes off only once the drops are older than five minutes",
      steps: ["drop", "drop", 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      // The second drop is 300 s old at the tenth round trip, and past it at the eleventh.
      trail: [false, true, true, true, true, true, true, true, true, true, true, true, false],
    },
  ])("$name", ({ steps, trail }) => {
    expect(play(steps).trail).toEqual(trail);
  });

  it.each<{ name: string; steps: Step[]; farTrail: boolean[] }>([
    {
      name: "a far link (two of three at 150 ms or more) shows typing at once without slow-connection mode",
      steps: [40, 185, 120, 180, 190],
      farTrail: [false, false, false, true, true],
    },
    {
      name: "it stays far near the line, and goes off after five round trips under 110 ms",
      steps: [180, 180, 130, 100, 100, 100, 100, 100],
      farTrail: [false, true, true, true, true, true, true, false],
    },
    {
      name: "slow-connection mode from drops alone also counts as far",
      steps: [30, "drop", 30, "drop"],
      farTrail: [false, false, false, true],
    },
  ])("$name", ({ steps, farTrail }) => {
    const played = play(steps);
    expect(played.farTrail).toEqual(farTrail);
    if (steps.every((step) => typeof step === "number" && step < 400)) expect(played.trail.every((slow) => !slow)).toBe(true);
  });

  it.each<{ preference: SlowLinkPreference; slow: boolean; active: boolean; reason: string | null; far: boolean }>([
    { preference: "auto", slow: true, active: true, reason: "latency", far: true },
    { preference: "auto", slow: false, active: false, reason: null, far: false },
    { preference: "on", slow: false, active: true, reason: "setting", far: true },
    { preference: "off", slow: true, active: false, reason: null, far: false },
  ])("the machine's setting $preference wins over the measure (slow: $slow)", ({ preference, slow, active, reason, far }) => {
    const { measure } = play(slow ? [700, 700] : [40, 40]);
    expect(slowLinkStatus(measure, preference)).toEqual({ active, reason, rttMs: slow ? 700 : 40, far });
  });
});
