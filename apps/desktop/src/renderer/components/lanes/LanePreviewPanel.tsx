import { useEffect, useState, useCallback, useRef } from "react";
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
  const [error, setError] = useState<string | null>(null);
  const copiedTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCopied(false);

    const refreshPreview = async () => {
      try {
        const info = await window.ade.lanes.proxyGetPreviewInfo({ laneId });
        const status = await window.ade.lanes.proxyGetStatus();
        if (cancelled) return;
        setPreviewInfo(info);
        setProxyStatus(status);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setPreviewInfo(null);
        setError(err instanceof Error ? err.message : "Preview unavailable.");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    const unsub = window.ade.lanes.onProxyEvent((ev) => {
      if (ev.status) setProxyStatus(ev.status);
      // Refresh preview info on route changes
      if (ev.route?.laneId === laneId || ev.type === "proxy-started" || ev.type === "proxy-stopped") {
        void refreshPreview();
      }
    });

    void refreshPreview();

    return () => {
      cancelled = true;
      unsub();
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, [laneId]);

  const handleOpen = useCallback(() => {
    setError(null);
    window.ade.lanes.proxyOpenPreview({ laneId }).catch(async (err) => {
      // If opening fails (no route), try to open the URL directly
      if (previewInfo?.previewUrl) {
        try {
          await window.ade.app.openExternal(previewInfo.previewUrl);
          return;
        } catch {
          // Fall through to the message below.
        }
      }
      setError(err instanceof Error ? err.message : "Unable to open preview.");
    });
  }, [laneId, previewInfo]);

  const handleCopy = useCallback(() => {
    if (!previewInfo?.previewUrl) return;
    setError(null);
    window.ade.app.writeClipboardText(previewInfo.previewUrl).then(() => {
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
      setCopied(true);
      copiedTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimeoutRef.current = null;
      }, 2000);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : "Unable to copy preview URL.");
    });
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

      {error ? (
        <div
          style={{
            ...recessedStyle(),
            color: COLORS.danger,
            fontFamily: MONO_FONT,
            fontSize: 11,
          }}
        >
          {error}
        </div>
      ) : null}

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
