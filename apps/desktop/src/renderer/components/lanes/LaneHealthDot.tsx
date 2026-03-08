import { useEffect, useState } from "react";
import { COLORS } from "./laneDesignTokens";
import type { LaneHealthCheck, LaneHealthStatus } from "../../../shared/types";

function dotColor(status: LaneHealthStatus): string {
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

export function LaneHealthDot({ laneId }: { laneId: string }) {
  const [status, setStatus] = useState<LaneHealthStatus>("unknown");

  useEffect(() => {
    let cancelled = false;
    setStatus("unknown");

    const loadHealth = async () => {
      try {
        const cached = await window.ade.lanes.diagnosticsGetLaneHealth({ laneId });
        if (cancelled) {
          return;
        }
        if (cached) {
          setStatus(cached.status);
          return;
        }

        const fresh = await window.ade.lanes.diagnosticsRunHealthCheck({ laneId });
        if (!cancelled) {
          setStatus(fresh.status);
        }
      } catch {
        /* silent — dot stays unknown */
      }
    };

    void loadHealth();

    const unsub = window.ade.lanes.onDiagnosticsEvent((ev) => {
      if (cancelled) return;
      if (ev.health && ev.health.laneId === laneId) {
        setStatus(ev.health.status);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [laneId]);

  return (
    <span
      title={`Health: ${status}`}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: dotColor(status),
        flexShrink: 0,
      }}
    />
  );
}
