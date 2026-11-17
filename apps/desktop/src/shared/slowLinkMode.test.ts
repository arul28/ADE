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
function play(steps: Step[]): { measure: SlowLinkMeasure; trail: boolean[] } {
  let measure = emptySlowLinkMeasure();
  let now = 1_000_000;
  const trail: boolean[] = [];
  for (const step of steps) {
    if (typeof step === "object") {
      now += step.wait;
      continue;
    }
    now += 30_000;
    measure = step === "drop" ? noteSlowLinkDrop(measure, now) : noteSlowLinkRtt(measure, step, now);
    trail.push(measure.slow);
  }
  return { measure, trail };
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

  it.each<{ preference: SlowLinkPreference; slow: boolean; active: boolean; reason: string | null }>([
    { preference: "auto", slow: true, active: true, reason: "latency" },
    { preference: "auto", slow: false, active: false, reason: null },
    { preference: "on", slow: false, active: true, reason: "setting" },
    { preference: "off", slow: true, active: false, reason: null },
  ])("the machine's setting $preference wins over the measure (slow: $slow)", ({ preference, slow, active, reason }) => {
    const { measure } = play(slow ? [700, 700] : [40, 40]);
    expect(slowLinkStatus(measure, preference)).toEqual({ active, reason, rttMs: slow ? 700 : 40 });
  });
});
