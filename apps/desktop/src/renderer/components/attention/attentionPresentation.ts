import type { AttentionActionKind, AttentionPhase } from "../../../shared/types";

export type AttentionTone =
  | "amber"
  | "red"
  | "violet"
  | "blue"
  | "cyan"
  | "emerald"
  | "neutral";

const PHASE_PRESENTATION: Record<
  AttentionPhase,
  { label: string; tone: AttentionTone; active: boolean }
> = {
  starting: { label: "Starting", tone: "blue", active: true },
  running: { label: "Working", tone: "blue", active: true },
  needs_you: { label: "Needs you", tone: "amber", active: true },
  blocked: { label: "Blocked", tone: "amber", active: true },
  failed: { label: "Failed", tone: "red", active: false },
  completed: { label: "Completed", tone: "emerald", active: false },
  stale: { label: "Stale", tone: "neutral", active: false },
  checks_failing: { label: "Checks failing", tone: "red", active: false },
  review_requested: { label: "Review requested", tone: "violet", active: false },
  changes_requested: { label: "Changes requested", tone: "red", active: false },
  merge_ready: { label: "Ready to merge", tone: "emerald", active: false },
  open: { label: "Open", tone: "blue", active: false },
  merged: { label: "Merged", tone: "emerald", active: false },
  closed: { label: "Closed", tone: "neutral", active: false },
};

export function attentionPhasePresentation(phase: AttentionPhase) {
  return PHASE_PRESENTATION[phase];
}

export function attentionActionTone(
  kind: AttentionActionKind,
): "primary" | "danger" | "secondary" | "ghost" {
  if (kind === "approve" || kind === "answer" || kind === "rerun_checks") return "primary";
  if (kind === "deny") return "danger";
  if (kind === "open" || kind === "restart") return "secondary";
  return "ghost";
}

export function attentionViewEmptyCopy(view: "live" | "inbox" | "recent"): {
  title: string;
  body: string;
} {
  if (view === "inbox") {
    return {
      title: "You’re all caught up",
      body: "Approvals, failures, review requests, and finished work you haven’t seen will collect here.",
    };
  }
  if (view === "recent") {
    return {
      title: "No recent outcomes",
      body: "Completed and resolved work stays here for 24 hours after you review it.",
    };
  }
  return {
    title: "No live work yet",
    body: "Active agents and pull requests from every signed-in machine will appear here as they move.",
  };
}
