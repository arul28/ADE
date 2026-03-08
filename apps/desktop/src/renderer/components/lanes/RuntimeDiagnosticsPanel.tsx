import { useEffect, useState, type CSSProperties } from "react";
import {
  COLORS,
  MONO_FONT,
  LABEL_STYLE,
  inlineBadge,
  cardStyle,
  recessedStyle,
  outlineButton,
} from "./laneDesignTokens";
import type {
  LaneHealthCheck,
  LaneHealthStatus,
  LaneHealthIssue,
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

function healthLabel(status: LaneHealthStatus): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "unhealthy":
      return "Unhealthy";
    case "unknown":
    default:
      return "Unknown";
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

function CheckIndicator({
  label,
  ok,
  okText,
  failText,
}: {
  label: string;
  ok: boolean;
  okText: string;
  failText: string;
}) {
  const color = ok ? COLORS.success : COLORS.danger;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
      <span
        style={{
          fontSize: 10,
          fontFamily: MONO_FONT,
          fontWeight: 700,
          color: COLORS.textDim,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 11,
          fontFamily: MONO_FONT,
          color: ok ? COLORS.textSecondary : COLORS.danger,
        }}
      >
        {ok ? okText : failText}
      </span>
    </div>
  );
}

function IssueRow({
  issue,
  onAction,
}: {
  issue: LaneHealthIssue;
  onAction?: (actionType: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 0",
        borderBottom: `1px solid ${COLORS.border}`,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontFamily: MONO_FONT,
          color: COLORS.textSecondary,
          flex: 1,
        }}
      >
        {issue.message}
      </span>
      {issue.actionLabel && issue.actionType && onAction && (
        <button
          type="button"
          style={outlineButton({
            height: 24,
            padding: "0 8px",
            fontSize: 9,
          })}
          onClick={() => onAction(issue.actionType!)}
        >
          {issue.actionLabel}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FallbackBanner
// ---------------------------------------------------------------------------

const fallbackBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "8px 12px",
  background: `${COLORS.warning}12`,
  border: `1px solid ${COLORS.warning}30`,
};

function FallbackBanner({
  onDeactivate,
  busy,
}: {
  onDeactivate: () => void;
  busy: boolean;
}) {
  return (
    <div style={fallbackBannerStyle}>
      <span
        style={{
          fontSize: 11,
          fontFamily: MONO_FONT,
          color: COLORS.warning,
          lineHeight: "16px",
        }}
      >
        Fallback mode active — isolation bypassed for this lane. Direct port
        access is being used.
      </span>
      <button
        type="button"
        style={outlineButton({
          height: 24,
          padding: "0 8px",
          fontSize: 9,
          color: COLORS.warning,
          borderColor: `${COLORS.warning}40`,
          flexShrink: 0,
        })}
        disabled={busy}
        onClick={onDeactivate}
      >
        {busy ? "..." : "DEACTIVATE"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RuntimeDiagnosticsPanel({ laneId }: { laneId: string }) {
  const [health, setHealth] = useState<LaneHealthCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [fallbackBusy, setFallbackBusy] = useState(false);

  // -------------------------------------------------------------------------
  // Fetch + subscribe
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setHealth(null);
    setIssuesOpen(false);

    window.ade.lanes
      .diagnosticsGetLaneHealth({ laneId })
      .then((result) => {
        if (!cancelled) {
          setHealth(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHealth(null);
          setLoading(false);
        }
      });

    const unsub = window.ade.lanes.onDiagnosticsEvent((ev) => {
      if (cancelled) return;
      if (ev.health && ev.health.laneId === laneId) {
        setHealth(ev.health);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [laneId]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleRunCheck = async () => {
    setCheckBusy(true);
    try {
      const result = await window.ade.lanes.diagnosticsRunHealthCheck({ laneId });
      setHealth(result);
    } catch {
      /* silent */
    } finally {
      setCheckBusy(false);
    }
  };

  const handleDeactivateFallback = async () => {
    setFallbackBusy(true);
    try {
      await window.ade.lanes.diagnosticsDeactivateFallback({ laneId });
    } catch {
      /* silent */
    } finally {
      setFallbackBusy(false);
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
          minHeight: 60,
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
  // Derived values
  // -------------------------------------------------------------------------

  const status: LaneHealthStatus = health?.status ?? "unknown";
  const color = healthColor(status);
  const issues = health?.issues ?? [];

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div style={cardStyle({ display: "flex", flexDirection: "column", gap: 12 })}>
      {/* Label */}
      <div style={LABEL_STYLE}>Runtime Diagnostics</div>

      {/* Fallback banner */}
      {health?.fallbackMode && (
        <FallbackBanner
          onDeactivate={handleDeactivateFallback}
          busy={fallbackBusy}
        />
      )}

      {/* Status summary */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 13,
            fontFamily: MONO_FONT,
            fontWeight: 700,
            color: COLORS.textPrimary,
          }}
        >
          {healthLabel(status)}
        </span>
        <span style={inlineBadge(color)}>{status.toUpperCase()}</span>
      </div>

      {/* Check indicators row */}
      {health && (
        <div
          style={recessedStyle({
            display: "flex",
            alignItems: "center",
            gap: 20,
            flexWrap: "wrap",
          })}
        >
          <CheckIndicator
            label="Process"
            ok={health.processAlive}
            okText="alive"
            failText="dead"
          />
          <CheckIndicator
            label="Port"
            ok={health.portResponding}
            okText="responding"
            failText="unresponsive"
          />
          <CheckIndicator
            label="Proxy"
            ok={health.proxyRouteActive}
            okText="active"
            failText="inactive"
          />
        </div>
      )}

      {/* Collapsible issues section */}
      {issues.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <button
            type="button"
            onClick={() => setIssuesOpen((prev) => !prev)}
            aria-expanded={issuesOpen}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontFamily: MONO_FONT,
                color: COLORS.textDim,
                transform: issuesOpen ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 0.15s ease",
                display: "inline-block",
              }}
            >
              &#9654;
            </span>
            <span
              style={{
                ...LABEL_STYLE,
                color: COLORS.danger,
                marginBottom: 0,
              }}
            >
              Issues ({issues.length})
            </span>
          </button>

          {issuesOpen && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                paddingLeft: 16,
              }}
            >
              {issues.map((issue, i) => (
                <IssueRow key={`${issue.type}-${i}`} issue={issue} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Run health check button + last checked */}
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
          style={outlineButton()}
          disabled={checkBusy}
          onClick={handleRunCheck}
        >
          {checkBusy ? "CHECKING..." : "RUN HEALTH CHECK"}
        </button>

        {health?.lastCheckedAt && (
          <span
            style={{
              fontSize: 10,
              fontFamily: MONO_FONT,
              color: COLORS.textDim,
            }}
          >
            Last checked {formatTimestamp(health.lastCheckedAt)}
          </span>
        )}
      </div>
    </div>
  );
}
