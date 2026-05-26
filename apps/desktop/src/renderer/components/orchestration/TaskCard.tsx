/**
 * TaskCard — individual orchestration task card with status pill, owner
 * info, file anchors, validation badges, and a lead-only context menu.
 *
 * Extracted from OrchestrationPanel.tsx to keep the panel component focused
 * on layout and data wiring.
 */

import {
  type CSSProperties,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  CheckCircle,
  ChatTeardropDots,
  Circle,
  ClockClockwise,
  DotsThree,
  MagnifyingGlass,
  PaperPlaneTilt,
  UserCircle,
  XCircle,
} from "@phosphor-icons/react";
import type {
  EvidenceRef,
  OrchestrationAgent,
  OrchestrationManifest,
  OrchestrationTask,
  OrchestrationTaskStatus,
  ValidationChecklistItem,
  ValidationChecklistRun,
  ValidationStep,
} from "../../../shared/types/orchestration";
import { cn } from "../ui/cn";
import { relativeWhen } from "../../lib/format";
import { STATUS_PILL, emitFileChip, formatElapsed, type OrchestrationTaskAction } from "./orchestrationTokens";

/* ──────────────────────────────────────────────────────────────────────────
   TaskCard
   ────────────────────────────────────────────────────────────────────────── */

export function TaskCard({
  task,
  agents,
  validation,
  isLead,
  onAction,
  onOpenSession,
  refCallback,
  highlighted,
}: {
  task: OrchestrationTask;
  agents: Map<string, OrchestrationAgent>;
  validation: OrchestrationManifest["validationStrategy"] | undefined;
  isLead: boolean;
  onAction?: (action: OrchestrationTaskAction, task: OrchestrationTask) => void;
  onOpenSession?: (sessionId: string) => void;
  refCallback?: (el: HTMLDivElement | null) => void;
  highlighted?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pill = STATUS_PILL[task.status];
  const owner = task.assigneeSessionId ? agents.get(task.assigneeSessionId) ?? null : null;
  const elapsedMs = task.claimedAt ? Date.now() - Date.parse(task.claimedAt) : null;
  const elapsedLabel =
    elapsedMs != null && Number.isFinite(elapsedMs) && elapsedMs > 0
      ? formatElapsed(elapsedMs)
      : null;

  const stepLookup = useMemo(() => {
    const m = new Map<string, ValidationStep>();
    for (const s of validation?.steps ?? []) m.set(s.id, s);
    return m;
  }, [validation]);
  const checklistByStep = useMemo(() => {
    const m = new Map<string, ValidationChecklistItem>();
    for (const item of validation?.checklist ?? []) {
      if (item.taskId === task.id) m.set(item.stepId, item);
    }
    return m;
  }, [validation, task.id]);

  return (
    <div
      ref={refCallback}
      data-testid="orchestration-task-card"
      data-orchestration-task-id={task.id}
      data-orchestration-task-status={task.status}
      data-orchestration-task-highlighted={highlighted ? "true" : undefined}
      className={cn(
        "group rounded-lg border px-3 py-2.5 transition-all",
        highlighted ? "border-accent/30 bg-accent/[0.04]" : "border-white/[0.06] hover:bg-white/[0.02]",
      )}
    >
      {/* Row 1: id + tag chip + status pill + expand + menu */}
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-fg/50">
          {task.id}
        </span>
        {task.tag ? (
          <span
            className="inline-flex items-center rounded px-1.5 py-[2px] text-[10px] font-medium text-fg/65"
            style={{
              background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
            }}
          >
            {task.tag}
          </span>
        ) : null}
        <span
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-[2px] text-[10px] font-medium"
          style={{ background: pill.bg, color: pill.fg }}
        >
          <StatusGlyph status={task.status} />
          {pill.label}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse task" : "Expand task"}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg/50 transition-colors hover:bg-white/[0.05] hover:text-fg/85"
        >
          <MagnifyingGlass size={10} weight="bold" />
        </button>
        {isLead ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Task actions"
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg/50 transition-colors hover:bg-white/[0.05] hover:text-fg/85"
            >
              <DotsThree size={12} weight="bold" />
            </button>
            {menuOpen ? (
              <TaskContextMenu
                onAction={(action) => {
                  setMenuOpen(false);
                  onAction?.(action, task);
                }}
                onDismiss={() => setMenuOpen(false)}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Row 2: title */}
      <div className="mt-1.5 font-sans text-[13px] font-medium leading-snug text-fg/88">
        {task.title}
      </div>

      {/* Row 3: description (3-line clamp) */}
      {task.description ? (
        <div
          className={cn(
            "mt-1 font-sans text-[12px] leading-[1.6] text-fg/60",
            expanded ? undefined : "line-clamp-3",
          )}
          style={{
            display: expanded ? undefined : "-webkit-box",
            WebkitLineClamp: expanded ? undefined : 3,
            WebkitBoxOrient: expanded ? undefined : "vertical",
            overflow: expanded ? undefined : "hidden",
          } as CSSProperties}
        >
          {task.description}
        </div>
      ) : null}

      {/* Row 4: file anchors */}
      {task.filesHint && task.filesHint.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {task.filesHint.slice(0, expanded ? task.filesHint.length : 4).map((path) => (
            <button
              key={path}
              type="button"
              onClick={() => emitFileChip(path)}
              className="inline-flex max-w-full items-center gap-1 truncate rounded border border-white/[0.05] bg-white/[0.02] px-1.5 py-0.5 font-mono text-[10px] text-fg/55 transition-colors hover:bg-white/[0.04] hover:text-fg/75"
              title={path}
            >
              <span className="truncate">{path}</span>
            </button>
          ))}
          {!expanded && task.filesHint.length > 4 ? (
            <span className="inline-flex items-center text-[10px] text-muted-fg/45">
              +{task.filesHint.length - 4}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Row 5: owner + elapsed */}
      {(owner || elapsedLabel) ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[11px] text-muted-fg/50">
          {owner ? (
            <button
              type="button"
              onClick={() => onOpenSession?.(owner.sessionId)}
              className="inline-flex items-center gap-1 text-fg/60 hover:text-fg/85"
              title={`Open ${owner.role} chat`}
            >
              <UserCircle size={11} weight="duotone" />
              <span>
                {owner.role}
                {owner.tag ? ` · ${owner.tag}` : ""}
              </span>
            </button>
          ) : null}
          {elapsedLabel ? (
            <span className="inline-flex items-center gap-1">
              <ClockClockwise size={11} weight="duotone" />
              <span className="tabular-nums">{elapsedLabel}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Row 6: validation badges */}
      {task.validationGate?.stepIds?.length ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {task.validationGate.stepIds.map((stepId) => {
            const step = stepLookup.get(stepId);
            const item = checklistByStep.get(stepId);
            const latest = item?.runs.find((r) => r.id === item.latestRunId) ?? item?.runs[item.runs.length - 1];
            const status = latest?.status ?? null;
            return (
              <ValidationBadge
                key={stepId}
                label={step?.concern ?? "validate"}
                status={status}
                title={step?.prompt ?? step?.concern ?? "validation step"}
                run={latest ?? null}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   StatusGlyph
   ────────────────────────────────────────────────────────────────────────── */

function StatusGlyph({
  status,
}: {
  status: OrchestrationTaskStatus;
}) {
  if (status === "done") return <CheckCircle size={9} weight="fill" />;
  if (status === "failed") return <XCircle size={9} weight="fill" />;
  if (status === "in_progress" || status === "claimed") return <ClockClockwise size={9} weight="bold" />;
  return <Circle size={8} weight="bold" />;
}

/* ──────────────────────────────────────────────────────────────────────────
   ValidationBadge
   ────────────────────────────────────────────────────────────────────────── */

type ValidationPalette = { bg: string; border: string; fg: string; glyph: string };

function validationBadgePalette(status: "running" | "passed" | "failed" | null): ValidationPalette {
  switch (status) {
    case "passed":
      return { bg: "rgba(34, 197, 94, 0.10)", border: "rgba(34, 197, 94, 0.30)", fg: "rgb(134, 239, 172)", glyph: "✓" };
    case "failed":
      return { bg: "rgba(239, 68, 68, 0.10)", border: "rgba(239, 68, 68, 0.30)", fg: "rgb(252, 165, 165)", glyph: "✗" };
    case "running":
      return { bg: "rgba(250, 204, 21, 0.10)", border: "rgba(250, 204, 21, 0.30)", fg: "rgb(254, 240, 138)", glyph: "⏳" };
    default:
      return { bg: "rgba(255, 255, 255, 0.04)", border: "rgba(255, 255, 255, 0.10)", fg: "rgba(255, 255, 255, 0.55)", glyph: "—" };
  }
}

function ValidationBadge({
  label,
  status,
  title,
  run,
}: {
  label: string;
  status: "running" | "passed" | "failed" | null;
  title?: string;
  run?: ValidationChecklistRun | null;
}) {
  const [open, setOpen] = useState(false);
  const palette = validationBadgePalette(status);
  const normalizedLabel = label.replace(/_/g, " ");
  const statusLabel = status ?? "pending";
  const evidence = run?.attachedEvidence ?? [];
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        title={title}
        aria-label={`Show evidence for ${normalizedLabel}`}
        aria-expanded={open}
        data-orchestration-validation-badge={label}
        className="inline-flex items-center gap-1 rounded-sm px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.14em] transition-colors hover:brightness-110"
        style={{ background: palette.bg, border: `1px solid ${palette.border}`, color: palette.fg }}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>{palette.glyph}</span>
        <span>{normalizedLabel}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={`Evidence for ${normalizedLabel}`}
          data-orchestration-validation-evidence-popover=""
          className="absolute left-0 top-full z-40 mt-1 w-[min(320px,80vw)] rounded-md border border-white/[0.10] bg-[color:color-mix(in_srgb,var(--color-bg)_88%,black_12%)] p-2.5 text-left shadow-[0_16px_40px_-18px_rgba(0,0,0,0.75)]"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-sans text-[11px] font-semibold text-fg/90">
                {normalizedLabel}
              </div>
              <div className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-fg/55">
                {statusLabel}
                {run?.endedAt ? ` · ${relativeWhen(run.endedAt)}` : ""}
              </div>
            </div>
            <button
              type="button"
              aria-label="Close validation evidence"
              onClick={() => setOpen(false)}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg/45 transition-colors hover:bg-white/[0.06] hover:text-fg/80"
            >
              <XCircle size={11} weight="bold" />
            </button>
          </div>
          {run?.notes ? (
            <div className="mt-2 rounded-sm border border-white/[0.06] bg-white/[0.025] px-2 py-1.5 font-sans text-[11px] leading-snug text-fg/72">
              {run.notes}
            </div>
          ) : null}
          <div className="mt-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-fg/45">
            Evidence
          </div>
          {evidence.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {evidence.map((ref, idx) => (
                <li
                  key={`${evidenceRefKey(ref)}-${idx}`}
                  className="rounded-sm border border-white/[0.05] bg-white/[0.018] px-2 py-1.5 font-mono text-[10px] leading-snug text-fg/70"
                >
                  {formatEvidenceRef(ref)}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-1.5 rounded-sm border border-white/[0.05] bg-white/[0.018] px-2 py-1.5 font-sans text-[11px] text-muted-fg/62">
              No evidence attached yet.
            </div>
          )}
        </div>
      ) : null}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   TaskContextMenu
   ────────────────────────────────────────────────────────────────────────── */

function TaskContextMenu({
  onAction,
  onDismiss,
}: {
  onAction: (action: OrchestrationTaskAction) => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-orchestration-context-menu]")) return;
      onDismiss();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onDismiss]);

  const item =
    "flex w-full items-center gap-1.5 px-2 py-1.5 text-left font-sans text-[11px] text-fg/80 transition-colors hover:bg-white/[0.06] hover:text-fg";

  return (
    <div
      data-orchestration-context-menu=""
      className="absolute right-0 z-30 mt-1 min-w-[170px] rounded-md border border-white/[0.10] bg-[color:color-mix(in_srgb,var(--color-bg)_84%,black_16%)] py-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.55)] backdrop-blur"
    >
      <button type="button" className={item} onClick={() => onAction({ kind: "open-worker-chat" })}>
        <ChatTeardropDots size={10} weight="duotone" /> Open worker chat
      </button>
      <button type="button" className={item} onClick={() => onAction({ kind: "cancel", revert: "review" })}>
        <XCircle size={10} weight="duotone" /> Cancel task...
      </button>
      <button type="button" className={item} onClick={() => onAction({ kind: "respawn" })}>
        <PaperPlaneTilt size={10} weight="duotone" /> Re-spawn
      </button>
      <div className="my-1 border-t border-white/[0.06]" />
      <button type="button" className={item} onClick={() => onAction({ kind: "mark-done-manually" })}>
        <CheckCircle size={10} weight="duotone" /> Mark done manually
      </button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Evidence helpers
   ────────────────────────────────────────────────────────────────────────── */

function evidenceRefKey(ref: EvidenceRef): string {
  if ("path" in ref) return `${ref.kind}:${ref.path}`;
  if ("url" in ref) return `${ref.kind}:${ref.url}`;
  return `${ref.kind}:${ref.sessionId}:${ref.turnId}`;
}

function formatEvidenceRef(ref: EvidenceRef): string {
  if ("path" in ref) {
    const range = ref.range ? `:${ref.range.startLine}-${ref.range.endLine}` : "";
    return `${ref.kind}: ${ref.path}${range}`;
  }
  if ("url" in ref) {
    return `${ref.kind}: ${ref.url}`;
  }
  const range = ref.range ? `:${ref.range.startCharOffset}-${ref.range.endCharOffset}` : "";
  return `${ref.kind}: ${ref.sessionId}/${ref.turnId}${range}`;
}
