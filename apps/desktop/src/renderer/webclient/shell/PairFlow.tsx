import React, { useCallback, useMemo, useState } from "react";
import { parsePairingQrText } from "../../../shared/pairingQr";
import type { SyncPairingQrPayload } from "../../../shared/types/sync";
import {
  AdeSyncClient,
  deriveBrowserSyncEndpoints,
  type WebClientEnvironmentRecord,
} from "../sync";
import { ScreenShell } from "./ScreenShell";
import { PinInput } from "./PinInput";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "./shellTokens";

const inputStyle: React.CSSProperties = {
  height: 36,
  width: "100%",
  background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 13,
  padding: "0 10px",
  outline: "none",
};

const helperStyle: React.CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 12,
  lineHeight: 1.6,
};

function defaultDeviceName(): string {
  if (typeof navigator === "undefined") return "Browser";
  const ua = navigator.userAgent;
  const browser = /edg\//i.test(ua) ? "Edge"
    : /chrome\//i.test(ua) ? "Chrome"
    : /firefox\//i.test(ua) ? "Firefox"
    : /safari\//i.test(ua) ? "Safari"
    : "Browser";
  const os = /mac os|macintosh/i.test(ua) ? "macOS"
    : /windows/i.test(ua) ? "Windows"
    : /linux/i.test(ua) ? "Linux"
    : null;
  return os ? `${browser} on ${os}` : browser;
}

type PairError = {
  title: string;
  detail: string;
  showRelayHelp: boolean;
};

function classifyPairError(error: unknown): PairError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("no dialable") || lower.includes("timed out") || lower.includes("websocket failed") || lower.includes("closed before")) {
    return {
      title: "Couldn't reach this machine",
      detail:
        "From a hosted page, browsers can only connect over a secure relay or Tailscale endpoint — a plain LAN address won't work. Turn on the cloud relay in ADE desktop under Settings > Sync, or paste a wss:// endpoint below.",
      showRelayHelp: true,
    };
  }
  if (lower.includes("pin")) {
    return {
      title: "Pairing PIN rejected",
      detail: "That PIN didn't match. Check the current PIN in ADE desktop under Settings > Sync, then try again.",
      showRelayHelp: false,
    };
  }
  return {
    title: "Pairing failed",
    detail: message || "Something went wrong while pairing. Try again, and confirm ADE desktop is running with a PIN set.",
    showRelayHelp: false,
  };
}

