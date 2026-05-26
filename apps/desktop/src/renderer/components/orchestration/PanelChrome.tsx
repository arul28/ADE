/**
 * PanelChrome — structural shell components for the orchestration panel:
 *   - CollapsedRail: icon-strip when panel is collapsed
 *   - RunHeader: run title, phase pill, agent count, collapse button
 *   - PlanReadyBar: implement-plan CTA bar
 *   - SectionHeader: labelled section divider
 *   - PHASE_ICON_MAP: React-node phase icons (must live in a .tsx file)
 *
 * Extracted from OrchestrationPanel.tsx. These have zero business logic --
 * they receive pre-computed data and render it.
 */

import type { CSSProperties, ReactNode } from "react";
import {
  ArrowsInLineHorizontal,
  ArrowsOutLineHorizontal,
  CheckCircle,
  ChatTeardropDots,
  ListChecks,
  Sparkle,
  Robot,
} from "@phosphor-icons/react";
import type {
  OrchestrationAgent,
  OrchestrationManifest,
  OrchestrationPhaseId,
} from "../../../shared/types/orchestration";
import { cn } from "../ui/cn";
import {
  PHASE_LABEL,
  type OrchestrationPanelProps,
} from "./orchestrationTokens";

/* ──────────────────────────────────────────────────────────────────────────
   Phase icon map (React nodes -- must live in a .tsx file)
   ────────────────────────────────────────────────────────────────────────── */

export const PHASE_ICON_MAP: Record<OrchestrationPhaseId, ReactNode> = {
  planning: <Sparkle size={11} weight="duotone" />,
  developing: <Robot size={11} weight="duotone" />,
  validating: <ListChecks size={11} weight="duotone" />,
  wrapup: <CheckCircle size={11} weight="duotone" />,
};

/* ──────────────────────────────────────────────────────────────────────────
   CollapsedRail
   ────────────────────────────────────────────────────────────────────────── */

export function CollapsedRail({
  manifest,
  onExpand,
  style,
  className,
}: {
  manifest: OrchestrationManifest | null;
  onExpand: () => void;
  style?: CSSProperties;
  className?: string;
}) {
  const phase = manifest?.currentPhase ?? "planning";
  const tasks = manifest?.tasks ?? [];
  const inFlight = tasks.filter(
    (t) => t.status === "claimed" || t.status === "in_progress",
  ).length;
  return (
    <aside
      data-testid="orchestration-panel"
      data-orchestration-panel-collapsed="true"
      className={cn(
        "flex h-full w-[40px] shrink-0 flex-col items-center gap-2 border-l border-white/[0.06] py-3",
        className,
      )}
      style={style}
    >
      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand plan panel"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg/40 transition-colors hover:bg-white/[0.05] hover:text-fg/80"
      >
        <ArrowsOutLineHorizontal size={14} weight="bold" />
      </button>
      <div
        className="flex h-6 w-6 items-center justify-center text-fg/40"
        title={PHASE_LABEL[phase]}
      >
        {PHASE_ICON_MAP[phase]}
      </div>
      {inFlight > 0 ? (
        <div
          className="mt-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent/10 px-1 text-[10px] font-medium text-accent-bright/70"
          title={`${inFlight} task${inFlight === 1 ? "" : "s"} in flight`}
        >
          {inFlight}
        </div>
      ) : null}
    </aside>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   RunHeader
   ────────────────────────────────────────────────────────────────────────── */

export function RunHeader({
  manifest,
  laneName,
  lead,
  loading,
  error,
  onCollapse,
}: {
  manifest: OrchestrationManifest | null;
  laneName: string | null;
  lead: OrchestrationAgent | null;
  loading: boolean;
  error: string | null;
  onCollapse: () => void;
}) {
  const runTitle = manifest?.title?.trim() || "Orchestration run";
  const phaseId = manifest?.currentPhase ?? "planning";
  const allPhasesDone = manifest?.phases.every((p) => p.status === "done") ?? false;
  return (
    <div className="shrink-0 border-b border-white/[0.06] px-5 py-3">
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium"
          style={allPhasesDone ? {
            background: "rgba(34, 197, 94, 0.10)",
            border: "1px solid rgba(34, 197, 94, 0.20)",
            color: "rgb(134, 239, 172)",
          } : {
            background: "rgba(139, 92, 246, 0.10)",
            border: "1px solid rgba(139, 92, 246, 0.20)",
            color: "rgb(196, 181, 253)",
          }}
        >
          {allPhasesDone ? <CheckCircle size={11} weight="fill" /> : PHASE_ICON_MAP[phaseId]}
          {allPhasesDone ? "Complete" : PHASE_LABEL[phaseId]}
        </span>
        <h2 className="min-w-0 flex-1 truncate font-sans text-[14px] font-medium text-fg/90" title={runTitle}>
          {runTitle}
        </h2>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse plan panel"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg/40 transition-colors hover:bg-white/[0.05] hover:text-fg/80"
        >
          <ArrowsInLineHorizontal size={14} weight="bold" />
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[12px] text-muted-fg/60">
        {laneName ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-accent/50" />
            {laneName}
          </span>
        ) : null}
        {lead ? (
          <span className="inline-flex items-center gap-1">
            {lead.displayName?.trim() || lead.goalSummary?.trim() || "Lead"}
          </span>
        ) : null}
        {manifest?.agents?.length ? (
          <span className="inline-flex items-center gap-1">
            {manifest.agents.length} agent{manifest.agents.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {loading ? (
          <span className="text-muted-fg/50">loading...</span>
        ) : null}
      </div>

      {error ? (
        <div className="mt-2 rounded-md border border-red-400/20 bg-red-400/[0.05] px-2.5 py-1.5 text-[12px] text-red-200/80">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   PlanReadyBar
   ────────────────────────────────────────────────────────────────────────── */

export function PlanReadyBar({
  pending,
  onImplement,
}: {
  pending: NonNullable<OrchestrationPanelProps["planApprovalPending"]>;
  onImplement?: OrchestrationPanelProps["onPlanApproval"];
}) {
  const disabled = pending.responding === true || !onImplement;
  const planTitle = pending.request.title?.trim() || "Plan ready";
  return (
    <div className="shrink-0 border-b border-white/[0.06] px-5 py-2.5">
      <div className="flex items-center gap-2.5 rounded-lg border border-emerald-400/15 bg-emerald-400/[0.04] px-3 py-2.5">
        <CheckCircle size={14} weight="duotone" className="shrink-0 text-emerald-300/75" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-fg/85">
            {planTitle}
          </div>
          <div className="truncate text-[11px] text-muted-fg/55">
            Keep planning in chat, or start from this plan.
          </div>
        </div>
        <button
          type="button"
          data-testid="orchestration-plan-implement-button"
          disabled={disabled}
          onClick={() => onImplement?.(pending.itemId, "accept")}
          className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-emerald-400/12 px-3 text-[12px] font-medium text-emerald-100 transition-colors hover:bg-emerald-400/18 disabled:pointer-events-none disabled:opacity-40"
        >
          {pending.responding ? "Starting..." : "Implement"}
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   SectionHeader
   ────────────────────────────────────────────────────────────────────────── */

export function SectionHeader({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-fg/50">
      {icon}
      <span>{children}</span>
    </div>
  );
}
