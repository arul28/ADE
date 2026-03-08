import { useEffect, useState, useCallback } from "react";
import {
  COLORS,
  MONO_FONT,
  LABEL_STYLE,
  inlineBadge,
  cardStyle,
  recessedStyle,
  outlineButton,
  primaryButton,
} from "./laneDesignTokens";
import type { ProxyStatus, LanePreviewInfo } from "../../../shared/types";

function ProxyStatusBadge({ running }: { running: boolean }) {
  const color = running ? COLORS.success : COLORS.textDim;
  return (
    <span style={inlineBadge(color)}>
      {running ? "PROXY ACTIVE" : "PROXY OFF"}
    </span>
  );
}

function PreviewUrlRow({
  info,
  onOpen,
  onCopy,
}: {
  info: LanePreviewInfo;
  onOpen: () => void;
  onCopy: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          fontFamily: MONO_FONT,
          fontSize: 13,
          fontWeight: 600,
          color: info.active ? COLORS.textPrimary : COLORS.textMuted,
          letterSpacing: "0.5px",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {info.previewUrl}
      </span>
      <button
        type="button"
        style={primaryButton({ height: 26, padding: "0 10px", fontSize: 10 })}
        onClick={onOpen}
        title="Open in browser"
      >
        OPEN
      </button>
      <button
        type="button"
        style={outlineButton({ height: 26, padding: "0 10px", fontSize: 10 })}
        onClick={onCopy}
        title="Copy preview URL"
      >
        COPY
      </button>
    </div>
  );
}

export function LanePreviewPanel({ laneId }: { laneId: string }) {
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null);
  const [previewInfo, setPreviewInfo] = useState<LanePreviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const unsub = window.ade.lanes.onProxyEvent((ev) => {
      if (ev.status) setProxyStatus(ev.status);
      // Refresh preview info on route changes
      if (ev.route?.laneId === laneId || ev.type === "proxy-started" || ev.type === "proxy-stopped") {
        window.ade.lanes.proxyGetPreviewInfo({ laneId }).then((info) => {
          if (!cancelled) setPreviewInfo(info);
        });
      }
    });

    Promise.all([
      window.ade.lanes.proxyGetStatus(),
      window.ade.lanes.proxyGetPreviewInfo({ laneId }),
    ])
      .then(([status, info]) => {
        if (!cancelled) {
          setProxyStatus(status);
          setPreviewInfo(info);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [laneId]);

  const handleOpen = useCallback(() => {
    window.ade.lanes.proxyOpenPreview({ laneId }).catch(() => {
      // If opening fails (no route), try to open the URL directly
      if (previewInfo?.previewUrl) {
        window.ade.app.openExternal(previewInfo.previewUrl);
      }
    });
  }, [laneId, previewInfo]);

  const handleCopy = useCallback(() => {
    if (!previewInfo?.previewUrl) return;
    window.ade.app.writeClipboardText(previewInfo.previewUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [previewInfo]);

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
          style={{ color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 11 }}
        >
          Loading preview...
        </span>
      </div>
    );
  }

  return (
    <div style={cardStyle({ display: "flex", flexDirection: "column", gap: 12 })}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={LABEL_STYLE}>Preview & Proxy</div>
        <ProxyStatusBadge running={proxyStatus?.running ?? false} />
      </div>

      {previewInfo ? (
        <>
          <PreviewUrlRow
            info={previewInfo}
            onOpen={handleOpen}
            onCopy={handleCopy}
          />

          {copied && (
            <span
              style={{
                fontSize: 10,
                color: COLORS.success,
                fontFamily: MONO_FONT,
              }}
            >
              Copied to clipboard
            </span>
          )}

          <div
            style={recessedStyle({
              display: "flex",
              flexDirection: "column",
              gap: 4,
            })}
          >
            <div style={{ display: "flex", gap: 16 }}>
              <span
                style={{
                  fontSize: 10,
                  color: COLORS.textDim,
                  fontFamily: MONO_FONT,
                }}
              >
                HOSTNAME
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: COLORS.textPrimary,
                  fontFamily: MONO_FONT,
                  fontWeight: 600,
                }}
              >
                {previewInfo.hostname}
              </span>
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <span
                style={{
                  fontSize: 10,
                  color: COLORS.textDim,
                  fontFamily: MONO_FONT,
                }}
              >
                TARGET PORT
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: COLORS.textPrimary,
                  fontFamily: MONO_FONT,
                  fontWeight: 600,
                }}
              >
                {previewInfo.targetPort}
              </span>
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <span
                style={{
                  fontSize: 10,
                  color: COLORS.textDim,
                  fontFamily: MONO_FONT,
                }}
              >
                STATUS
              </span>
              <span
                style={inlineBadge(
                  previewInfo.active ? COLORS.success : COLORS.textDim
                )}
              >
                {previewInfo.active ? "ROUTABLE" : "INACTIVE"}
              </span>
            </div>
          </div>
        </>
      ) : (
        <div
          style={{
            ...recessedStyle(),
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={inlineBadge(COLORS.textDim)}>NO ROUTE</span>
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 11,
              color: COLORS.textMuted,
            }}
          >
            No proxy route configured for this lane
          </span>
        </div>
      )}

      {proxyStatus && proxyStatus.running && (
        <div
          style={{
            fontSize: 10,
            color: COLORS.textDim,
            fontFamily: MONO_FONT,
          }}
        >
          Proxy port {proxyStatus.proxyPort} ·{" "}
          {proxyStatus.routes.length} route(s) active
        </div>
      )}
    </div>
  );
}
