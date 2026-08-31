import { describe, expect, it } from "vitest";

import {
  DEFAULT_ELAPSED_AFTER_MS,
  describeToolActivity,
  formatElapsed,
  matchLabelKey,
  phaseForToolStatus,
  resolveActivityIcon,
  resolveActivityLabel,
  type ActivityLabelConfig,
} from "../src/activity/labels";
import type { ToolChipRow } from "../src/transcript/transcriptRows";

function chip(overrides: Partial<ToolChipRow> = {}): ToolChipRow {
  return {
    type: "tool_chip",
    id: "tool::t1::i1",
    tool: "server.tool",
    args: {},
    status: "running",
    turnId: "t1",
    ...overrides,
  };
}

describe("matchLabelKey", () => {
  it("prefers an exact key over any wildcard", () => {
    expect(matchLabelKey(["server.tool", "server.*", "*"], "server.tool")).toBe("server.tool");
  });

  it("prefers the longest matching wildcard prefix", () => {
    expect(matchLabelKey(["*", "server.*", "server.db.*"], "server.db.read")).toBe("server.db.*");
  });

  it("falls back to a bare star", () => {
    expect(matchLabelKey(["server.*", "*"], "billing.charge")).toBe("*");
  });

  it("returns null when nothing matches", () => {
    expect(matchLabelKey(["server.*"], "billing.charge")).toBeNull();
  });
});

describe("resolveActivityLabel", () => {
  const config: ActivityLabelConfig = {
    map: {
      "server.tool": { running: "Searching…", done: "Searched", error: "Search failed" },
      "billing.*": "Checking your billing…",
    },
    thinkingLabel: "Thinking…",
  };

  it("returns the phase-specific string from an object entry", () => {
    for (const [phase, expected] of [
      ["running", "Searching…"],
      ["done", "Searched"],
      ["error", "Search failed"],
    ] as const) {
      expect(
        resolveActivityLabel(
          { kind: "tool", tool: "server.tool", phase, event: chip({ tool: "server.tool" }) },
          config,
        ),
      ).toBe(expected);
    }
  });

  it("uses a bare string for running only, so a finished chip is not mislabelled", () => {
    const source = { kind: "tool", tool: "billing.charge", event: chip() } as const;
    expect(resolveActivityLabel({ ...source, phase: "running" }, config)).toBe("Checking your billing…");
    expect(resolveActivityLabel({ ...source, phase: "done" }, config)).toBeNull();
    expect(resolveActivityLabel({ ...source, phase: "error" }, config)).toBeNull();
  });

  it("lets resolve() win over the map", () => {
    const label = resolveActivityLabel(
      { kind: "tool", tool: "server.tool", phase: "running", event: chip() },
      { ...config, resolve: () => "Override" },
    );
    expect(label).toBe("Override");
  });

  it("falls through to the map when resolve() returns null", () => {
    const label = resolveActivityLabel(
      { kind: "tool", tool: "server.tool", phase: "running", event: chip() },
      { ...config, resolve: () => null },
    );
    expect(label).toBe("Searching…");
  });

  it("labels the thinking indicator", () => {
    expect(
      resolveActivityLabel({ kind: "thinking", tool: null, phase: "running", event: null }, config),
    ).toBe("Thinking…");
  });

  it("returns null with no config, so callers fall back to the raw name", () => {
    expect(
      resolveActivityLabel({ kind: "tool", tool: "server.tool", phase: "running", event: chip() }, undefined),
    ).toBeNull();
  });
});

describe("resolveActivityIcon", () => {
  it("honours the same wildcard matching as labels", () => {
    const icons = { "server.*": "server-icon", "*": "fallback-icon" };
    expect(resolveActivityIcon("server.tool", { icons })).toBe("server-icon");
    expect(resolveActivityIcon("billing.charge", { icons })).toBe("fallback-icon");
    expect(resolveActivityIcon(null, { icons })).toBeUndefined();
  });
});

describe("phaseForToolStatus", () => {
  it("maps every status onto a phase", () => {
    expect(phaseForToolStatus("running")).toBe("running");
    expect(phaseForToolStatus("failed")).toBe("error");
    expect(phaseForToolStatus("completed")).toBe("done");
    expect(phaseForToolStatus("interrupted")).toBe("done");
  });
});

describe("formatElapsed", () => {
  it("stays silent below the threshold so short calls never flash a timer", () => {
    expect(formatElapsed(0)).toBeNull();
    expect(formatElapsed(DEFAULT_ELAPSED_AFTER_MS - 1)).toBeNull();
  });

  it("appears at exactly the threshold", () => {
    expect(formatElapsed(DEFAULT_ELAPSED_AFTER_MS)).toBe("3s");
  });

  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(60_000)).toBe("1m");
    expect(formatElapsed(95_000)).toBe("1m 35s");
    expect(formatElapsed(3_600_000)).toBe("1h 0m");
    expect(formatElapsed(3_930_000)).toBe("1h 5m");
  });

  it("honours a custom threshold", () => {
    expect(formatElapsed(1000, 500)).toBe("1s");
    expect(formatElapsed(1000, 5000)).toBeNull();
  });
});

describe("describeToolActivity", () => {
  const config: ActivityLabelConfig = {
    map: { "server.*": { running: "Searching…", done: "Searched" } },
  };

  it("attaches an elapsed suffix only while running", () => {
    expect(describeToolActivity({ chip: chip(), config, elapsedMs: 5000 }).elapsed).toBe("5s");
    expect(
      describeToolActivity({ chip: chip({ status: "completed" }), config, elapsedMs: 5000 }).elapsed,
    ).toBeNull();
  });

  it("falls back to the raw tool name when nothing matches", () => {
    expect(describeToolActivity({ chip: chip({ tool: "Bash" }), config }).label).toBe("Bash");
  });
});
