import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKvDb, type AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { createPluginSyncMeter } from "./pluginSyncMeter";

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("plugin sync meter", () => {
  let root: string;
  let db: AdeDb;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-meter-"));
    db = await openKvDb(path.join(root, ".ade", "kv.sqlite"), createLogger());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function build(now: () => number) {
    return createPluginSyncMeter({
      db,
      now,
      // No real timer: the flush is driven explicitly so the test never races it.
      setInterval: () => ({ unref: () => {} }),
      clearInterval: () => {},
    });
  }

  it("accumulates in memory and only touches the database on flush", () => {
    const meter = build(() => Date.parse("2026-08-11T10:00:00.000Z"));
    meter.record("graph", "out", 100);
    meter.record("graph", "out", 50);
    meter.record("graph", "in", 20);

    // The chokepoints that call `record` run per frame on a synchronous SQLite
    // driver; a write there would put a disk round trip in every send.
    expect(db.all("select * from plugin_wire_meter_daily")).toHaveLength(0);

    meter.flush();
    const rows = db.all<{ direction: string; bytes: number; frames: number }>(
      "select direction, bytes, frames from plugin_wire_meter_daily order by direction",
    );
    expect(rows).toEqual([
      { direction: "in", bytes: 20, frames: 1 },
      { direction: "out", bytes: 150, frames: 2 },
    ]);
  });

  it("adds to an existing day rather than replacing it", () => {
    const meter = build(() => Date.parse("2026-08-11T10:00:00.000Z"));
    meter.record("graph", "out", 100);
    meter.flush();
    meter.record("graph", "out", 25);
    meter.flush();

    const row = db.get<{ bytes: number; frames: number }>(
      "select bytes, frames from plugin_wire_meter_daily where plugin_id = ? and direction = 'out'",
      ["graph"],
    );
    expect(row).toEqual({ bytes: 125, frames: 2 });
  });

  it("ignores untagged, zero, and non-finite frames", () => {
    const meter = build(() => Date.parse("2026-08-11T10:00:00.000Z"));
    meter.record("  ", "out", 100);
    meter.record("graph", "out", 0);
    meter.record("graph", "out", Number.NaN);
    meter.flush();
    expect(db.all("select * from plugin_wire_meter_daily")).toHaveLength(0);
  });

  it("summarizes a day window, flushing first so same-minute traffic is counted", () => {
    let nowMs = Date.parse("2026-08-01T10:00:00.000Z");
    const meter = build(() => nowMs);
    meter.record("graph", "out", 500);
    meter.flush();

    nowMs += 40 * DAY_MS;
    meter.record("graph", "out", 10);
    meter.record("video", "in", 90);

    // No explicit flush: a summary that reported zero for traffic recorded a
    // moment ago would read as a broken meter rather than a buffered one.
    const recent = meter.summary({ days: 7 });
    expect(recent.plugins).toEqual([
      { pluginId: "video", bytesIn: 90, bytesOut: 0, framesIn: 1, framesOut: 0 },
      { pluginId: "graph", bytesIn: 0, bytesOut: 10, framesIn: 0, framesOut: 1 },
    ]);

    // The 40-day-old row is outside the 7-day window but inside a 60-day one.
    const lifetime = meter.summary({ days: 60 });
    expect(lifetime.plugins[0]).toEqual({
      pluginId: "graph",
      bytesIn: 0,
      bytesOut: 510,
      framesIn: 0,
      framesOut: 2,
    });
    expect(lifetime.fromDay).toBe("2026-07-13");
    expect(lifetime.toDay).toBe("2026-09-10");

    const scoped = meter.summary({ days: 60, pluginId: "video" });
    expect(scoped.plugins.map((entry) => entry.pluginId)).toEqual(["video"]);
    meter.dispose();
  });

  it("flushes on dispose and stops recording afterwards", () => {
    const meter = build(() => Date.parse("2026-08-11T10:00:00.000Z"));
    meter.record("graph", "out", 42);
    meter.dispose();
    expect(db.get("select bytes from plugin_wire_meter_daily")).toEqual({ bytes: 42 });

    meter.record("graph", "out", 1_000);
    meter.flush();
    expect(db.get("select bytes from plugin_wire_meter_daily")).toEqual({ bytes: 42 });
  });
});
