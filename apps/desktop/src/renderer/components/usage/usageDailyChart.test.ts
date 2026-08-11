import { describe, expect, it } from "vitest";

import type { AdeUsageDailyPoint } from "../../../shared/types/usage";
import type { UsageDayColumn } from "./usageDailyChartModel";
import {
  USAGE_CHART_COMBINED_ID,
  USAGE_CHART_OTHER_ID,
  buildDayColumns,
  buildGeometry,
  computePeak,
  evaluateSegment,
  monotoneSegments,
  monotoneTangents,
  niceScale,
  selectTopSeries,
  resolveHighlightedSeriesId,
  seriesValue,
  smoothCurve,
} from "./usageDailyChartModel";

function day(
  date: string,
  byProvider: Record<string, { totalTokens: number; costUsd: number }> | undefined,
  totalTokens = 0,
): AdeUsageDailyPoint {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens,
    commits: 0,
    prs: 0,
    insertions: 0,
    deletions: 0,
    filesChanged: 0,
    sessions: 0,
    ...(byProvider ? { byProvider } : {}),
  };
}

describe("niceScale", () => {
  it("never leaves the peak above the returned max", () => {
    const peaks = [
      0.004, 0.03, 0.3, 1, 1.0001, 2, 2.5, 3, 5, 5.5, 7, 9.9, 10, 11, 42, 99,
      100, 101, 1234, 9_999, 123_456, 987_654_321,
    ];
    for (const peak of peaks) {
      expect(niceScale(peak)).toBeGreaterThanOrEqual(peak);
    }
  });

  it("rounds up to a 1/2/5 x 10^n step", () => {
    expect(niceScale(1)).toBe(1);
    expect(niceScale(1.2)).toBe(2);
    expect(niceScale(2)).toBe(2);
    expect(niceScale(2.1)).toBe(5);
    expect(niceScale(5)).toBe(5);
    expect(niceScale(6)).toBe(10);
    expect(niceScale(11)).toBe(20);
    expect(niceScale(1234)).toBe(2000);
  });

  it("does not promote an exact step because of float error", () => {
    // 0.3 / 0.1 === 3.0000000000000004 in IEEE754.
    expect(niceScale(0.3)).toBeCloseTo(0.5, 10);
    expect(niceScale(0.2)).toBeCloseTo(0.2, 10);
    expect(niceScale(0.1)).toBeCloseTo(0.1, 10);
  });

  it("degrades safely on empty / invalid peaks", () => {
    expect(niceScale(0)).toBe(1);
    expect(niceScale(-5)).toBe(1);
    expect(niceScale(Number.NaN)).toBe(1);
    expect(niceScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("monotone smoothing", () => {
  const sample = (xs: number[], ys: number[]) => {
    const segments = monotoneSegments(xs, ys);
    const out: number[] = [];
    for (const segment of segments) {
      for (let step = 0; step <= 40; step += 1) {
        out.push(evaluateSegment(segment, step / 40));
      }
    }
    return out;
  };

  it("never produces a y outside the range of its input samples", () => {
    const cases: number[][] = [
      [0, 100, 0, 0, 0, 90, 0], // spike train — the classic overshoot case
      [10, 10, 10, 10],
      [0, 0, 0, 500],
      [500, 0, 0, 0],
      [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5],
      [0, 0.0001, 0, 0.0002, 0],
    ];
    for (const ys of cases) {
      const xs = ys.map((_, index) => index * 12);
      const min = Math.min(...ys);
      const max = Math.max(...ys);
      for (const y of sample(xs, ys)) {
        expect(y).toBeGreaterThanOrEqual(min - 1e-9);
        expect(y).toBeLessThanOrEqual(max + 1e-9);
      }
    }
  });

  it("never dips below zero on a non-negative series (no phantom negative spend)", () => {
    const ys = [0, 0, 240, 0, 0, 0, 310, 0, 0];
    const xs = ys.map((_, index) => index * 20);
    for (const y of sample(xs, ys)) expect(y).toBeGreaterThanOrEqual(-1e-9);
  });

  it("flattens tangents at local extrema", () => {
    const tangents = monotoneTangents([0, 1, 2], [0, 10, 0]);
    expect(tangents[1]).toBe(0);
  });

  it("passes exactly through every sample", () => {
    const xs = [0, 10, 20, 30];
    const ys = [5, 40, 12, 33];
    const segments = monotoneSegments(xs, ys);
    expect(segments).toHaveLength(3);
    segments.forEach((segment, index) => {
      expect(evaluateSegment(segment, 0)).toBeCloseTo(ys[index]!, 9);
      expect(evaluateSegment(segment, 1)).toBeCloseTo(ys[index + 1]!, 9);
    });
  });

  it("handles empty and single-sample input without throwing", () => {
    expect(monotoneTangents([], [])).toEqual([]);
    expect(monotoneSegments([5], [5])).toEqual([]);
    expect(smoothCurve([], [])).toBe("");
    expect(smoothCurve([5], [7])).toBe("M 5 7");
  });
});

describe("buildDayColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];

  it("splits by provider when byProvider is present", () => {
    const daily = [
      day("2026-08-01", { claude: { totalTokens: 100, costUsd: 1 }, codex: { totalTokens: 50, costUsd: 2 } }),
      day("2026-08-03", { claude: { totalTokens: 10, costUsd: 0.5 } }),
    ];
    const tokens = buildDayColumns(days, daily, "tokens");
    expect(tokens.combined).toBe(false);
    expect(tokens.columns.map((column) => column.total)).toEqual([150, 0, 10]);
    expect(tokens.providers).toEqual(["claude", "codex"]);

    const cost = buildDayColumns(days, daily, "cost");
    expect(cost.columns[0]!.values).toEqual({ claude: 1, codex: 2 });
    expect(cost.columns[0]!.total).toBe(3);
  });

  it("fills missing days with zero rather than dropping them", () => {
    const result = buildDayColumns(days, [day("2026-08-02", { claude: { totalTokens: 7, costUsd: 1 } })], "tokens");
    expect(result.columns).toHaveLength(3);
    expect(result.columns.map((column) => column.date)).toEqual(days);
    expect(result.columns[0]!.total).toBe(0);
  });

  it("yields exactly one combined series when byProvider is absent everywhere", () => {
    const daily = [
      day("2026-08-01", undefined, 400),
      day("2026-08-02", undefined, 0),
      day("2026-08-03", undefined, 900),
    ];
    const result = buildDayColumns(days, daily, "tokens");
    expect(result.combined).toBe(true);
    expect(result.providers).toEqual([USAGE_CHART_COMBINED_ID]);

    const series = selectTopSeries(result.columns, result.providers);
    expect(series).toHaveLength(1);
    expect(series[0]!.id).toBe(USAGE_CHART_COMBINED_ID);
    expect(series[0]!.total).toBe(1300);
  });

  // The page reads `combined` as "this host cannot report daily cost" and says
  // so in the UI. A range with no data at all is not evidence of that — it is
  // just empty — so it must not claim the host needs upgrading.
  it("is not combined for a range that is entirely empty", () => {
    const noPoints = buildDayColumns(days, [], "tokens");
    expect(noPoints.combined).toBe(false);
    // The single-band fallback still holds so the chart draws one flat baseline
    // instead of changing shape when the first non-zero day lands.
    expect(noPoints.providers).toEqual([USAGE_CHART_COMBINED_ID]);
    expect(noPoints.columns.map((column) => column.total)).toEqual([0, 0, 0]);

    const zeroPoints = buildDayColumns(
      days,
      days.map((date) => day(date, undefined, 0)),
      "tokens",
    );
    expect(zeroPoints.combined).toBe(false);
    expect(zeroPoints.providers).toEqual([USAGE_CHART_COMBINED_ID]);

    // One non-zero flat day is enough to make the split-less claim true again.
    expect(buildDayColumns(days, [day("2026-08-02", undefined, 5)], "tokens").combined).toBe(true);
    // ...including in cost mode, where a split-less host has nothing to plot.
    expect(buildDayColumns(days, [day("2026-08-02", undefined, 5)], "cost").combined).toBe(true);
  });

  it("uses the split as soon as any day in the range carries one", () => {
    const daily = [
      day("2026-08-01", undefined, 400),
      day("2026-08-02", { claude: { totalTokens: 60, costUsd: 1 } }, 60),
    ];
    const result = buildDayColumns(days, daily, "tokens");
    expect(result.combined).toBe(false);
    expect(result.providers).toEqual(["claude"]);
    // The flat-only day contributes nothing to a split series rather than being
    // silently attributed to whichever provider happened to be first.
    expect(result.columns[0]!.total).toBe(0);
  });

  it("does not throw on an empty range or a single-day range", () => {
    expect(() => buildDayColumns([], [], "cost")).not.toThrow();
    const empty = buildDayColumns([], [], "cost");
    expect(empty.columns).toEqual([]);
    expect(selectTopSeries(empty.columns, empty.providers)).toEqual([]);

    const single = buildDayColumns(
      ["2026-08-01"],
      [day("2026-08-01", { claude: { totalTokens: 5, costUsd: 0.25 } })],
      "cost",
    );
    expect(single.columns).toHaveLength(1);
    expect(single.columns[0]!.total).toBe(0.25);
  });

  it("ignores negative and non-finite values", () => {
    const daily = [
      day("2026-08-01", {
        claude: { totalTokens: -50, costUsd: Number.NaN },
        codex: { totalTokens: 20, costUsd: 3 },
      }),
    ];
    const result = buildDayColumns(days, daily, "tokens");
    expect(result.columns[0]!.values).toEqual({ codex: 20 });
  });
});

describe("selectTopSeries", () => {
  const makeColumns = (totals: Record<string, number>) => [
    { date: "2026-08-01", values: { ...totals }, total: Object.values(totals).reduce((a, b) => a + b, 0) },
  ];

  it("keeps the top N and merges the tail into one Other series", () => {
    const columns = makeColumns({ a: 100, b: 90, c: 80, d: 70, e: 60, f: 5 });
    const series = selectTopSeries(columns, ["a", "b", "c", "d", "e", "f"], 4);
    expect(series.map((entry) => entry.id)).toEqual(["a", "b", "c", "d", USAGE_CHART_OTHER_ID]);
    const other = series[4]!;
    expect(other.merged).toBe(true);
    expect(other.members).toEqual(["e", "f"]);
    expect(other.total).toBe(65);
  });

  it("adds no Other series when the provider count fits", () => {
    const columns = makeColumns({ a: 3, b: 2 });
    const series = selectTopSeries(columns, ["a", "b"], 4);
    expect(series).toHaveLength(2);
    expect(series.every((entry) => !entry.merged)).toBe(true);
  });

  it("breaks ties on provider id so ordering is stable across refreshes", () => {
    const columns = makeColumns({ zeta: 10, alpha: 10, mid: 10, beta: 10, omega: 10 });
    const first = selectTopSeries(columns, ["zeta", "alpha", "mid", "beta", "omega"], 4);
    const shuffled = selectTopSeries(columns, ["omega", "mid", "beta", "zeta", "alpha"], 4);
    expect(first.map((entry) => entry.id)).toEqual(shuffled.map((entry) => entry.id));
    expect(first.map((entry) => entry.id)).toEqual([
      "alpha",
      "beta",
      "mid",
      "omega",
      USAGE_CHART_OTHER_ID,
    ]);
    expect(first[4]!.members).toEqual(["zeta"]);
  });

  it("sums merged members per day, not just over the range", () => {
    const columns: UsageDayColumn[] = [
      { date: "d1", values: { a: 10, e: 1, f: 2 }, total: 13 },
      { date: "d2", values: { a: 10, e: 5 }, total: 15 },
    ];
    const series = selectTopSeries(columns, ["a", "e", "f"], 1);
    const other = series[1]!;
    expect(seriesValue(columns[0]!, other)).toBe(3);
    expect(seriesValue(columns[1]!, other)).toBe(5);
  });

  it("returns nothing for an empty range", () => {
    expect(selectTopSeries([], [])).toEqual([]);
  });
});

describe("scale + geometry", () => {
  const columns = [
    { date: "d1", values: { a: 100, b: 90 }, total: 190 },
    { date: "d2", values: { a: 40, b: 10 }, total: 50 },
  ];
  const series = selectTopSeries(columns, ["a", "b"], 4);

  it("scales to the largest single provider-day, not the largest daily sum", () => {
    expect(computePeak(columns, series)).toBe(100);
    const geometry = buildGeometry(columns, series, 600, 220);
    expect(geometry.max).toBe(100);
    expect(geometry.max).toBeLessThan(190);
  });

  it("never draws a point above the top of the plot", () => {
    const geometry = buildGeometry(columns, series, 600, 220);
    const yFor = (value: number) =>
      geometry.plot.top + geometry.plot.height * (1 - value / geometry.max);
    expect(yFor(100)).toBeGreaterThanOrEqual(geometry.plot.top - 1e-9);
  });

  it("produces a path per series and closes each area on the baseline", () => {
    const geometry = buildGeometry(columns, series, 600, 220);
    expect(geometry.paths).toHaveLength(series.length);
    for (const path of geometry.paths) {
      expect(path.line.startsWith("M ")).toBe(true);
      expect(path.area.endsWith("Z")).toBe(true);
    }
  });

  it("handles a single-day range without throwing or dividing by zero", () => {
    const single = [{ date: "d1", values: { a: 5 }, total: 5 }];
    const singleSeries = selectTopSeries(single, ["a"], 4);
    const geometry = buildGeometry(single, singleSeries, 600, 220);
    expect(geometry.xs).toHaveLength(1);
    expect(Number.isFinite(geometry.xs[0]!)).toBe(true);
    expect(geometry.paths[0]!.area).toContain("Z");
  });

  it("handles an empty range without throwing", () => {
    expect(() => buildGeometry([], [], 600, 220)).not.toThrow();
    const geometry = buildGeometry([], [], 600, 220);
    expect(geometry.xs).toEqual([]);
    expect(geometry.max).toBe(1);
  });

  it("survives a zero-width container", () => {
    expect(() => buildGeometry(columns, series, 0, 0)).not.toThrow();
    const geometry = buildGeometry(columns, series, 0, 0);
    expect(geometry.plot.width).toBeGreaterThan(0);
    expect(geometry.plot.height).toBeGreaterThan(0);
  });
});

// The page-wide provider highlight has to survive the chart's own reshaping of
// the provider list (top-N plus a merged "Other"). Both edges below produced a
// visibly wrong chart before `resolveHighlightedSeriesId` existed.
describe("resolveHighlightedSeriesId", () => {
  const series = [
    { id: "claude", label: "claude", total: 10, merged: false, members: ["claude"] },
    {
      id: USAGE_CHART_OTHER_ID,
      label: "Other",
      total: 4,
      merged: true,
      members: ["cursor", "droid"],
    },
  ];

  it("resolves a provider folded into the merged tail to that tail", () => {
    // Comparing ids directly dimmed the very band the provider is drawn in.
    expect(resolveHighlightedSeriesId(series, "droid")).toBe(USAGE_CHART_OTHER_ID);
  });

  it("resolves a drawn provider to itself", () => {
    expect(resolveHighlightedSeriesId(series, "claude")).toBe("claude");
  });

  it("resolves a provider the chart does not draw to nothing", () => {
    // Not `series[0]` and not `null`-because-unhighlighted: the caller must be
    // able to tell "highlight nothing" from "highlight everything else", or an
    // unplotted provider greys out the whole chart.
    expect(resolveHighlightedSeriesId(series, "gemini")).toBeNull();
    expect(resolveHighlightedSeriesId(series, null)).toBeNull();
  });
});
