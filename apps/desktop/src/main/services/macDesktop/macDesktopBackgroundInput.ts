/**
 * Background input on the Windows main desktop (the shared seat), seen from
 * the service.
 *
 * The driver posts input to a parked lane window and knows which app
 * frameworks ignore posted input (`background.cpp`, after trycua/cua's
 * cua-driver). What the service does with that table:
 *
 * - Keys and text, when the caller named no mode: the driver refuses a row
 *   with WINDOWS_DESKTOP_BACKGROUND_UNAVAILABLE and the action is sent again
 *   as real input (the window comes forward for it and the user's goes back).
 * - Everything else (a click, scroll or drag, which have no real path on a
 *   parked window, and a caller's explicit mode): the request carries
 *   `forceBackground`, the driver posts as it did before the table existed,
 *   and its reply names the row in `backgroundRow`.
 *
 * Either way the row is reported, because the table comes from another
 * project's measurements and this is how ADE learns where it is wrong.
 */

import type { ComputerUseActionNextStep } from "../../../shared/types/agentObservation";
import { WINDOWS_DESKTOP_BACKGROUND_UNAVAILABLE_CODE } from "../../../shared/types/macDesktop";
import { forwardSignalToSentry } from "../../../shared/sentry/logBridge";
import type { Logger } from "../logging/logger";
import { asRecord } from "./macDesktopSeatProvider";

/** A table row the driver named: the exe and window class, never a title. */
export type BackgroundRow = { app: string | null; windowClass: string | null; input: string | null };

/** `real`: refused, then sent as real input. `posted`: posted anyway. */
export type BackgroundDelivery = BackgroundRow & { fallback: "real" | "posted" };

const field = (value: unknown): string | null => (typeof value === "string" && value ? value.slice(0, 80) : null);

const rowFrom = (value: unknown): BackgroundRow | null => {
  const record = asRecord(value);
  if (!Object.keys(record).length) return null;
  return { app: field(record.app), windowClass: field(record.windowClass), input: field(record.input) };
};

/**
 * Whether the driver refused background input, and the row it named: null for
 * a key that needs Shift, which no app could take posted and which is no row
 * of the table. Undefined when the error is something else.
 */
export function backgroundRefusal(error: unknown): BackgroundRow | null | undefined {
  const failure = error as { code?: unknown; details?: unknown } | null;
  if (failure?.code !== WINDOWS_DESKTOP_BACKGROUND_UNAVAILABLE_CODE) return undefined;
  return rowFrom(failure.details);
}

/** The row a `forceBackground` reply named, when the input was posted to an app the table lists. */
export function postedAnyway(reply: unknown): BackgroundRow | null {
  return rowFrom(asRecord(reply).backgroundRow);
}

/**
 * One line per delivery the table touched, and a Sentry Log (never an issue)
 * on the signal budget: a couple per app, input and fallback an hour, and 10
 * an hour for the event as a whole. `outcome` is the effect the observation
 * after the action saw (`observed` after `posted` is a row that refuses input
 * the app takes), or `failed` / `not_observed`.
 */
export function reportBackgroundDelivery(
  logger: Logger | null | undefined,
  action: string,
  delivery: BackgroundDelivery,
  outcome: string,
): void {
  const meta = { action, ...delivery, outcome };
  logger?.info("windows_desktop.background_unavailable", meta);
  forwardSignalToSentry(
    "windows_desktop.background_unavailable",
    meta,
    `${delivery.app ?? "unknown"}:${delivery.input ?? action}:${delivery.fallback}`,
  );
}

/** What to tell the agent when input posted to a listed app changed nothing. */
export function postedAnywayNextStep(row: BackgroundRow): ComputerUseActionNextStep {
  const app = row.app ?? "this app";
  return {
    method: "observe",
    reason: `${app} usually ignores ${row.input ?? "input"} sent in the background on the main desktop, and nothing changed; check the screenshot, then act on an element by --handle, send keys or text with --real, or ask the user for the private screen`,
    command: null,
  };
}
