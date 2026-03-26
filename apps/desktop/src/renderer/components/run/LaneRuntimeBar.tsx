import { useEffect, useState } from "react";
import { COLORS, MONO_FONT, LABEL_STYLE, inlineBadge, outlineButton, healthColor } from "../lanes/laneDesignTokens";
import type {
  LaneHealthCheck,
  LanePreviewInfo,
  ProcessEvent,
  ProcessRuntime,
} from "../../../shared/types";

type LaneRuntimeBarProps = {
  laneId: string | null;
};

const dividerStyle = {
  borderRight: `1px solid ${COLORS.border}`,
  paddingRight: 16,
};

export function LaneRuntimeBar({ laneId }: LaneRuntimeBarProps) {
  const [health, setHealth] = useState<LaneHealthCheck | null>(null);
  const [preview, setPreview] = useState<LanePreviewInfo | null>(null);
  const [runtimes, setRuntimes] = useState<ProcessRuntime[]>([]);

  // Parallel initial fetch for all lane runtime data
  useEffect(() => {
    if (!laneId) {
      setHealth(null);
      setPreview(null);
      setRuntimes([]);
      return;
    }
    let cancelled = false;
    const deferredTimer = window.setTimeout(() => {
      void window.ade.lanes.proxyGetPreviewInfo({ laneId }).catch(() => null).then((p) => {
        if (!cancelled) setPreview(p);
      });
    }, 350);

    void Promise.all([
      window.ade.lanes.diagnosticsGetLaneHealth({ laneId }).catch(() => null),
      window.ade.processes.listRuntime(laneId).catch(() => [] as ProcessRuntime[]),
    ]).then(([h, nextRuntimes]) => {
      if (cancelled) return;
      setHealth(h);
      setRuntimes(nextRuntimes);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(deferredTimer);
    };
  }, [laneId]);

  // Live subscriptions for real-time updates
  useEffect(() => {
    if (!laneId) return;
    let cancelled = false;

    const unsubHealth = window.ade.lanes.onDiagnosticsEvent((ev) => {
      if (!cancelled && ev.laneId === laneId && ev.health) setHealth(ev.health);
    });

    const unsubProxy = window.ade.lanes.onProxyEvent((ev) => {
      if (!cancelled && ev.route?.laneId === laneId) {
        window.ade.lanes.proxyGetPreviewInfo({ laneId }).then((p) => {
          if (!cancelled) setPreview(p);
        }).catch(() => {});
      }
    });

    const unsubProcesses = window.ade.processes.onEvent((ev: ProcessEvent) => {
      if (cancelled || ev.type !== "runtime" || ev.runtime.laneId !== laneId) return;
      setRuntimes((prev) => {
        const idx = prev.findIndex((runtime) => runtime.processId === ev.runtime.processId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = ev.runtime;
          return next;
        }
        return [...prev, ev.runtime];
      });
    });

    return () => {
      cancelled = true;
      unsubHealth();
      unsubProxy();
      unsubProcesses();
    };
  }, [laneId]);

  if (!laneId) {
    return (
      <div
        style={{
          background: COLORS.recessedBg,
          borderBottom: `1px solid ${COLORS.border}`,
          padding: "8px 20px",
          fontFamily: MONO_FONT,
          fontSize: 11,
          color: COLORS.textDim,
        }}
      >
        Select a lane
      </div>
    );
  }

  const hStatus = health?.status ?? "unknown";
  const hColor = healthColor(hStatus);
  const issueCount = health?.issues?.length ?? 0;
  const hasPreviewableRuntime = runtimes.some((runtime) => (
    (runtime.status === "starting" || runtime.status === "running" || runtime.status === "degraded")
      && runtime.ports.length > 0
  ));

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        background: COLORS.recessedBg,
        borderBottom: `1px solid ${COLORS.border}`,
        padding: "8px 20px",
        flexShrink: 0,
      }}
    >
      {/* Health */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, ...dividerStyle }}>
        <span style={inlineBadge(hColor, { fontSize: 9, padding: "1px 6px" })}>
          {hStatus.toUpperCase()}
        </span>
        {issueCount > 0 && (
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              color: COLORS.warning,
            }}
          >
            {issueCount} issue{issueCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Preview */}
      {hasPreviewableRuntime && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Preview</span>
          {preview && preview.active ? (
            <>
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  color: COLORS.textSecondary,
                  maxWidth: 180,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={preview.previewUrl}
              >
                {preview.hostname}
              </span>
              <button
                type="button"
                onClick={() => void window.ade.app.openExternal(preview.previewUrl)}
                aria-label={`Open preview ${preview.hostname}`}
                style={outlineButton({ height: 22, fontSize: 9, padding: "0 8px" })}
              >
                OPEN
              </button>
              <button
                type="button"
                onClick={() => void window.ade.app.writeClipboardText(preview.previewUrl)}
                aria-label={`Copy preview URL ${preview.hostname}`}
                style={outlineButton({ height: 22, fontSize: 9, padding: "0 8px" })}
              >
                COPY
              </button>
            </>
          ) : (
            <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>
              Starting preview...
            </span>
          )}
        </div>
      )}
    </div>
  );
}
