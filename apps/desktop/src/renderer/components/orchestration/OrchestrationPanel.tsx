/**
 * OrchestrationPanel — the right-side plan panel for orchestrator chats.
 *
 * Mount this whenever the active session has `orchestrationRunId`. It owns:
 *   1. Run header (title, lane, phase pill, lead identity, collapse arrow)
 *   2. Phases accordion (Planning / Developing / Validating / Wrap-up)
 *   3. Task cards under each phase
 *   4. plan.md narrative via <PlanMarkdown />
 *   5. Empty-state Q&A history during Planning (built from
 *      manifest.decisions entries that match planning-question shapes)
 *
 * Layout: ~360px default width, resizable, collapse-to-icon-strip.
 * Lead view = fully interactive (context menus on tasks). Worker /
 * Validator view = same panel, read-only.
 *
 * Subscribes to `window.ade.orchestration.subscribe({ runId }, cb)` which
 * fires on every manifest / plan / asset / lifecycle event. We do a full
 * bundle re-read on every event for now — the bundle is small (kilobytes),
 * mutex-serialised on the server, and the panel only mounts on the active
 * session, so this is plenty fast in practice.
 */

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  CaretDown,
  CaretRight,
  ClockClockwise,
  DotsThree,
  ListChecks,
  MagnifyingGlass,
  Robot,
  UserCircle,
  Sparkle,
  CheckCircle,
  Circle,
  XCircle,
  ArrowsInLineHorizontal,
  ArrowsOutLineHorizontal,
  ChatTeardropDots,
  PaperPlaneTilt,
} from "@phosphor-icons/react";
import type {
  DecisionLogEntry,
  OrchestrationAgent,
  OrchestrationEventPayload,
  OrchestrationManifest,
  OrchestrationPhase,
  OrchestrationPhaseId,
  OrchestrationRole,
  OrchestrationTask,
  OrchestrationTaskStatus,
  ValidationChecklistItem,
  ValidationStep,
} from "../../../shared/types/orchestration";
import { cn } from "../ui/cn";
import { relativeTimeCompact, relativeWhen } from "../../lib/format";
import { PlanMarkdown, type PlanAssetResolver } from "./PlanMarkdown";

export const ORCHESTRATION_PANEL_TEST_ID = "orchestration-panel";
export const ORCHESTRATION_PANEL_EMPTY_QA_TEST_ID = "orchestration-panel-empty-qa";
export const ORCHESTRATION_PANEL_TASK_CARD_TEST_ID = "orchestration-task-card";
export const ORCHESTRATION_PANEL_PLAN_TEST_ID = "orchestration-panel-plan";

/* ──────────────────────────────────────────────────────────────────────────
   Public props
   ────────────────────────────────────────────────────────────────────────── */

export type OrchestrationPanelProps = {
  /** Active session's run id (the panel only mounts when this is present). */
  runId: string;
  /** Active session lane id (passed to the bundle-read IPC). */
  laneId: string;
  /** Lane display name for the run header. */
  laneName?: string | null;
  /**
   * Initial manifest snapshot (avoids a flash of empty content while the
   * first IPC read settles). Optional.
   */
  initialManifest?: OrchestrationManifest;
  /** Initial plan.md text. Optional. */
  initialPlanMd?: string;
  /**
   * Role of the viewer's chat session. The panel renders identically in all
   * three modes — but only `lead` exposes the per-task context menu.
   */
  viewerRole?: OrchestrationRole;
  /** Open another orchestration session in the work tab. */
  onOpenSession?: (sessionId: string) => void;
  /** Switch to the lead chat (used by worker / validator role banners). */
  onSwitchToLead?: () => void;
  /** Hand back a task action to the surrounding chat surface. */
  onTaskAction?: (action: OrchestrationTaskAction, task: OrchestrationTask) => void;
  /** Resolve a relative asset path into a renderable URL for PlanMarkdown. */
  resolveAsset?: PlanAssetResolver;
  /** Bundle root (forwarded to PlanMarkdown for "Open in ADE browser"). */
  bundleRoot?: string | null;
  /** External signal: scroll the panel to highlight this task card. */
  highlightedTaskId?: string | null;
  /** Override the subscribe / read pipeline (used by tests). */
  source?: OrchestrationDataSource;
  /** Optional default-collapsed flag (icon strip only). */
  defaultCollapsed?: boolean;
  className?: string;
  style?: CSSProperties;
};

