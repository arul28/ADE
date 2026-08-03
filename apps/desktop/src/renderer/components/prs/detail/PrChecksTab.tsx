/**
 * CI / Checks — live pipeline visualizer.
 *
 * Replaces the old flat stack of `cardStyle()` rows (1px border, radius 16, and
 * a `backdropFilter: blur(20px)` per row, ~34 deep). State now lives in a 2px
 * left spine and one status icon; there are no per-row cards and no backdrop
 * filters anywhere in this tree.
 */

import React from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CheckCircle,
  CircleNotch,
  MinusCircle,
  XCircle,
} from "@phosphor-icons/react";

import type {
  PrActionRun,
  PrCheck,
  PrChecksStatus,
  PrCheckLogExcerpt,
  PrPipelineState,
  PrRerunChecksTarget,
  PrWorkflowGraph,
  PrWorkflowGraphNode,
} from "../../../../shared/types";
import { COLORS, MONO_FONT, RADII, SANS_FONT, SPACING, floatingPane } from "../../lanes/laneDesignTokens";
import { formatDurationMs } from "../../../lib/format";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { PrCommandPalettes, type PaletteCheck } from "../shared/PrCommandPalettes";
import {
  PrCheckLogDrawer,
  type PrCheckLogDrawerState,
} from "../shared/PrCheckLogDrawer";
import {
  buildUnifiedChecks,
  checkElapsedMs,
  pipelineStateOf,
} from "../shared/prUnifiedChecks";
import { fetchCheckLog, fetchWorkflowGraph, hasCheckLogApi } from "./prChecksApi";
import {
  buildGraphColumns,
  buildLogExcerptMarkdown,
  deriveFallbackGraph,
  failingNodes,
  graphBuckets,
  graphUnavailableCopy,
  groupByWorkflow,
  hydrateWorkflowGraph,
  isEdgeLive,
  matrixLegCaption,
  nodeElapsedMs,
  pipelineElapsedMs,
  readStoredChecksView,
  resolveLogJobId,
  stepProgress,
  writeStoredChecksView,
  type ChecksView,
  type GraphColumn,
} from "./prChecksModel";

const LIVE_TICK_MS = 1_000;

/** Every state color resolves through the semantic palette — no hex literals. */
const STATE_COLOR: Record<PrPipelineState, string> = {
  passed: COLORS.checkPass,
  failed: COLORS.danger,
  running: COLORS.warning,
  queued: COLORS.textDim,
  skipped: COLORS.textDim,
  unknown: COLORS.textMuted,
};

const STATE_LABEL: Record<PrPipelineState, string> = {
  passed: "passed",
  failed: "failed",
  running: "running",
  queued: "queued",
  skipped: "skipped",
  unknown: "unknown",
};

function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

function fmtMs(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const label = formatDurationMs(ms);
  return label === "--" ? "0s" : label;
}

// ---------------------------------------------------------------------------
// Live clock — only ticks while something is actually moving.
// ---------------------------------------------------------------------------

function useLiveNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function StateIcon({ state, size = 13 }: { state: PrPipelineState; size?: number }) {
  const color = STATE_COLOR[state];
  if (state === "passed") return <CheckCircle size={size} weight="fill" style={{ color, flexShrink: 0 }} />;
  if (state === "failed") return <XCircle size={size} weight="fill" style={{ color, flexShrink: 0 }} />;
  if (state === "running") {
    return <CircleNotch size={size} className="motion-safe:animate-spin" style={{ color, flexShrink: 0 }} />;
  }
  if (state === "skipped") return <MinusCircle size={size} weight="fill" style={{ color, flexShrink: 0 }} />;
  return (
    <span
      className="shrink-0 rounded-full"
      style={{ width: size - 2, height: size - 2, border: `1.5px dashed ${tint(COLORS.textDim, 80)}` }}
    />
  );
}

function SegButton({
  active, onClick, children, testId,
}: { active: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className="h-[22px] rounded px-2.5 text-[11px] font-medium"
      style={{
        border: "none",
        cursor: "pointer",
        borderRadius: RADII.sm,
        fontFamily: SANS_FONT,
        background: active ? COLORS.cardBgSolid : "transparent",
        color: active ? COLORS.textPrimary : COLORS.textMuted,
      }}
    >
      {children}
    </button>
  );
}

