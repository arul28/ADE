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
 * Subscribes to `window.ade.orchestration.subscribe({ runId, laneId }, cb)` which
 * fires on every manifest / plan / asset / lifecycle event. We do a full
 * bundle re-read on every event for now — the bundle is small (kilobytes),
 * mutex-serialised on the server, and the panel only mounts on the active
 * session, so this is plenty fast in practice.
 *
 * Sub-components are split into sibling files to keep this module focused
 * on data fetching, state management, and layout wiring:
 *   - orchestrationDataSource.ts — IPC bridge + asset URL helpers
 *   - orchestrationTokens.ts     — design tokens, types, and pure helpers
 *   - PanelChrome.tsx            — shell components (header, rail, section)
 *   - PhaseAccordion.tsx         — collapsible phase sections
 *   - TaskCard.tsx               — task card + context menu
 */

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { ChatTeardropDots, UsersThree } from "@phosphor-icons/react";
import type {
  OrchestrationAgent,
  OrchestrationEventPayload,
  OrchestrationManifest,
  OrchestrationPhase,
  OrchestrationPhaseId,
  OrchestrationTask,
} from "../../../shared/types/orchestration";
import { cn } from "../ui/cn";
import { relativeTimeCompact, relativeWhen } from "../../lib/format";
import { PlanMarkdown, type PlanAssetResolver } from "./PlanMarkdown";
import {
  type OrchestrationDataSource,
  defaultDataSource,
} from "./orchestrationDataSource";
import {
  filterPlanningQuestions,
  formatElapsed,
  type OrchestrationTaskAction,
  type OrchestrationPanelProps,
} from "./orchestrationTokens";
import {
  CollapsedRail,
  RunHeader,
  PlanReadyBar,
  PlanApprovalFooter,
  SectionHeader,
} from "./PanelChrome";
import { PhaseAccordion } from "./PhaseAccordion";
import { ValidationFindings } from "./ValidationFindings";

/* ──────────────────────────────────────────────────────────────────────────
   Test IDs (stable cross-file references)
   ────────────────────────────────────────────────────────────────────────── */

export const ORCHESTRATION_PANEL_TEST_ID = "orchestration-panel";
export const ORCHESTRATION_PANEL_EMPTY_QA_TEST_ID = "orchestration-panel-empty-qa";
export const ORCHESTRATION_PANEL_TASK_CARD_TEST_ID = "orchestration-task-card";
export const ORCHESTRATION_PANEL_PLAN_TEST_ID = "orchestration-panel-plan";
export const ORCHESTRATION_PLAN_IMPLEMENT_BUTTON_TEST_ID = "orchestration-plan-implement-button";

