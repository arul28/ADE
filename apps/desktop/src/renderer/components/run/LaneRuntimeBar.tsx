import { useCallback, useEffect, useRef, useState } from "react";
import { Globe } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, LABEL_STYLE, inlineBadge, outlineButton, healthColor } from "../lanes/laneDesignTokens";
import type {
  LaneHealthCheck,
  LanePreviewInfo,
  PortLease,
  ProcessEvent,
  ProcessRuntime,
  ProxyStatus,
} from "../../../shared/types";
import { isActiveProcessStatus } from "./processUtils";

type LaneRuntimeBarProps = {
  laneId: string | null;
  onOpenPreviewRouting?: () => void;
};

const dividerStyle = {
  borderRight: `1px solid ${COLORS.border}`,
  paddingRight: 16,
};

export function LaneRuntimeBar({ laneId, onOpenPreviewRouting }: LaneRuntimeBarProps) {
  const [health, setHealth] = useState<LaneHealthCheck | null>(null);
  const [preview, setPreview] = useState<LanePreviewInfo | null>(null);
  const [lease, setLease] = useState<PortLease | null>(null);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null);
  const [runtimes, setRuntimes] = useState<ProcessRuntime[]>([]);
  const [oauthEnabled, setOauthEnabled] = useState(false);
  const [oauthCallbackUrl, setOauthCallbackUrl] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const activeLaneIdRef = useRef<string | null>(laneId);
  const refreshSeqRef = useRef(0);

  useEffect(() => {
    activeLaneIdRef.current = laneId;
  }, [laneId]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshRuntimeState = useCallback((targetLaneId: string, opts?: { runHealthCheck?: boolean }) => {
    const requestId = ++refreshSeqRef.current;
    const healthPromise = opts?.runHealthCheck
      ? window.ade.lanes.diagnosticsRunHealthCheck({ laneId: targetLaneId }).catch(() => null)
      : window.ade.lanes.diagnosticsGetLaneHealth({ laneId: targetLaneId }).catch(() => null);

    void Promise.all([
      healthPromise,
      window.ade.lanes.proxyGetPreviewInfo({ laneId: targetLaneId }).catch(() => null),
      window.ade.lanes.portGetLease({ laneId: targetLaneId }).catch(() => null),
      window.ade.lanes.proxyGetStatus().catch(() => null),
      window.ade.processes.listRuntime(targetLaneId).catch(() => [] as ProcessRuntime[]),
      window.ade.lanes.oauthGetStatus().catch(() => null),
      window.ade.lanes.oauthGenerateRedirectUris({ provider: "google" }).catch(() => []),
    ]).then(([nextHealth, nextPreview, nextLease, nextProxyStatus, nextRuntimes, nextOauthStatus, nextOauthUris]) => {
      if (!isMountedRef.current) return;
      if (refreshSeqRef.current !== requestId) return;
      if (activeLaneIdRef.current !== targetLaneId) return;
      setHealth(nextHealth);
      setPreview(nextPreview);
      setLease(nextLease);
      setProxyStatus(nextProxyStatus);
      setRuntimes(nextRuntimes);
      setOauthEnabled(nextOauthStatus?.enabled ?? false);
      setOauthCallbackUrl(nextOauthUris[0]?.uris?.[0] ?? null);
    });
  }, []);

  useEffect(() => {
    if (!laneId) {
      setHealth(null);
      setPreview(null);
      setLease(null);
      setProxyStatus(null);
      setRuntimes([]);
      setOauthEnabled(false);
      setOauthCallbackUrl(null);
      return;
    }
    let cancelled = false;
    const runRefresh = (runHealthCheck: boolean) => {
      if (cancelled) return;
      refreshRuntimeState(laneId, { runHealthCheck });
    };
    runRefresh(false);
    const deferredTimer = window.setTimeout(() => runRefresh(true), 160);
    const refreshInterval = window.setInterval(() => runRefresh(true), 2500);

    return () => {
      cancelled = true;
      window.clearTimeout(deferredTimer);
      window.clearInterval(refreshInterval);
    };
  }, [laneId, refreshRuntimeState]);

  useEffect(() => {
    if (!laneId) return;
    let cancelled = false;
    let refreshTimer: number | null = null;
    const scheduleRefresh = (runHealthCheck: boolean) => {
      if (cancelled) return;
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (cancelled) return;
        refreshRuntimeState(laneId, { runHealthCheck });
      }, runHealthCheck ? 180 : 80);
    };

    const unsubHealth = window.ade.lanes.onDiagnosticsEvent((ev) => {
      if (!cancelled && ev.laneId === laneId && ev.health) setHealth(ev.health);
    });

    const unsubProxy = window.ade.lanes.onProxyEvent((ev) => {
      if (cancelled) return;
      if (ev.route?.laneId === laneId || ev.type === "proxy-started" || ev.type === "proxy-stopped") {
        scheduleRefresh(false);
      }
    });

    const unsubPorts = window.ade.lanes.onPortEvent((ev) => {
      if (cancelled) return;
      if (ev.lease?.laneId === laneId) {
        setLease(ev.lease);
        scheduleRefresh(true);
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
      scheduleRefresh(true);
    });

    return () => {
      cancelled = true;
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
      unsubHealth();
      unsubProxy();
      unsubPorts();
      unsubProcesses();
    };
  }, [laneId, refreshRuntimeState]);

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
  const activeLease = lease?.status === "active" ? lease : null;
  const activeRuntimePorts = Array.from(
    new Set(
      runtimes
        .filter((runtime) => isActiveProcessStatus(runtime.status))
        .flatMap((runtime) => runtime.ports),
    ),
  ).sort((a, b) => a - b);
  const hasExpectedRuntimePort = activeLease ? activeRuntimePorts.includes(activeLease.rangeStart) : false;
  const mismatchedRuntimePorts = activeLease
    ? activeRuntimePorts.filter((port) => port !== activeLease.rangeStart)
    : [];
  const respondingPort = health?.respondingPort ?? null;
  const proxyPort = preview?.proxyPort ?? proxyStatus?.proxyPort ?? null;
  const proxyRunning = proxyStatus?.running ?? false;
  const appPortText = respondingPort !== null
    ? `:${respondingPort}`
    : activeLease
      ? `Waiting in :${activeLease.rangeStart}-:${activeLease.rangeEnd}`
      : "Not assigned";

  let previewMessage = "No lane port assigned yet.";
  let previewTitle = previewMessage;
  if (!activeLease) {
    previewMessage = "Preview URL unavailable until ADE assigns a lane port.";
    previewTitle = previewMessage;
  } else if (preview) {
    if (!proxyRunning) {
      previewMessage = `${preview.previewUrl} (gateway off)`;
      previewTitle = `${preview.previewUrl} — ADE preview routing is off. Start the gateway to open this lane preview.`;
    } else if (respondingPort !== null && preview.targetPort !== respondingPort) {
      previewMessage = `${preview.previewUrl} (updating)`;
      previewTitle = `${preview.previewUrl} — ADE detected your app on :${respondingPort} and is retargeting the lane preview now.`;
    } else if (!preview.active) {
      previewMessage = `${preview.previewUrl} (waiting)`;
      previewTitle = `${preview.previewUrl} — preview routing is reserved for this lane and will open once the gateway is ready.`;
    } else {
      previewMessage = preview.previewUrl;
      previewTitle = `${preview.previewUrl} — stable ADE preview URL for this lane.`;
    }
  } else if (mismatchedRuntimePorts.length > 0 && !hasExpectedRuntimePort && health?.portResponding === false) {
    previewMessage = `Command reported ${mismatchedRuntimePorts.map((port) => `:${port}`).join(", ")}. ADE is still checking the live port.`;
    previewTitle = previewMessage;
  } else if (!proxyRunning) {
    previewMessage = `ADE preview gateway is off. Start it to use the stable preview URL.`;
    previewTitle = previewMessage;
  } else if (health?.portResponding === false) {
    previewMessage = `Waiting for your app in :${activeLease.rangeStart}-:${activeLease.rangeEnd}.`;
    previewTitle = previewMessage;
  } else {
    previewMessage = `Preparing the stable preview URL for this lane...`;
    previewTitle = previewMessage;
  }

  const oauthMessage = oauthEnabled
    ? oauthCallbackUrl ?? (proxyPort ? `http://localhost:${proxyPort}/oauth/callback` : "Waiting for the ADE callback URL...")
    : "ADE callback routing is off";

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

      <div style={{ display: "flex", alignItems: "center", gap: 8, ...dividerStyle }}>
        <span style={{ ...LABEL_STYLE, fontSize: 9 }}>App</span>
        <span
          style={{
            fontFamily: MONO_FONT,
            fontSize: 11,
            color: respondingPort !== null ? COLORS.textPrimary : COLORS.textDim,
            whiteSpace: "nowrap",
          }}
          title={respondingPort !== null ? `ADE detected the app on ${appPortText}` : appPortText}
        >
          {appPortText}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, ...dividerStyle }}>
        <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Open</span>
        <span
          style={{
            fontFamily: MONO_FONT,
            fontSize: 11,
            color: preview ? COLORS.textPrimary : COLORS.textDim,
            maxWidth: 320,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={previewTitle}
        >
          {previewMessage}
        </span>
        {preview ? (
          <>
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
        ) : null}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span style={{ ...LABEL_STYLE, fontSize: 9 }}>OAuth</span>
        <span
          style={{
            fontFamily: MONO_FONT,
            fontSize: 11,
            color: oauthEnabled ? COLORS.textSecondary : COLORS.textDim,
            maxWidth: 260,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={oauthEnabled ? `${oauthMessage} — register this once, then start sign-in from the preview URL.` : oauthMessage}
        >
          {oauthMessage}
        </span>
        {oauthEnabled && oauthCallbackUrl ? (
          <button
            type="button"
            onClick={() => void window.ade.app.writeClipboardText(oauthCallbackUrl)}
            aria-label={`Copy OAuth callback URL ${oauthCallbackUrl}`}
            style={outlineButton({ height: 22, fontSize: 9, padding: "0 8px" })}
          >
            COPY
          </button>
        ) : null}
        {onOpenPreviewRouting ? (
          <button
            type="button"
            onClick={onOpenPreviewRouting}
            style={outlineButton({ height: 22, fontSize: 9, padding: "0 8px" })}
            aria-label="Open preview and routing settings"
          >
            <Globe size={11} weight="bold" />
            Preview & routing
          </button>
        ) : null}
      </div>
    </div>
  );
}
