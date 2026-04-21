import React, { useCallback, useEffect, useState } from "react";
import type { ComputerUseSettingsSnapshot, ComputerUseExternalBackendStatus } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function backendStatusLabel(
  backend: ComputerUseExternalBackendStatus,
  ghostConnected: boolean,
): { label: string; color: string } {
  if (backend.name === "Ghost OS") {
    if (ghostConnected && backend.available) return { label: "Installed, connected", color: COLORS.success };
    if (backend.available) return { label: "Installed", color: COLORS.success };
    if (backend.state === "installed") return { label: "Installed, not connected", color: COLORS.warning };
    return { label: "Not detected", color: COLORS.textDim };
  }
  if (backend.available) return { label: "Installed", color: COLORS.success };
  if (backend.state === "installed") return { label: "Installed", color: COLORS.success };
  return { label: "Not detected", color: COLORS.textDim };
}

/* ------------------------------------------------------------------ */
/*  Expandable backend row                                             */
/* ------------------------------------------------------------------ */

function BackendRow({
  name,
  available,
  statusLabel,
  statusColor,
  detail,
}: {
  name: string;
  available: boolean;
  statusLabel: string;
  statusColor: string;
  detail: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          padding: "8px 0",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: SANS_FONT,
          fontSize: 13,
          color: COLORS.textPrimary,
          textAlign: "left",
        }}
      >
        {/* status dot */}
        <span
          style={{
            display: "inline-block",
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: available ? COLORS.success : COLORS.textDim,
            flexShrink: 0,
          }}
        />

        {/* name */}
        <span style={{ flex: 1, fontWeight: 500 }}>{name}</span>

        {/* status text */}
        <span style={{ fontSize: 12, color: statusColor, fontWeight: 400 }}>{statusLabel}</span>

        {/* chevron */}
        <span
          style={{
            fontSize: 10,
            color: COLORS.textDim,
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 0.15s ease",
          }}
        >
          {"\u25B8"}
        </span>
      </button>

      {expanded && detail ? (
        <div
          style={{
            paddingLeft: 17,
            paddingBottom: 6,
            fontSize: 12,
            lineHeight: 1.5,
            color: COLORS.textSecondary,
          }}
        >
          {detail}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main section                                                       */
/* ------------------------------------------------------------------ */

export function ComputerUseSection() {
  const [snapshot, setSnapshot] = useState<ComputerUseSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    void window.ade.computerUse.getSettings()
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refresh(), [refresh]);

  const backends = snapshot?.backendStatus.backends ?? [];

  /* ---- loading / error states ---- */

  if (loading) {
    return (
      <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
        Loading...
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
        {error ?? "Computer-use settings unavailable."}
      </div>
    );
  }

  const ghostCheck = snapshot.ghostOsCheck;
  const localFallback = snapshot.backendStatus.localFallback;

  return (
    <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ---- header ---- */}
      <div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "1px",
            color: COLORS.textMuted,
          }}
        >
          Computer Use
        </div>

        <p
          style={{
            marginTop: 8,
            fontSize: 13,
            lineHeight: 1.55,
            color: COLORS.textSecondary,
            fontFamily: SANS_FONT,
          }}
        >
          ADE automatically captures proof from any screenshot, recording, trace, or log tool
          visible in ADE chat. CLI-native tools can also register proof through the ADE CLI so
          missions, workers, and chats share the same proof drawer.
        </p>
      </div>

      {/* ---- Ghost OS recommendation ---- */}
      {!ghostCheck.adeConnected ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            fontSize: 12,
            lineHeight: 1.5,
            fontFamily: SANS_FONT,
            color: COLORS.accent,
            background: COLORS.accentSubtle,
            border: `1px solid ${COLORS.accentBorder}`,
            borderRadius: 8,
          }}
        >
          <span style={{ flex: 1 }}>
            We recommend{" "}
            <strong>Ghost OS</strong>{" "}
            for full desktop automation.
          </span>
          <button
            type="button"
            style={{
              ...outlineButton({ height: 26, padding: "0 10px", fontSize: 11 }),
              color: COLORS.accent,
              borderColor: COLORS.accentBorder,
              flexShrink: 0,
            }}
            onClick={() => void window.ade.app.openExternal(ghostCheck.repoUrl)}
          >
            Set up Ghost OS
          </button>
        </div>
      ) : null}

      {/* ---- detected backends ---- */}
      <div
        style={{
          background: COLORS.cardBg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          padding: "4px 14px",
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "1px",
            color: COLORS.textMuted,
            padding: "10px 0 2px",
          }}
        >
          Detected backends
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          {backends.map((b) => {
            const status = backendStatusLabel(b, ghostCheck.adeConnected);
            return (
              <div
                key={b.name}
                style={{ borderTop: `1px solid ${COLORS.border}` }}
              >
                <BackendRow
                  name={b.name}
                  available={b.available}
                  statusLabel={status.label}
                  statusColor={status.color}
                  detail={b.detail}
                />
              </div>
            );
          })}

          {/* ADE Local fallback — always show */}
          <div style={{ borderTop: `1px solid ${COLORS.border}` }}>
            <BackendRow
              name="ADE Local"
              available={false}
              statusLabel={localFallback.available ? "Available as fallback" : "Unavailable"}
              statusColor={localFallback.available ? COLORS.info : COLORS.textDim}
              detail={localFallback.detail}
            />
          </div>
        </div>
      </div>

      {/* ---- transient error ---- */}
      {error ? (
        <div style={{ color: COLORS.warning, fontFamily: MONO_FONT, fontSize: 10 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
