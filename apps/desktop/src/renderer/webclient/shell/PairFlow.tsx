import React, { useCallback, useMemo, useState } from "react";
import { parsePairingQrText } from "../../../shared/pairingQr";
import {
  deriveBrowserSyncEndpoints,
  filterPairingEndpoints,
  WebRelayAuthRequiredError,
  type AdeSyncClient,
  type WebClientEnvironmentRecord,
  type WebRelayAccess,
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
  requiresSignIn: boolean;
};

function classifyPairError(error: unknown): PairError {
  if (error instanceof WebRelayAuthRequiredError) {
    return {
      title: "Sign in to connect",
      detail: error.message,
      showRelayHelp: false,
      requiresSignIn: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("no dialable") || lower.includes("timed out") || lower.includes("websocket failed") || lower.includes("closed before")) {
    return {
      title: "Your browser can't reach this Mac",
      detail:
        "On the Mac, open ADE > Connections > Web client and turn on Connect from anywhere. Then try again.",
      showRelayHelp: true,
      requiresSignIn: false,
    };
  }
  if (lower.includes("pin")) {
    return {
      title: "That code didn't work",
      detail: "Check the six digits shown on the Mac, then try again.",
      showRelayHelp: false,
      requiresSignIn: false,
    };
  }
  return {
    title: "Pairing failed",
    detail: message || "Make sure ADE is open on the Mac, then try again.",
    showRelayHelp: false,
    requiresSignIn: false,
  };
}

export function PairFlow({
  client,
  hash,
  relayAccess,
  onSignIn,
  onPaired,
  onBack,
}: {
  client: AdeSyncClient;
  /** window.location.hash carrying the base64url pairing payload. */
  hash: string;
  relayAccess: WebRelayAccess;
  onSignIn: () => void;
  onPaired: (environment: WebClientEnvironmentRecord) => void;
  onBack?: () => void;
}) {
  const initialPayload = useMemo(() => (
    hash ? parsePairingQrText(hash.startsWith("#") ? hash.slice(1) : hash) : null
  ), [hash]);
  const [pastedLink, setPastedLink] = useState("");
  const pastedPayload = useMemo(() => (pastedLink.trim() ? parsePairingQrText(pastedLink) : null), [pastedLink]);
  const payload = initialPayload ?? pastedPayload;

  const [pin, setPin] = useState("");
  const [deviceName] = useState(defaultDeviceName);
  const [manualEndpoint, setManualEndpoint] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairError | null>(null);

  const endpointState = useMemo(() => {
    if (!payload) return [];
    const original = deriveBrowserSyncEndpoints({ payload });
    return filterPairingEndpoints(payload, original, relayAccess);
  }, [payload, relayAccess]);
  const directEndpoint = /^wss:\/\/[^\s]+$/i.test(manualEndpoint.trim()) ? manualEndpoint.trim() : null;
  const canPair = endpointState.some((candidate) => candidate.dialable) || Boolean(directEndpoint);
  const relayBlocked = Boolean(payload)
    && deriveBrowserSyncEndpoints({ payload }).some((candidate) => candidate.kind === "relay" && candidate.dialable)
    && !endpointState.some((candidate) => candidate.dialable);
  const noReachablePath = Boolean(payload) && !canPair;

  const submit = useCallback(async () => {
    if (!payload || pin.replace(/\D/g, "").length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const environment = await client.pair({
        payload,
        pin,
        deviceName: deviceName.trim() || defaultDeviceName(),
        relayAccess,
        directWssEndpoint: directEndpoint,
      });
      onPaired(environment);
    } catch (pairError) {
      setError(classifyPairError(pairError));
      setBusy(false);
    }
  }, [busy, client, deviceName, directEndpoint, onPaired, payload, pin, relayAccess]);

  // No usable payload in the URL — ask for the pairing link.
  if (!payload) {
    const linkField = (
      <label style={{ display: "grid", gap: 8 }}>
        <span style={LABEL_STYLE}>Pairing link</span>
        <input
          value={pastedLink}
          onChange={(event) => setPastedLink(event.target.value)}
          placeholder="https://app.ade-app.dev/pair#…"
          style={inputStyle}
          autoFocus={relayAccess.kind === "signed_in"}
        />
      </label>
    );
    return (
      <ScreenShell
        title="Connect to your Mac"
        subtitle={relayAccess.kind === "signed_in"
          ? "On your Mac, open ADE > Connections > Web client and copy the pairing link."
          : "Sign in to connect to your Mac from the web."}
      >
        {relayAccess.kind === "signed_in" ? linkField : (
          <>
            <button type="button" style={primaryButton({ justifySelf: "start", height: 36 })} onClick={onSignIn}>
              Sign in
            </button>
            <details style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 14 }}>
              <summary style={{ color: COLORS.textSecondary, cursor: "pointer", fontFamily: SANS_FONT, fontSize: 13 }}>
                Connect directly (advanced)
              </summary>
              <div style={{ display: "grid", gap: 10, paddingTop: 12 }}>
                <div style={helperStyle}>For localhost or a secure address you manage.</div>
                {linkField}
              </div>
            </details>
          </>
        )}
        {pastedLink.trim() && !pastedPayload ? (
          <div style={{ ...helperStyle, color: COLORS.danger }}>
            That link did not work. Copy it again from Connections &gt; Web client on the Mac.
          </div>
        ) : relayAccess.kind === "signed_in" ? (
          <div style={helperStyle}>You only need to pair this browser once.</div>
        ) : null}
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
      subtitle={relayBlocked && !directEndpoint
        ? "Sign in with the same ADE account as this Mac, or connect directly."
        : "Enter the six-digit code shown beside the pairing link on the Mac."}
    >
      {relayBlocked && !directEndpoint ? (
        <button type="button" style={primaryButton({ justifySelf: "start", height: 36 })} onClick={onSignIn}>
          {relayAccess.kind === "signed_in" ? "Use another account" : "Sign in"}
        </button>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <span style={LABEL_STYLE}>6-digit code</span>
          <PinInput value={pin} onChange={setPin} onComplete={() => { void submit(); }} disabled={busy} />
        </div>
      )}

      {noReachablePath ? (
        <div style={{ ...helperStyle, color: COLORS.warning }}>
          This browser cannot reach the Mac yet. Sign in with the same ADE account as the Mac, or add a secure address below.
        </div>
      ) : null}

      <details
        open={advancedOpen || relayBlocked || noReachablePath || Boolean(error?.showRelayHelp)}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 14 }}
      >
        <summary style={{ color: COLORS.textSecondary, cursor: "pointer", fontFamily: SANS_FONT, fontSize: 13 }}>
          Connect directly (advanced)
        </summary>
        <label style={{ display: "grid", gap: 8, paddingTop: 12 }}>
          <span style={LABEL_STYLE}>Secure address</span>
          <input
            value={manualEndpoint}
            onChange={(event) => setManualEndpoint(event.target.value)}
            style={inputStyle}
            disabled={busy}
            placeholder="wss://my-machine.example.com:8787"
          />
          <span style={helperStyle}>Use a secure WebSocket address you manage.</span>
        </label>
      </details>

      {error ? (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600 }}>{error.title}</div>
          <div style={helperStyle}>{error.detail}</div>
        </div>
      ) : null}

      {error?.requiresSignIn ? (
        <button type="button" style={primaryButton({ justifySelf: "start", height: 36 })} onClick={onSignIn}>
          Sign in again
        </button>
      ) : null}

      {canPair && !error?.requiresSignIn ? <div style={{ display: "flex", gap: 8 }}>
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
      </div> : onBack ? (
        <button type="button" style={outlineButton({ justifySelf: "start", height: 36 })} disabled={busy} onClick={onBack}>
          Back
        </button>
      ) : null}
    </ScreenShell>
  );
}
