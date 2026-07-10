import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { QRCodeSVG } from "qrcode.react";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { publicAssetUrl } from "../onboarding/WelcomeVideoGate";
import { openExternalUrl } from "../../lib/openExternal";
import { extractError } from "../../lib/format";
import type { RemoteRuntimeLocalPairingInfo } from "../../../shared/types";

const labelStyle: CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 11,
  fontWeight: 500,
};

// ADE-branded QR treatment mirrored from the Sync pairing panel: white tile,
// accent-tinted border, excavated ADE mark (hence error-correction level H).
function ShareQrBox({ value }: { value: string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        padding: 12,
        borderRadius: 12,
        background: "#FFFFFF",
        border: "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 30%, transparent)",
      }}
    >
      <QRCodeSVG
        value={value}
        size={128}
        level="H"
        marginSize={1}
        bgColor="#FFFFFF"
        fgColor="#111827"
        title="Pairing QR code"
        imageSettings={{
          src: publicAssetUrl("welcome/ade-icon.webp"),
          height: 28,
          width: 28,
          excavate: true,
        }}
      />
    </div>
  );
}

/**
 * "Share this machine" surface: shows this Mac's pairing code, a copyable link,
 * a scannable QR, and a plain reachability line. When no PIN is set, other
 * machines cannot pair, so it points the user at Settings → Sync instead of
 * showing a code that will not work.
 */
export function ShareMachineCard() {
  const [info, setInfo] = useState<RemoteRuntimeLocalPairingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<"pin" | "link" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await window.ade.remoteRuntime.getLocalPairingInfo();
        if (!cancelled) setInfo(result);
      } catch (err) {
        if (!cancelled) setError(extractError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = useCallback(async (value: string, which: "pin" | "link") => {
    try {
      const writeClipboardText = window.ade?.app?.writeClipboardText;
      if (!writeClipboardText) return;
      await writeClipboardText(value);
      setCopied(which);
      window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    } catch {
      // Clipboard may be unavailable; the value stays visible to copy manually.
    }
  }, []);

  return (
    <div
      style={{
        display: "grid",
        gap: 14,
        padding: 14,
        borderRadius: 10,
        border: `1px solid ${COLORS.border}`,
        background: "rgba(0,0,0,0.16)",
      }}
    >
      <div
        style={{
          color: COLORS.textPrimary,
          fontFamily: SANS_FONT,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        Share this machine
      </div>

      {loading ? (
        <div style={labelStyle}>Loading pairing info…</div>
      ) : error ? (
        <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12 }}>
          {error}
        </div>
      ) : info ? (
        info.pin ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto minmax(0,1fr)",
              gap: 16,
              alignItems: "start",
            }}
          >
            <ShareQrBox value={info.url} />
            <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
              <div style={{ display: "grid", gap: 4 }}>
                <span style={labelStyle}>Pairing code</span>
                <div
                  style={{
                    color: COLORS.textPrimary,
                    fontFamily: MONO_FONT,
                    fontSize: 18,
                    letterSpacing: "0.28em",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {info.pin}
                </div>
                <button
                  type="button"
                  onClick={() => void copy(info.pin as string, "pin")}
                  style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11, justifySelf: "start" })}
                >
                  {copied === "pin" ? "Copied" : "Copy code"}
                </button>
              </div>
              <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                <span style={labelStyle}>Pairing link</span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => void copy(info.url, "link")}
                    style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
                  >
                    {copied === "link" ? "Copied" : "Copy link"}
                  </button>
                  <button
                    type="button"
                    onClick={() => openExternalUrl(info.url)}
                    style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
                  >
                    Open link
                  </button>
                </div>
              </div>
              <div style={labelStyle}>
                {info.machineName} · reachable over LAN
                {info.relayAvailable ? " · relay" : ""}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 12.5, lineHeight: 1.5 }}>
              No pairing code is set, so other machines can't pair with this Mac
              yet. Set a pairing PIN in Settings → Sync to share it.
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}