export type OrchestrationTaskAction =
  | { kind: "open-worker-chat" }
  | { kind: "cancel"; revert: "true" | "false" | "review" }
  | { kind: "respawn" }
  | { kind: "mark-done-manually" };

/* The data source lets tests inject mock bundle reads + a manual event bus.
   In production it's auto-derived from `window.ade.orchestration.*`. */
export type OrchestrationDataSource = {
  read: (
    args: { runId: string; laneId: string },
  ) => Promise<{ manifest: OrchestrationManifest; planMd: string; etag: string }>;
  subscribe: (
    args: { runId: string },
    callback: (payload: OrchestrationEventPayload) => void,
  ) => () => void;
};

function defaultDataSource(): OrchestrationDataSource {
  return {
    read: async ({ runId, laneId }) => {
      const w = (typeof window !== "undefined" ? window : undefined) as
        | { ade?: { orchestration?: { bundleRead?: (args: { runId: string; laneId: string }) => Promise<{ manifest: OrchestrationManifest; planMd: string; etag: string }> } } }
        | undefined;
      const read = w?.ade?.orchestration?.bundleRead;
      if (!read) throw new Error("orchestration.bundleRead is not available");
      return read({ runId, laneId });
    },
    subscribe: ({ runId }, cb) => {
      const w = (typeof window !== "undefined" ? window : undefined) as
        | {
            ade?: {
              orchestration?: {
                subscribe?: (args: { runId: string }, cb: (payload: OrchestrationEventPayload) => void) => () => void;
              };
            };
          }
        | undefined;
      const subscribe = w?.ade?.orchestration?.subscribe;
      if (!subscribe) return () => undefined;
      return subscribe({ runId }, cb);
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   Local design tokens
   ────────────────────────────────────────────────────────────────────────── */

const PHASE_LABEL: Record<OrchestrationPhaseId, string> = {
  planning: "Planning",
  developing: "Developing",
  validating: "Validating",
  wrapup: "Wrap-up",
};

const PHASE_ICON: Record<OrchestrationPhaseId, ReactNode> = {
  planning: <Sparkle size={11} weight="duotone" />,
  developing: <Robot size={11} weight="duotone" />,
  validating: <ListChecks size={11} weight="duotone" />,
  wrapup: <CheckCircle size={11} weight="duotone" />,
};

const STATUS_PILL: Record<
  OrchestrationTaskStatus,
  { label: string; bg: string; border: string; fg: string }
> = {
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

const ROLE_PILL: Record<
  OrchestrationRole,
  { label: string; bg: string; border: string; fg: string }
> = {
  lead: {
    label: "LEAD",
    bg: "rgba(168, 85, 247, 0.14)",
    border: "rgba(168, 85, 247, 0.40)",
    fg: "rgb(216, 180, 254)",
  },
  worker: {
    label: "WORKER",
    bg: "rgba(96, 165, 250, 0.13)",
    border: "rgba(96, 165, 250, 0.36)",
    fg: "rgb(147, 197, 253)",
  },
  validator: {
    label: "VALIDATOR",
    bg: "rgba(34, 197, 94, 0.12)",
    border: "rgba(34, 197, 94, 0.34)",
    fg: "rgb(134, 239, 172)",
  },
};

/* ──────────────────────────────────────────────────────────────────────────
   Reducer / state plumbing
   ────────────────────────────────────────────────────────────────────────── */

type PanelState = {
  manifest: OrchestrationManifest | null;
  planMd: string;
  etag: string | null;
  error: string | null;
  loading: boolean;
};

type PanelAction =
  | { type: "load-start" }
  | { type: "load-success"; manifest: OrchestrationManifest; planMd: string; etag: string }
  | { type: "load-error"; error: string }
  | { type: "event"; payload: OrchestrationEventPayload };

function reducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "load-start":
      return { ...state, loading: true, error: null };
    case "load-success":
      return {
        ...state,
        loading: false,
        error: null,
        manifest: action.manifest,
        planMd: action.planMd,
        etag: action.etag,
      };
    case "load-error":
      return { ...state, loading: false, error: action.error };
    case "event": {
      const p = action.payload;
      if (p.kind === "manifest" && p.manifest) {
        return { ...state, manifest: p.manifest, etag: p.etag };
      }
      if (p.kind === "plan" && typeof p.planMd === "string") {
        return { ...state, planMd: p.planMd, etag: p.etag };
      }
      return state;
    }
    default:
      return state;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Component
   ────────────────────────────────────────────────────────────────────────── */

export function OrchestrationPanel({
  runId,
  laneId,
  laneName,
  initialManifest,
  initialPlanMd = "",
  viewerRole,
  onOpenSession,
  onSwitchToLead,
  onTaskAction,
  resolveAsset,
  bundleRoot,
  highlightedTaskId = null,
  source,
  defaultCollapsed = false,
  className,
  style,
}: OrchestrationPanelProps) {
  const ds = useMemo(() => source ?? defaultDataSource(), [source]);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [state, dispatch] = useReducer(reducer, {
    manifest: initialManifest ?? null,
    planMd: initialPlanMd,
    etag: initialManifest?.etag ?? null,
    error: null,
    loading: !initialManifest,
  });

  // Bundle read on mount / runId change
  const readVersion = useRef(0);
  useEffect(() => {
    let cancelled = false;
    readVersion.current += 1;
    const version = readVersion.current;
    if (!initialManifest) dispatch({ type: "load-start" });
    ds.read({ runId, laneId })
      .then((res) => {
        if (cancelled || version !== readVersion.current) return;
        dispatch({
          type: "load-success",
          manifest: res.manifest,
          planMd: res.planMd,
          etag: res.etag,
        });
      })
      .catch((err) => {
        if (cancelled || version !== readVersion.current) return;
        const message = err instanceof Error ? err.message : String(err);
        dispatch({ type: "load-error", error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [ds, runId, laneId, initialManifest]);

  // Subscribe to live events
  useEffect(() => {
    const off = ds.subscribe({ runId }, (payload) => {
      // If a manifest event omits the full manifest (small patch), refresh.
      if (payload.kind === "manifest" && !payload.manifest) {
        ds.read({ runId, laneId })
          .then((res) =>
            dispatch({
              type: "load-success",
              manifest: res.manifest,
              planMd: res.planMd,
              etag: res.etag,
            }),
          )
          .catch(() => undefined);
        return;
      }
      dispatch({ type: "event", payload });
    });
    return off;
  }, [ds, runId, laneId]);

  // Highlight scroll
  const taskRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  useEffect(() => {
    if (!highlightedTaskId) return;
    const el = taskRefs.current.get(highlightedTaskId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.setAttribute("data-orchestration-task-highlight", "true");
      const t = window.setTimeout(() => {
        el.removeAttribute("data-orchestration-task-highlight");
      }, 1500);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [highlightedTaskId]);

  const manifest = state.manifest;
  const isLead = viewerRole === "lead";
  const lead = useMemo<OrchestrationAgent | null>(
    () => manifest?.agents.find((a) => a.role === "lead") ?? null,
    [manifest],
  );
  const phases = useMemo<OrchestrationPhase[]>(
    () => manifest?.phases ?? [],
    [manifest],
  );
  const tasksByPhase = useMemo(() => {
    const map = new Map<OrchestrationPhaseId, OrchestrationTask[]>();
    for (const task of manifest?.tasks ?? []) {
      const arr = map.get(task.phaseId) ?? [];
      arr.push(task);
      map.set(task.phaseId, arr);
    }
    return map;
  }, [manifest]);
  const agentsBySessionId = useMemo(() => {
    const map = new Map<string, OrchestrationAgent>();
    for (const agent of manifest?.agents ?? []) map.set(agent.sessionId, agent);
    return map;
  }, [manifest]);

  if (collapsed) {
    return (
      <CollapsedRail
        manifest={manifest}
        onExpand={() => setCollapsed(false)}
        style={style}
        className={className}
      />
    );
  }

  return (
    <aside
      data-testid={ORCHESTRATION_PANEL_TEST_ID}
      data-orchestration-panel-run={runId}
      className={cn(
        "flex h-full min-h-0 w-full flex-col overflow-hidden",
        "border-l border-white/[0.06] bg-[color:color-mix(in_srgb,var(--color-bg)_92%,black_8%)]",
        className,
      )}
      style={style}
    >
      <RunHeader
        manifest={manifest}
        laneName={laneName ?? null}
        lead={lead}
        onCollapse={() => setCollapsed(true)}
        loading={state.loading}
        error={state.error}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Phases */}
        <div className="flex flex-col gap-2 px-3 pt-3">
          {phases.map((phase) => (
            <PhaseAccordion
              key={phase.id}
              phase={phase}
              tasks={tasksByPhase.get(phase.id) ?? []}
              isCurrent={manifest?.currentPhase === phase.id}
              isLead={isLead}
              agents={agentsBySessionId}
              validation={manifest?.validationStrategy}
              onTaskAction={onTaskAction}
              onOpenSession={onOpenSession}
              registerTaskRef={(id, el) => {
                if (el) taskRefs.current.set(id, el);
                else taskRefs.current.delete(id);
              }}
              decisions={manifest?.decisions ?? []}
              highlightedTaskId={highlightedTaskId}
            />
          ))}
        </div>

        {/* plan.md narrative */}
        {state.planMd.trim() ? (
          <div className="mt-4 border-t border-white/[0.05] px-3 py-3">
            <SectionHeader icon={<ChatTeardropDots size={11} weight="duotone" />}>
              Plan narrative
            </SectionHeader>
            <div
              data-testid={ORCHESTRATION_PANEL_PLAN_TEST_ID}
              className="mt-2 rounded-md border border-white/[0.05] bg-white/[0.015] px-3 py-2.5"
            >
              <PlanMarkdown
                source={state.planMd}
                resolveAsset={resolveAsset}
                bundleRoot={bundleRoot ?? manifest?.bundlePath ?? null}
              />
            </div>
          </div>
        ) : null}

        {/* Footer breathing space */}
        <div className="h-6 shrink-0" />
      </div>
    </aside>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Sub-components
   ────────────────────────────────────────────────────────────────────────── */

function CollapsedRail({
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
  const inFlight = (manifest?.tasks ?? []).filter(
    (t) => t.status === "claimed" || t.status === "in_progress",
  ).length;
  return (
    <aside
      data-testid={ORCHESTRATION_PANEL_TEST_ID}
      data-orchestration-panel-collapsed="true"
      className={cn(
        "flex h-full w-[40px] shrink-0 flex-col items-center gap-2 border-l border-white/[0.06] bg-[color:color-mix(in_srgb,var(--color-bg)_92%,black_8%)] py-3",
        className,
      )}
      style={style}
    >
      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand plan panel"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/[0.06] text-fg/60 transition-colors hover:bg-white/[0.05] hover:text-fg/90"
      >
        <ArrowsOutLineHorizontal size={12} weight="bold" />
      </button>
      <div
        className="flex h-6 w-6 items-center justify-center rounded-md text-fg/55"
        title={PHASE_LABEL[phase]}
      >
        {PHASE_ICON[phase]}
      </div>
      {inFlight > 0 ? (
        <div
          className="mt-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full border border-violet-300/30 bg-violet-300/10 px-1 font-mono text-[9px] font-semibold text-violet-100"
          title={`${inFlight} task${inFlight === 1 ? "" : "s"} in flight`}
        >
          {inFlight}
        </div>
      ) : null}
    </aside>
  );
}

function RunHeader({
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
  const title = manifest?.title?.trim() || "Orchestration run";
  const phaseId = manifest?.currentPhase ?? "planning";
  return (
    <div className="shrink-0 border-b border-white/[0.05] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] font-mono text-[9.5px] font-medium uppercase tracking-[0.18em]"
          style={{
            background: "rgba(168, 85, 247, 0.12)",
            border: "1px solid rgba(168, 85, 247, 0.34)",
            color: "rgb(216, 180, 254)",
          }}
        >
          {PHASE_ICON[phaseId]}
          {PHASE_LABEL[phaseId]}
        </span>
        <h2 className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-semibold text-fg/92" title={title}>
          {title}
        </h2>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse plan panel"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/[0.06] text-fg/55 transition-colors hover:bg-white/[0.05] hover:text-fg/90"
        >
          <ArrowsInLineHorizontal size={12} weight="bold" />
        </button>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[10.5px] text-muted-fg/70">
        {laneName ? (
          <span className="inline-flex items-center gap-1">
            <Circle size={6} weight="fill" className="text-violet-300/65" />
            Lane <span className="font-medium text-fg/75">{laneName}</span>
          </span>
        ) : null}
        {lead ? (
          <span className="inline-flex items-center gap-1">
            <UserCircle size={10} weight="duotone" className="text-violet-300/75" />
            Lead{" "}
            <span className="font-medium text-fg/75">
              {lead.displayName?.trim() || lead.goalSummary?.trim() || "—"}
            </span>
          </span>
        ) : null}
        {manifest?.agents?.length ? (
          <span className="inline-flex items-center gap-1">
            <Robot size={10} weight="duotone" className="text-sky-300/75" />
            {manifest.agents.length} agent{manifest.agents.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {loading ? (
          <span className="inline-flex items-center gap-1 text-violet-200/65">
            <Sparkle size={10} weight="duotone" /> loading…
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="mt-2 rounded-md border border-red-400/30 bg-red-400/[0.06] px-2 py-1 font-sans text-[10.5px] text-red-200/85">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function SectionHeader({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.18em] text-muted-fg/55">
      {icon}
      <span>{children}</span>
    </div>
  );
}

function PhaseAccordion({
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
          {PHASE_ICON[phase.id]}
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

function PlanningEmptyState({ decisions }: { decisions: DecisionLogEntry[] }) {
  const qa = useMemo(() => filterPlanningQuestions(decisions), [decisions]);
  return (
    <div
      data-testid={ORCHESTRATION_PANEL_EMPTY_QA_TEST_ID}
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

/**
 * Parse `decisions[]` entries for planning Q&A pairs. The lead skill writes
 * decisions as "Q: <question>" / "A: <answer>" summary strings; we surface
 * those, plus any plain-text question entries while planning is in flight.
 */
type PlanningQA = {
  id: string;
  kind: "question-pending" | "question-answered";
  question: string;
  answer: string | null;
};
function filterPlanningQuestions(decisions: DecisionLogEntry[]): PlanningQA[] {
  const out: PlanningQA[] = [];
  for (const entry of decisions) {
    const text = entry.summary?.trim() ?? "";
    if (!text) continue;
    // Match shapes like "Q: ... / A: ...", "Question: ...", "ask: ...".
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

function TaskCard({
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
      data-testid={ORCHESTRATION_PANEL_TASK_CARD_TEST_ID}
      data-orchestration-task-id={task.id}
      data-orchestration-task-status={task.status}
      data-orchestration-task-highlighted={highlighted ? "true" : undefined}
      className={cn(
        "group rounded-md border bg-white/[0.018] px-2.5 py-2 transition-all",
        highlighted ? "border-violet-300/45 shadow-[0_0_0_1px_rgba(168,85,247,0.25)]" : "border-white/[0.06]",
        "hover:bg-white/[0.03]",
      )}
    >
      {/* Row 1: id + tag chip + status pill + expand + ⋯ */}
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] font-semibold tracking-tight text-fg/65">
          {task.id}
        </span>
        {task.tag ? (
          <span
            className="inline-flex items-center rounded-sm px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.14em] text-fg/70"
            style={{
              background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-accent) 26%, transparent)",
            }}
          >
            {task.tag}
          </span>
        ) : null}
        <span
          className="ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.14em]"
          style={{ background: pill.bg, border: `1px solid ${pill.border}`, color: pill.fg }}
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
              <ContextMenu
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
      <div className="mt-1 font-sans text-[12px] font-medium leading-snug text-fg/90">
        {task.title}
      </div>

      {/* Row 3: description (3-line clamp) */}
      {task.description ? (
        <div
          className={cn(
            "mt-1 font-sans text-[11px] leading-[1.55] text-fg/65",
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
              className="inline-flex max-w-full items-center gap-1 truncate rounded-sm border border-white/[0.06] bg-white/[0.02] px-1.5 py-[1px] font-mono text-[9.5px] text-fg/65 transition-colors hover:bg-white/[0.05] hover:text-fg/85"
              title={path}
            >
              <span aria-hidden>📄</span>
              <span className="truncate">{path}</span>
            </button>
          ))}
          {!expanded && task.filesHint.length > 4 ? (
            <span className="inline-flex items-center font-mono text-[9.5px] text-muted-fg/55">
              +{task.filesHint.length - 4}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Row 5: owner + elapsed */}
      {(owner || elapsedLabel) ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[10.5px] text-muted-fg/65">
          {owner ? (
            <button
              type="button"
              onClick={() => onOpenSession?.(owner.sessionId)}
              className="inline-flex items-center gap-1 text-fg/70 hover:text-fg/95"
              title={`Open ${owner.role} chat`}
            >
              <UserCircle size={10} weight="duotone" />
              <span>
                {owner.role}
                {owner.tag ? ` · ${owner.tag}` : ""}
              </span>
            </button>
          ) : null}
          {elapsedLabel ? (
            <span className="inline-flex items-center gap-1">
              <ClockClockwise size={10} weight="duotone" />
              <span className="tabular-nums">{elapsedLabel} elapsed</span>
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
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function StatusGlyph({ status }: { status: OrchestrationTaskStatus }) {
  if (status === "done") return <CheckCircle size={9} weight="fill" />;
  if (status === "failed") return <XCircle size={9} weight="fill" />;
  if (status === "in_progress" || status === "claimed") return <ClockClockwise size={9} weight="bold" />;
  return <Circle size={8} weight="bold" />;
}

function ValidationBadge({
  label,
  status,
  title,
}: {
  label: string;
  status: "running" | "passed" | "failed" | null;
  title?: string;
}) {
  const palette =
    status === "passed"
      ? { bg: "rgba(34, 197, 94, 0.10)", border: "rgba(34, 197, 94, 0.30)", fg: "rgb(134, 239, 172)", glyph: "✓" }
      : status === "failed"
        ? { bg: "rgba(239, 68, 68, 0.10)", border: "rgba(239, 68, 68, 0.30)", fg: "rgb(252, 165, 165)", glyph: "✗" }
        : status === "running"
          ? { bg: "rgba(250, 204, 21, 0.10)", border: "rgba(250, 204, 21, 0.30)", fg: "rgb(254, 240, 138)", glyph: "⏳" }
          : { bg: "rgba(255, 255, 255, 0.04)", border: "rgba(255, 255, 255, 0.10)", fg: "rgba(255, 255, 255, 0.55)", glyph: "—" };
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.14em]"
      style={{ background: palette.bg, border: `1px solid ${palette.border}`, color: palette.fg }}
    >
      <span aria-hidden>{palette.glyph}</span>
      <span>{label.replace(/_/g, " ")}</span>
    </span>
  );
}

function ContextMenu({
  onAction,
  onDismiss,
}: {
  onAction: (action: OrchestrationTaskAction) => void;
  onDismiss: () => void;
}) {
  // Dismiss on outside click
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
        <XCircle size={10} weight="duotone" /> Cancel task…
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

function emitFileChip(path: string): void {
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

function formatElapsed(ms: number): string {
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

// Re-export utility for sibling components / tests.
export { filterPlanningQuestions, formatElapsed, relativeWhen, relativeTimeCompact };

export default OrchestrationPanel;
