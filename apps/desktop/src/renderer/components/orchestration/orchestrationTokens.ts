/**
 * orchestrationTokens — shared design tokens, constants, and pure helpers
 * for the orchestration panel family of components.
 *
 * These are stateless values and functions with no React dependency. They
 * can be freely imported from any orchestration component or test.
 */

import type {
  AgentChatApprovalDecision,
  PendingInputRequest,
} from "../../../shared/types/chat";
import type {
  OrchestrationPhaseId,
  OrchestrationRole,
  OrchestrationTask,
  OrchestrationTaskStatus,
  DecisionLogEntry,
} from "../../../shared/types/orchestration";
import type { PlanAssetResolver } from "./PlanMarkdown";
import type { OrchestrationDataSource } from "./orchestrationDataSource";

/* ──────────────────────────────────────────────────────────────────────────
   Shared types (used by multiple panel sub-components)
   ────────────────────────────────────────────────────────────────────────── */

export type OrchestrationTaskAction =
  | { kind: "open-worker-chat" }
  | { kind: "cancel"; revert: "true" | "false" | "review" }
  | { kind: "respawn" }
  | { kind: "mark-done-manually" };

export type OrchestrationPanelProps = {
  runId: string;
  laneId: string;
  laneName?: string | null;
  initialManifest?: import("../../../shared/types/orchestration").OrchestrationManifest;
  initialPlanMd?: string;
  viewerRole?: OrchestrationRole;
  onOpenSession?: (sessionId: string) => void;
  onSwitchToLead?: () => void;
  onTaskAction?: (action: OrchestrationTaskAction, task: OrchestrationTask) => void;
  resolveAsset?: PlanAssetResolver;
  bundleRoot?: string | null;
  highlightedTaskId?: string | null;
  planApprovalPending?: {
    itemId: string;
    request: PendingInputRequest;
    responding?: boolean;
  } | null;
  onPlanApproval?: (
    itemId: string,
    decision: AgentChatApprovalDecision,
    responseText?: string | null,
    answers?: Record<string, string | string[]>,
  ) => void;
  source?: OrchestrationDataSource;
  defaultCollapsed?: boolean;
  className?: string;
  style?: import("react").CSSProperties;
};

/* ──────────────────────────────────────────────────────────────────────────
   Phase labels
   ────────────────────────────────────────────────────────────────────────── */

export const PHASE_LABEL: Record<OrchestrationPhaseId, string> = {
  planning: "Planning",
  developing: "Developing",
  validating: "Validating",
  wrapup: "Wrap-up",
};

/* ──────────────────────────────────────────────────────────────────────────
   Status pill palette
   ────────────────────────────────────────────────────────────────────────── */

export type StatusPillStyle = { label: string; bg: string; border: string; fg: string };

export const STATUS_PILL: Record<OrchestrationTaskStatus, StatusPillStyle> = {
  pending: {
    label: "pending",
    bg: "color-mix(in srgb, var(--color-muted-fg) 9%, transparent)",
    border: "color-mix(in srgb, var(--color-muted-fg) 22%, transparent)",
    fg: "color-mix(in srgb, var(--color-muted-fg) 95%, white 5%)",
  },
  claimed: {
    label: "claimed",
    bg: "rgba(96, 165, 250, 0.10)",
    border: "rgba(96, 165, 250, 0.30)",
    fg: "rgb(147, 197, 253)",
  },
  in_progress: {
    label: "in progress",
    bg: "rgba(168, 85, 247, 0.12)",
    border: "rgba(168, 85, 247, 0.32)",
    fg: "rgb(196, 181, 253)",
  },
  review: {
    label: "in review",
    bg: "rgba(250, 204, 21, 0.10)",
    border: "rgba(250, 204, 21, 0.30)",
    fg: "rgb(254, 240, 138)",
  },
  done: {
    label: "done",
    bg: "rgba(34, 197, 94, 0.10)",
    border: "rgba(34, 197, 94, 0.30)",
    fg: "rgb(134, 239, 172)",
  },
  failed: {
    label: "failed",
    bg: "rgba(239, 68, 68, 0.10)",
    border: "rgba(239, 68, 68, 0.30)",
    fg: "rgb(252, 165, 165)",
  },
};

/* ──────────────────────────────────────────────────────────────────────────
   Planning Q&A parsing
   ────────────────────────────────────────────────────────────────────────── */

export type PlanningQA = {
  id: string;
  kind: "question-pending" | "question-answered";
  question: string;
  answer: string | null;
};

export function filterPlanningQuestions(decisions: DecisionLogEntry[]): PlanningQA[] {
  const out: PlanningQA[] = [];
  for (const entry of decisions) {
    const text = entry.summary?.trim() ?? "";
    if (!text) continue;
    const qaMatch = text.match(/^Q\s*[:\-]\s*(.+?)(?:\s*\/\s*A\s*[:\-]\s*(.+))?$/i);
    if (qaMatch) {
      const [, question, answer] = qaMatch;
      out.push({
        id: entry.id,
        kind: answer ? "question-answered" : "question-pending",
        question: question.trim(),
        answer: answer?.trim() ?? null,
      });
      continue;
    }
    const questionMatch = text.match(/^(?:question|ask|prompt)\s*[:\-]\s*(.+)$/i);
    if (questionMatch) {
      out.push({
        id: entry.id,
        kind: "question-pending",
        question: questionMatch[1].trim(),
        answer: null,
      });
    }
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   Formatting utilities
   ────────────────────────────────────────────────────────────────────────── */

export function formatElapsed(ms: number): string {
  if (ms < 60_000) {
    const s = Math.floor(ms / 1_000);
    return `${s}s`;
  }
  if (ms < 60 * 60_000) {
    const m = Math.floor(ms / 60_000);
    return `${m}m`;
  }
  const hours = Math.floor(ms / (60 * 60_000));
  const mins = Math.floor((ms - hours * 60 * 60_000) / 60_000);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function emitFileChip(path: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("ade:agent-chat:add-attachment", {
        detail: { path },
      }),
    );
  } catch {
    /* no-op: best-effort signal to the composer */
  }
}
