import { useEffect, useRef, useSyncExternalStore } from "react";
import { applyScheduledLook, applyScheduleSlot } from "../../state/appStore";
import { activeSlotAt, dueSlot, readAppearanceSchedule, subscribeAppearanceSchedule } from "../../theme/appearanceSchedule";

/** Until the next slot starts, or the next whole hour if that is sooner. */
function nextCheckDelay(now: number, endsAt: number | null): number {
  const nextHour = new Date(now);
  nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
  const until = Math.min(endsAt == null ? Infinity : Math.max(endsAt - now, 0), nextHour.getTime() - now);
  return Math.max(until + 250, 1000);
}

/**
 * Runs the appearance schedule in this window: one timer to the next slot
 * start (and at each whole hour, so a clock or time zone change, or a start
 * that falls in a skipped daylight-saving hour, is caught), and a
 * check whenever the window comes back into view, since timers drift while a
 * computer sleeps. A slot that began while ADE was closed is applied before
 * the first paint by `appStore`.
 *
 * Several windows run this. The first to see a slot begin applies it and
 * records it; the others, once they see that slot's start pass, paint the
 * same slot without saving it again. A window opened later keeps whatever look
 * is saved, so a change made by hand still holds until the next slot.
 */
export function AppearanceScheduleHost() {
  const schedule = useSyncExternalStore(subscribeAppearanceSchedule, readAppearanceSchedule);
  // Timing only depends on whether it is on and where the slots start.
  const timingKey = schedule.enabled ? schedule.slots.map((slot) => `${slot.id}@${slot.start}`).join(",") : "";
  // The slot in charge at this window's last check, and when it ends. Null
  // until the first check, so a window that opens keeps the saved look; once
  // the schedule is seen off, any slot that later takes charge counts as new.
  const seenRef = useRef<{ slotId: string; endsAt: number } | null>(null);

  useEffect(() => {
    if (!timingKey) {
      seenRef.current = { slotId: "", endsAt: 0 };
      return;
    }
    let timer: number | undefined;
    const check = () => {
      window.clearTimeout(timer);
      const now = Date.now();
      const current = readAppearanceSchedule();
      const active = activeSlotAt(current.slots, now);
      if (active && current.enabled) {
        const due = dueSlot(current, now);
        if (due) {
          applyScheduleSlot(due);
        } else {
          const seen = seenRef.current;
          // Another window applied a slot that took charge since the last check: its
          // start passed, or the schedule was turned on or changed there. Moving the
          // time of the slot in charge is neither, so a change by hand survives it.
          if (seen && (now >= seen.endsAt || seen.slotId !== active.slot.id)) {
            applyScheduledLook(active.slot.look, { persist: false });
          }
        }
        seenRef.current = { slotId: active.slot.id, endsAt: active.endsAt };
      }
      timer = window.setTimeout(check, nextCheckDelay(now, active?.endsAt ?? null));
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
