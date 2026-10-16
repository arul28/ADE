/**
 * A blocking turn ended because its chat went away (ended, deleted, disposed),
 * not because the agent failed. Retrying it would start a new agent.
 */
export class SessionTurnAbandonedError extends Error {}

/** Largest delay a Node timer honors; anything longer fires immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A turn limit in ms: at least 15 s, and never past what a timer can hold. */
export function clampTurnTimerMs(ms: number): number {
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(15_000, Math.floor(ms)));
}

/** An event stamped with a different turn than the one the collector is waiting on. */
export function isForeignTurnEvent(
  collectorTurnId: string | null | undefined,
  eventTurnId: string | null | undefined,
): boolean {
  return Boolean(collectorTurnId && eventTurnId && eventTurnId !== collectorTurnId);
}

/**
 * The turn in-flight fold lives in `shared/turnInFlight.ts` so the chat pane can
 * tell "waiting on real work" from "gone quiet" without a second copy. Re-exported
 * here so every main-process watchdog keeps importing it from one place.
 */
export { trackTurnInFlight } from "../../../shared/turnInFlight";
