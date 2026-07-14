import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaretDown,
  CaretRight,
  Check,
  Circle,
  CircleHalf,
  Pause,
  Play,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { formatDurationMs, formatSubagentDurationMs } from "../../lib/format";
import type { ChatScheduledWorkSnapshot, ChatSubagentSnapshot } from "./chatExecutionSummary";
import { derivePlan } from "./chatExecutionSummary";
import type { TodoItemSnapshot } from "./chatExecutionSummary";
import { ChatTaskList } from "./ChatTasksPanel";
import type { ChatInfoPlanStep, PaneSectionKey } from "../../../shared/chatSubagents";
import {
  BACKGROUND_ACTIVE_CAP,
  PROGRESS_CAP,
  SCHEDULE_ACTIVE_CAP,
  SUBAGENTS_ACTIVE_CAP,
  TASKS_CAP,
  capPaneSectionItems,
  groupPaneSectionItems,
  isBackgroundShellCommand,
  isEarlierSubagentSnapshot,
} from "../../../shared/chatSubagents";
import {
  backgroundCommandCwd,
  backgroundCommandLabel,
  isEarlierBackgroundItem,
  isEarlierScheduleItem,
  isFiredOneShotWakeup,
  scheduledNextFireLabel,
} from "../../../shared/chatScheduledWork";
import type { AgentChatEventEnvelope, CodexThreadGoal } from "../../../shared/types";
import type { SubagentCapability } from "../../../shared/subagentCapabilities";
import { BottomDrawerSection } from "./BottomDrawerSection";
import { CodexGoalCard } from "./codex/CodexGoalCard";
import { ChatSubagentGlyph, chatSubagentColor, chatSubagentDisplayName } from "./chatSubagentIdentity";

const GLYPH_SIZE = 16;
const PANE_UI_STORAGE_PREFIX = "ade.chat.paneUi.v1";
const PANE_CLEARED_STORAGE_PREFIX = "ade.chat.paneCleared.v1";
const PANE_STORAGE_ENTRY_CAP = 100;

type PaneUiStorageState = {
  collapsed: Partial<Record<PaneSectionKey, boolean>>;
  earlier: Partial<Record<Extract<PaneSectionKey, "subagents" | "background" | "schedule">, boolean>>;
};

type PaneClearedStorageState = Record<Extract<PaneSectionKey, "subagents" | "background" | "schedule">, string[]>;

type PaneStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const EMPTY_PANE_UI_STATE: PaneUiStorageState = { collapsed: {}, earlier: {} };
const EMPTY_PANE_CLEARED_STATE: PaneClearedStorageState = { subagents: [], background: [], schedule: [] };
const PANE_SECTION_KEYS: PaneSectionKey[] = ["progress", "tasks", "subagents", "background", "schedule"];
const PANE_EARLIER_SECTION_KEYS = ["subagents", "background", "schedule"] as const;

export function chatPaneUiStorageKey(sessionId: string): string {
  return `${PANE_UI_STORAGE_PREFIX}:${sessionId}`;
}

export function chatPaneClearedStorageKey(sessionId: string): string {
  return `${PANE_CLEARED_STORAGE_PREFIX}:${sessionId}`;
}

function booleanMap<T extends string>(value: unknown, keys: readonly T[]): Partial<Record<T, boolean>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const result: Partial<Record<T, boolean>> = {};
  for (const key of keys) {
    if (typeof record[key] === "boolean") result[key] = record[key] as boolean;
  }
  return result;
}

export function parseChatPaneUiState(raw: string | null): PaneUiStorageState {
  if (!raw) return EMPTY_PANE_UI_STATE;
  try {
    const parsed = JSON.parse(raw) as { collapsed?: unknown; earlier?: unknown };
    return {
      collapsed: booleanMap(parsed.collapsed, PANE_SECTION_KEYS),
      earlier: booleanMap(parsed.earlier, PANE_EARLIER_SECTION_KEYS),
    };
  } catch {
    return EMPTY_PANE_UI_STATE;
  }
}

export function parseChatPaneClearedState(raw: string | null): PaneClearedStorageState {
  if (!raw) return EMPTY_PANE_CLEARED_STATE;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(PANE_EARLIER_SECTION_KEYS.map((section) => [
      section,
      Array.isArray(parsed[section])
        ? [...new Set(parsed[section].filter((id): id is string => typeof id === "string" && id.length > 0))]
        : [],
    ])) as PaneClearedStorageState;
  } catch {
    return EMPTY_PANE_CLEARED_STATE;
  }
}

export function cleanupChatPaneStorage(storage: PaneStorage): void {
  for (const prefix of [PANE_UI_STORAGE_PREFIX, PANE_CLEARED_STORAGE_PREFIX]) {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(`${prefix}:`)) keys.push(key);
    }
    for (const key of keys.slice(0, Math.max(0, keys.length - PANE_STORAGE_ENTRY_CAP))) {
      storage.removeItem(key);
    }
  }
}

function readPaneUiState(sessionId?: string | null): PaneUiStorageState {
  if (!sessionId || typeof window === "undefined") return EMPTY_PANE_UI_STATE;
  try {
    return parseChatPaneUiState(window.localStorage.getItem(chatPaneUiStorageKey(sessionId)));
  } catch {
    return EMPTY_PANE_UI_STATE;
  }
}

function readPaneClearedState(sessionId?: string | null): PaneClearedStorageState {
  if (!sessionId || typeof window === "undefined") return EMPTY_PANE_CLEARED_STATE;
  try {
    return parseChatPaneClearedState(window.localStorage.getItem(chatPaneClearedStorageKey(sessionId)));
  } catch {
    return EMPTY_PANE_CLEARED_STATE;
  }
}

function paneSectionHint(args: {
  activeCount: number;
  runningCount?: number;
  failedCount?: number;
}): string {
  return args.runningCount && args.failedCount
    ? `${args.runningCount} running · ${args.failedCount} failed`
    : `${args.activeCount}`;
}

type GlyphCategory = "subagent" | "background";

function PlanGlyph({ status }: { status: ChatInfoPlanStep["status"] }) {
  if (status === "completed") {
    return <Check aria-hidden size={GLYPH_SIZE} weight="bold" className="text-emerald-300/90" />;
  }
  if (status === "in_progress") {
    return (
      <CircleHalf
        aria-hidden
        size={GLYPH_SIZE}
        weight="fill"
        className="text-[color:var(--color-accent,#A78BFA)] motion-safe:ade-glow-pulse"
      />
    );
  }
  if (status === "failed") {
    return <X aria-hidden size={GLYPH_SIZE} weight="bold" className="text-rose-300/85" />;
  }
  return <Circle aria-hidden size={GLYPH_SIZE} weight="regular" className="text-fg/30" />;
}

/* ── Section header — sentence case, paper-section feel ── */

type SectionTone = "subagent" | "background" | "workflow" | "scheduled" | "neutral";

const SECTION_DOT_CLASS: Record<SectionTone, string> = {
  subagent: "bg-[color:var(--color-accent,#A78BFA)]/70",
  background: "bg-cyan-300/65",
  workflow: "bg-amber-300/65",
  scheduled: "bg-sky-300/65",
  neutral: "bg-fg/30",
};