// Re-export types that consumers depend on from OrchestrationPanel's module path.
export type { OrchestrationPanelProps, OrchestrationTaskAction } from "./orchestrationTokens";
export type { OrchestrationDataSource } from "./orchestrationDataSource";

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
      if (p.kind === "heartbeat" && state.manifest) {
        return {
          ...state,
          manifest: {
            ...state.manifest,
            agents: state.manifest.agents.map((agent) =>
              agent.sessionId === p.sessionId
                ? { ...agent, lastHeartbeatAt: p.lastHeartbeatAt }
                : agent,
            ),
          },
        };
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
  onTaskAction,
  resolveAsset,
  bundleRoot,
  highlightedTaskId = null,
  planApprovalPending = null,
  onPlanApproval,
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
    const off = ds.subscribe({ runId, laneId }, (payload) => {
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

  // Route the task context-menu "open worker chat" action to the jump handler
  // (it previously bubbled to an unhandled onTaskAction and did nothing).
  const handleTaskAction = useCallback(
    (action: OrchestrationTaskAction, task: OrchestrationTask) => {
      if (action.kind === "open-worker-chat") {
        if (task.assigneeSessionId) onOpenSession?.(task.assigneeSessionId);
        return;
      }
      onTaskAction?.(action, task);
    },
    [onTaskAction, onOpenSession],
  );

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

  // Plan-diff signal: the lead changed plan.md since the last time the user
  // reviewed it (decline records the reviewed hash; re-approval carries the
  // current one). We surface a lightweight "updated" badge on re-approval.
  const pendingPlanHash = ((): string | null => {
    const meta = (planApprovalPending?.request as { providerMetadata?: Record<string, unknown> } | undefined)
      ?.providerMetadata;
    const h = meta?.planContentHash;
    return typeof h === "string" ? h : null;
  })();
  const lastReviewedHash = manifest?.planSpec?.approval.lastReviewedPlanContentHash ?? null;
  const changedSinceLastReview = Boolean(
    pendingPlanHash && lastReviewedHash && pendingPlanHash !== lastReviewedHash,
  );
  const hasPlanNarrative = state.planMd.trim().length > 0;

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

      {/* Approval normally docks to the live plan narrative below; this top bar
          is only a fallback for the rare case where approval is pending but no
          plan.md has been authored yet. */}
      {planApprovalPending && !hasPlanNarrative ? (
        <PlanReadyBar
          pending={planApprovalPending}
          onImplement={onPlanApproval}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Agents roster — every agent in the run with a one-click jump to its chat */}
        <AgentsRoster agents={manifest?.agents ?? []} onOpenSession={onOpenSession} />

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
              onTaskAction={handleTaskAction}
              onOpenSession={onOpenSession}
              registerTaskRef={(id, el) => {
                if (el) taskRefs.current.set(id, el);
                else taskRefs.current.delete(id);
              }}
              decisions={manifest?.decisions ?? []}
              planning={manifest?.leadState?.planning}
              highlightedTaskId={highlightedTaskId}
            />
          ))}
        </div>

        {/* Validation findings — severity-ranked roll-up of the validator panel */}
        <ValidationFindings manifest={manifest} />

        {/* plan.md narrative — the single source of truth, and where approval docks */}
        {hasPlanNarrative ? (
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
              {planApprovalPending ? (
                <PlanApprovalFooter
                  pending={planApprovalPending}
                  onImplement={onPlanApproval}
                  changedSinceLastReview={changedSinceLastReview}
                />
              ) : null}
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
   Agents roster — every agent in the run + a one-click jump to its chat
   ────────────────────────────────────────────────────────────────────────── */

function AgentStatusDot({ status }: { status: OrchestrationAgent["status"] }) {
  const color =
    status === "running"
      ? "rgb(110, 231, 183)"
      : status === "completed"
        ? "rgb(110, 231, 183)"
        : status === "failed"
          ? "rgb(252, 165, 165)"
          : status === "blocked"
            ? "rgb(253, 224, 71)"
            : "rgba(255,255,255,0.35)";
  return (
    <span
      aria-hidden
      title={status}
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", status === "running" && "animate-pulse")}
      style={{ background: color }}
    />
  );
}

function AgentsRoster({
  agents,
  onOpenSession,
}: {
  agents: OrchestrationAgent[];
  onOpenSession?: (sessionId: string) => void;
}) {
  if (!agents.length) return null;
  return (
    <div
      data-testid="orchestration-agents-roster"
      className="border-b border-white/[0.05] px-3 py-2.5"
    >
      <SectionHeader icon={<UsersThree size={11} weight="duotone" />}>Agents</SectionHeader>
      <div className="mt-2 flex flex-col gap-0.5">
        {agents.map((agent) => (
          <div
            key={agent.sessionId}
            className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-white/[0.02]"
          >
            <AgentStatusDot status={agent.status} />
            <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-fg/75">
              {agent.role}
              {agent.tag ? <span className="text-fg/55"> · {agent.tag}</span> : null}
            </span>
            <button
              type="button"
              data-testid="orchestration-roster-open-chat"
              aria-label={`Open ${agent.role}${agent.tag ? ` · ${agent.tag}` : ""} chat`}
              onClick={() => onOpenSession?.(agent.sessionId)}
              className="inline-flex items-center gap-1 rounded-md border border-sky-300/30 bg-sky-300/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-100 transition-colors hover:bg-sky-300/[0.18]"
              title={`Open ${agent.role}${agent.tag ? ` · ${agent.tag}` : ""} chat`}
            >
              <ChatTeardropDots size={10} weight="duotone" />
              Open chat
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Re-export utility for sibling components / tests.
export { filterPlanningQuestions, formatElapsed, relativeWhen, relativeTimeCompact };

export default OrchestrationPanel;
