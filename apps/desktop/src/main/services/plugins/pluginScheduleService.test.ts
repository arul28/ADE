import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isPluginBudgetExceeded,
  PluginSdkError,
  PLUGIN_SCHEDULES_MAX_PER_PLUGIN,
} from "../../../shared/plugins/sdk";
import type { Logger } from "../logging/logger";
import { createPluginScheduleService } from "./pluginScheduleService";

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

const tempDirs: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-schedules-"));
  tempDirs.push(dir);
  return path.join(dir, "schedules.json");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const NOON = Date.parse("2026-08-13T12:00:00.000Z");

type Invocation = { pluginId: string; action: string; args: Record<string, unknown> };

function createService(overrides?: {
  filePath?: string;
  now?: () => number;
  invoke?: (input: Invocation) => Promise<unknown>;
}): {
  service: ReturnType<typeof createPluginScheduleService>;
  calls: Invocation[];
  filePath: string;
} {
  const calls: Invocation[] = [];
  const filePath = overrides?.filePath ?? tempFile();
  const service = createPluginScheduleService({
    filePath,
    logger: silentLogger(),
    now: overrides?.now ?? (() => NOON),
    invoke: overrides?.invoke ?? (async (input) => {
      calls.push(input);
      return null;
    }),
  });
  return { service, calls, filePath };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PluginSdkError) return error.code;
    throw error;
  }
  throw new Error("Expected the scheduler to refuse this call.");
}

describe("createPluginScheduleService create", () => {
  it("creates a one-shot and a recurring schedule with a next run time", () => {
    const { service } = createService();

    const once = service.create("graph", { action: "sync", delaySeconds: 300 });
    const cron = service.create("graph", { action: "report", cron: "0 9 * * *" });

    expect(once.kind).toBe("once");
    expect(once.pluginId).toBe("graph");
    expect(Date.parse(once.nextRunAt!)).toBe(NOON + 300_000);
    expect(cron.kind).toBe("cron");
    expect(cron.cron).toBe("0 9 * * *");
    expect(cron.nextRunAt).not.toBeNull();
  });

  it("refuses zero or several timing expressions rather than picking a winner", () => {
    const { service } = createService();

    expect(codeOf(() => service.create("graph", { action: "sync" }))).toBe("invalid_args");
    expect(codeOf(() => service.create("graph", {
      action: "sync",
      cron: "0 9 * * *",
      delaySeconds: 300,
    }))).toBe("invalid_args");
  });

  it("refuses a delay under the floor, a past runAt and an unparseable cron", () => {
    const { service } = createService();

    // The floor exists for delaySeconds: a one-second schedule is a busy loop
    // with a persistence file attached.
    expect(codeOf(() => service.create("graph", { action: "sync", delaySeconds: 5 }))).toBe("invalid_args");
    expect(codeOf(() => service.create("graph", {
      action: "sync",
      runAt: "2020-01-01T00:00:00Z",
    }))).toBe("invalid_args");
    expect(codeOf(() => service.create("graph", { action: "sync", cron: "not a cron" }))).toBe("invalid_args");
    expect(codeOf(() => service.create("graph", { action: "", delaySeconds: 300 }))).toBe("invalid_args");
  });

  it("refuses past the per-plugin quota, counting live rows only", () => {
    const { service } = createService();

    for (let index = 0; index < PLUGIN_SCHEDULES_MAX_PER_PLUGIN; index += 1) {
      service.create("graph", { action: "sync", delaySeconds: 300 + index });
    }

    let refusal: unknown;
    try {
      service.create("graph", { action: "sync", delaySeconds: 999 });
    } catch (error) {
      refusal = error;
    }
    expect(isPluginBudgetExceeded(refusal)).toBe(true);
    // The quota is per plugin, not per machine.
    expect(() => service.create("other", { action: "sync", delaySeconds: 300 })).not.toThrow();
  });

  it("refuses an args frame past its ceiling", () => {
    const { service } = createService();

    expect(codeOf(() => service.create("graph", {
      action: "sync",
      delaySeconds: 300,
      args: { blob: "x".repeat(5000) },
    }))).toBe("plugin_budget_exceeded");
  });
});

