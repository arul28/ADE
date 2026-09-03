/**
 * The four layout pieces `ReviewPage.tsx` defined inline, moved out.
 *
 * `SectionCard`, `MetaCard`, `ScopeBranchNode` and `ReviewLaunchScopeVisual`
 * were module-level components in the compiled page and are unchanged here
 * except for their imports. They live in their own file because BOTH surfaces
 * draw them now — the runs browser prints a run's scope with the same diagram
 * the launch form previews the scope with, which is the whole point of the
 * diagram: the reader recognises what they are about to review from what they
 * reviewed last time.
 */

import React from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";
import { BranchIcon } from "@ade-dev/ui/icons";

import type { ReviewScopeVisualProps } from "../lib/reviewFormat";

export const REVIEW_CARD_SURFACE =
  "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]/75";
export const REVIEW_INSET_SURFACE =
  "rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/45";
export const REVIEW_TOGGLE_ACTIVE = "bg-sky-500/15 text-[#F5FAFF] ring-1 ring-sky-400/30";
export const REVIEW_LIST_ACTIVE = "border-sky-400/28 bg-sky-500/[0.08]";
export const REVIEW_INPUT_FOCUS = "focus:border-sky-400/45";
export const REVIEW_INPUT =
  "h-9 w-full appearance-none rounded-xl border border-white/[0.08] bg-[var(--color-muted)]/55 px-3 pr-8 text-sm text-[#F5FAFF] outline-none transition-colors";

export function ScopeBranchNode({
  label,
  caption,
  emphasized = false,
}: {
  label: string;
  caption: string;
  emphasized?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 flex-1 rounded-lg border px-3 py-2.5",
        emphasized
          ? "border-teal-400/25 bg-teal-500/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
          : "border-white/[0.08] bg-[var(--color-muted)]/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <BranchIcon
          size={12}
          weight="bold"
          className={emphasized ? "shrink-0 text-teal-400" : "shrink-0 text-[#8FA1B8]"}
        />
        <span className="truncate font-mono text-[11px] font-semibold text-[#F5FAFF]">{label}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] text-[#94A3B8]">{caption}</div>
    </div>
  );
}

export function ReviewLaunchScopeVisual({
  targetMode,
  compareKind,
  title,
  description,
  laneName,
  compareLaneName,
  baseRefLabel,
  branchRefLabel,
  baseCommitLabel,
  headCommitLabel,
}: ReviewScopeVisualProps) {
  let leftNode = { label: branchRefLabel, caption: laneName, emphasized: true };
  let rightNode = { label: baseRefLabel, caption: "Base ref", emphasized: false };
  const connectorLabel = "vs.";

  if (targetMode === "lane_diff" && compareKind === "lane") {
    leftNode = { label: branchRefLabel, caption: laneName, emphasized: true };
    rightNode = {
      label: compareLaneName ?? "Comparison lane",
      caption: "Compare against",
      emphasized: false,
    };
  } else if (targetMode === "commit_range") {
    leftNode = { label: headCommitLabel ?? "Later commit", caption: "Included head", emphasized: true };
    rightNode = { label: baseCommitLabel ?? "Earlier commit", caption: "Excluded base", emphasized: false };
  } else if (targetMode === "working_tree") {
    leftNode = {
      label: "Working tree",
      caption: "Staged + unstaged + untracked",
      emphasized: true,
    };
    rightNode = { label: "HEAD commit", caption: "Checked-out tip", emphasized: false };
  }

  return (
    <div className={cn(REVIEW_INSET_SURFACE, "p-3")} data-review-scope={targetMode}>
      <div className="flex items-stretch gap-2">
        <ScopeBranchNode label={leftNode.label} caption={leftNode.caption} emphasized={leftNode.emphasized} />
        <div className="flex shrink-0 flex-col items-center justify-center gap-1 px-0.5 pt-3">
          <div className="flex items-center gap-0.5">
            <div className="h-px w-3 bg-white/[0.08]" />
            <ArrowRight size={12} weight="bold" className="text-sky-400" />
            <div className="h-px w-3 bg-white/[0.08]" />
          </div>
          <span className="font-mono text-[8px] font-bold tracking-[0.14em] text-sky-400/75">
            {connectorLabel}
          </span>
        </div>
        <ScopeBranchNode label={rightNode.label} caption={rightNode.caption} emphasized={rightNode.emphasized} />
      </div>
      <div className="mt-3 text-sm font-semibold text-[#F5FAFF]">{title}</div>
      <div className="mt-1 text-[11px] leading-relaxed text-[#C5D2E6]">{description}</div>
    </div>
  );
}

export function MetaCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={cn(REVIEW_INSET_SURFACE, "p-3")}>
      <div className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">{label}</div>
      <div className="mt-1 break-all text-xs text-[#F5FAFF]">{value}</div>
    </div>
  );
}

export function SectionCard({
  title,
  icon: Icon,
  children,
  action,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className={cn(REVIEW_CARD_SURFACE, "p-4")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-sky-500/[0.06]">
            <Icon size={15} weight="bold" className="text-sky-400" />
          </div>
          <div>
            <div className="text-sm font-semibold text-[#F5FAFF]">{title}</div>
          </div>
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}