function SectionHeader({
  label,
  hint,
  action,
  tone = "neutral",
  emphasized = false,
  sticky = false,
  collapsible = false,
  collapsed = false,
  onToggle,
}: {
  label: string;
  hint?: string;
  action?: ReactNode;
  tone?: SectionTone;
  emphasized?: boolean;
  sticky?: boolean;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const wrapperClass = cn(
    "flex items-center justify-between px-3.5",
    emphasized ? "pb-1.5 pt-3" : "pb-1 pt-2.5",
    sticky && "sticky top-0 z-[5] bg-[color:var(--work-sidebar-bg,#161618)]",
  );
  if (collapsible) {
    return (
      <div className={wrapperClass}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center justify-between text-left"
          onClick={onToggle}
          aria-expanded={!collapsed}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 font-sans uppercase tracking-[0.06em] text-fg/45",
              emphasized ? "text-[10.5px] font-medium" : "text-[10px] font-medium",
            )}
          >
            <span aria-hidden className="shrink-0 text-fg/35">
              {collapsed ? <CaretRight size={10} weight="bold" /> : <CaretDown size={10} weight="bold" />}
            </span>
            <span aria-hidden className={cn("inline-block h-1 w-1 shrink-0 rounded-full", SECTION_DOT_CLASS[tone])} />
            <span className="truncate">{label}</span>
          </span>
          {hint ? (
            <span className="ml-2 shrink-0 font-sans text-[10.5px] tabular-nums text-fg/35">
              {hint}
            </span>
          ) : null}
        </button>
        {action ? <span className="ml-1.5 flex items-center gap-1.5">{action}</span> : null}
      </div>
    );
  }
  return (
    <div className={wrapperClass}>
      <span
        className={cn(
          "flex items-center gap-1.5 font-sans uppercase tracking-[0.06em] text-fg/45",
          emphasized ? "text-[10.5px] font-medium" : "text-[10px] font-medium",
        )}
      >
        <span
          aria-hidden
          className={cn("inline-block h-1 w-1 rounded-full", SECTION_DOT_CLASS[tone])}
        />
        {label}
      </span>
      <span className="flex items-center gap-1.5">
        {hint ? (
          <span className="font-sans text-[10.5px] tabular-nums text-fg/35">
            {hint}
          </span>
        ) : null}
        {action}
      </span>
    </div>
  );
}

function SectionDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function EarlierToggle({
  count,
  clearedCount,
  expanded,
  onToggle,
}: {
  count: number;
  clearedCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left font-sans text-[10.5px] text-fg/40 transition-colors hover:bg-white/[0.035] hover:text-fg/60"
    >
      <span aria-hidden>{expanded ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />}</span>
      Completed ({count}){clearedCount ? ` · ${clearedCount} hidden` : ""}
    </button>
  );
}

function ShowAllButton({ hiddenLabel, onClick }: { hiddenLabel: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-2 flex w-[calc(100%-1rem)] items-center rounded-md px-2 py-1 text-left font-sans text-[10.5px] text-fg/40 transition-colors hover:bg-white/[0.035] hover:text-fg/60"
    >
      Show all ({hiddenLabel})
    </button>
  );
}

function PaneTextAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-sans text-[10px] text-fg/35 transition-colors hover:text-fg/60"
    >
      {children}
    </button>
  );
}

type ScalablePaneSectionKey = keyof PaneClearedStorageState;

function PaneScalableSection<T>({
  sectionKey, label, hint, tone, cap, groups, capped, paneUi, sticky, extraHeaderAction,
  idOf, renderActiveRow, renderEarlierRow, onToggleCollapsed, onToggleEarlier,
  onClear, onRestore, onShowAll, showAll, hasPrecedingSection, showAllLabel,
  animateActiveRows = true, animateEarlierRows = false, keepEmptyActiveList = true,
  subagentTaskIdOf,
}: {
  sectionKey: ScalablePaneSectionKey;
  label: string;
  hint: string;
  tone: SectionTone;
  cap: number;
  groups: { active: T[]; earlier: T[]; clearedCount: number };
  capped: { visible: T[]; hiddenCount: number };
  paneUi: PaneUiStorageState;
  sticky: boolean;
  extraHeaderAction?: ReactNode;
  idOf: (item: T) => string;
  renderActiveRow: (item: T) => ReactNode;
  renderEarlierRow: (item: T) => ReactNode;
  onToggleCollapsed: () => void;
  onToggleEarlier: () => void;
  onClear: (ids: string[]) => void;
  onRestore: () => void;
  onShowAll: () => void;
  showAll: boolean;
  hasPrecedingSection: boolean;
  showAllLabel?: string;
  animateActiveRows?: boolean;
  animateEarlierRows?: boolean;
  keepEmptyActiveList?: boolean;
  subagentTaskIdOf?: (item: T) => string;
}) {
  const allClear = groups.active.length === 0 && groups.earlier.length === 0 && groups.clearedCount > 0;
  const collapsible = groups.earlier.length > 0 || groups.active.length > cap;
  const collapsed = collapsible && paneUi.collapsed[sectionKey] === true;
  const earlierExpanded = paneUi.earlier[sectionKey] === true;
  const sectionAction = allClear ? (
    <PaneTextAction onClick={onRestore}>Restore ({groups.clearedCount})</PaneTextAction>
  ) : null;
  const renderRows = (items: T[], renderRow: (item: T) => ReactNode, animated: boolean) => {
    const rows = items.map((item) => animated ? (
      <motion.div
        key={idOf(item)}
        data-subagent-task-id={subagentTaskIdOf?.(item)}
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
        className="overflow-hidden"
      >
        {renderRow(item)}
      </motion.div>
    ) : <Fragment key={idOf(item)}>{renderRow(item)}</Fragment>);
    return animated ? <AnimatePresence initial={false}>{rows}</AnimatePresence> : rows;
  };

  return (
    <section className={cn("pb-3", hasPrecedingSection && "border-t border-white/[0.04]")}>
      <SectionHeader
        label={label}
        hint={allClear ? "all clear" : hint}
        tone={tone}
        emphasized
        sticky={sticky}
        collapsible={collapsible}
        collapsed={collapsed}
        onToggle={onToggleCollapsed}
        action={extraHeaderAction === undefined ? sectionAction : <>{sectionAction}{extraHeaderAction}</>}
      />
      <SectionDisclosure open={!collapsed}>
        {allClear ? <div className="px-4 pb-2 text-[11px] text-fg/35">{label} · all clear</div> : null}
        {keepEmptyActiveList || capped.visible.length > 0 ? (
          <div className="space-y-px px-2 pb-1">
            {renderRows(capped.visible, renderActiveRow, animateActiveRows)}
          </div>
        ) : null}
        {!showAll && capped.hiddenCount > 0 ? (
          <ShowAllButton hiddenLabel={showAllLabel ?? `${capped.hiddenCount}`} onClick={onShowAll} />
        ) : null}
        {groups.earlier.length > 0 || groups.clearedCount > 0 ? (
          <div className="px-2 pt-0.5">
            <div className="flex items-center">
              <EarlierToggle count={groups.earlier.length} clearedCount={groups.clearedCount} expanded={earlierExpanded} onToggle={onToggleEarlier} />
              {earlierExpanded && groups.earlier.length > 0 ? (
                <span className="shrink-0 pl-1.5 pr-1">
                  <PaneTextAction onClick={() => onClear(groups.earlier.map(idOf))}>Clear</PaneTextAction>
                </span>
              ) : null}
            </div>
            <SectionDisclosure open={earlierExpanded}>
              <div className="space-y-px pb-1">
                {renderRows(groups.earlier, renderEarlierRow, animateEarlierRows)}
              </div>
              {groups.clearedCount > 0 ? (
                <div className="px-2 pb-1"><PaneTextAction onClick={onRestore}>Restore ({groups.clearedCount})</PaneTextAction></div>
              ) : null}
            </SectionDisclosure>
          </div>
        ) : null}
      </SectionDisclosure>
    </section>
  );
}