describe("createPluginScheduleService list and delete", () => {
  it("never lists or deletes another plugin's schedules", () => {
    const { service } = createService();
    const mine = service.create("graph", { action: "sync", delaySeconds: 300 });
    service.create("other", { action: "sync", delaySeconds: 300 });

    expect(service.list("graph").map((row) => row.id)).toEqual([mine.id]);

    // A guessed id from another plugin must not cancel its work.
    service.delete("other", mine.id);
    expect(service.list("graph")).toHaveLength(1);

    service.delete("graph", mine.id);
    expect(service.list("graph")).toHaveLength(0);
  });

  it("treats deleting an unknown id as a no-op, not an error", () => {
    const { service } = createService();

    // A plugin cleaning up after itself should not have to race the scheduler
    // to find out whether a one-shot already fired.
    expect(() => service.delete("graph", "plugin:graph:gone")).not.toThrow();
  });

  it("survives a restart", () => {
    const filePath = tempFile();
    const first = createService({ filePath });
    const created = first.service.create("graph", { action: "sync", delaySeconds: 300 });
    first.service.dispose();

    const second = createService({ filePath });

    expect(second.service.list("graph").map((row) => row.id)).toEqual([created.id]);
  });
});

describe("createPluginScheduleService firing", () => {
  it("invokes the plugin's own action when a schedule comes due, then drops the one-shot", async () => {
    vi.useFakeTimers();
    try {
      const { service, calls } = createService({ now: () => Date.now() });
      service.create("graph", { action: "sync", delaySeconds: 60, args: { full: true } });

      await vi.advanceTimersByTimeAsync(61_000);

      expect(calls).toEqual([{ pluginId: "graph", action: "sync", args: { full: true } }]);
      // A fired one-shot must not keep holding a quota slot for a job that
      // will never run again.
      expect(service.list("graph")).toHaveLength(0);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a recurring schedule armed and records why the last run failed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T08:59:00.000Z"));
    try {
      const { service } = createService({
        now: () => Date.now(),
        invoke: async () => {
          throw new Error("the report service is offline");
        },
      });
      service.create("graph", { action: "report", cron: "* * * * *" });

      await vi.advanceTimersByTimeAsync(61_000);

      const [row] = service.list("graph");
      // Cancelling a schedule because its action threw would make the user's
      // eventual fix look like it did not work.
      expect(row?.nextRunAt).not.toBeNull();
      expect(row?.lastRunAt).toBeTruthy();
      expect(row?.lastError).toContain("offline");
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire after dispose", async () => {
    vi.useFakeTimers();
    try {
      const { service, calls } = createService({ now: () => Date.now() });
      service.create("graph", { action: "sync", delaySeconds: 60 });

      service.dispose();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createPluginScheduleService uninstall cleanup", () => {
  it("removes every schedule the uninstalled plugin owned and nobody else's", () => {
    const { service } = createService();
    service.create("graph", { action: "sync", delaySeconds: 300 });
    service.create("graph", { action: "report", cron: "0 9 * * *" });
    service.create("other", { action: "sync", delaySeconds: 300 });

    expect(service.removeAllForPlugin("graph")).toBe(2);

    expect(service.list("graph")).toHaveLength(0);
    expect(service.list("other")).toHaveLength(1);
  });

  it("leaves nothing behind that could fire after the plugin is gone", async () => {
    vi.useFakeTimers();
    try {
      const { service, calls } = createService({ now: () => Date.now() });
      service.create("graph", { action: "sync", delaySeconds: 60 });

      service.removeAllForPlugin("graph");
      await vi.advanceTimersByTimeAsync(120_000);

      // This is the whole point of owning schedules rather than borrowing
      // ADE's: an uninstalled plugin cannot still be woken on a timer.
      expect(calls).toHaveLength(0);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the removal, so a restart does not resurrect them", () => {
    const filePath = tempFile();
    const first = createService({ filePath });
    first.service.create("graph", { action: "sync", delaySeconds: 300 });
    first.service.removeAllForPlugin("graph");
    first.service.dispose();

    const second = createService({ filePath });

    expect(second.service.list("graph")).toHaveLength(0);
  });
});
