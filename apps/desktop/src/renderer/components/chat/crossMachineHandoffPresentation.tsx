import { CheckCircle, CircleNotch, Warning } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { AgentChatProvider } from "../../../shared/types";
import { providerDisplayLabel as providerDisplayLabelShared } from "../../../shared/pendingInputLabels";
import { cn } from "../ui/cn";

/**
 * Pure presentation for the cross-machine handoff modal — types, copy and the
 * small row component. With no state and no hooks they can be asserted
 * directly.
 */

export type ModalStage = "choose" | "clone" | "review";
export type HandoffMode = "brief" | "fork";

export function providerDisplayLabel(provider: AgentChatProvider | null | undefined): string {
  return providerDisplayLabelShared(provider, "This chat");
}

/**
 * Prepare errors that mean "this chat can't fork, but a brief always can" — the
 * source history is over the transport cap ("too large"), or the provider's
 * native session file can't be forked at all (e.g. a Codex `.zst` rollout). Both
 * get the one-click brief fallback; the plain-language reason differs by cause.
 */
export function forkFallbackReasonForPrepareError(message: string): string | null {
  if (/too large|too big/i.test(message)) {
    return "This chat's history is too big to send — a brief works everywhere.";
  }
  if (/can'?t be forked|cannot be forked|not forkable/i.test(message)) {
    return "This chat's history can't be forked — a brief works everywhere.";
  }
  if (/aren'?t portable|not portable/i.test(message)) {
    return "This chat's history can't move between machines — a brief works everywhere.";
  }
  return null;
}

/**
 * Copy for the per-machine repository hint. "unknown" and "checking" render
 * nothing rather than a hedge — an unanswered question isn't worth a row.
 */
export function repoReadinessLabel(state: "checking" | "present" | "absent" | "unknown" | undefined): string | null {
  if (state === "present") return "repo ready";
  if (state === "absent") return "will clone the repo";
  return null;
}

export function repoReadinessClass(state: "checking" | "present" | "absent" | "unknown" | undefined): string {
  return state === "present" ? "text-emerald-300/60" : "text-amber-200/60";
}

export function CheckRow({
  label,
  detail,
  state,
  icon,
}: {
  label: string;
  detail: string;
  state: "ok" | "warn" | "error" | "pending";
  /** Optional leading glyph (repo / branch / provider mark) for the row's subject. */
  icon?: ReactNode;
}) {
  const Icon = state === "ok" ? CheckCircle : state === "pending" ? CircleNotch : Warning;
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-fg/[0.055] bg-fg/[0.025] px-3 py-2.5">
      <Icon
        size={16}
        weight={state === "ok" ? "fill" : "regular"}
        className={cn(
          "mt-0.5 shrink-0",
          state === "ok" && "text-emerald-300/85",
          state === "warn" && "text-amber-300/85",
          state === "error" && "text-red-300/85",
          state === "pending" && "animate-spin text-fg/40",
        )}
      />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 font-sans text-[11px] font-semibold text-fg/80">
          {icon ? <span aria-hidden className="inline-flex shrink-0 text-fg/55">{icon}</span> : null}
          {label}
        </div>
        <div className="mt-0.5 text-[10px] leading-4 text-fg/46">{detail}</div>
      </div>
    </div>
  );
}
