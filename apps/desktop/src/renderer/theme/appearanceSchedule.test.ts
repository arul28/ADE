import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE_PREFERENCES } from "../scene/scenePreferences";
import {
  activeSlotAt,
  dueSlot,
  normalizeAppearanceSchedule,
  withSlotStart,
  type AppearanceSchedule,
  type ScheduledLook,
  type ScheduleSlot,
} from "./appearanceSchedule";

// Local clock times, so the rules are checked on the wall clock the user sees.
// Day 0 is the day the schedule is looked at; negative offsets are earlier days.
const day = (offset: number, hours: number, minutes = 0) => new Date(2026, 10, 9 + offset, hours, minutes).getTime();

const look: ScheduledLook = {
  themeId: "dark",
  followsSystem: false,
  scene: DEFAULT_SCENE_PREFERENCES,
  sansFont: "geist",
  monoFont: "jetbrains",
};

const slot = (id: string, start: number): ScheduleSlot => ({ id, start, name: "", look });
const MORNING = slot("morning", 8 * 60);
const EVENING = slot("evening", 18 * 60);
const ALL_DAY = slot("all", 9 * 60);

function schedule(
  slots: ScheduleSlot[],
  lastApplied: AppearanceSchedule["lastApplied"] = null,
  enabled = true,
): AppearanceSchedule {
  return { enabled, slots, lastApplied };
}

/** The id of the slot that would be applied now, or null when nothing is due. */
function dueId(value: AppearanceSchedule, now: number): string | null {
  return dueSlot(value, now)?.slot.id ?? null;
}

describe("appearance schedule: which slot is due, and when its run began and ends", () => {
  it.each([
    ["before the first start, yesterday's last slot is due when never applied", schedule([MORNING, EVENING]), day(0, 7), "evening"],
    ["yesterday's last slot applied yesterday holds before the first start", schedule([MORNING, EVENING], { slotId: "evening", at: day(-1, 18) }), day(0, 7), null],
    ["the first start of the day makes that slot due", schedule([MORNING, EVENING], { slotId: "evening", at: day(-1, 18) }), day(0, 8, 30), "morning"],
    ["a change by hand holds until the next start", schedule([MORNING, EVENING], { slotId: "morning", at: day(0, 8) }), day(0, 17, 59), null],
    ["the next start makes the next slot due", schedule([MORNING, EVENING], { slotId: "morning", at: day(0, 8) }), day(0, 18), "evening"],
    ["a slot applied on an earlier day is due again", schedule([MORNING, EVENING], { slotId: "morning", at: day(-1, 8) }), day(0, 9), "morning"],
    ["an applied slot that no longer exists makes the slot in charge due", schedule([MORNING, EVENING], { slotId: "gone", at: day(0, 8) }), day(0, 12), "morning"],
    ["a disabled schedule is never due", schedule([MORNING, EVENING], null, false), day(0, 12), null],
    ["an empty schedule is never due", schedule([]), day(0, 12), null],
    ["one slot is due at its time today", schedule([ALL_DAY]), day(0, 10), "all"],
    ["one slot holds for the rest of its run", schedule([ALL_DAY], { slotId: "all", at: day(0, 9) }), day(0, 10), null],
    ["one slot holds in the early hours, since its run began yesterday and was applied", schedule([ALL_DAY], { slotId: "all", at: day(-1, 9) }), day(0, 8), null],
    ["one slot comes due again the next day at its time", schedule([ALL_DAY], { slotId: "all", at: day(0, 9) }), day(1, 10), "all"],
    ["one slot does not come due again before its time the next day", schedule([ALL_DAY], { slotId: "all", at: day(0, 9) }), day(1, 8), null],
  ])("dueSlot: %s", (_label, value, now, expected) => {
    expect(dueId(value, now)).toBe(expected);
  });

  it.each([
    ["before the first start: began yesterday at the last start, ends at today's first", [MORNING, EVENING], day(0, 7), day(-1, 18), day(0, 8), "evening"],
    ["between two starts: began at the first, ends at the second", [MORNING, EVENING], day(0, 12), day(0, 8), day(0, 18), "morning"],
    ["after the last start: ends at tomorrow's first start", [MORNING, EVENING], day(0, 20), day(0, 18), day(1, 8), "evening"],
    ["one slot before its start: began yesterday, ends today", [ALL_DAY], day(0, 7), day(-1, 9), day(0, 9), "all"],
    ["one slot after its start: began today, ends tomorrow at the same time", [ALL_DAY], day(0, 10), day(0, 9), day(1, 9), "all"],
  ])("activeSlotAt: %s", (_label, slots, now, startedAt, endsAt, slotId) => {
    expect(activeSlotAt(slots, now)).toMatchObject({ slot: { id: slotId }, startedAt, endsAt });
  });
});

describe("appearance schedule: moving a slot's time", () => {
  // At 10:00 the morning slot is in charge and was applied at 08:00.
  const applied = schedule([MORNING, EVENING], { slotId: "morning", at: day(0, 8) });
  const now = day(0, 10);

  it.each([
    ["moved earlier, the slot in charge stays applied", applied, "morning", 7 * 60, null],
    ["moved later but still past, the slot in charge stays applied", applied, "morning", 9 * 60 + 30, null],
    ["moved after now, control passes to the previous slot, which is due", applied, "morning", 11 * 60, "evening"],
    ["moving the other slot leaves the slot in charge applied", applied, "evening", 20 * 60, null],
    ["moving the slot in charge when nothing was applied keeps it due", schedule([MORNING, EVENING]), "morning", 9 * 60, "morning"],
  ])("withSlotStart: %s", (_label, value, id, start, expected) => {
    expect(dueId(withSlotStart(value, id, start, now), now)).toBe(expected);
  });
});

describe("appearance schedule: stored values are normalized", () => {
  const raw = (id: string, start: unknown, themeId: unknown = "dark") => ({
    id,
    start,
    name: "",
    look: { themeId, followsSystem: false },
  });
  const eight = Array.from({ length: 10 }, (_, i) => raw(`s${i}`, i * 60));

  it.each([
    ["slots are sorted by start", [raw("b", 600), raw("a", 120)], null, ["a", "b"], null],
    ["the first of two slots with the same start is kept", [raw("a", 480), raw("b", 480)], null, ["a"], null],
    ["starts outside the day or not numbers are dropped, and a start that rounds into the day is kept", [raw("a", 1440), raw("b", -1), raw("c", "480"), raw("d", null), raw("e", 1439.4)], null, ["e"], null],
    ["a slot without a theme is dropped", [raw("a", 480, "  "), raw("b", 600)], null, ["b"], null],
    ["at most eight slots are kept", eight, null, Array.from({ length: 8 }, (_, i) => `s${i}`), null],
    ["a complete lastApplied record is kept", [], { slotId: "a", at: 123 }, [], { slotId: "a", at: 123 }],
    ["a lastApplied record without a numeric time is dropped", [], { slotId: "a", at: "123" }, [], null],
  ])("normalizeAppearanceSchedule: %s", (_label, slots, lastApplied, expectedIds, expectedLast) => {
    const value = normalizeAppearanceSchedule({ enabled: true, slots, lastApplied });
    expect(value.slots.map((entry) => entry.id)).toEqual(expectedIds);
    expect(value.lastApplied).toEqual(expectedLast);
  });
});