/** Merge a manual wss:// endpoint into the payload as a dialable relay route. */
function withManualEndpoint(payload: SyncPairingQrPayload, manual: string): SyncPairingQrPayload {
  const trimmed = manual.trim();
  if (!trimmed || !/^wss:\/\//i.test(trimmed)) return payload;
  return { ...payload, relayUrl: trimmed };
}

export function PairFlow({
  client,
  hash,
  onPaired,
  onBack,
}: {
  client: AdeSyncClient;
  /** window.location.hash carrying the base64url pairing payload. */
  hash: string;
  onPaired: (environment: WebClientEnvironmentRecord) => void;
  onBack?: () => void;
}) {
  const initialPayload = useMemo(() => (hash ? parsePairingQrText(hash) : null), [hash]);
  const [pastedLink, setPastedLink] = useState("");
  const pastedPayload = useMemo(() => (pastedLink.trim() ? parsePairingQrText(pastedLink) : null), [pastedLink]);
  const payload = initialPayload ?? pastedPayload;

  const [pin, setPin] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [manualEndpoint, setManualEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairError | null>(null);

  const dialable = useMemo(() => {
    if (!payload) return [];
    return deriveBrowserSyncEndpoints({ payload }).filter((candidate) => candidate.dialable);
  }, [payload]);
  const noReachablePath = Boolean(payload) && dialable.length === 0;

  const submit = useCallback(async () => {
    if (!payload || pin.replace(/\D/g, "").length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const effectivePayload = manualEndpoint ? withManualEndpoint(payload, manualEndpoint) : payload;
      const environment = await client.pair({
        payload: effectivePayload,
        pin,
        deviceName: deviceName.trim() || defaultDeviceName(),
      });
      onPaired(environment);
    } catch (pairError) {
      setError(classifyPairError(pairError));
      setBusy(false);
    }
  }, [busy, client, deviceName, manualEndpoint, onPaired, payload, pin]);

  // No usable payload in the URL — ask for the pairing link.
  if (!payload) {
    return (
      <ScreenShell
        title="Pair with a machine"
        subtitle="Open ADE desktop, go to Settings > Sync > Web client, and scan the QR or copy the pairing link. Paste it here to continue."
      >
        <label style={{ display: "grid", gap: 8 }}>
          <span style={LABEL_STYLE}>Pairing link</span>
          <input
            value={pastedLink}
            onChange={(event) => setPastedLink(event.target.value)}
            placeholder="https://app.ade-app.dev/pair#…"
            style={inputStyle}
            autoFocus
          />
        </label>
        {pastedLink.trim() && !pastedPayload ? (
          <div style={{ ...helperStyle, color: COLORS.danger }}>
            That doesn't look like a valid ADE pairing link. Copy it again from Settings &gt; Sync.
          </div>
        ) : (
          <div style={helperStyle}>The link is safe to paste — its pairing details live in the URL fragment and never reach a server.</div>
        )}
        {onBack ? (
          <button type="button" style={outlineButton({ justifySelf: "start" })} onClick={onBack}>
            Back
          </button>
        ) : null}
      </ScreenShell>
    );
  }

  const machineName = payload.hostIdentity.name;

  return (
    <ScreenShell
      title={`Pair with ${machineName}`}
      subtitle="Enter the 6-digit pairing PIN shown in ADE desktop under Settings > Sync."
    >
      <div style={{ display: "grid", gap: 8 }}>
        <span style={LABEL_STYLE}>Pairing PIN</span>
        <PinInput value={pin} onChange={setPin} onComplete={() => { void submit(); }} disabled={busy} />
      </div>

      <label style={{ display: "grid", gap: 8 }}>
        <span style={LABEL_STYLE}>This device's name</span>
        <input
          value={deviceName}
          onChange={(event) => setDeviceName(event.target.value)}
          style={inputStyle}
          disabled={busy}
          placeholder="e.g. Chrome on macOS"
        />
      </label>

      {noReachablePath ? (
        <div style={{ ...helperStyle, color: COLORS.warning }}>
          This machine only published local network addresses, which a hosted page can't reach. Enable the cloud relay in
          ADE desktop under Settings &gt; Sync, or paste a wss:// endpoint below (Tailscale serve users).
        </div>
      ) : null}

      {(noReachablePath || error?.showRelayHelp) ? (
        <label style={{ display: "grid", gap: 8 }}>
          <span style={LABEL_STYLE}>Manual endpoint (optional)</span>
          <input
            value={manualEndpoint}
            onChange={(event) => setManualEndpoint(event.target.value)}
            style={inputStyle}
            disabled={busy}
            placeholder="wss://my-machine.ts.net:8787"
          />
        </label>
      ) : null}

      {error ? (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600 }}>{error.title}</div>
          <div style={helperStyle}>{error.detail}</div>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          style={primaryButton({ opacity: pin.replace(/\D/g, "").length === 6 && !busy ? 1 : 0.5, height: 36 })}
          disabled={pin.replace(/\D/g, "").length !== 6 || busy}
          onClick={() => { void submit(); }}
        >
          {busy ? "Pairing…" : "Pair"}
        </button>
        {onBack ? (
          <button type="button" style={outlineButton({ height: 36 })} disabled={busy} onClick={onBack}>
            Back
          </button>
        ) : null}
      </div>
    </ScreenShell>
  );
}
