import { useEffect, useRef, useSyncExternalStore } from "react";
import { applyScheduledLook } from "../../state/appStore";
import {
  activeSlotAt,
  dueSlot,
  markSlotApplied,
  readAppearanceSchedule,
  subscribeAppearanceSchedule,
} from "../../theme/appearanceSchedule";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Runs the appearance schedule in this window: one timer to the next slot
 * start (capped at an hour, so a clock or time zone change is caught), and a
 * check whenever the window comes back into view, since timers drift while a
 * computer sleeps. A slot that began while ADE was closed is applied before
 * the first paint by `appStore`.
 *
 * Several windows run this. The first to see a slot begin applies it and
 * records it; the others then apply the same slot to themselves without
 * recording again. A window opened later keeps whatever look is saved, so a
 * change made by hand still holds until the next slot.
 */
export function AppearanceScheduleHost() {
  const schedule = useSyncExternalStore(subscribeAppearanceSchedule, readAppearanceSchedule);
  // Timing only depends on whether it is on and where the slots start.
  const timingKey = schedule.enabled ? schedule.slots.map((slot) => `${slot.id}@${slot.start}`).join(",") : "";
  // The slot run this window last showed or deferred to; null until the first check.
  const seenRunRef = useRef<string | null>(null);

  useEffect(() => {
    if (!timingKey) {
      seenRunRef.current = null;
      return;
    }
    let timer: number | undefined;
    const check = () => {
      window.clearTimeout(timer);
      const now = Date.now();
      const current = readAppearanceSchedule();
      const active = activeSlotAt(current.slots, now);
      if (active && current.enabled) {
        const run = `${active.slot.id}@${active.startedAt}`;
        const due = dueSlot(current, now);
        if (due) {
          applyScheduledLook(due.slot.look);
          markSlotApplied(due);
        } else if (seenRunRef.current !== null && seenRunRef.current !== run) {
          // Another window applied this slot first.
          applyScheduledLook(active.slot.look);
        }
        seenRunRef.current = run;
      }
      const wait = active ? Math.min(Math.max(active.endsAt - now + 250, 1000), HOUR_MS) : HOUR_MS;
      timer = window.setTimeout(check, wait);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [timingKey]);

  return null;
}