/* ── Progress bar — 1 px hairline rule ── */

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="mx-4 mb-1 h-px rounded-full bg-white/[0.05]">
      <div
        className="h-px rounded-full bg-[color:var(--color-accent,#A78BFA)]/55 transition-[width] duration-500 ease-out"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/* ── Row ──
 *
 * Codex-style compact list row: per-agent identicon glyph on the left, name,
 * then status + elapsed time on the right. No card chrome, no saturated fill —
 * the row hugs its content with only a faint hover wash. Selection is a subtle
 * violet ring/tint, nothing more.
 */

const STATUS_LABEL: Record<ChatSubagentSnapshot["status"], string> = {
  running: "running",
  completed: "done",
  failed: "failed",
  stopped: "halted",
};

// Elapsed-time chip for the right rail — duration only (no tool/token noise),
// so the compact row stays scannable.
function elapsedText(snapshot: ChatSubagentSnapshot, nowMs?: number): string | null {
  const startedAt = Date.parse(snapshot.startedAt);
  const updatedAt = Date.parse(snapshot.updatedAt);
  const liveElapsedMs = snapshot.status === "running" && Number.isFinite(startedAt) && typeof nowMs === "number"
    ? Math.max(0, nowMs - startedAt)
    : null;
  const elapsedMs = liveElapsedMs
    ?? snapshot.usage?.durationMs
    ?? Math.max(0, updatedAt - startedAt);
  if (snapshot.status === "running") {
    const formatted = formatDurationMs(elapsedMs);
    return formatted === "--" ? null : formatted;
  }
  return formatSubagentDurationMs(elapsedMs);
}

// A runtime can emit more than one *kind* of subagent (Claude surfaces five via
// `taskType`). They all live in one list; a small chip discriminates the
// non-default kinds so the consolidation stays legible. `subagent` (the default)
// and `background` (its own section) get no chip. Workflow runs prefer their
// workflow name, which the row renders separately.
function kindBadge(snapshot: ChatSubagentSnapshot): string | null {
  if (snapshot.workflowName) return null; // workflowName chip covers this row
  switch (snapshot.taskType) {
    case "local_workflow":
      return "workflow";
    case "cron":
      return "scheduled";
    case "other":
      return "task";
    default:
      return null;
  }
}

const SCHEDULE_STATUS_LABEL: Record<ChatScheduledWorkSnapshot["status"], string> = {
  scheduled: "scheduled",
  paused: "paused",
  running: "running",
  fired: "fired",
  missed: "missed",
  completed: "done",
  cancelled: "cancelled",
  failed: "failed",
  stopped: "stopped",
};

function scheduledKindLabel(kind: ChatScheduledWorkSnapshot["kind"]): string {
  switch (kind) {
    case "wakeup":
      return "wakeup";
    case "cron":
      return "cron";
    case "loop":
      return "loop";
    case "remote_trigger":
      return "trigger";
    case "background_task":
      return "background";
  }
}

