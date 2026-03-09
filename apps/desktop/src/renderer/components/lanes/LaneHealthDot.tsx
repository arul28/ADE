import { useEffect, useState } from "react";
import { healthColor } from "./laneDesignTokens";
import type { LaneHealthStatus } from "../../../shared/types";

export function LaneHealthDot({ laneId }: { laneId: string }) {
  const [status, setStatus] = useState<LaneHealthStatus>("unknown");

  useEffect(() => {
    let cancelled = false;
    setStatus("unknown");

    const loadHealth = async () => {
      try {
        const cached = await window.ade.lanes.diagnosticsGetLaneHealth({ laneId });
        if (cancelled) return;
        const result = cached ?? await window.ade.lanes.diagnosticsRunHealthCheck({ laneId });
        if (!cancelled) setStatus(result.status);
      } catch {
        /* silent -- dot stays unknown */
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
        background: healthColor(status),
        flexShrink: 0,
      }}
    />
  );
}
