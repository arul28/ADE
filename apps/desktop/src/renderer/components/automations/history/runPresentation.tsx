import { CheckCircle, CircleNotch, MinusCircle, PauseCircle, XCircle } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { formatDurationMs } from "../../../lib/format";

/** How a run or step reads in Automations history: its state, glyph and time. */

export type RunState = "running" | "paused" | "succeeded" | "failed" | "skipped";

/** Every run and step status, folded to the five a reader tells apart. */
export function runState(status: string): RunState {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "running" || status === "queued") return "running";
  if (status === "paused") return "paused";
  return "skipped";
}

/** The state's colour, for its glyph and its word. */
export const STATE_TEXT: Record<RunState, string> = {
  running: "text-sky-300",
  paused: "text-amber-300",
  succeeded: "text-emerald-300",
  failed: "text-red-400",
  skipped: "text-fg/40",
};

/** The tinted disc behind a run's glyph. */
export const STATE_HALO: Record<RunState, string> = {
  running: "bg-sky-500/10",
  paused: "bg-amber-500/10",
  succeeded: "bg-emerald-500/10",
  failed: "bg-red-500/10",
  skipped: "bg-fg/[0.05]",
};

/** A run's or step's message: an error reads red, anything else reads quiet. */
export function messageTone(state: RunState): string {
  return state === "failed" ? "text-red-300/90" : "text-fg/70";
}

/** The word for a run's or step's status. */
const RUN_HEADLINE: Record<string, string> = {
  queued: "Waiting to run",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  paused: "Paused",
  skipped: "Skipped",
};

export function statusWord(status: string): string {
  return RUN_HEADLINE[status] ?? status;
}

/** Status lives on the glyph: a ring while it runs, a pause, a check, a cross, a dash. */
export function StatusGlyph({ status, size }: { status: string; size: number }) {
  const state = runState(status);
  // Cancelled and skipped share a glyph; the word tells them apart.
  const label = { role: "img", "aria-label": statusWord(status) } as const;
  const className = cn("shrink-0", STATE_TEXT[state]);
  if (state === "running") {
    return <CircleNotch {...label} size={size} weight="bold" className={className} style={{ animation: "ade-icon-spin 1s steps(30) infinite" }} />;
  }
  if (state === "paused") return <PauseCircle {...label} size={size} weight="fill" className={className} />;
  if (state === "succeeded") return <CheckCircle {...label} size={size} weight="fill" className={className} />;
  if (state === "failed") return <XCircle {...label} size={size} weight="fill" className={className} />;
  return <MinusCircle {...label} size={size} weight="fill" className={className} />;
}

export function durationLabel(startedAt: string | null, endedAt: string | null, short = false): string | null {
  if (!startedAt || !endedAt) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return short ? "<1s" : "under a second";
  return formatDurationMs(ms);
}
