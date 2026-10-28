import { CheckCircle, CircleNotch, MinusCircle, XCircle } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { formatDurationMs } from "../../../lib/format";

/** How a run or step reads in Automations history: its state, glyph and time. */

export type RunState = "running" | "succeeded" | "failed" | "skipped";

/** Every run and step status, folded to the four a reader tells apart. */
export function runState(status: string): RunState {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "running" || status === "queued") return "running";
  return "skipped";
}

export const STATE_TEXT: Record<RunState, string> = {
  running: "text-sky-300",
  succeeded: "text-emerald-300",
  failed: "text-red-400",
  skipped: "text-fg/40",
};

export const RUN_HEADLINE: Record<string, string> = {
  queued: "Waiting to run",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  paused: "Paused",
};

/** Status lives on the glyph: a ring while it runs, a check, a cross, a dash. */
export function StatusGlyph({ status, size }: { status: string; size: number }) {
  const state = runState(status);
  const className = cn("shrink-0", STATE_TEXT[state]);
  if (state === "running") {
    return <CircleNotch size={size} weight="bold" className={className} style={{ animation: "ade-icon-spin 1s steps(30) infinite" }} />;
  }
  if (state === "succeeded") return <CheckCircle size={size} weight="fill" className={className} />;
  if (state === "failed") return <XCircle size={size} weight="fill" className={className} />;
  return <MinusCircle size={size} weight="fill" className={className} />;
}

export function durationLabel(startedAt: string | null, endedAt: string | null, short = false): string | null {
  if (!startedAt || !endedAt) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return short ? "<1s" : "under a second";
  return formatDurationMs(ms);
}
