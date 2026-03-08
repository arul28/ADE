import { useEffect, useState } from "react";
import {
  COLORS,
  MONO_FONT,
  LABEL_STYLE,
  inlineBadge,
  cardStyle,
  recessedStyle,
  primaryButton,
} from "../lanes/laneDesignTokens";
import type {
  RuntimeDiagnosticsStatus,
  LaneHealthCheck,
  LaneHealthStatus,
} from "../../../shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function healthColor(status: LaneHealthStatus): string {
  switch (status) {
    case "healthy":
      return COLORS.success;
    case "degraded":
      return COLORS.warning;
    case "unhealthy":
      return COLORS.danger;
    case "unknown":
    default:
      return COLORS.textDim;
  }
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LaneHealthRow({ health }: { health: LaneHealthCheck }) {
  const color = healthColor(health.status);
  const issueCount = health.issues.length;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        background: COLORS.recessedBg,
      }}
    >
      {/* Health dot */}
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }}
      />

      {/* Lane ID (first 8 chars) */}
      <span
        style={{
          fontSize: 12,
          fontFamily: MONO_FONT,
          fontWeight: 600,
          color: COLORS.textPrimary,
          letterSpacing: "0.5px",
          minWidth: 72,
        }}
      >
        {health.laneId.slice(0, 8)}
      </span>

      {/* Status badge */}
      <span style={inlineBadge(color)}>{health.status.toUpperCase()}</span>

      {/* Spacer */}
      <span style={{ flex: 1 }} />

      {/* Issue count */}
      {issueCount > 0 && (
        <span
          style={{
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: COLORS.danger,
            fontWeight: 700,
          }}
        >
          {issueCount} issue{issueCount !== 1 ? "s" : ""}
        </span>
      )}

      {/* Fallback indicator */}
      {health.fallbackMode && (
        <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>
          FALLBACK
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DiagnosticsDashboardSection() {
  const [status, setStatus] = useState<RuntimeDiagnosticsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkBusy, setCheckBusy] = useState(false);
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Fetch + subscribe
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    setLoading(true);

    const syncLastChecked = (lanes: LaneHealthCheck[]) => {
      const timestamps = lanes.map((lane) => lane.lastCheckedAt).filter(Boolean);
      if (timestamps.length === 0) {
        setLastChecked(null);
        return;
      }
      timestamps.sort();
      setLastChecked(timestamps[timestamps.length - 1]);
    };

    const loadStatus = async () => {
      try {
        const initial = await window.ade.lanes.diagnosticsGetStatus();
        if (cancelled) {
          return;
        }
        setStatus(initial);
        syncLastChecked(initial.lanes);

        if (initial.lanes.length === 0) {
          await window.ade.lanes.diagnosticsRunFullCheck();
          if (cancelled) {
            return;
          }
          const refreshed = await window.ade.lanes.diagnosticsGetStatus();
          if (cancelled) {
            return;
          }
          setStatus(refreshed);
          syncLastChecked(refreshed.lanes);
        }
      } catch {
        if (!cancelled) {
          setStatus(null);
          setLastChecked(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadStatus();

    const unsub = window.ade.lanes.onDiagnosticsEvent((ev) => {
      if (cancelled) return;

      if (ev.status) {
        setStatus(ev.status);
        syncLastChecked(ev.status.lanes);
      }

      if (ev.health) {
        const nextHealth = ev.health;
        setStatus((prev) => {
          if (!prev) {
            return {
              lanes: [nextHealth],
              proxyRunning: false,
              proxyPort: 0,
              totalRoutes: 0,
              activeConflicts: 0,
              fallbackLanes: nextHealth.fallbackMode ? [nextHealth.laneId] : [],
            };
          }
          const idx = prev.lanes.findIndex((lane) => lane.laneId === nextHealth.laneId);
          const nextFallback = nextHealth.fallbackMode
            ? Array.from(new Set([...prev.fallbackLanes, nextHealth.laneId]))
            : prev.fallbackLanes.filter((id) => id !== nextHealth.laneId);
          if (idx === -1) {
            return {
              ...prev,
              lanes: [...prev.lanes, nextHealth],
              fallbackLanes: nextFallback,
            };
          }
          const nextLanes = [...prev.lanes];
          nextLanes[idx] = nextHealth;
          return { ...prev, lanes: nextLanes, fallbackLanes: nextFallback };
        });
        if (nextHealth.lastCheckedAt) {
          setLastChecked(nextHealth.lastCheckedAt);
        }
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleRunFullCheck = async () => {
    setCheckBusy(true);
    try {
      await window.ade.lanes.diagnosticsRunFullCheck();
      const refreshed = await window.ade.lanes.diagnosticsGetStatus();
      setStatus(refreshed);
      const timestamps = refreshed.lanes.map((lane) => lane.lastCheckedAt).filter(Boolean);
      if (timestamps.length === 0) {
        setLastChecked(null);
      } else {
        timestamps.sort();
        setLastChecked(timestamps[timestamps.length - 1]);
      }
    } catch {
      /* silent */
    } finally {
      setCheckBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div
        style={{
          ...cardStyle(),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 80,
        }}
      >
        <span
          style={{
            color: COLORS.textDim,
            fontFamily: MONO_FONT,
            fontSize: 11,
          }}
        >
          Loading diagnostics...
        </span>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const proxyRunning = status?.proxyRunning ?? false;
  const totalRoutes = status?.totalRoutes ?? 0;
  const activeConflicts = status?.activeConflicts ?? 0;
  const fallbackLanes = status?.fallbackLanes ?? [];
  const lanes = status?.lanes ?? [];

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div style={cardStyle({ display: "flex", flexDirection: "column", gap: 16 })}>
      {/* Label */}
      <div style={LABEL_STYLE}>Runtime Diagnostics</div>

      {/* Summary row */}
      <div
        style={recessedStyle({
          display: "flex",
          alignItems: "center",
          gap: 24,
          flexWrap: "wrap",
        })}
      >
        {/* Proxy status */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: proxyRunning ? COLORS.success : COLORS.textDim,
              flexShrink: 0,
            }}
          />
          <span style={inlineBadge(proxyRunning ? COLORS.success : COLORS.textDim)}>
            {proxyRunning ? "PROXY RUNNING" : "PROXY STOPPED"}
          </span>
        </div>

        {/* Route count */}
        <div>
          <span
            style={{
              fontSize: 10,
              fontFamily: MONO_FONT,
              fontWeight: 700,
              color: COLORS.textDim,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              marginRight: 6,
            }}
          >
            Routes
          </span>
          <span
            style={{
              fontSize: 13,
              fontFamily: MONO_FONT,
              fontWeight: 600,
              color: COLORS.textPrimary,
            }}
          >
            {totalRoutes}
          </span>
        </div>

        {/* Active conflicts */}
        <div>
          <span
            style={{
              fontSize: 10,
              fontFamily: MONO_FONT,
              fontWeight: 700,
              color: COLORS.textDim,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              marginRight: 6,
            }}
          >
            Conflicts
          </span>
          <span
            style={{
              fontSize: 13,
              fontFamily: MONO_FONT,
              fontWeight: 600,
              color: activeConflicts > 0 ? COLORS.danger : COLORS.textPrimary,
            }}
          >
            {activeConflicts}
          </span>
        </div>
      </div>

      {/* Fallback lanes banner */}
      {fallbackLanes.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            background: `${COLORS.warning}12`,
            border: `1px solid ${COLORS.warning}30`,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontFamily: MONO_FONT,
              color: COLORS.warning,
              lineHeight: "16px",
            }}
          >
            Fallback mode active for:{" "}
            {fallbackLanes.map((id) => id.slice(0, 8)).join(", ")}
          </span>
        </div>
      )}

      {/* Lane health list */}
      {lanes.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {lanes.map((lane) => (
            <LaneHealthRow key={lane.laneId} health={lane} />
          ))}
        </div>
      ) : (
        <div
          style={{
            ...recessedStyle(),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontFamily: MONO_FONT,
              color: COLORS.textMuted,
            }}
          >
            No diagnostics data. Run a full health check.
          </span>
        </div>
      )}

      {/* Run full check button + last checked */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <button
          type="button"
          style={primaryButton()}
          disabled={checkBusy}
          onClick={handleRunFullCheck}
        >
          {checkBusy ? "CHECKING..." : "RUN FULL CHECK"}
        </button>

        {lastChecked && (
          <span
            style={{
              fontSize: 10,
              fontFamily: MONO_FONT,
              color: COLORS.textDim,
            }}
          >
            Last checked {formatTimestamp(lastChecked)}
          </span>
        )}
      </div>
    </div>
  );
}