function scheduledDetail(snapshot: ChatScheduledWorkSnapshot): string | null {
  const parts = [
    snapshot.cron ? snapshot.cron : null,
    snapshot.reason ? snapshot.reason : null,
    snapshot.summary ? snapshot.summary : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

function formatScheduleClock(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function ScheduledWorkRow({
  snapshot,
  schedulesPaused = false,
  onCancel,
}: {
  snapshot: ChatScheduledWorkSnapshot;
  schedulesPaused?: boolean;
  onCancel?: () => void;
}) {
  const isPaused = schedulesPaused || snapshot.status === "paused";
  const isActive = snapshot.status === "running" || snapshot.status === "fired";
  const isProblem = snapshot.status === "failed" || snapshot.status === "missed";
  const isMuted = snapshot.status === "completed" || snapshot.status === "cancelled" || snapshot.status === "stopped";
  const detail = scheduledDetail(snapshot);
  const prompt = snapshot.prompt?.trim();
  // Relative next-fire label for cron/wakeup rows (e.g. "next in 3h · 9:00 AM").
  // Recomputed on a 30s tick so the countdown stays roughly fresh without churn.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (snapshot.kind !== "cron" && snapshot.kind !== "wakeup") return;
    if (isMuted) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, [snapshot.kind, isMuted]);
  const nextFire = isMuted ? null : scheduledNextFireLabel(snapshot, nowMs);
  const lastRun = snapshot.kind === "cron" ? formatScheduleClock(snapshot.lastRunAt) : null;
  const timing = [lastRun ? `last ran ${lastRun}` : null, nextFire]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <div
      data-paused={isPaused || undefined}
      className={cn(
        "group grid min-h-[42px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5",
        "transition-colors duration-150 hover:bg-white/[0.035]",
        isPaused && "opacity-45",
      )}
      title={prompt || detail || snapshot.title}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              isActive && "bg-sky-300/75 motion-safe:ade-glow-pulse",
              isProblem && "bg-rose-300/80",
              isMuted && "bg-fg/25",
              !isActive && !isProblem && !isMuted && "bg-sky-300/55",
            )}
          />
          <span
            className={cn(
              "min-w-0 truncate font-sans text-[12.5px] leading-5",
              isActive && "text-sky-100/90",
              isProblem && "text-rose-200/85",
              isMuted && "text-fg/45",
              isPaused && "text-fg/45",
              !isActive && !isProblem && !isMuted && "text-fg/70",
            )}
          >
            {snapshot.title}
          </span>
          <span className="shrink-0 rounded-sm bg-white/[0.05] px-1 py-px font-sans text-[9.5px] uppercase tracking-[0.05em] text-fg/40">
            {scheduledKindLabel(snapshot.kind)}
          </span>
        </div>
        {detail || prompt ? (
          <div className="min-w-0 truncate pl-3.5 font-sans text-[10.5px] leading-4 text-fg/38">
            {detail ?? prompt}
          </div>
        ) : null}
        {timing ? (
          <div className="min-w-0 truncate pl-3.5 font-sans text-[10px] leading-4 text-sky-300/45">
            {timing}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <span
          className={cn(
            "font-sans text-[10.5px] tabular-nums",
            isActive && "text-sky-300/75",
            isProblem && "text-rose-300/75",
            isMuted && "text-fg/35",
            !isActive && !isProblem && !isMuted && "text-fg/45",
          )}
        >
          {isPaused ? "paused" : SCHEDULE_STATUS_LABEL[snapshot.status]}
        </span>
        {onCancel && snapshot.cancellable === true && !isMuted ? (
          <button
            type="button"
            onClick={onCancel}
            aria-label={`Cancel ${snapshot.title}`}
            title={snapshot.kind === "cron" ? "Cancel through Claude CronDelete" : "Cancel scheduled work"}
            className="flex h-5 w-5 items-center justify-center rounded-sm text-fg/25 opacity-0 transition-all hover:bg-white/[0.06] hover:text-rose-200/80 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X aria-hidden size={11} weight="bold" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ScheduleHistoryRow({ snapshot }: { snapshot: ChatScheduledWorkSnapshot }) {
  const firedAt = formatScheduleClock(
    snapshot.firedAt ?? snapshot.lastRunAt ?? snapshot.updatedAt,
  );
  const parts = [
    `✓ ${snapshot.title}`,
    firedAt ? `fired ${firedAt}` : "fired",
    snapshot.late ? "late" : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <div
      className="min-w-0 truncate rounded-md px-2 py-1.5 font-sans text-[11px] leading-5 text-fg/45"
      title={snapshot.prompt?.trim() || snapshot.reason?.trim() || snapshot.title}
    >
      {parts.join(" · ")}
    </div>
  );
}

// Duration between two ISO timestamps, formatted compactly (or null).
function backgroundDurationLabel(snapshot: ChatScheduledWorkSnapshot, nowMs?: number): string | null {
  const start = Date.parse(snapshot.createdAt);
  const isRunning = snapshot.status === "running" || snapshot.status === "fired";
  const end = isRunning && typeof nowMs === "number" ? nowMs : Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (isRunning) {
    const formatted = formatDurationMs(end - start);
    return formatted === "--" ? null : formatted;
  }
  return formatSubagentDurationMs(end - start);
}

/**
 * Background command row: `$ <smart label>` + status. Expands (click) to reveal
 * the full original command in monospace, prefixed by a dim cwd chip when the
 * command carries a leading `cd <path> &&`. Terminal rows render their final
 * state (the backend now guarantees terminal events arrive).
 */
function BackgroundCommandRow({ snapshot }: { snapshot: ChatScheduledWorkSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const rawCommand = (snapshot.title || snapshot.prompt || snapshot.summary || "").trim();
  const label = backgroundCommandLabel(rawCommand) || rawCommand || "Background command";
  const cwd = backgroundCommandCwd(rawCommand);
  const isRunning = snapshot.status === "running" || snapshot.status === "fired";
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [isRunning]);
  const duration = backgroundDurationLabel(snapshot, nowMs);
  const isProblem = snapshot.status === "failed" || snapshot.status === "missed";
  const isMuted = snapshot.status === "completed" || snapshot.status === "cancelled" || snapshot.status === "stopped";

  return (
    <div className="rounded-md transition-colors duration-150 hover:bg-white/[0.035]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 px-2 py-1.5 text-left"
        title={rawCommand || label}
      >
        <span aria-hidden className="shrink-0 text-fg/30">
          {expanded ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="shrink-0 font-mono text-[11px] text-cyan-300/55">$</span>
          <span className="min-w-0 truncate font-mono text-[11.5px] leading-5 text-fg/70">{label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-sans text-[10.5px] tabular-nums">
          {duration ? <span className="text-fg/35">{duration}</span> : null}
          <span
            className={cn(
              "tracking-[0.01em]",
              isRunning && "text-cyan-300/70",
              isProblem && "text-rose-300/70",
              isMuted && "text-fg/35",
              !isRunning && !isProblem && !isMuted && "text-fg/45",
            )}
          >
            {SCHEDULE_STATUS_LABEL[snapshot.status]}
          </span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="bg-command-details"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="mx-2 mb-1 mt-0.5 space-y-1 rounded-md bg-white/[0.025] px-2.5 py-2">
              {cwd ? (
                <span className="inline-block rounded-sm bg-white/[0.05] px-1.5 py-px font-mono text-[10px] text-fg/45">
                  {cwd}
                </span>
              ) : null}
              <div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-fg/60">
                {rawCommand || label}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function SubagentRow({
  snapshot,
  selected,
  category,
  expanded,
  probing,
  canViewFullTranscript,
  onClick,
}: {
  snapshot: ChatSubagentSnapshot;
  selected: boolean;
  category: GlyphCategory;
  expanded: boolean;
  /** True while we're checking whether this agent has a pullable transcript. */
  probing: boolean;
  /** Whether this runtime can surface a full child transcript (drives the
   * drawer's "transcript not ready yet" vs "live details only" footer). */
  canViewFullTranscript: boolean;
  onClick: () => void;
}) {
  const name = chatSubagentDisplayName(snapshot);
  const kindLabel = kindBadge(snapshot);
  const color = chatSubagentColor(snapshot.agentId ?? snapshot.taskId);
  const isRunning = snapshot.status === "running";
  const isCompleted = snapshot.status === "completed";
  const isStopped = snapshot.status === "stopped";
  const isFailed = snapshot.status === "failed";
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [isRunning]);
  const time = elapsedText(snapshot, nowMs);
  const statusLabel = STATUS_LABEL[snapshot.status];
  const runningLabelTint = category === "background"
    ? "text-cyan-100/90"
    : "text-[color:var(--color-accent-bright,#C4B5FD)]";

  // Tiny "what we know" facts for the inline drawer (agents without a pullable
  // transcript) — token usage + last tool, nothing heavy.
  const totalTokens = snapshot.usage?.totalTokens;
  const toolUses = snapshot.usage?.toolUses;
  const costUsd = snapshot.usage?.costUsd;
  const lastTool = snapshot.lastToolName?.trim();
  // Latest progress/result text (e.g. Cursor's task `text`, OpenCode's diff
  // summary) — shown only when it adds something beyond the description.
  const summaryRaw = (snapshot.finalSummary ?? snapshot.summary)?.trim();
  const summaryText = summaryRaw && summaryRaw !== snapshot.description?.trim() ? summaryRaw : null;

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        title={snapshot.description || "View subagent details"}
        data-selected={selected || undefined}
        className={cn(
          "group relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
          "transition-colors duration-150",
          "hover:bg-white/[0.04]",
          (selected || expanded)
            && "bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] ring-1 ring-inset ring-[color:color-mix(in_srgb,var(--color-accent)_30%,transparent)]",
        )}
      >
        <ChatSubagentGlyph id={snapshot.agentId ?? snapshot.taskId} color={color} status={snapshot.status} />

        <span
          className={cn(
            "min-w-0 flex-1 truncate font-sans text-[12.5px] leading-5",
            isRunning && runningLabelTint,
            isFailed && "text-rose-200/85",
            isCompleted && "text-fg/55",
            isStopped && "text-fg/45",
            !isRunning && !isFailed && !isCompleted && !isStopped && "text-fg/75",
          )}
        >
          {name}
          {snapshot.background ? (
            <span className="ml-1.5 rounded-sm bg-cyan-300/[0.1] px-1 py-px font-sans text-[9.5px] uppercase tracking-[0.05em] text-cyan-200/70">
              background
            </span>
          ) : null}
          {snapshot.workflowName ? (
            <span className="ml-1.5 font-sans text-[11px] tracking-[0.01em] text-amber-300/55">
              {snapshot.workflowName}
            </span>
          ) : kindLabel ? (
            <span className="ml-1.5 rounded-sm bg-white/[0.05] px-1 py-px font-sans text-[9.5px] uppercase tracking-[0.05em] text-fg/40">
              {kindLabel}
            </span>
          ) : null}
        </span>

        <span className="flex shrink-0 items-center gap-1.5 font-sans text-[10.5px] tabular-nums">
          {probing ? (
            <span
              aria-hidden
              className="h-3 w-3 animate-spin rounded-full border border-fg/20 border-t-fg/55 [animation-duration:0.7s]"
            />
          ) : null}
          <span
            className={cn(
              "tracking-[0.01em]",
              isRunning && (category === "background" ? "text-cyan-300/70" : "text-[color:var(--color-accent,#A78BFA)]/80"),
              isFailed && "text-rose-300/70",
              isStopped && "text-amber-300/55",
              isCompleted && "text-fg/35",
            )}
          >
            {statusLabel}
          </span>
          {time ? <span className="text-fg/35 group-hover:text-fg/50">{time}</span> : null}
        </span>
      </button>

      {/* No pullable transcript → a tiny details drawer slides out beneath the
          row instead of taking over the chat with an empty page. */}
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="details-drawer"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="mx-2 mb-1 mt-0.5 space-y-1 rounded-md bg-white/[0.025] px-2.5 py-2 font-sans text-[10.5px] leading-4 text-fg/55">
              {snapshot.description ? (
                <div className="break-words text-fg/65">{snapshot.description}</div>
              ) : null}
              {summaryText ? (
                <div className="break-words text-fg/50">{summaryText}</div>
              ) : null}
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums text-fg/45">
                {typeof totalTokens === "number" && totalTokens > 0 ? <span>{totalTokens.toLocaleString()} tokens</span> : null}
                {typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0 ? <span>${costUsd < 0.1 ? costUsd.toFixed(4) : costUsd.toFixed(2)}</span> : null}
                {typeof toolUses === "number" && toolUses > 0 ? <span>{toolUses} tool{toolUses === 1 ? "" : "s"}</span> : null}
                {lastTool ? <span>last: {lastTool}</span> : null}
                {time ? <span>{time}</span> : null}
              </div>
              {/* Honest, runtime-aware footer: capable runtimes whose transcript
                  isn't ready yet say so (it can appear on a later poll); runtimes
                  that never expose a child transcript (e.g. Cursor) don't pretend
                  one is missing — the drawer above IS the detail. */}
              {canViewFullTranscript ? (
                <div className="text-fg/30">
                  {snapshot.status === "running" ? "Transcript not ready yet." : "No transcript recorded for this agent."}
                </div>
              ) : (
                <div className="text-fg/30">Live details only — this runtime doesn't expose a full transcript.</div>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ── Main component ── */

export type SubagentSelection = {
  taskId: string;
  agentId: string | null;
  agentType: string | null;
  status: ChatSubagentSnapshot["status"];
  background: boolean;
};

export function ChatSubagentsPanel({
  sessionId,
  snapshots,
  events,
  onSelectSubagent,
  onClearSelectedSubagent,
  probeSubagentTranscript,
  capability = null,
  selectedTaskId,
  className,
  variant = "drawer",
  onClose,
  goal,
  onEditGoal,
  onClearGoal,
  onSetGoalStatus,
  goalPending = false,
  todoItems = [],
  scheduleItems = [],
  backgroundItems = [],
  schedulesPaused = false,
  onToggleSchedulesPaused,
  onCancelScheduledWork,
}: {
  sessionId?: string | null;
  snapshots: ChatSubagentSnapshot[];
  events: AgentChatEventEnvelope[];
  onSelectSubagent?: (selection: SubagentSelection) => void;
  onClearSelectedSubagent?: () => void;
  /** Probe (same fetch the takeover uses) for whether an agent has a pullable
   * transcript. Returns true → take over the chat; false → inline drawer. */
  probeSubagentTranscript?: (args: { taskId: string; agentId: string | null }) => Promise<boolean>;
  /** Per-runtime subagent capability — the single source of truth for whether a
   * subagent click can take over the chat (full transcript) or only opens the
   * inline drawer, and whether running agents take over immediately. Null →
   * treated as no transcript (drawer-only). See `shared/subagentCapabilities`. */
  capability?: SubagentCapability | null;
  selectedTaskId?: string | null;
  className?: string;
  variant?: "drawer" | "pane";
  onClose?: () => void;
  goal?: CodexThreadGoal | null;
  onEditGoal?: (nextObjective: string) => void;
  onClearGoal?: () => void;
  onSetGoalStatus?: (status: Extract<NonNullable<CodexThreadGoal["status"]>, "active" | "paused" | "blocked" | "complete">) => void;
  goalPending?: boolean;
  todoItems?: TodoItemSnapshot[];
  /** Schedule kinds only (wakeup/cron/loop/remote_trigger) — background tasks live in `backgroundItems`. */
  scheduleItems?: ChatScheduledWorkSnapshot[];
  /** Background command tasks (kind background_task). */
  backgroundItems?: ChatScheduledWorkSnapshot[];
  /** Whether all durable schedules for this chat are currently paused. */
  schedulesPaused?: boolean;
  /** Pause or resume all durable schedules for this chat. */
  onToggleSchedulesPaused?: () => void;
  /** Cancel one durable schedule. Claude cron jobs are deleted through CronDelete. */
  onCancelScheduledWork?: (snapshot: ChatScheduledWorkSnapshot) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [paneUi, setPaneUi] = useState<PaneUiStorageState>(() => readPaneUiState(sessionId));
  const [paneCleared, setPaneCleared] = useState<PaneClearedStorageState>(() => readPaneClearedState(sessionId));
  const [showAll, setShowAll] = useState<Partial<Record<PaneSectionKey, boolean>>>({});
  // Which agent's inline details drawer is open (agents with no transcript).
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // Which agent we're currently probing for a transcript (shows a row spinner).
  const [probingTaskId, setProbingTaskId] = useState<string | null>(null);
  // Cached probe outcomes per task so repeat clicks are instant. Running agents
  // are never cached — their transcript can appear after a later poll.
  const [probeResults, setProbeResults] = useState<Record<string, boolean>>({});
  const paneScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPaneUi(readPaneUiState(sessionId));
    setPaneCleared(readPaneClearedState(sessionId));
    setShowAll({});
  }, [sessionId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      cleanupChatPaneStorage(window.localStorage);
    } catch {
      // Renderer storage is best-effort; disclosure remains available in memory.
    }
  }, []);

  const updatePaneUi = useCallback((update: (current: PaneUiStorageState) => PaneUiStorageState) => {
    setPaneUi((current) => {
      const next = update(current);
      if (sessionId) {
        try {
          window.localStorage.setItem(chatPaneUiStorageKey(sessionId), JSON.stringify(next));
        } catch {
          // Keep the in-memory state when localStorage is blocked.
        }
      }
      return next;
    });
  }, [sessionId]);

  const updatePaneCleared = useCallback((update: (current: PaneClearedStorageState) => PaneClearedStorageState) => {
    setPaneCleared((current) => {
      const next = update(current);
      if (sessionId) {
        try {
          window.localStorage.setItem(chatPaneClearedStorageKey(sessionId), JSON.stringify(next));
        } catch {
          // Keep the in-memory state when localStorage is blocked.
        }
      }
      return next;
    });
  }, [sessionId]);

  const toggleSection = useCallback((section: PaneSectionKey) => {
    updatePaneUi((current) => ({
      ...current,
      collapsed: { ...current.collapsed, [section]: current.collapsed[section] !== true },
    }));
  }, [updatePaneUi]);

  const toggleEarlier = useCallback((section: "subagents" | "background" | "schedule") => {
    updatePaneUi((current) => ({
      ...current,
      earlier: { ...current.earlier, [section]: current.earlier[section] !== true },
    }));
  }, [updatePaneUi]);

  const clearEarlier = useCallback((section: "subagents" | "background" | "schedule", ids: string[]) => {
    updatePaneCleared((current) => ({
      ...current,
      [section]: [...new Set([...current[section], ...ids])],
    }));
  }, [updatePaneCleared]);

  const restoreCleared = useCallback((section: "subagents" | "background" | "schedule") => {
    updatePaneCleared((current) => ({ ...current, [section]: [] }));
  }, [updatePaneCleared]);

  const plan = useMemo(() => derivePlan(events), [events]);

  const { subagents, runningCount, completedCount, bgRunningCount } = useMemo(() => {
    // ONE merged subagent list — foreground + background-run agents together.
    // Filter OUT historical command-as-subagent snapshots (old chats persisted
    // background shell commands as subagents); the shared predicate keys on
    // taskType/agentType/description.
    const list: ChatSubagentSnapshot[] = [];
    let running = 0;
    let completed = 0;
    let bgRunning = 0;
    for (const snap of snapshots) {
      if (isBackgroundShellCommand({
        taskType: snap.taskType,
        agentType: snap.agentType,
        description: snap.description,
      })) {
        continue;
      }
      list.push(snap);
      if (snap.status === "running") {
        running += 1;
        if (snap.background) bgRunning += 1;
      } else if (snap.status === "completed") {
        completed += 1;
      }
    }
    // Preserve the incoming spawn order (newest-first, fixed at spawn) — do NOT
    // re-sort by running/status, which would make rows jump as agents complete.
    return {
      subagents: list,
      runningCount: running,
      completedCount: completed,
      bgRunningCount: bgRunning,
    };
  }, [snapshots]);

  const pinnedSubagentIds = useMemo(() => new Set(
    [selectedTaskId, expandedTaskId].filter((id): id is string => Boolean(id)),
  ), [expandedTaskId, selectedTaskId]);
  const clearedSubagentIds = useMemo(() => new Set(paneCleared.subagents), [paneCleared.subagents]);
  const clearedBackgroundIds = useMemo(() => new Set(paneCleared.background), [paneCleared.background]);
  const clearedScheduleIds = useMemo(() => new Set(paneCleared.schedule), [paneCleared.schedule]);

  const subagentGroups = useMemo(() => groupPaneSectionItems(subagents, {
    isEarlier: isEarlierSubagentSnapshot,
    isCleared: (snapshot) => clearedSubagentIds.has(snapshot.taskId),
    isPinned: (snapshot) => pinnedSubagentIds.has(snapshot.taskId),
  }), [clearedSubagentIds, pinnedSubagentIds, subagents]);
  const backgroundGroups = useMemo(() => groupPaneSectionItems(backgroundItems, {
    isEarlier: isEarlierBackgroundItem,
    isCleared: (snapshot) => clearedBackgroundIds.has(snapshot.id),
    isPinned: () => false,
  }), [backgroundItems, clearedBackgroundIds]);
  const scheduleGroups = useMemo(() => groupPaneSectionItems(scheduleItems, {
    isEarlier: isEarlierScheduleItem,
    isCleared: (snapshot) => clearedScheduleIds.has(snapshot.id),
    isPinned: () => false,
  }), [clearedScheduleIds, scheduleItems]);

  const cappedSubagents = useMemo(() => (
    showAll.subagents
      ? { visible: subagentGroups.active, hiddenCount: 0 }
      : capPaneSectionItems(subagentGroups.active, SUBAGENTS_ACTIVE_CAP, (snapshot) => (
          snapshot.status === "failed" || pinnedSubagentIds.has(snapshot.taskId)
        ))
  ), [pinnedSubagentIds, showAll.subagents, subagentGroups.active]);
  const cappedBackground = useMemo(() => (
    showAll.background
      ? { visible: backgroundGroups.active, hiddenCount: 0 }
      : capPaneSectionItems(backgroundGroups.active, BACKGROUND_ACTIVE_CAP, (snapshot) => snapshot.status === "failed")
  ), [backgroundGroups.active, showAll.background]);
  const cappedSchedule = useMemo(() => (
    showAll.schedule
      ? { visible: scheduleGroups.active, hiddenCount: 0 }
      : capPaneSectionItems(scheduleGroups.active, SCHEDULE_ACTIVE_CAP, (snapshot) => snapshot.status === "failed")
  ), [scheduleGroups.active, showAll.schedule]);

  useEffect(() => {
    if (!selectedTaskId) return;
    if (paneUi.collapsed.subagents) {
      updatePaneUi((current) => ({
        ...current,
        collapsed: { ...current.collapsed, subagents: false },
      }));
    }
    const frame = window.requestAnimationFrame(() => {
      const target = [...(paneScrollRef.current?.querySelectorAll<HTMLElement>("[data-subagent-task-id]") ?? [])]
        .find((element) => element.dataset.subagentTaskId === selectedTaskId);
      target?.scrollIntoView?.({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [paneUi.collapsed.subagents, selectedTaskId, updatePaneUi]);

  const headerSummary = useMemo(() => {
    const parts: string[] = [];
    if (runningCount) parts.push(`${runningCount} running`);
    if (bgRunningCount) parts.push(`${bgRunningCount} bg`);
    if (backgroundGroups.active.length) parts.push(`${backgroundGroups.active.length} background`);
    if (scheduleGroups.active.length) parts.push(`${scheduleGroups.active.length} scheduled`);
    if (scheduleGroups.earlier.length) parts.push(`${scheduleGroups.earlier.length} earlier`);
    if (completedCount) parts.push(`${completedCount} done`);
    if (!parts.length && subagents.length) parts.push(`${subagents.length} tracked`);
    if (!parts.length) parts.push("idle");
    return parts.join(" · ");
  }, [backgroundGroups.active.length, completedCount, runningCount, bgRunningCount, scheduleGroups.active.length, scheduleGroups.earlier.length, subagents.length]);

  const takeover = (snap: ChatSubagentSnapshot) => {
    setExpandedTaskId(null);
    onSelectSubagent?.({
      taskId: snap.taskId,
      agentId: snap.agentId ?? null,
      agentType: snap.agentType ?? null,
      status: snap.status,
      background: snap.background === true,
    });
  };

  // Capability gates the click behavior. Runtimes that can't surface a child
  // transcript (Cursor, Droid, LM Studio) NEVER take over the chat — clicking a
  // row only opens the inline details drawer. Codex (rich metadata + a
  // guaranteed live thread) takes over immediately for running agents; Claude /
  // OpenCode probe first so a still-warming subagent falls back to the drawer
  // instead of an empty takeover page.
  const canTakeover = capability?.canViewFullTranscript ?? false;
  const immediateForRunning = canTakeover && (capability?.hasRichMetadata ?? false);

  const handleRowClick = (snap: ChatSubagentSnapshot) => {
    // Clicking the row whose drawer is open closes it.
    if (expandedTaskId === snap.taskId) {
      setExpandedTaskId(null);
      return;
    }
    // Already viewing this one's transcript — clicking again returns to parent.
    if (selectedTaskId === snap.taskId) {
      onClearSelectedSubagent?.();
      return;
    }

    // No full transcript for this runtime → always the inline drawer, no probe.
    if (!canTakeover) {
      setExpandedTaskId(snap.taskId);
      return;
    }

    if (immediateForRunning && snap.status === "running") {
      takeover(snap);
      return;
    }

    // Decide takeover-vs-drawer by asking the SAME fetch the takeover uses, so
    // we never replace the chat with an empty "No transcript" page. Running
    // agents re-probe every click (their transcript can appear later).
    const cached = snap.status === "running" ? undefined : probeResults[snap.taskId];
    if (cached === true) {
      takeover(snap);
      return;
    }
    if (cached === false) {
      setExpandedTaskId(snap.taskId);
      return;
    }
    if (!probeSubagentTranscript) {
      // Can't probe → never risk an empty takeover; show the inline drawer.
      setExpandedTaskId(snap.taskId);
      return;
    }

    setProbingTaskId(snap.taskId);
    void probeSubagentTranscript({ taskId: snap.taskId, agentId: snap.agentId ?? null })
      .then((hasTranscript) => {
        setProbingTaskId((current) => (current === snap.taskId ? null : current));
        setProbeResults((prev) => ({ ...prev, [snap.taskId]: hasTranscript }));
        if (hasTranscript) takeover(snap);
        else setExpandedTaskId(snap.taskId);
      })
      .catch(() => {
        setProbingTaskId((current) => (current === snap.taskId ? null : current));
        setProbeResults((prev) => ({ ...prev, [snap.taskId]: false }));
        setExpandedTaskId(snap.taskId);
      });
  };

  const planComplete = plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const planTotal = plan?.steps.length ?? 0;
  const planPercent = planTotal > 0 ? Math.round((planComplete / planTotal) * 100) : 0;
  const progressCollapsible = planTotal > PROGRESS_CAP;
  const progressCollapsed = progressCollapsible && paneUi.collapsed.progress === true;
  const visiblePlanSteps = plan && !showAll.progress ? plan.steps.slice(0, PROGRESS_CAP) : plan?.steps ?? [];
  const hiddenPlanCount = Math.max(0, planTotal - visiblePlanSteps.length);
  const taskComplete = todoItems.filter((item) => item.status === "completed").length;
  const taskActive = todoItems.filter((item) => item.status === "in_progress").length;
  const tasksCollapsible = todoItems.length > TASKS_CAP;
  const tasksCollapsed = tasksCollapsible && paneUi.collapsed.tasks === true;
  const visibleTodoItems = showAll.tasks ? todoItems : todoItems.slice(0, TASKS_CAP);
  const hiddenTaskCount = todoItems.length - visibleTodoItems.length;
  const taskHint = todoItems.length
    ? [
        `${taskComplete}/${todoItems.length} complete`,
        ...(taskActive ? [`${taskActive} active`] : []),
      ].join(" · ")
    : undefined;

  const subagentRunningCount = subagentGroups.active.filter((item) => item.status === "running").length;
  const subagentFailedCount = subagentGroups.active.filter((item) => item.status === "failed").length;
  const backgroundRunningCount = backgroundGroups.active.filter((item) => item.status === "running").length;
  const backgroundFailedCount = backgroundGroups.active.filter((item) => item.status === "failed").length;
  const scheduleRunningCount = scheduleGroups.active.filter((item) => item.status === "running").length;
  const scheduleFailedCount = scheduleGroups.active.filter((item) => item.status === "failed").length;

  const stickyHeaders = variant === "pane";

  const hasGoal = Boolean(goal?.objective?.trim());
  const hasTasks = todoItems.length > 0;
  const hasSubagents = subagents.length > 0;
  const hasBackground = backgroundItems.length > 0;
  const hasScheduled = scheduleItems.length > 0;
  const hasAnything = hasGoal || Boolean(plan) || hasTasks || hasSubagents || hasBackground || hasScheduled;
  const renderSubagentPaneRow = (snap: ChatSubagentSnapshot) => (
    <SubagentRow
      snapshot={snap}
      selected={selectedTaskId === snap.taskId}
      expanded={expandedTaskId === snap.taskId}
      probing={probingTaskId === snap.taskId}
      canViewFullTranscript={canTakeover}
      category={snap.background ? "background" : "subagent"}
      onClick={() => handleRowClick(snap)}
    />
  );

  const body = (
    <div className="flex min-h-full flex-col font-sans">
      {/* ── Goal (Codex chat goal) ───────────────────────────────── */}
      {hasGoal && goal ? (
        <CodexGoalCard
          goal={goal}
          onEdit={onEditGoal}
          onClear={onClearGoal}
          onSetStatus={onSetGoalStatus}
          pending={goalPending}
        />
      ) : null}

      {/* ── Progress ─────────────────────────────────────────────── */}
      {plan && plan.steps.length > 0 ? (
        <section className="pb-3">
          <SectionHeader
            label="Progress"
            hint={`${planComplete}/${planTotal} · ${planPercent}%`}
            tone="subagent"
            sticky={stickyHeaders}
            collapsible={progressCollapsible}
            collapsed={progressCollapsed}
            onToggle={() => toggleSection("progress")}
          />
          <SectionDisclosure open={!progressCollapsed}>
            <ProgressBar percent={planPercent} />
            <ul className="px-4 pt-2">
            {visiblePlanSteps.map((step, index) => {
              const isCompleted = step.status === "completed";
              const isInProgress = step.status === "in_progress";
              const isFailed = step.status === "failed";
              return (
                <li
                  key={`${index}-${step.text}`}
                  className={cn(
                    "flex items-start gap-2.5 py-[3px] text-[12.5px] leading-5",
                    isCompleted && "text-fg/45",
                    isInProgress && "text-[color:var(--color-accent-bright,#C4B5FD)]",
                    !isCompleted && !isInProgress && !isFailed && "text-fg/65",
                    isFailed && "text-rose-200/90",
                  )}
                >
                  <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <PlanGlyph status={step.status} />
                  </span>
                  <span className="min-w-0 flex-1 break-words">{step.text}</span>
                </li>
              );
            })}
            </ul>
            {hiddenPlanCount > 0 ? (
              <ShowAllButton hiddenLabel={`${hiddenPlanCount}`} onClick={() => setShowAll((current) => ({ ...current, progress: true }))} />
            ) : null}
          </SectionDisclosure>
        </section>
      ) : null}

      {/* ── Tasks ───────────────────────────────────────────────── */}
      {hasTasks ? (
        <section
          className={cn(
            "pb-3",
            (hasGoal || plan) && "border-t border-white/[0.04]",
          )}
        >
          <SectionHeader
            label="Tasks"
            hint={taskHint}
            tone="workflow"
            emphasized
            sticky={stickyHeaders}
            collapsible={tasksCollapsible}
            collapsed={tasksCollapsed}
            onToggle={() => toggleSection("tasks")}
          />
          <SectionDisclosure open={!tasksCollapsed}>
            <ChatTaskList items={visibleTodoItems} className="px-1 pb-1 pt-0" />
            {hiddenTaskCount > 0 ? (
              <ShowAllButton hiddenLabel={`${hiddenTaskCount}`} onClick={() => setShowAll((current) => ({ ...current, tasks: true }))} />
            ) : null}
          </SectionDisclosure>
        </section>
      ) : null}

      {/* ── Subagents (merged foreground + background-run agents) ──── */}
      {hasSubagents ? (
        <PaneScalableSection
          sectionKey="subagents" label="Subagents" tone="subagent" cap={SUBAGENTS_ACTIVE_CAP}
          hint={paneSectionHint({ activeCount: subagentGroups.active.length, runningCount: subagentRunningCount, failedCount: subagentFailedCount })}
          groups={subagentGroups} capped={cappedSubagents} paneUi={paneUi} sticky={stickyHeaders}
          idOf={(snap) => snap.taskId}
          renderActiveRow={renderSubagentPaneRow} renderEarlierRow={renderSubagentPaneRow}
          onToggleCollapsed={() => toggleSection("subagents")} onToggleEarlier={() => toggleEarlier("subagents")}
          onClear={(ids) => clearEarlier("subagents", ids)} onRestore={() => restoreCleared("subagents")}
          onShowAll={() => setShowAll((current) => ({ ...current, subagents: true }))} showAll={showAll.subagents === true}
          hasPrecedingSection={Boolean(hasGoal || plan || hasTasks)} showAllLabel={`${cappedSubagents.hiddenCount} running`}
          animateEarlierRows subagentTaskIdOf={(snap) => snap.taskId}
        />
      ) : null}

      {/* ── Background (background command tasks) ─────────────────── */}
      {hasBackground ? (
        <PaneScalableSection
          sectionKey="background" label="Background" tone="background" cap={BACKGROUND_ACTIVE_CAP}
          hint={paneSectionHint({ activeCount: backgroundGroups.active.length, runningCount: backgroundRunningCount, failedCount: backgroundFailedCount })}
          groups={backgroundGroups} capped={cappedBackground} paneUi={paneUi} sticky={stickyHeaders}
          idOf={(item) => item.id}
          renderActiveRow={(item) => <BackgroundCommandRow snapshot={item} />}
          renderEarlierRow={(item) => <BackgroundCommandRow snapshot={item} />}
          onToggleCollapsed={() => toggleSection("background")} onToggleEarlier={() => toggleEarlier("background")}
          onClear={(ids) => clearEarlier("background", ids)} onRestore={() => restoreCleared("background")}
          onShowAll={() => setShowAll((current) => ({ ...current, background: true }))} showAll={showAll.background === true}
          hasPrecedingSection={Boolean(hasGoal || plan || hasTasks || hasSubagents)}
        />
      ) : null}

      {/* ── Schedule (schedule kinds only) ───────────────────────── */}
      {hasScheduled ? (
        <PaneScalableSection
          sectionKey="schedule" label="Schedule" tone="scheduled" cap={SCHEDULE_ACTIVE_CAP}
          hint={paneSectionHint({ activeCount: scheduleGroups.active.length, runningCount: scheduleRunningCount, failedCount: scheduleFailedCount })}
          groups={scheduleGroups} capped={cappedSchedule} paneUi={paneUi} sticky={stickyHeaders}
          extraHeaderAction={<>{onToggleSchedulesPaused ? (
            <button
              type="button"
              onClick={onToggleSchedulesPaused}
              aria-label={schedulesPaused ? "Resume scheduled work for this chat" : "Pause scheduled work for this chat"}
              title={schedulesPaused ? "Resume scheduled work for this chat" : "Pause scheduled work for this chat"}
              className="flex h-5 w-5 items-center justify-center rounded-sm text-fg/35 transition-colors hover:bg-white/[0.05] hover:text-fg/65"
            >
              {schedulesPaused ? <Play aria-hidden size={11} weight="fill" /> : <Pause aria-hidden size={11} weight="fill" />}
            </button>
          ) : null}</>}
          idOf={(item) => item.id}
          renderActiveRow={(item) => <ScheduledWorkRow snapshot={item} schedulesPaused={schedulesPaused} onCancel={onCancelScheduledWork ? () => onCancelScheduledWork(item) : undefined} />}
          renderEarlierRow={(item) => isFiredOneShotWakeup(item)
            ? <ScheduleHistoryRow snapshot={item} />
            : <ScheduledWorkRow snapshot={item} schedulesPaused={schedulesPaused} />}
          onToggleCollapsed={() => toggleSection("schedule")} onToggleEarlier={() => toggleEarlier("schedule")}
          onClear={(ids) => clearEarlier("schedule", ids)} onRestore={() => restoreCleared("schedule")}
          onShowAll={() => setShowAll((current) => ({ ...current, schedule: true }))} showAll={showAll.schedule === true}
          hasPrecedingSection={Boolean(hasGoal || plan || hasTasks || hasSubagents || hasBackground)}
          animateActiveRows={false} keepEmptyActiveList={false}
        />
      ) : null}

      {/* ── Single-agent empty state ─────────────────────────────── */}
      {!hasAnything ? (
        <div className="px-4 py-6 text-[12px] leading-5 text-fg/40">
          No agent activity for this chat.
          <span className="block pt-0.5 text-fg/25">Single-agent mode.</span>
        </div>
      ) : null}

    </div>
  );

  if (variant === "pane") {
    return (
      <div className={cn("flex h-full min-h-0 flex-col font-sans", className)}>
        <div ref={paneScrollRef} data-testid="chat-subagents-pane-scroll" className="min-h-0 flex-1 overflow-y-auto">
          {body}
        </div>
      </div>
    );
  }

  return (
    <BottomDrawerSection
      label="Subagents"
      icon={TreeStructure}
      summary={headerSummary}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      className={className}
    >
      {body}
    </BottomDrawerSection>
  );
}
