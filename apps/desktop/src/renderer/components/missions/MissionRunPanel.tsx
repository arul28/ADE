import { useMemo } from "react";
import type {
  MissionRunView,
  MissionRunViewWorkerSummary,
  MissionRunViewProgressItem,
  MissionRunViewHaltReason,
  MissionIntervention,
  MissionRunViewLatestIntervention,
} from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";
import { formatComputerUseKind, summarizeComputerUseProof } from "../../lib/computerUse";
import { getMissionInterventionOwnerLabel } from "./missionHelpers";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type MissionRunPanelProps = {
  runView: MissionRunView | null;
  interventions?: MissionIntervention[] | null;
  loading?: boolean;
  onOpenIntervention?: (interventionId: string) => void;
  showInterventions?: boolean;
  hideInterventionHaltReason?: boolean;
};

// ---------------------------------------------------------------------------
// Color maps
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<string, string> = {
  running: "#3B82F6",
  completed: "#22C55E",
  failed: "#EF4444",
  paused: "#F59E0B",
  blocked: "#F59E0B",
  not_started: "#6B7280",
  canceled: "#6B7280",
  starting: "#A78BFA",
};

const WORKER_DOT: Record<string, string> = {
  active: "#22C55E",
  completed: "#6B7280",
  failed: "#EF4444",
  blocked: "#F59E0B",
  idle: "#F59E0B",
};

const SEVERITY_COLOR: Record<string, string> = {
  info: "#3B82F6",
  warning: "#F59E0B",
  error: "#EF4444",
  success: "#22C55E",
};

