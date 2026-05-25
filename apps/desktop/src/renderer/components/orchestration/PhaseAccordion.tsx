/**
 * PhaseAccordion — collapsible phase section used inside the orchestration
 * panel body. Each phase renders as a bordered card with a header button
 * (caret + title + status) and an expandable task list.
 *
 * Also includes:
 *   - PlanningEmptyState: Q&A history shown when the planning phase has
 *     no tasks yet.
 *
 * Extracted from OrchestrationPanel.tsx to keep the panel focused on
 * layout and data wiring.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CaretRight,
  CheckCircle,
  Sparkle,
} from "@phosphor-icons/react";
import type {
  DecisionLogEntry,
  OrchestrationAgent,
  OrchestrationManifest,
  OrchestrationPhase,
  OrchestrationTask,
} from "../../../shared/types/orchestration";
import { cn } from "../ui/cn";
import { TaskCard } from "./TaskCard";
import { PHASE_ICON_MAP } from "./PanelChrome";
import {
  PHASE_LABEL,
  filterPlanningQuestions,
  type OrchestrationTaskAction,
} from "./orchestrationTokens";

/* ──────────────────────────────────────────────────────────────────────────
   PhaseAccordion
   ────────────────────────────────────────────────────────────────────────── */

export function PhaseAccordion({
  phase,
  tasks,
  isCurrent,
  isLead,
  agents,
  validation,
  onTaskAction,
  onOpenSession,
  registerTaskRef,
  decisions,
  highlightedTaskId,
}: {
  phase: OrchestrationPhase;
  tasks: OrchestrationTask[];
  isCurrent: boolean;
  isLead: boolean;
  agents: Map<string, OrchestrationAgent>;
  validation: OrchestrationManifest["validationStrategy"] | undefined;
  onTaskAction?: (action: OrchestrationTaskAction, task: OrchestrationTask) => void;
  onOpenSession?: (sessionId: string) => void;
  registerTaskRef: (id: string, el: HTMLDivElement | null) => void;
  decisions: DecisionLogEntry[];
  highlightedTaskId: string | null;
}) {
  // Active phase auto-expands; others start collapsed unless they have content.
  const [open, setOpen] = useState<boolean>(
    isCurrent || phase.status === "active" || tasks.length > 0,
  );
  // Auto-open when the phase newly becomes active or first acquires tasks. The
  // useRef tracks the previous "should be open" signal so we don't keep
  // overriding manual user toggles when the signal hasn't changed.
  const prevShouldBeOpenRef = useRef<boolean>(isCurrent || phase.status === "active" || tasks.length > 0);
  useEffect(() => {
    const shouldBeOpen = isCurrent || phase.status === "active" || tasks.length > 0;
    if (shouldBeOpen && !prevShouldBeOpenRef.current) {
      setOpen(true);
    }
    prevShouldBeOpenRef.current = shouldBeOpen;
  }, [isCurrent, phase.status, tasks.length]);

  const doneCount = tasks.filter((t) => t.status === "done").length;
  const inFlightCount = tasks.filter(
    (t) => t.status === "claimed" || t.status === "in_progress",
  ).length;

  return (
    <div
      data-orchestration-phase={phase.id}
      data-orchestration-phase-current={isCurrent ? "true" : "false"}
      className="rounded-lg border border-white/[0.05] bg-white/[0.015]"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span aria-hidden className="inline-flex h-3 w-3 items-center justify-center text-fg/55">
          {open ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />}
        </span>
        <span className="inline-flex items-center gap-1.5 font-sans text-[11.5px] font-semibold text-fg/85">
          {PHASE_ICON_MAP[phase.id]}
          {phase.title || PHASE_LABEL[phase.id]}
        </span>
        {phase.status === "active" || isCurrent ? (
          <span
            className="ml-1 inline-flex items-center rounded-full border border-violet-300/30 bg-violet-300/10 px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.16em] text-violet-100/90"
          >
            active
          </span>
        ) : phase.status === "done" ? (
          <span
            className="ml-1 inline-flex items-center rounded-full border border-emerald-300/30 bg-emerald-300/10 px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.16em] text-emerald-100/90"
          >
            done
          </span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-fg/55">
          {tasks.length > 0 ? (
            <span>
              <span className="text-fg/75">{doneCount}</span>
              <span className="text-muted-fg/45"> / {tasks.length}</span>
            </span>
          ) : (
            <span className="text-muted-fg/40">no tasks</span>
          )}
          {inFlightCount > 0 ? (
            <span className="inline-flex items-center rounded-full bg-violet-300/10 px-1.5 text-[9px] text-violet-100/85">
              {inFlightCount} ↻
            </span>
          ) : null}
        </span>
      </button>

      {open ? (
        <div className="space-y-1.5 px-2 pb-2">
          {tasks.length === 0 ? (
            phase.id === "planning" ? (
              <PlanningEmptyState decisions={decisions} />
            ) : (
              <div className="px-2 py-3 font-sans text-[11px] text-muted-fg/55">
                No tasks here yet.
              </div>
            )
          ) : (
            tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                agents={agents}
                validation={validation}
                isLead={isLead}
                onAction={onTaskAction}
                onOpenSession={onOpenSession}
                refCallback={(el) => registerTaskRef(task.id, el)}
                highlighted={highlightedTaskId === task.id}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   PlanningEmptyState
   ────────────────────────────────────────────────────────────────────────── */

export function PlanningEmptyState({
  decisions,
}: {
  decisions: DecisionLogEntry[];
}) {
  const qa = useMemo(() => filterPlanningQuestions(decisions), [decisions]);
  return (
    <div
      data-testid="orchestration-panel-empty-qa"
      className="space-y-2 rounded-md border border-violet-300/15 bg-violet-300/[0.04] px-2.5 py-2.5"
    >
      <div className="flex items-center gap-1.5 font-sans text-[11px] font-semibold text-violet-100/90">
        <Sparkle size={11} weight="duotone" />
        Planning in progress
      </div>
      {qa.length === 0 ? (
        <p className="font-sans text-[11px] leading-snug text-fg/65">
          The lead is inspecting the repo and will propose tasks shortly. Tasks
          will appear here once planning completes.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {qa.map((entry, idx) => (
            <li key={entry.id} className="flex gap-2 font-sans text-[11px] leading-snug">
              <span
                className={cn(
                  "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-[9px]",
                  entry.kind === "question-answered"
                    ? "bg-emerald-300/15 text-emerald-200/90"
                    : "bg-violet-300/15 text-violet-100/85",
                )}
                aria-hidden
              >
                {entry.kind === "question-answered" ? "✓" : "?"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-fg/85">
                  <span className="text-muted-fg/55">Q{idx + 1} · </span>
                  {entry.question}
                </div>
                {entry.answer ? (
                  <div className="mt-0.5 truncate text-muted-fg/70">
                    <span className="text-muted-fg/45">A · </span>
                    {entry.answer}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
