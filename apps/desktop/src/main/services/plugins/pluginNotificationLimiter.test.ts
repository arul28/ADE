import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isPluginBudgetExceeded,
  PLUGIN_NOTIFICATIONS_PER_BURST,
  PLUGIN_NOTIFICATIONS_PER_DAY,
  PLUGIN_NOTIFICATION_BURST_WINDOW_MS,
} from "../../../shared/plugins/sdk";
import type { Logger } from "../logging/logger";
import { createPluginNotificationLimiter } from "./pluginNotificationLimiter";

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

const tempDirs: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-notify-"));
  tempDirs.push(dir);
  return path.join(dir, "notification-usage.json");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** A clock the test moves, so nothing here waits on real time. */
function clock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let value = startMs;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

const NOON = Date.parse("2026-08-13T12:00:00.000Z");

function reserveCode(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (isPluginBudgetExceeded(error)) {
      return (error as { detail?: { budget?: string } }).detail?.budget ?? "plugin_budget_exceeded";
    }
    throw error;
  }
  throw new Error("Expected the limiter to refuse this post.");
}

describe("createPluginNotificationLimiter", () => {
  it("allows a burst up to the ceiling and refuses the one past it", () => {
    const time = clock(NOON);
    const limiter = createPluginNotificationLimiter({
      filePath: tempFile(),
      logger: silentLogger(),
      now: time.now,
    });

    for (let index = 0; index < PLUGIN_NOTIFICATIONS_PER_BURST; index += 1) {
      limiter.reserve("graph");
    }

    expect(reserveCode(() => limiter.reserve("graph"))).toBe("notifications.burst");
  });

  it("lets the burst window roll forward without spending the day", () => {
    const time = clock(NOON);
    const limiter = createPluginNotificationLimiter({
      filePath: tempFile(),
      logger: silentLogger(),
      now: time.now,
    });

    for (let index = 0; index < PLUGIN_NOTIFICATIONS_PER_BURST; index += 1) {
      limiter.reserve("graph");
    }
    time.advance(PLUGIN_NOTIFICATION_BURST_WINDOW_MS + 1);

    // A plugin that waited is not still being punished for the earlier batch.
    expect(() => limiter.reserve("graph")).not.toThrow();
  });

  it("refuses past the daily ceiling even when the burst window is clear", () => {
    const time = clock(NOON);
    const limiter = createPluginNotificationLimiter({
      filePath: tempFile(),
      logger: silentLogger(),
      now: time.now,
    });

    for (let index = 0; index < PLUGIN_NOTIFICATIONS_PER_DAY; index += 1) {
      limiter.reserve("graph");
      time.advance(PLUGIN_NOTIFICATION_BURST_WINDOW_MS + 1);
    }

    // This is the ceiling that stops a slow drip, which is the failure a user
    // reports as "my phone will not stop".
    expect(reserveCode(() => limiter.reserve("graph"))).toBe("notifications.daily");
  });

  it("resets the day bucket at UTC midnight without a sweep", () => {
    const time = clock(NOON);
    const limiter = createPluginNotificationLimiter({
      filePath: tempFile(),
      logger: silentLogger(),
      now: time.now,
    });

    for (let index = 0; index < PLUGIN_NOTIFICATIONS_PER_DAY; index += 1) {
      limiter.reserve("graph");
      time.advance(PLUGIN_NOTIFICATION_BURST_WINDOW_MS + 1);
    }
    expect(reserveCode(() => limiter.reserve("graph"))).toBe("notifications.daily");

    // The machine need not have been running for the bucket to roll over.
    time.advance(24 * 60 * 60 * 1000);
    expect(() => limiter.reserve("graph")).not.toThrow();
  });

  it("counts each plugin separately", () => {
    const time = clock(NOON);
    const limiter = createPluginNotificationLimiter({
      filePath: tempFile(),
      logger: silentLogger(),
      now: time.now,
    });

    for (let index = 0; index < PLUGIN_NOTIFICATIONS_PER_BURST; index += 1) {
      limiter.reserve("graph");
    }

    expect(() => limiter.reserve("other")).not.toThrow();
  });

  it("survives a restart, so crashing the child does not refill the allowance", () => {
    const filePath = tempFile();
    const time = clock(NOON);
    const first = createPluginNotificationLimiter({ filePath, logger: silentLogger(), now: time.now });
    for (let index = 0; index < PLUGIN_NOTIFICATIONS_PER_DAY; index += 1) {
      first.reserve("graph");
      time.advance(PLUGIN_NOTIFICATION_BURST_WINDOW_MS + 1);
    }

    // A fresh limiter over the same file is what a restarted ADE gets. An
    // in-memory counter would hand the plugin a whole new day here.
    const second = createPluginNotificationLimiter({ filePath, logger: silentLogger(), now: time.now });

    expect(reserveCode(() => second.reserve("graph"))).toBe("notifications.daily");
  });

  it("starts clean rather than refusing everything when the ledger is corrupt", () => {
    const filePath = tempFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not json", "utf8");
    const limiter = createPluginNotificationLimiter({
      filePath,
      logger: silentLogger(),
      now: clock(NOON).now,
    });

    // Breaking a working feature to protect a backstop is the wrong trade.
    expect(() => limiter.reserve("graph")).not.toThrow();
  });

  it("drops a plugin's counters on uninstall", () => {
    const filePath = tempFile();
    const time = clock(NOON);
    const limiter = createPluginNotificationLimiter({ filePath, logger: silentLogger(), now: time.now });
    limiter.reserve("graph");

    limiter.forget("graph");

    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).plugins).toEqual({});
  });
});