type RunPanelIntervention = {
  id: string;
  title: string;
  interventionType: string;
  status: "open";
  ownerLabel: string | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(startIso: string | null): string {
  if (!startIso) return "--";
  const ms = Math.max(0, Date.now() - Date.parse(startIso));
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export function sortWorkers(workers: MissionRunViewWorkerSummary[]): MissionRunViewWorkerSummary[] {
  const order: Record<string, number> = { active: 0, blocked: 1, idle: 2, completed: 3, failed: 4 };
  return [...workers].sort((a, b) => {
    const oa = order[a.status] ?? 5;
    const ob = order[b.status] ?? 5;
    if (oa !== ob) return oa - ob;
    // Among completed workers, sort most recently completed first
    if (a.completedAt && b.completedAt) return Date.parse(b.completedAt) - Date.parse(a.completedAt);
    return 0;
  });
}

export function selectRecentProgress(items: MissionRunViewProgressItem[], limit = 6): MissionRunViewProgressItem[] {
  return items.slice(0, Math.max(0, limit));
}

export function selectOpenInterventions(args: {
  interventions?: MissionIntervention[] | null;
  latestIntervention?: MissionRunViewLatestIntervention | null;
}): RunPanelIntervention[] {
  const open = (args.interventions ?? [])
    .filter((intervention): intervention is MissionIntervention & { status: "open" } => intervention.status === "open")
    .map((intervention) => ({
      id: intervention.id,
      title: intervention.title,
      interventionType: intervention.interventionType,
      status: "open" as const,
      ownerLabel: getMissionInterventionOwnerLabel(intervention),
      createdAt: intervention.updatedAt || intervention.createdAt,
    }));

  if (open.length > 0) {
    return [...open].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  if (args.latestIntervention?.status === "open") {
    return [{
      id: args.latestIntervention.id,
      title: args.latestIntervention.title,
      interventionType: args.latestIntervention.interventionType,
      status: "open",
      ownerLabel: args.latestIntervention.ownerLabel ?? null,
      createdAt: args.latestIntervention.createdAt,
    }];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Section styles
// ---------------------------------------------------------------------------

const sectionStyle: React.CSSProperties = {
  background: COLORS.cardBg,
  border: `1px solid ${COLORS.border}`,
  padding: "8px 10px",
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: COLORS.textDim,
  marginBottom: 4,
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? COLORS.textMuted;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 6px",
        fontSize: 9,
        fontWeight: 700,
        fontFamily: MONO_FONT,
        textTransform: "uppercase",
        letterSpacing: "0.8px",
        color,
        background: `${color}18`,
        border: `1px solid ${color}30`,
      }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function HaltBanner({ halt }: { halt: MissionRunViewHaltReason }) {
  const color = halt.severity === "error" ? COLORS.danger : COLORS.warning;
  return (
    <div
      style={{
        background: `${color}0C`,
        borderLeft: `3px solid ${color}`,
        padding: "6px 10px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          fontFamily: SANS_FONT,
          color,
          marginBottom: 2,
        }}
      >
        {halt.title}
      </div>
      <div
        style={{
          fontSize: 10,
          fontFamily: MONO_FONT,
          color: COLORS.textSecondary,
          lineHeight: "1.4",
        }}
      >
        {halt.detail}
      </div>
    </div>
  );
}

function WorkerRow({ worker }: { worker: MissionRunViewWorkerSummary }) {
  const dotColor = WORKER_DOT[worker.status] ?? COLORS.textMuted;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 0",
        fontSize: 10,
        fontFamily: MONO_FONT,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          color: COLORS.textPrimary,
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {worker.stepTitle ?? "idle"}
      </span>
      {worker.executorKind && (
        <span style={{ color: COLORS.textDim, flexShrink: 0 }}>
          {worker.executorKind}
        </span>
      )}
      <span
        style={{
          color: WORKER_DOT[worker.status] ?? COLORS.textMuted,
          flexShrink: 0,
          fontSize: 9,
          fontWeight: 600,
          textTransform: "uppercase",
        }}
      >
        {worker.state}
      </span>
    </div>
  );
}

function ProgressEntry({ item }: { item: MissionRunViewProgressItem }) {
  const color = SEVERITY_COLOR[item.severity] ?? COLORS.textMuted;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        padding: "1px 0",
        fontSize: 10,
        fontFamily: MONO_FONT,
        lineHeight: "1.35",
      }}
    >
      <span
        style={{
          color: COLORS.textDim,
          flexShrink: 0,
          minWidth: 42,
          textAlign: "right",
          fontSize: 9,
        }}
      >
        {relativeWhen(item.at)}
      </span>
      <span
        style={{
          width: 4,
          height: 4,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
          marginTop: 4,
        }}
      />
      <span
        style={{
          color: COLORS.textSecondary,
          whiteSpace: "normal",
          wordBreak: "break-word",
        }}
      >
        {item.title}
      </span>
    </div>
  );
}

function ComputerUsePanel({ runView }: { runView: MissionRunView }) {
  const snapshot = runView.computerUse;
  if (!snapshot) return null;

  return (
    <div style={sectionStyle}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div style={sectionLabelStyle}>Proof</div>
      </div>
      <div className="mt-1 text-[11px]" style={{ color: COLORS.textPrimary }}>
        {snapshot.summary}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
        <span>{summarizeComputerUseProof(snapshot)}</span>
        <span>
          Backend: {snapshot.activeBackend ? `${snapshot.activeBackend.name} (${snapshot.activeBackend.source})` : "not selected"}
        </span>
      </div>
      {snapshot.activity.length > 0 ? (
        <div className="mt-3 space-y-1">
          {snapshot.activity.slice(0, 4).map((item) => (
            <div key={item.id} className="flex items-start gap-2 text-[10px]" style={{ fontFamily: MONO_FONT }}>
              <span style={{ color: SEVERITY_COLOR[item.severity] ?? COLORS.textMuted, minWidth: 50 }}>
                {relativeWhen(item.at)}
              </span>
              <span style={{ color: COLORS.textSecondary }}>{item.title}</span>
            </div>
          ))}
        </div>
      ) : null}
      {snapshot.recentArtifacts.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          {snapshot.recentArtifacts.slice(0, 4).map((artifact) => (
            <span key={artifact.id}>
              {formatComputerUseKind(artifact.kind)} via {artifact.backendName}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function InterventionBanner({
  intervention,
  onOpen,
}: {
  intervention: RunPanelIntervention;
  onOpen?: (id: string) => void;
}) {
  return (
    <div
      style={{
        background: `${COLORS.warning}0C`,
        borderLeft: `3px solid ${COLORS.warning}`,
        padding: "6px 10px",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 9,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "0.8px",
            color: COLORS.warning,
            marginBottom: 2,
          }}
        >
          {intervention.ownerLabel ?? intervention.interventionType.replace(/_/g, " ")}
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: SANS_FONT,
            color: COLORS.textPrimary,
            whiteSpace: "normal",
            wordBreak: "break-word",
          }}
        >
          {intervention.title}
        </div>
      </div>
      {onOpen && (
        <button
          type="button"
          onClick={() => onOpen(intervention.id)}
          style={{
            flexShrink: 0,
            padding: "3px 10px",
            fontSize: 9,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "1px",
            color: COLORS.warning,
            background: `${COLORS.warning}14`,
            border: `1px solid ${COLORS.warning}35`,
            cursor: "pointer",
          }}
        >
          OPEN
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function MissionRunPanel({
  runView,
  interventions = null,
  loading = false,
  onOpenIntervention,
  showInterventions = true,
  hideInterventionHaltReason = false,
}: MissionRunPanelProps) {
  const sortedWorkers = useMemo(
    () => (runView ? sortWorkers(runView.workers) : []),
    [runView],
  );

  const recentProgress = useMemo(
    () => (runView ? selectRecentProgress(runView.progressLog) : []),
    [runView],
  );

  const openInterventions = useMemo(
    () => selectOpenInterventions({ interventions, latestIntervention: runView?.latestIntervention ?? null }),
    [interventions, runView?.latestIntervention],
  );

  // Null state
  if (!runView) {
    if (loading) {
      return (
        <div style={{ fontSize: 11, color: COLORS.textDim, padding: "8px 0" }}>
          Loading run view...
        </div>
      );
    }
    return null;
  }

  const { lifecycle, active, coordinator, haltReason } = runView;
  const statusColor = STATUS_COLOR[lifecycle.displayStatus] ?? COLORS.textMuted;
  const shouldRenderHaltReason = !(hideInterventionHaltReason && haltReason?.source === "intervention");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* ── 1. Status Bar ── */}
      <div
        style={{
          ...sectionStyle,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <StatusBadge status={lifecycle.displayStatus} />

        <span
          style={{
            fontSize: 11,
            fontFamily: SANS_FONT,
            fontWeight: 600,
            color: COLORS.textPrimary,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {lifecycle.summary}
        </span>

        {active.phaseName && (
          <span
            style={{
              fontSize: 9,
              fontFamily: MONO_FONT,
              fontWeight: 600,
              color: COLORS.accent,
              textTransform: "uppercase",
              letterSpacing: "0.8px",
              flexShrink: 0,
            }}
          >
            {active.phaseName}
          </span>
        )}

        <span
          style={{
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: COLORS.textDim,
            flexShrink: 0,
          }}
        >
          {elapsed(lifecycle.startedAt)}
        </span>
      </div>

      {/* ── 2. Halt / Blocker Banner ── */}
      {haltReason && shouldRenderHaltReason && <HaltBanner halt={haltReason} />}
      {!haltReason && lifecycle.displayStatus === "blocked" && (
        <HaltBanner
          halt={{
            title: "Mission blocked",
            detail: lifecycle.summary || "The mission is blocked and requires attention.",
            severity: "warning",
            source: "mission",
          }}
        />
      )}
      {!haltReason && lifecycle.displayStatus === "paused" && (
        <HaltBanner
          halt={{
            title: "Run paused",
            detail: lifecycle.summary || "The orchestrator run has been paused.",
            severity: "warning",
            source: "run",
          }}
        />
      )}
      {!haltReason
        && lifecycle.displayStatus !== "blocked"
        && lifecycle.displayStatus !== "paused"
        && showInterventions
        && openInterventions.length > 0
        && (
        <HaltBanner
          halt={{
            title: "Intervention required",
            detail: `${openInterventions.length} open intervention${openInterventions.length === 1 ? "" : "s"} awaiting response.`,
            severity: "warning",
            source: "intervention",
          }}
        />
      )}

      {/* ── 3. Active Step ── */}
      {active.stepTitle && (
        <div
          style={{
            ...sectionStyle,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: statusColor,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 11,
              fontFamily: SANS_FONT,
              fontWeight: 600,
              color: COLORS.textPrimary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            {active.stepTitle}
          </span>
          {active.featureLabel && (
            <span
              style={{
                fontSize: 9,
                fontFamily: MONO_FONT,
                color: COLORS.textMuted,
                flexShrink: 0,
              }}
            >
              {active.featureLabel}
            </span>
          )}
        </div>
      )}

      {/* ── 4. Coordinator Status ── */}
      {coordinator.available != null && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: COLORS.textDim,
          }}
        >
          <span>
            Coordinator:{" "}
            <span
              style={{
                color: coordinator.available ? COLORS.success : COLORS.textMuted,
                fontWeight: 600,
              }}
            >
              {coordinator.available ? "online" : "offline"}
            </span>
          </span>
          {coordinator.mode && (
            <span style={{ color: COLORS.textMuted }}>
              {coordinator.mode.replace(/_/g, " ")}
            </span>
          )}
          {coordinator.summary && (
            <span
              style={{
                color: COLORS.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {coordinator.summary}
            </span>
          )}
        </div>
      )}

      <ComputerUsePanel runView={runView} />

      {/* ── 5. Workers ── */}
      {sortedWorkers.length > 0 && (
        <div style={sectionStyle}>
          <div style={sectionLabelStyle}>
            Workers ({sortedWorkers.length})
          </div>
          {sortedWorkers.map((worker, idx) => (
            <WorkerRow
              key={worker.attemptId ?? worker.sessionId ?? `w-${idx}`}
              worker={worker}
            />
          ))}
        </div>
      )}

      {/* ── 6. Open Interventions ── */}
      {showInterventions && openInterventions.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {openInterventions.map((intervention) => (
            <InterventionBanner
              key={intervention.id}
              intervention={intervention}
              onOpen={onOpenIntervention}
            />
          ))}
        </div>
      )}

      {/* ── 7. Progress Log ── */}
      {recentProgress.length > 0 && (
        <div style={sectionStyle}>
          <div style={sectionLabelStyle}>Recent Activity</div>
          {recentProgress.map((item) => (
            <ProgressEntry key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
