import { describe, expect, it } from "vitest";
import {
  decodeActiveDayKeys,
  encodeActiveDayBits,
  mergeLaneUsageTombstones,
  type LaneUsageTombstoneRow,
} from "./laneUsageTombstone";

function row(patch: Partial<LaneUsageTombstoneRow> = {}): LaneUsageTombstoneRow {
  return {
    project_id: "proj",
    lane_id: "lane",
    created_day: "2026-03-01",
    deleted_day: "2026-03-10",
    lanes_created: 1,
    chat_sessions: 0,
    terminal_sessions: 0,
    files_changed: 0,
    insertions: 0,
    deletions: 0,
    commits_created: 0,
    push_operations: 0,
    pr_landings: 0,
    artifacts_captured: 0,
    longest_session_ms: 0,
    first_active_day: null,
    last_active_day: null,
    active_day_bits: null,
    ...patch,
  };
}

describe("lane usage tombstone day bitmap", () => {
  it("round-trips a sparse day set", () => {
    const days = ["2026-03-01", "2026-03-02", "2026-03-09", "2026-03-31"];
    const encoded = encodeActiveDayBits(days);
    expect(encoded.firstDay).toBe("2026-03-01");
    expect(encoded.lastDay).toBe("2026-03-31");
    expect(decodeActiveDayKeys(encoded.firstDay, encoded.bits)).toEqual(days);
  });

  it("stays tiny: a month-long lane encodes to a handful of characters", () => {
    const days: string[] = [];
    for (let day = 1; day <= 28; day += 1) days.push(`2026-03-${String(day).padStart(2, "0")}`);
    const encoded = encodeActiveDayBits(days);
    // 28 days -> 4 bytes -> 8 hex characters.
    expect(encoded.bits).toHaveLength(8);
    expect(decodeActiveDayKeys(encoded.firstDay, encoded.bits)).toHaveLength(28);
  });

  it("survives a DST boundary without shifting days", () => {
    const days = ["2026-03-07", "2026-03-08", "2026-03-09", "2026-11-01", "2026-11-02"];
    const encoded = encodeActiveDayBits(days);
    expect(decodeActiveDayKeys(encoded.firstDay, encoded.bits)).toEqual(days);
  });

  it("ignores unparseable days rather than corrupting the anchor", () => {
    const encoded = encodeActiveDayBits(["", "not-a-day", "2026-02-30", "2026-03-05"]);
    expect(decodeActiveDayKeys(encoded.firstDay, encoded.bits)).toEqual(["2026-03-05"]);
  });

  it("caps an oversized bitmap at the span the encoder is allowed to write", () => {
    // The encoder clamps to a 4096-day span (512 bytes). This value arrives
    // over CRR from a peer, so a corrupt or hostile row is not bound by that;
    // an uncapped decode expanded to two day strings per byte on every read
    // and fed the synthetic days straight into the streak.
    const oversized = "ff".repeat(4_096);
    const decoded = decodeActiveDayKeys("2026-03-01", oversized);
    expect(decoded).toHaveLength(4_096);
    // The encoder's own maximum round-trips untouched.
    const maxSpan = encodeActiveDayBits(["2015-01-01", "2026-03-01"]);
    expect(decodeActiveDayKeys(maxSpan.firstDay, maxSpan.bits).length).toBeLessThanOrEqual(4_096);
  });

  it("returns nothing for an empty day set", () => {
    expect(encodeActiveDayBits([])).toEqual({ firstDay: null, lastDay: null, bits: null });
    expect(decodeActiveDayKeys(null, null)).toEqual([]);
  });
});

describe("lane usage tombstone merge", () => {
  it("is idempotent: merging the same tombstone twice never doubles a counter", () => {
    const first = row({
      chat_sessions: 3,
      terminal_sessions: 2,
      insertions: 120,
      commits_created: 4,
      first_active_day: "2026-03-01",
      last_active_day: "2026-03-03",
      active_day_bits: encodeActiveDayBits(["2026-03-01", "2026-03-03"]).bits,
    });
    const once = mergeLaneUsageTombstones(null, first);
    const twice = mergeLaneUsageTombstones(once, first);
    expect(twice).toEqual(once);
    expect(twice.chat_sessions).toBe(3);
    expect(twice.commits_created).toBe(4);
  });

  it("takes the maximum counter and the union of days when a retry sees fewer rows", () => {
    const full = row({
      chat_sessions: 5,
      insertions: 90,
      first_active_day: "2026-03-01",
      last_active_day: "2026-03-02",
      active_day_bits: encodeActiveDayBits(["2026-03-01", "2026-03-02"]).bits,
    });
    // A retry after a partial cascade sees fewer sessions but a day the first
    // pass had already lost.
    const partial = row({
      chat_sessions: 1,
      insertions: 0,
      deleted_day: "2026-03-11",
      first_active_day: "2026-03-05",
      last_active_day: "2026-03-05",
      active_day_bits: encodeActiveDayBits(["2026-03-05"]).bits,
    });
    const merged = mergeLaneUsageTombstones(full, partial);
    expect(merged.chat_sessions).toBe(5);
    expect(merged.insertions).toBe(90);
    // The earliest recorded deletion wins; a retry does not restamp the lane.
    expect(merged.deleted_day).toBe("2026-03-10");
    expect(decodeActiveDayKeys(merged.first_active_day, merged.active_day_bits)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-05",
    ]);
  });

  it("does not let an absorbed duplicate erase a lane that already counted as created", () => {
    const created = row({ lanes_created: 1 });
    const absorbed = row({ lanes_created: 0 });
    expect(mergeLaneUsageTombstones(created, absorbed).lanes_created).toBe(1);
  });
});