function SmallButton({
  onClick, children, tone = "neutral", disabled = false, testId, title,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  tone?: "neutral" | "warn";
  disabled?: boolean;
  testId?: string;
  title?: string;
}) {
  const color = tone === "warn" ? COLORS.warning : COLORS.textSecondary;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className="inline-flex h-[26px] shrink-0 items-center gap-1.5 px-2.5 text-[11px] font-medium"
      style={{
        borderRadius: RADII.sm,
        fontFamily: SANS_FONT,
        color,
        background: COLORS.cardBg,
        border: `1px solid ${tone === "warn" ? tint(COLORS.warning, 38) : COLORS.outlineBorder}`,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Header strip
// ---------------------------------------------------------------------------

function StripSegment({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="flex flex-col gap-[3px] px-[15px] py-[11px]" style={{ borderLeft: `1px solid ${COLORS.borderMuted}` }}>
      <span
        className="text-[9.5px] uppercase"
        style={{ letterSpacing: "0.09em", color: COLORS.textDim, fontFamily: SANS_FONT }}
      >
        {label}
      </span>
      <span
        className="text-[15px] font-semibold tabular-nums"
        style={{ color: color ?? COLORS.textPrimary, fontFamily: SANS_FONT }}
      >
        {value}
      </span>
    </div>
  );
}

/** Pass/fail of every workflow run on this PR, oldest → newest. */
function RunHistorySparkline({ runs }: { runs: PrActionRun[] }) {
  const ordered = React.useMemo(
    () => [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-24),
    [runs],
  );
  if (ordered.length < 2) return null;
  return (
    <span
      className="flex h-[14px] items-end gap-[2px]"
      data-testid="pr-checks-run-sparkline"
      title={`${ordered.length} runs on this PR`}
    >
      {ordered.map((run) => {
        const state: PrPipelineState = run.status !== "completed"
          ? "running"
          : run.conclusion === "success"
            ? "passed"
            : run.conclusion === "failure"
                || run.conclusion === "timed_out"
                || run.conclusion === "cancelled"
                || run.conclusion === "action_required"
              ? "failed"
              : "skipped";
        const height = state === "passed" ? 6 : state === "failed" ? 14 : 10;
        return (
          <i
            key={run.id}
            className="block w-[3px] rounded-[1px]"
            style={{ height, background: STATE_COLOR[state] }}
          />
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Graph node
// ---------------------------------------------------------------------------

function GraphNodeCell({
  node, now, selected, onCritical, onSelect,
}: {
  node: PrWorkflowGraphNode;
  now: number;
  selected: boolean;
  onCritical: boolean;
  onSelect: (node: PrWorkflowGraphNode) => void;
}) {
  const elapsed = fmtMs(nodeElapsedMs(node, now));
  const caption = matrixLegCaption(node);
  const progress = node.state === "running" ? stepProgress(node) : null;
  const spine = onCritical ? COLORS.accent : STATE_COLOR[node.state];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(node)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(node); } }}
      data-testid="pr-checks-graph-node"
      data-job-id={node.jobId}
      data-state={node.state}
      data-critical={onCritical ? "true" : undefined}
      className="relative cursor-pointer overflow-hidden py-[7px] pl-[9px] pr-[9px]"
      style={{
        borderRadius: RADII.md,
        background: selected ? tint(COLORS.accent, 10) : node.state === "failed" ? tint(COLORS.danger, 6) : "transparent",
      }}
    >
      {/* 2px state spine — accent-tinted on the critical path. */}
      <span
        aria-hidden
        className="absolute bottom-0 left-0 top-0 w-[2px]"
        style={{ background: spine, opacity: onCritical ? 0.9 : 1 }}
      />
      <div className="flex items-center gap-1.5">
        <StateIcon state={node.state} />
        <span
          className="min-w-0 truncate text-[11.5px] font-medium"
          style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}
          title={node.displayName}
        >
          {node.displayName}
        </span>
        <span
          className="ml-auto shrink-0 text-[10px] font-medium tabular-nums"
          style={{
            color: node.state === "running" ? COLORS.warning : COLORS.textDim,
            fontFamily: MONO_FONT,
          }}
          data-testid="pr-checks-node-duration"
        >
          {elapsed ?? STATE_LABEL[node.state]}
        </span>
      </div>

      {node.legs.length > 0 ? (
        <>
          <div className="mt-[5px] flex gap-[3px] pl-[19px]" data-testid="pr-checks-node-legs">
            {node.legs.map((leg, idx) => (
              <i
                key={`${leg.name}-${idx}`}
                data-testid="pr-checks-node-leg"
                data-leg-state={leg.state}
                title={`${leg.name} · ${STATE_LABEL[leg.state]}`}
                className="block h-[3px] flex-1 rounded-[2px]"
                style={{ background: STATE_COLOR[leg.state] }}
              />
            ))}
          </div>
          {caption ? (
            <div
              className="mt-1 pl-[19px] text-[10px]"
              style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
              data-testid="pr-checks-node-leg-caption"
            >
              {caption}
            </div>
          ) : null}
        </>
      ) : null}

      {progress ? (
        <div className="mt-1.5 pl-[19px]" data-testid="pr-checks-node-steps">
          {node.steps.slice(0, 6).map((step) => {
            const state = pipelineStateOf(step);
            const stepMs = checkElapsedMs(step, now);
            return (
              <div key={`${step.number}-${step.name}`} className="flex items-center gap-1.5 py-px text-[10.5px]" style={{ color: COLORS.textMuted }}>
                <span
                  className="h-[9px] w-[9px] shrink-0 rounded-full"
                  style={
                    state === "running"
                      ? { border: `1.5px solid ${COLORS.warning}`, borderTopColor: "transparent" }
                      : state === "passed"
                        ? { background: COLORS.checkPass }
                        : state === "failed"
                          ? { background: COLORS.danger }
                          : { border: `1px dashed ${tint(COLORS.textDim, 70)}` }
                  }
                />
                <span className="min-w-0 truncate" style={{ fontFamily: SANS_FONT }}>{step.name}</span>
                <span className="ml-auto text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                  {stepMs != null ? fmtMs(stepMs) : "—"}
                </span>
              </div>
            );
          })}
          <div
            className="mt-[5px] h-[2px] overflow-hidden rounded-[2px]"
            style={{ background: tint(COLORS.textDim, 25) }}
          >
            <i className="block h-full" style={{ width: `${progress.pct}%`, background: COLORS.warning }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flat row (list / failures / swimlane fallback / external lane)
// ---------------------------------------------------------------------------

function FlatRow({
  name, state, elapsedMs, detailsUrl, selected, onSelect, subtitle,
}: {
  name: string;
  state: PrPipelineState;
  elapsedMs: number | null;
  detailsUrl: string | null;
  selected?: boolean;
  onSelect?: () => void;
  subtitle?: string | null;
}) {
  const interactive = Boolean(onSelect);
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={interactive ? (e) => { if (e.key === "Enter") { e.preventDefault(); onSelect?.(); } } : undefined}
      data-testid="pr-checks-row"
      data-check-name={name}
      data-state={state}
      className="group relative flex items-center gap-[7px] py-1.5 pl-[9px] pr-2 text-[11.5px]"
      style={{
        borderRadius: RADII.sm,
        background: selected ? tint(COLORS.accent, 10) : "transparent",
        cursor: interactive ? "pointer" : "default",
      }}
    >
      <span aria-hidden className="absolute bottom-0 left-0 top-0 w-[2px]" style={{ background: STATE_COLOR[state] }} />
      <StateIcon state={state} />
      <span className="min-w-0 truncate" style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }} title={name}>
        {name}
      </span>
      {subtitle ? (
        <span className="shrink-0 text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
          {subtitle}
        </span>
      ) : null}
      <span className="ml-auto shrink-0 text-[10px] tabular-nums" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
        {fmtMs(elapsedMs) ?? STATE_LABEL[state]}
      </span>
      {detailsUrl ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void window.ade.app.openExternal(detailsUrl); }}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: 2 }}
          aria-label={`Open ${name} on GitHub`}
        >
          <ArrowSquareOut size={11} />
        </button>
      ) : null}
    </div>
  );
}

function LaneHeader({ tag, children }: { tag: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[7px] px-0.5 py-1.5 text-[10.5px]" style={{ color: COLORS.textMuted }}>
      <span
        className="uppercase"
        style={{
          fontFamily: MONO_FONT,
          fontSize: 9,
          letterSpacing: "0.07em",
          padding: "1px 6px",
          borderRadius: 999,
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.borderMuted}`,
          color: COLORS.textDim,
        }}
      >
        {tag}
      </span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export type PrChecksTabProps = {
  pr: {
    id: string;
    projectId: string;
    repoOwner: string;
    repoName: string;
    githubPrNumber: number;
    headSha?: string | null;
  };
  checks: PrCheck[];
  actionRuns: PrActionRun[];
  actionBusy: boolean;
  /**
   * The canonical rollup. `buckets` folds `graph.externalChecks` into its
   * counts, so with no Actions run three preview-bot successes rendered
   * "Passed 3/3" in green — contradicting the header pill on the same screen.
   */
  checksStatus?: PrChecksStatus | null;
  /**
   * True for GitHub-tab PRs with no `pull_requests` row. The workflow-graph and
   * log-excerpt endpoints are row-based and reject for these, so we never call
   * them — the tab degrades to the swimlane fallback built from `checks`.
   */
  unmapped?: boolean;
  onRerunChecks?: (target?: PrRerunChecksTarget) => void;
  focusedCheckId?: string | null;
  onFocusedCheckConsumed?: () => void;
  /** Bumped by the `g k` chord in `PrDetailPane` to open the checks palette. */
  paletteRequest?: number;
  /** Opens the lane's most recent Work chat with the failing log prefilled. */
  onFixInChat?: (excerpt: PrCheckLogExcerpt) => void;
};

export function PrChecksTab({
  pr,
  checks,
  actionRuns,
  actionBusy,
  checksStatus,
  unmapped = false,
  onRerunChecks,
  focusedCheckId,
  onFocusedCheckConsumed,
  paletteRequest = 0,
  onFixInChat,
}: PrChecksTabProps) {
  const [view, setView] = React.useState<ChecksView>(() => readStoredChecksView(pr.projectId) ?? "graph");
  const [serviceGraph, setServiceGraph] = React.useState<PrWorkflowGraph | null>(null);
  const [drawer, setDrawer] = React.useState<PrCheckLogDrawerState | null>(null);
  const [excerpt, setExcerpt] = React.useState<PrCheckLogExcerpt | null>(null);
  const [logLoading, setLogLoading] = React.useState(false);
  const [logError, setLogError] = React.useState<string | null>(null);
  const { copy, copied, reset: resetCopied } = useCopyToClipboard({ timeout: 1600 });
  const [selectedAttempt, setSelectedAttempt] = React.useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [focusedFailureIdx, setFocusedFailureIdx] = React.useState(0);
  const autoOpenedForPrRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    setView(readStoredChecksView(pr.projectId) ?? "graph");
  }, [pr.projectId]);

  const selectView = React.useCallback((next: ChecksView) => {
    setView(next);
    writeStoredChecksView(pr.projectId, next);
  }, [pr.projectId]);

  // ---- attempts ---------------------------------------------------------
  const attempts = React.useMemo(() => {
    const seen = new Set<number>();
    for (const run of actionRuns) seen.add(run.runAttempt ?? 1);
    return Array.from(seen).sort((a, b) => a - b);
  }, [actionRuns]);
  const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1]! : 1;
  const viewingLatestAttempt = selectedAttempt == null || selectedAttempt === latestAttempt;
  const hasActionRuns = actionRuns.length > 0;

  React.useEffect(() => {
    if (selectedAttempt != null && !attempts.includes(selectedAttempt)) {
      setSelectedAttempt(null);
    }
  }, [attempts, selectedAttempt]);

  const attemptRuns = React.useMemo(
    () => (viewingLatestAttempt ? actionRuns : actionRuns.filter((r) => (r.runAttempt ?? 1) === selectedAttempt)),
    [actionRuns, selectedAttempt, viewingLatestAttempt],
  );

  const unified = React.useMemo(
    () => buildUnifiedChecks(checks, attemptRuns),
    [checks, attemptRuns],
  );

  // ---- graph ------------------------------------------------------------
  React.useEffect(() => {
    let cancelled = false;
    setServiceGraph(null);
    // The graph endpoint is row-based and rejects for unmapped GitHub-tab PRs,
    // so don't ask — go straight to the fallback built from `checks`.
    if (unmapped) return undefined;
    void fetchWorkflowGraph({ prId: pr.id })
      .then((value) => { if (!cancelled) setServiceGraph(value); })
      .catch(() => { if (!cancelled) setServiceGraph(null); });
    return () => { cancelled = true; };
  }, [pr.id, pr.headSha, unmapped, hasActionRuns]);

  const graph = React.useMemo<PrWorkflowGraph>(() => {
    // Older attempts are not charted by the service (it only parses the head
    // run), so scrubbing back always falls through to the flat swimlanes.
    const usable = viewingLatestAttempt
      && serviceGraph
      && (serviceGraph.nodes.length > 0 || serviceGraph.externalChecks.length > 0);
    if (usable) return hydrateWorkflowGraph(serviceGraph, unified);
    return deriveFallbackGraph(unified, {
      headSha: pr.headSha ?? serviceGraph?.headSha ?? null,
      reason: viewingLatestAttempt ? serviceGraph?.unavailableReason ?? null : null,
    });
  }, [serviceGraph, unified, pr.headSha, viewingLatestAttempt]);

  const buckets = React.useMemo(() => graphBuckets(graph), [graph]);
  const anythingRunning = buckets.running > 0 || buckets.queued > 0;
  const now = useLiveNow(anythingRunning);

  const columns = React.useMemo<GraphColumn[]>(() => buildGraphColumns(graph.nodes), [graph.nodes]);
  const criticalPath = React.useMemo(() => new Set(graph.criticalPath), [graph.criticalPath]);
  const failures = React.useMemo(() => failingNodes(graph), [graph]);

  // ---- log drawer -------------------------------------------------------
  const openDrawerFor = React.useCallback((node: PrWorkflowGraphNode) => {
    setDrawer({ node, jobId: resolveLogJobId(node) });
    resetCopied();
  }, [resetCopied]);

  React.useEffect(() => {
    if (!drawer) {
      setExcerpt(null);
      setLogError(null);
      setLogLoading(false);
      return undefined;
    }
    if (unmapped) {
      setExcerpt(null);
      setLogLoading(false);
      setLogError("Map this PR to a lane to pull its CI logs into ADE — until then, open the full log on GitHub.");
      return undefined;
    }
    if (drawer.jobId == null) {
      setExcerpt(null);
      setLogLoading(false);
      setLogError("ADE couldn't resolve a GitHub job id for this check, so there's no log to fetch.");
      return undefined;
    }
    if (!hasCheckLogApi()) {
      setExcerpt(null);
      setLogLoading(false);
      setLogError("This ADE runtime can't fetch CI logs yet — open the full log on GitHub instead.");
      return undefined;
    }
    let cancelled = false;
    setExcerpt(null);
    setLogLoading(true);
    setLogError(null);
    void fetchCheckLog({ prId: pr.id, jobId: drawer.jobId })
      .then((value) => {
        if (cancelled) return;
        setExcerpt(value);
        if (!value) setLogError("No log excerpt came back for this job.");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setExcerpt(null);
        setLogError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLogLoading(false); });
    return () => { cancelled = true; };
  }, [drawer, pr.id, unmapped]);

  React.useEffect(() => {
    autoOpenedForPrRef.current = null;
    setDrawer(null);
    setSelectedAttempt(null);
  }, [pr.id]);

  // Auto-open the first failing job, once per PR, unless the user already
  // picked one. This effect intentionally follows the PR-reset effect above so
  // the mount/reset pass cannot immediately close the drawer it just opened.
  React.useEffect(() => {
    if (autoOpenedForPrRef.current === pr.id) return;
    if (failures.length === 0) return;
    autoOpenedForPrRef.current = pr.id;
    openDrawerFor(failures[0]!);
  }, [failures, openDrawerFor, pr.id]);

  React.useEffect(() => {
    setFocusedFailureIdx((current) => (
      failures.length === 0 ? 0 : Math.min(current, failures.length - 1)
    ));
  }, [failures.length]);

  // Focus request from the overview rail: select the matching node and open it.
  React.useEffect(() => {
    if (!focusedCheckId) return;
    const item = unified.find((i) => i.id === focusedCheckId);
    const node = graph.nodes.find(
      (n) => n.jobId === focusedCheckId
        || (item != null && n.displayName === item.displayName),
    );
    if (node) openDrawerFor(node);
    onFocusedCheckConsumed?.();
  }, [focusedCheckId, graph.nodes, onFocusedCheckConsumed, openDrawerFor, unified]);

  // ---- keyboard: g k palette, j/k across failures, Enter to open ---------
  React.useEffect(() => {
    if (paletteRequest > 0) setPaletteOpen(true);
  }, [paletteRequest]);

  React.useEffect(() => {
    const CHORD_WINDOW_MS = 800;
    let lastKey = "";
    let lastKeyAt = 0;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const now2 = Date.now();
      if (lastKey === "g" && now2 - lastKeyAt < CHORD_WINDOW_MS) {
        lastKey = "";
        if (event.key === "k") {
          event.preventDefault();
          setPaletteOpen(true);
        }
        return;
      }
      if (event.key === "g") {
        lastKey = "g";
        lastKeyAt = now2;
        return;
      }
      if (failures.length === 0) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        setFocusedFailureIdx((prev) => {
          const delta = event.key === "j" ? 1 : -1;
          return (prev + delta + failures.length) % failures.length;
        });
      } else if (event.key === "Enter") {
        const node = failures[focusedFailureIdx] ?? failures[0];
        if (node) {
          event.preventDefault();
          openDrawerFor(node);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [failures, focusedFailureIdx, openDrawerFor]);

  const paletteChecks = React.useMemo<PaletteCheck[]>(
    () => graph.nodes.map((node) => ({
      id: node.jobId,
      name: node.displayName,
      state: STATE_LABEL[node.state],
      workflowName: node.workflowName || null,
    })),
    [graph.nodes],
  );

  // ---- actions ----------------------------------------------------------
  const drawerElapsed = drawer ? fmtMs(nodeElapsedMs(drawer.node, now)) : null;
  const handleCopy = React.useCallback(() => {
    if (!excerpt) return;
    const markdown = buildLogExcerptMarkdown({ excerpt, elapsedLabel: drawerElapsed, pr });
    void copy(markdown);
  }, [copy, excerpt, drawerElapsed, pr]);

  const rerunFailedVisible = Boolean(onRerunChecks) && buckets.failed > 0;
  const drawerRerun = React.useMemo(() => {
    if (!onRerunChecks || !drawer) return undefined;
    if (drawer.node.actionsJobId != null) {
      return () => onRerunChecks({ actionJobIds: [drawer.node.actionsJobId!] });
    }
    if (drawer.node.checkRunId != null) {
      return () => onRerunChecks({ checkRunIds: [drawer.node.checkRunId!] });
    }
    return undefined;
  }, [drawer, onRerunChecks]);

  const elapsed = fmtMs(pipelineElapsedMs(graph, now));
  const workflowLabel = graph.nodes[0]?.workflowName
    ?? attemptRuns[0]?.name
    ?? "Checks";

  const listItems = view === "failures"
    ? unified.filter((item) => {
        const state = pipelineStateOf(item);
        return state === "failed" || state === "unknown";
      })
    : unified;
  const selectableNodeByCheck = React.useMemo(() => {
    const byCheckRunId = new Map<number, PrWorkflowGraphNode>();
    const byDisplayName = new Map<string, PrWorkflowGraphNode>();
    for (const node of graph.nodes) {
      if (node.checkRunId != null && !byCheckRunId.has(node.checkRunId)) {
        byCheckRunId.set(node.checkRunId, node);
      }
      if (!byDisplayName.has(node.displayName)) byDisplayName.set(node.displayName, node);
    }
    return (item: (typeof unified)[number]): PrWorkflowGraphNode | undefined => (
      (item.checkRunId != null ? byCheckRunId.get(item.checkRunId) : undefined)
      ?? byDisplayName.get(item.displayName)
    );
  }, [graph.nodes, unified]);

  return (
    <div className="flex flex-col" style={{ padding: SPACING.md, background: COLORS.prSurface }} data-testid="pr-checks-tab">
      {/* ===== header strip ===== */}
      <div
        className="flex items-stretch overflow-hidden"
        style={{ ...floatingPane({ padding: 0 }), borderRadius: RADII.lg }}
        data-testid="pr-checks-header"
      >
        <div className="flex flex-col gap-[3px] px-[15px] py-[11px]">
          <span className="text-[9.5px] uppercase" style={{ letterSpacing: "0.09em", color: COLORS.textDim, fontFamily: SANS_FONT }}>
            Run
          </span>
          <span className="truncate text-[15px] font-semibold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
            {workflowLabel}
            <small className="ml-1 text-[11px] font-medium" style={{ color: COLORS.textMuted }}>
              · attempt {selectedAttempt ?? graph.attempt ?? latestAttempt}
            </small>
          </span>
        </div>
        <StripSegment label="Elapsed" value={elapsed ?? "—"} color={anythingRunning ? COLORS.warning : undefined} />
        <StripSegment
          label={checksStatus === "not_run" ? "Verified" : "Passed"}
          color={checksStatus === "not_run" ? COLORS.textMuted : COLORS.checkPass}
          value={
            checksStatus === "not_run"
              ? <>0<small className="text-[11px] font-medium" style={{ color: COLORS.textMuted }}>/{buckets.total}</small></>
              : <>{buckets.passed}<small className="text-[11px] font-medium" style={{ color: COLORS.textMuted }}>/{buckets.total}</small></>
          }
        />
        <StripSegment label="Failed" value={buckets.failed} color={buckets.failed > 0 ? COLORS.danger : COLORS.textMuted} />
        <StripSegment label="Running" value={buckets.running} color={buckets.running > 0 ? COLORS.warning : COLORS.textMuted} />
        <StripSegment label="Queued" value={buckets.queued} color={COLORS.textMuted} />

        <div className="flex flex-1 flex-wrap items-center justify-end gap-2 px-3.5">
          <RunHistorySparkline runs={actionRuns} />
          {graph.stale ? (
            <span
              data-testid="pr-checks-stale-badge"
              className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px]"
              style={{
                borderRadius: 999,
                background: tint(COLORS.warning, 12),
                border: `1px solid ${tint(COLORS.warning, 30)}`,
                color: COLORS.warning,
                fontFamily: SANS_FONT,
              }}
            >
              ◷ {graph.headSha ? graph.headSha.slice(0, 7) : "older commit"}
              {graph.staleBehindBy != null ? ` · ${graph.staleBehindBy} commits behind head` : " · behind head"}
            </span>
          ) : null}
          {attempts.length > 1 ? (
            <div
              className="flex items-center gap-[3px] p-0.5"
              style={{ background: COLORS.recessedBg, borderRadius: RADII.md }}
              data-testid="pr-checks-attempt-scrubber"
            >
              {attempts.map((attempt) => (
                <SegButton
                  key={attempt}
                  active={(selectedAttempt ?? latestAttempt) === attempt}
                  onClick={() => setSelectedAttempt(attempt)}
                  testId={`pr-checks-attempt-${attempt}`}
                >
                  #{attempt}
                </SegButton>
              ))}
            </div>
          ) : null}
          <div
            className="flex items-center gap-[3px] p-0.5"
            style={{ background: COLORS.recessedBg, borderRadius: RADII.md }}
            data-testid="pr-checks-view-switch"
          >
            <SegButton active={view === "graph"} onClick={() => selectView("graph")} testId="pr-checks-view-graph">Graph</SegButton>
            <SegButton active={view === "list"} onClick={() => selectView("list")} testId="pr-checks-view-list">List</SegButton>
            <SegButton active={view === "failures"} onClick={() => selectView("failures")} testId="pr-checks-view-failures">Failures</SegButton>
          </div>
          {rerunFailedVisible ? (
            <SmallButton
              tone="warn"
              disabled={actionBusy}
              onClick={() => onRerunChecks?.()}
              testId="pr-checks-rerun-failed"
            >
              <ArrowsClockwise size={12} /> Re-run failed
            </SmallButton>
          ) : null}
        </div>
      </div>

      {/* 4-colour progress bar — semantic tokens, so it survives light mode. */}
      {buckets.total > 0 ? (
        <div
          className="flex overflow-hidden"
          style={{ height: 3, borderRadius: `0 0 ${RADII.lg}px ${RADII.lg}px`, marginTop: -1, marginBottom: SPACING.md }}
          data-testid="pr-checks-progress-bar"
        >
          {([
            ["passed", COLORS.checkPass],
            ["failed", COLORS.danger],
            ["running", COLORS.warning],
            ["queued", COLORS.textDim],
            ["skipped", COLORS.textDim],
            ["unknown", COLORS.textMuted],
          ] as const).map(([key, color]) => (
            buckets[key] > 0 ? (
              <i
                key={key}
                data-testid={`pr-checks-progress-${key}`}
                className="block"
                style={{ flex: buckets[key], background: color, transition: "flex 300ms ease" }}
              />
            ) : null
          ))}
        </div>
      ) : <div style={{ marginBottom: SPACING.md }} />}

      {buckets.total === 0 ? (
        <div className="px-1 py-4 text-[12px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }} data-testid="pr-checks-empty">
          No checks have reported for this pull request yet.
        </div>
      ) : view === "graph" ? (
        <GraphView
          graph={graph}
          columns={columns}
          criticalPath={criticalPath}
          now={now}
          selectedJobId={drawer?.node.jobId ?? null}
          focusedJobId={failures[focusedFailureIdx]?.jobId ?? null}
          workflowLabel={workflowLabel}
          onSelect={openDrawerFor}
        />
      ) : (
        <div className="flex flex-col" data-testid="pr-checks-flat-view">
          <LaneHeader tag={view === "failures" ? "failures" : "all checks"}>
            <span style={{ color: COLORS.textDim }}>
              {listItems.length} of {unified.length} checks
            </span>
          </LaneHeader>
          {listItems.length === 0 ? (
            <div className="px-1 py-3 text-[11.5px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}>
              No failed or indeterminate checks.
            </div>
          ) : (
            <div className="grid gap-[5px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))" }}>
              {listItems.map((item) => {
                const node = selectableNodeByCheck(item);
                return (
                  <FlatRow
                    key={item.id}
                    name={item.displayName}
                    state={pipelineStateOf(item)}
                    elapsedMs={checkElapsedMs(item, now)}
                    detailsUrl={item.detailsUrl}
                    subtitle={item.source === "check" ? "external" : null}
                    onSelect={node ? () => openDrawerFor(node) : undefined}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {drawer ? (
        <PrCheckLogDrawer
          drawer={drawer}
          excerpt={excerpt}
          loading={logLoading}
          error={logError}
          elapsedLabel={drawerElapsed}
          onCopy={handleCopy}
          copied={copied}
          onRerunJob={drawerRerun}
          onFixInChat={onFixInChat && excerpt ? () => onFixInChat(excerpt) : undefined}
          onClose={() => setDrawer(null)}
        />
      ) : null}

      {/* External / non-graphable checks always get their own lane. */}
      {view === "graph" && graph.externalChecks.length > 0 ? (
        <div className="mt-2" data-testid="pr-checks-external-lane">
          <LaneHeader tag="external">
            <span style={{ color: COLORS.textDim }}>status checks · no workflow file · not graphable</span>
          </LaneHeader>
          <div className="grid gap-[5px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))" }}>
            {graph.externalChecks.map((check) => (
              <FlatRow
                key={check.name}
                name={check.name}
                state={pipelineStateOf(check)}
                elapsedMs={checkElapsedMs(check, now)}
                detailsUrl={check.detailsUrl}
              />
            ))}
          </div>
        </div>
      ) : null}

      <PrCommandPalettes
        open={paletteOpen ? "check" : null}
        onClose={() => setPaletteOpen(false)}
        commits={[]}
        threads={[]}
        files={[]}
        checks={paletteChecks}
        onPickCommit={() => {}}
        onPickThread={() => {}}
        onPickFile={() => {}}
        onPickCheck={(id) => {
          const node = graph.nodes.find((n) => n.jobId === id);
          if (node) openDrawerFor(node);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graph view (DAG, or the honest swimlane fallback)
// ---------------------------------------------------------------------------

function GraphView({
  graph, columns, criticalPath, now, selectedJobId, focusedJobId, workflowLabel, onSelect,
}: {
  graph: PrWorkflowGraph;
  columns: GraphColumn[];
  criticalPath: Set<string>;
  now: number;
  selectedJobId: string | null;
  focusedJobId: string | null;
  workflowLabel: string;
  onSelect: (node: PrWorkflowGraphNode) => void;
}) {
  if (graph.nodes.length === 0) {
    return (
      <div className="px-1 py-3 text-[11.5px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }} data-testid="pr-checks-graph-empty">
        No GitHub Actions jobs on this run.
      </div>
    );
  }

  // No dependency data → flat swimlanes grouped by workflow, plus one honest
  // line explaining why there is no graph. We never guess an edge.
  if (graph.source === "none" || graph.edges.length === 0) {
    const lanes = groupByWorkflow(graph.nodes);
    return (
      <div data-testid="pr-checks-swimlanes">
        <p
          className="mb-1.5 px-0.5 text-[11px]"
          style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}
          data-testid="pr-checks-graph-unavailable-note"
        >
          {graphUnavailableCopy(graph.unavailableReason)}
        </p>
        {lanes.map((lane) => (
          <div key={lane.workflowName} className="mb-1" data-testid="pr-checks-swimlane" data-workflow={lane.workflowName}>
            <LaneHeader tag="workflow">
              <b style={{ color: COLORS.textSecondary }}>{lane.workflowName}</b>
              <span style={{ color: COLORS.textDim }}>· {lane.nodes.length} jobs</span>
            </LaneHeader>
            <div className="grid gap-[5px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))" }}>
              {lane.nodes.map((node) => (
                <FlatRow
                  key={node.jobId}
                  name={node.displayName}
                  state={node.state}
                  elapsedMs={nodeElapsedMs(node, now)}
                  detailsUrl={node.detailsUrl}
                  selected={selectedJobId === node.jobId}
                  onSelect={() => onSelect(node)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div data-testid="pr-checks-graph">
      <LaneHeader tag="workflow">
        <b style={{ color: COLORS.textSecondary }}>{workflowLabel}</b>
        <span style={{ color: COLORS.textDim }}>
          · {graph.nodes.length} jobs · graph from {graph.source === "worktree" ? "the workflow file in your lane" : "the workflow file on GitHub"}
          {graph.headSha ? ` @ ${graph.headSha.slice(0, 7)}` : ""}
        </span>
      </LaneHeader>
      <div className="flex items-stretch overflow-x-auto pb-2.5 pt-1">
        {columns.map((column, index) => (
          <React.Fragment key={column.tier}>
            <div className="flex min-w-[210px] flex-col justify-center gap-1.5">
              <div
                className="mb-0.5 pl-0.5 text-[9.5px] uppercase"
                style={{ letterSpacing: "0.09em", color: COLORS.textDim, fontFamily: SANS_FONT }}
              >
                {column.label}
              </div>
              {column.nodes.map((node) => (
                <GraphNodeCell
                  key={node.jobId}
                  node={node}
                  now={now}
                  selected={selectedJobId === node.jobId || focusedJobId === node.jobId}
                  onCritical={criticalPath.has(node.jobId)}
                  onSelect={onSelect}
                />
              ))}
            </div>
            {index < columns.length - 1 ? (
              <GraphEdge live={isEdgeLive(graph, columns, index)} />
            ) : null}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function GraphEdge({ live }: { live: boolean }) {
  return (
    <div
      className="relative w-[26px] shrink-0"
      data-testid="pr-checks-graph-edge"
      data-live={live ? "true" : "false"}
      aria-hidden
    >
      <span
        className={live ? "absolute left-0 right-0 top-1/2 h-px motion-safe:animate-pulse" : "absolute left-0 right-0 top-1/2 h-px"}
        style={{
          background: live
            ? `linear-gradient(90deg, transparent, ${COLORS.warning} 50%, transparent)`
            : `linear-gradient(90deg, transparent, ${tint(COLORS.border, 90)} 30%, ${tint(COLORS.border, 90)} 70%, transparent)`,
        }}
      />
    </div>
  );
}

export default PrChecksTab;
