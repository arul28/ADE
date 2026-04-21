import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import type {
  SyncDesktopConnectionDraft,
  SyncDeviceRecord,
  SyncDeviceRuntimeState,
  SyncRoleSnapshot,
  SyncTailnetDiscoveryStatus,
} from "../../../shared/types";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
  dangerButton,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

const helperTextStyle: React.CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: MONO_FONT,
  fontSize: 11,
  lineHeight: 1.6,
};

const inputStyle: React.CSSProperties = {
  height: 32,
  width: "100%",
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 8,
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 12,
  padding: "0 10px",
  outline: "none",
};

const detailBlockStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 12,
  padding: 14,
  background: "rgba(255,255,255,0.015)",
};

const detailSummaryStyle: React.CSSProperties = {
  cursor: "pointer",
  color: COLORS.textPrimary,
  fontFamily: SANS_FONT,
  fontSize: 14,
  fontWeight: 600,
  listStyle: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const panelStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 10,
  padding: 12,
  display: "grid",
  gap: 6,
};

const codeValueStyle: React.CSSProperties = {
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 12,
  lineHeight: 1.8,
};

function tagStyle(color: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "3px 8px",
    borderRadius: 8,
    border: `1px solid ${color}33`,
    background: `${color}14`,
    color,
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.04em",
  };
}

function formatEndpoint(host: string | null | undefined, port: number | null | undefined): string {
  if (!host) return "Not published yet";
  return port ? `${host}:${port}` : host;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Never";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatLatency(value: number | null | undefined): string {
  if (typeof value !== "number") return "n/a";
  return `${value} ms`;
}

function connectionColor(state: SyncDeviceRuntimeState["connectionState"]): string {
  switch (state) {
    case "self":
      return COLORS.accent;
    case "connected":
      return COLORS.success;
    default:
      return COLORS.textMuted;
  }
}

function deviceConnectionLabel(device: SyncDeviceRuntimeState): string {
  switch (device.connectionState) {
    case "self":
      return "This desktop";
    case "connected":
      return "Connected";
    default:
      return "Offline";
  }
}

export function SyncDevicesSection() {
  const [status, setStatus] = useState<SyncRoleSnapshot | null>(null);
  const [devices, setDevices] = useState<SyncDeviceRuntimeState[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextStatus, nextDevices] = await Promise.all([
      window.ade.sync.getStatus(),
      window.ade.sync.listDevices(),
    ]);
    setStatus(nextStatus);
    setDevices(nextDevices);
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } catch (refreshError) {
        if (!cancelled) {
          setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const dispose = window.ade.sync.onEvent((event) => {
      if (event.type !== "sync-status" || cancelled) return;
      setStatus(event.snapshot);
      void window.ade.sync.listDevices().then((nextDevices) => {
        if (!cancelled) setDevices(nextDevices);
      }).catch(() => {});
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [refresh]);

  const runAction = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleSetPin = useCallback((pin: string) => runAction(async () => {
    await window.ade.sync.setPin(pin);
    setNotice("PIN updated.");
  }), [runAction]);

  const handleClearPin = useCallback(() => runAction(async () => {
    await window.ade.sync.clearPin();
    setNotice("PIN removed. Phones can no longer pair.");
  }), [runAction]);

  const handleRenameLocal = useCallback((name: string) => runAction(async () => {
    if (!name.trim()) throw new Error("Name cannot be empty.");
    await window.ade.sync.updateLocalDevice({ name: name.trim() });
    setNotice("Name updated.");
  }), [runAction]);

  const handleForgetDevice = useCallback((device: SyncDeviceRuntimeState) => runAction(async () => {
    await window.ade.sync.forgetDevice(device.deviceId);
    setNotice(device.connectionState === "connected" ? "Device revoked." : "Device removed.");
  }), [runAction]);

  const handleRetryDiscovery = useCallback(() => runAction(async () => {
    const nextStatus = await window.ade.sync.refreshDiscovery();
    setStatus(nextStatus);
    setNotice("Tailnet discovery retry started.");
  }), [runAction]);

  if (loading) {
    return <div style={helperTextStyle}>Loading sync status...</div>;
  }
  if (error && !status) {
    return <div style={{ ...helperTextStyle, color: COLORS.danger }}>Failed to load sync settings: {error}</div>;
  }
  if (!status) {
    return <div style={helperTextStyle}>Sync is unavailable for this project.</div>;
  }

  const peerCount = status.connectedPeers.length;
  const phones = devices.filter((device) => !device.isLocal && device.deviceType === "phone");
  const phonesConnected = phones.filter((d) => d.connectionState === "connected").length;
  const phonesOffline = phones.length - phonesConnected;
  const isLocalHost = status.role === "brain";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <StatusBar connected={peerCount > 0} peerCount={peerCount} />

      {isLocalHost ? (
        <PairPhoneCard
          qrPayloadText={status.pairingConnectInfo?.qrPayloadText ?? null}
          pin={status.pairingPin}
          pinConfigured={status.pairingPinConfigured}
          busy={busy}
          onSavePin={handleSetPin}
          onClearPin={handleClearPin}
        />
      ) : (
        <ViewerPairingNotice />
      )}

      <TailnetDiscoveryPanel
        status={status.tailnetDiscovery}
        busy={busy}
        isLocalHost={isLocalHost}
        onRetry={handleRetryDiscovery}
      />

      {notice ? <div style={{ ...helperTextStyle, color: COLORS.success }}>{notice}</div> : null}
      {error ? <div style={{ ...helperTextStyle, color: COLORS.danger }}>{error}</div> : null}

      <details style={detailBlockStyle}>
        <summary style={detailSummaryStyle}>
          <span>This computer</span>
          <span style={helperTextStyle}>
            {status.localDevice.name}
            {" "}&middot;{" "}
            {formatEndpoint(status.localDevice.lastHost, status.localDevice.lastPort ?? 8787)}
          </span>
        </summary>
        <div style={{ marginTop: 12 }}>
          <ThisComputerDetails
            localDevice={status.localDevice}
            busy={busy}
            onRename={handleRenameLocal}
          />
        </div>
      </details>

      <details style={detailBlockStyle}>
        <summary style={detailSummaryStyle}>
          <span>Phones</span>
          <span style={helperTextStyle}>
            {phones.length === 0
              ? "None paired"
              : `${phonesConnected} connected, ${phonesOffline} offline`}
          </span>
        </summary>
        <div style={{ marginTop: 12 }}>
          <PhonesList devices={phones} busy={busy} onForget={handleForgetDevice} />
        </div>
      </details>

      <details style={detailBlockStyle}>
        <summary style={detailSummaryStyle}>
          <span>Advanced</span>
          <span style={helperTextStyle}>Desktop linking &middot; host handoff</span>
        </summary>
        <div style={{ marginTop: 12 }}>
          <AdvancedSection status={status} busy={busy} runAction={runAction} />
        </div>
      </details>
    </div>
  );
}

function StatusBar({ connected, peerCount }: { connected: boolean; peerCount: number }) {
  const dotColor = connected ? COLORS.accent : COLORS.textMuted;
  let label: string;
  if (!connected) {
    label = "Offline - waiting for phones";
  } else if (peerCount === 1) {
    label = "Connected";
  } else {
    label = `Connected - ${peerCount} devices`;
  }
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 22, fontWeight: 700 }}>
        Sync
      </div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: dotColor,
            boxShadow: connected ? `0 0 8px ${COLORS.accent}55` : undefined,
          }}
        />
        <span style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 500 }}>
          {label}
        </span>
      </div>
    </div>
  );
}

function displayTailnetHost(status: SyncTailnetDiscoveryStatus): string {
  return `${status.serviceName.replace(/^svc:/, "")}:${status.servicePort}`;
}

function tailnetStatusCopy(status: SyncTailnetDiscoveryStatus, isLocalHost: boolean): {
  label: string;
  color: string;
  title: string;
  detail: string;
  canRetry: boolean;
} {
  const host = displayTailnetHost(status);
  switch (status.state) {
    case "published":
      return {
        label: "Published",
        color: COLORS.success,
        title: `Published as ${host}`,
        detail: "Phones on this tailnet can find this host automatically.",
        canRetry: true,
      };
    case "pending_approval":
      return {
        label: "Pending approval",
        color: COLORS.warning,
        title: `Waiting on ${host}`,
        detail: status.stderr || status.error || "Tailscale accepted the service, but tailnet policy may need admin approval.",
        canRetry: true,
      };
    case "publishing":
      return {
        label: "Publishing",
        color: COLORS.accent,
        title: `Publishing ${host}`,
        detail: status.target ? `Forwarding to ${status.target}.` : "Publishing tailnet discovery.",
        canRetry: false,
      };
    case "unavailable":
      return {
        label: "Tailscale not available",
        color: COLORS.warning,
        title: `Cannot publish ${host}`,
        detail: status.stderr || status.error || "Install or open Tailscale on this desktop, then retry.",
        canRetry: true,
      };
    case "failed":
      return {
        label: "Failed",
        color: COLORS.danger,
        title: `Could not publish ${host}`,
        detail: status.stderr || status.error || "Tailscale Serve returned an error.",
        canRetry: true,
      };
    default:
      return {
        label: "Not active",
        color: COLORS.textMuted,
        title: isLocalHost ? `Not published as ${host}` : "Only the host desktop publishes tailnet discovery",
        detail: status.error || "Start phone sync hosting to publish tailnet discovery.",
        canRetry: isLocalHost,
      };
  }
}

function TailnetDiscoveryPanel({
  status,
  busy,
  isLocalHost,
  onRetry,
}: {
  status: SyncTailnetDiscoveryStatus;
  busy: boolean;
  isLocalHost: boolean;
  onRetry: () => void;
}) {
  const copy = tailnetStatusCopy(status, isLocalHost);
  const disabled = busy || !copy.canRetry;
  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
              Tailnet discovery
            </span>
            <span style={tagStyle(copy.color)}>{copy.label}</span>
          </div>
          <div style={{ ...codeValueStyle, marginTop: 4 }}>{copy.title}</div>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={onRetry}
          style={outlineButton({
            height: 30,
            opacity: disabled ? 0.55 : 1,
            cursor: disabled ? "not-allowed" : "pointer",
          })}
        >
          Retry
        </button>
      </div>
      <div style={{ ...helperTextStyle, overflowWrap: "anywhere" }}>
        {copy.detail}
      </div>
      {status.updatedAt ? (
        <div style={helperTextStyle}>Updated {formatTimestamp(status.updatedAt)}</div>
      ) : null}
    </div>
  );
}

function PairPhoneCard({
  qrPayloadText,
  pin,
  pinConfigured,
  busy,
  onSavePin,
  onClearPin,
}: {
  qrPayloadText: string | null;
  pin: string | null;
  pinConfigured: boolean;
  busy: boolean;
  onSavePin: (pin: string) => Promise<void>;
  onClearPin: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!qrPayloadText) {
      setQrDataUrl(null);
      return;
    }
    void QRCode.toDataURL(qrPayloadText, {
      width: 240,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#F4F7FB", light: "#11151A" },
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    }).catch(() => {
      if (!cancelled) setQrDataUrl(null);
    });
    return () => {
      cancelled = true;
    };
  }, [qrPayloadText]);

  const pinMissing = !pinConfigured;
  const qrDimmed = pinMissing;

  const handleSave = async (value: string) => {
    setPinError(null);
    try {
      await onSavePin(value);
      setEditing(false);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={cardStyle({ display: "grid", gap: 16 })}>
      <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 15, fontWeight: 600 }}>
        Pair a phone
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "240px minmax(220px, 1fr)", gap: 20, alignItems: "center" }}>
        <div
          style={{
            position: "relative",
            width: 240,
            height: 240,
            borderRadius: 12,
            overflow: "hidden",
            border: `1px solid ${COLORS.border}`,
            background: "#11151A",
          }}
        >
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="Phone pairing QR code"
              style={{ display: "block", width: "100%", height: "100%", opacity: qrDimmed ? 0.25 : 1 }}
            />
          ) : (
            <div style={{ ...helperTextStyle, display: "grid", placeItems: "center", height: "100%" }}>
              Generating QR...
            </div>
          )}
          {qrDimmed ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                padding: 12,
                textAlign: "center",
                color: COLORS.textSecondary,
                fontFamily: SANS_FONT,
                fontSize: 12,
                fontWeight: 500,
                background: "rgba(10,10,14,0.55)",
              }}
            >
              Set a PIN to enable pairing
            </div>
          ) : null}
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {editing ? (
            <PinEditor
              initial={pin ?? ""}
              busy={busy}
              onCancel={() => { setEditing(false); setPinError(null); }}
              onSave={handleSave}
              error={pinError}
            />
          ) : pinMissing ? (
            <EmptyPinBlock onSet={() => { setPinError(null); setEditing(true); }} />
          ) : pin ? (
            <PinDisplay
              pin={pin}
              busy={busy}
              onChange={() => { setPinError(null); setEditing(true); }}
              onRemove={() => { void onClearPin(); }}
            />
          ) : (
            <SavedPinBlock
              busy={busy}
              onChange={() => { setPinError(null); setEditing(true); }}
              onRemove={() => { void onClearPin(); }}
            />
          )}
        </div>
      </div>

      <div style={helperTextStyle}>
        {pinMissing
          ? "No PIN set. Phones cannot pair."
          : pin
            ? "Scan on your phone and enter this PIN to pair."
            : "Scan on your phone and enter the saved PIN, or set a new one."}
      </div>
    </div>
  );
}

function ViewerPairingNotice() {
  return (
    <div style={cardStyle({ display: "grid", gap: 10 })}>
      <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 15, fontWeight: 600 }}>
        Phone pairing lives on the host
      </div>
      <div style={helperTextStyle}>
        Open Sync settings on the host desktop to set the phone PIN and show the QR code.
      </div>
    </div>
  );
}

function PinDisplay({
  pin,
  busy,
  onChange,
  onRemove,
}: {
  pin: string;
  busy: boolean;
  onChange: () => void;
  onRemove: () => void;
}) {
  const digits = pin.padEnd(6, " ").slice(0, 6).split("");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={LABEL_STYLE}>PIN</div>
      <div style={{ display: "flex", gap: 8 }}>
        {digits.map((digit, index) => (
          <div
            key={index}
            style={{
              width: 40,
              height: 48,
              borderRadius: 10,
              border: `1px solid ${COLORS.accentBorder}`,
              background: "rgba(167, 139, 250, 0.10)",
              display: "grid",
              placeItems: "center",
              color: COLORS.textPrimary,
              fontFamily: MONO_FONT,
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "0.02em",
            }}
          >
            {digit.trim() ? digit : ""}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={outlineButton()} disabled={busy} onClick={onChange}>
          Change
        </button>
        <button type="button" style={dangerButton()} disabled={busy} onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

function EmptyPinBlock({ onSet }: { onSet: () => void }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={LABEL_STYLE}>PIN</div>
      <div style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 13 }}>
        No PIN set yet.
      </div>
      <div>
        <button type="button" style={primaryButton()} onClick={onSet}>
          Set a 6-digit PIN
        </button>
      </div>
    </div>
  );
}

function SavedPinBlock({
  busy,
  onChange,
  onRemove,
}: {
  busy: boolean;
  onChange: () => void;
  onRemove: () => void;
}) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={LABEL_STYLE}>PIN</div>
      <div style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 13 }}>
        A PIN is saved. Set a new PIN if you need to show it again.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={outlineButton()} disabled={busy} onClick={onChange}>
          Set new PIN
        </button>
        <button type="button" style={dangerButton()} disabled={busy} onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

function PinEditor({
  initial,
  busy,
  onSave,
  onCancel,
  error,
}: {
  initial: string;
  busy: boolean;
  onSave: (pin: string) => Promise<void> | void;
  onCancel: () => void;
  error: string | null;
}) {
  const seed = useMemo(() => {
    const digits = (initial ?? "").replace(/\D/g, "").slice(0, 6);
    return Array.from({ length: 6 }, (_, i) => digits[i] ?? "");
  }, [initial]);
  const [values, setValues] = useState<string[]>(seed);
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    refs.current[0]?.focus();
    refs.current[0]?.select?.();
  }, []);

  const setDigit = (index: number, char: string) => {
    setValues((prev) => {
      const next = prev.slice();
      next[index] = char;
      return next;
    });
  };

  const handleChange = (index: number, raw: string) => {
    const digit = raw.replace(/\D/g, "").slice(-1);
    setDigit(index, digit);
    if (digit && index < 5) {
      refs.current[index + 1]?.focus();
      refs.current[index + 1]?.select?.();
    }
  };

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace") {
      if (!values[index] && index > 0) {
        event.preventDefault();
        refs.current[index - 1]?.focus();
        setDigit(index - 1, "");
      }
      return;
    }
    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      refs.current[index - 1]?.focus();
      return;
    }
    if (event.key === "ArrowRight" && index < 5) {
      event.preventDefault();
      refs.current[index + 1]?.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      attemptSave();
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!text) return;
    event.preventDefault();
    const next = Array.from({ length: 6 }, (_, i) => text[i] ?? "");
    setValues(next);
    const focusIdx = Math.min(text.length, 5);
    refs.current[focusIdx]?.focus();
    refs.current[focusIdx]?.select?.();
  };

  const complete = values.every((v) => v && /\d/.test(v));

  const attemptSave = () => {
    if (!complete || busy) return;
    void onSave(values.join(""));
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={LABEL_STYLE}>Set a 6-digit PIN</div>
      <div style={{ display: "flex", gap: 8 }}>
        {values.map((value, index) => {
          const isFocused = focusedIndex === index;
          const filled = Boolean(value);
          return (
            <input
              key={index}
              ref={(el) => { refs.current[index] = el; }}
              value={value}
              onChange={(event) => handleChange(index, event.target.value)}
              onKeyDown={(event) => handleKeyDown(index, event)}
              onPaste={handlePaste}
              onFocus={() => setFocusedIndex(index)}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={1}
              aria-label={`PIN digit ${index + 1}`}
              style={{
                width: 40,
                height: 48,
                textAlign: "center",
                fontFamily: MONO_FONT,
                fontSize: 22,
                fontWeight: 600,
                padding: 0,
                color: COLORS.textPrimary,
                background: filled
                  ? "rgba(167, 139, 250, 0.10)"
                  : "rgba(255, 255, 255, 0.06)",
                border: `1px solid ${
                  isFocused
                    ? COLORS.accent
                    : filled
                      ? COLORS.accentBorder
                      : "rgba(255, 255, 255, 0.18)"
                }`,
                borderRadius: 10,
                outline: "none",
                boxShadow: isFocused
                  ? `0 0 0 3px rgba(167, 139, 250, 0.18)`
                  : "none",
                transition: "border-color 120ms ease, box-shadow 120ms ease, background 120ms ease",
              }}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          style={primaryButton({ opacity: complete ? 1 : 0.5 })}
          disabled={!complete || busy}
          onClick={attemptSave}
        >
          Save PIN
        </button>
        <button type="button" style={outlineButton()} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error ? <div style={{ ...helperTextStyle, color: COLORS.danger }}>{error}</div> : null}
    </div>
  );
}

function ThisComputerDetails({
  localDevice,
  busy,
  onRename,
}: {
  localDevice: SyncDeviceRecord;
  busy: boolean;
  onRename: (name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState(localDevice.name);

  useEffect(() => {
    setName(localDevice.name);
  }, [localDevice.name]);

  const dirty = name.trim().length > 0 && name.trim() !== localDevice.name;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1fr) auto", gap: 12, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={LABEL_STYLE}>Name shown to phones</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={inputStyle}
            placeholder="This Mac"
          />
        </label>
        <button
          type="button"
          style={primaryButton({ opacity: dirty ? 1 : 0.5 })}
          disabled={busy || !dirty}
          onClick={() => void onRename(name)}
        >
          Save
        </button>
      </div>

      <div style={panelStyle}>
        <div style={LABEL_STYLE}>Network</div>
        <div style={codeValueStyle}>
          <div>Port: {localDevice.lastPort ?? 8787}</div>
          {localDevice.ipAddresses.length > 0 ? (
            <div>Addresses: {localDevice.ipAddresses.join(", ")}</div>
          ) : (
            <div>Addresses: not published yet</div>
          )}
          {localDevice.tailscaleIp ? <div>Tailscale: {localDevice.tailscaleIp}</div> : null}
        </div>
      </div>

      <div style={panelStyle}>
        <div style={LABEL_STYLE}>Device</div>
        <div style={codeValueStyle}>
          <div>Platform: {localDevice.platform}</div>
          <div>Type: {localDevice.deviceType}</div>
        </div>
      </div>
    </div>
  );
}

function PhonesList({
  devices,
  busy,
  onForget,
}: {
  devices: SyncDeviceRuntimeState[];
  busy: boolean;
  onForget: (device: SyncDeviceRuntimeState) => Promise<void> | void;
}) {
  if (devices.length === 0) {
    return <div style={helperTextStyle}>No phones paired yet.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {devices.map((device) => {
        const connected = device.connectionState === "connected";
        const pillColor = connectionColor(device.connectionState);
        return (
          <div
            key={device.deviceId}
            style={{
              border: `1px solid ${COLORS.border}`,
              borderRadius: 10,
              padding: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "grid", gap: 4, minWidth: 180 }}>
              <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600 }}>
                {device.name}
              </div>
              <div style={helperTextStyle}>
                {device.platform} &middot; {device.deviceType}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={tagStyle(pillColor)}>{deviceConnectionLabel(device)}</span>
              <div style={helperTextStyle}>
                {connected
                  ? `Latency ${formatLatency(device.latencyMs)}`
                  : `Last seen ${formatTimestamp(device.lastSeenAt)}`}
              </div>
              <button type="button" style={dangerButton()} disabled={busy} onClick={() => void onForget(device)}>
                {connected ? "Revoke" : "Remove"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AdvancedSection({
  status,
  busy,
  runAction,
}: {
  status: SyncRoleSnapshot;
  busy: boolean;
  runAction: (work: () => Promise<void>) => Promise<void>;
}) {
  const isLocalHost = status.role === "brain";

  const [connectHost, setConnectHost] = useState(status.client.savedDraft?.host ?? "");
  const [connectPort, setConnectPort] = useState(String(status.client.savedDraft?.port ?? 8787));
  const [connectToken, setConnectToken] = useState("");

  const handleConnect = useCallback(() => runAction(async () => {
    if (!connectHost.trim()) throw new Error("Enter the host address or IP.");
    const port = Number(connectPort);
    if (!Number.isFinite(port) || port <= 0) throw new Error("Enter a valid port.");
    if (!connectToken.trim()) throw new Error("Enter the bootstrap token from the host.");
    const draft: SyncDesktopConnectionDraft = {
      host: connectHost.trim(),
      port: Math.floor(port),
      token: connectToken.trim(),
    };
    await window.ade.sync.connectToBrain(draft);
  }), [connectHost, connectPort, connectToken, runAction]);

  const handleDisconnect = useCallback(() => runAction(async () => {
    await window.ade.sync.disconnectFromBrain();
  }), [runAction]);

  const handleTransfer = useCallback(() => runAction(async () => {
    await window.ade.sync.transferBrainToLocal();
  }), [runAction]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {isLocalHost && status.bootstrapToken ? (
        <div style={panelStyle}>
          <div style={LABEL_STYLE}>Host link details</div>
          <div style={codeValueStyle}>
            <div>Host: {status.localDevice.lastHost ?? "127.0.0.1"}</div>
            <div>Port: {status.localDevice.lastPort ?? 8787}</div>
            <div>Token: {status.bootstrapToken}</div>
          </div>
          <div style={helperTextStyle}>
            Use these details to link another desktop as a controller.
          </div>
        </div>
      ) : null}

      {!isLocalHost ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={LABEL_STYLE}>Link this desktop to a host</div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) 120px minmax(220px, 1fr)", gap: 10 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={LABEL_STYLE}>Host or IP</span>
              <input value={connectHost} onChange={(event) => setConnectHost(event.target.value)} style={inputStyle} placeholder="127.0.0.1" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={LABEL_STYLE}>Port</span>
              <input value={connectPort} onChange={(event) => setConnectPort(event.target.value)} style={inputStyle} placeholder="8787" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={LABEL_STYLE}>Bootstrap token</span>
              <input value={connectToken} onChange={(event) => setConnectToken(event.target.value)} style={inputStyle} placeholder="Paste host bootstrap token" />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" style={primaryButton()} disabled={busy} onClick={handleConnect}>
              Connect
            </button>
            {status.client.state === "connected" ? (
              <button type="button" style={outlineButton()} disabled={busy} onClick={handleDisconnect}>
                Disconnect
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {!isLocalHost ? (
        <div style={{ display: "grid", gap: 10, borderTop: `1px solid ${COLORS.border}`, paddingTop: 14 }}>
          <div style={LABEL_STYLE}>Move hosting to this desktop</div>
          <div style={helperTextStyle}>
            Host handoff does not move live processes. Running missions, chat turns, terminals, or managed
            processes must stop first.
          </div>
          <div>
            <button
              type="button"
              style={outlineButton({
                color: status.transferReadiness.ready ? COLORS.textPrimary : COLORS.textMuted,
                borderColor: status.transferReadiness.ready ? COLORS.accentBorder : COLORS.border,
              })}
              disabled={busy || !status.transferReadiness.ready}
              onClick={handleTransfer}
            >
              Make this desktop the host
            </button>
          </div>
          <div style={{ ...helperTextStyle, color: status.transferReadiness.ready ? COLORS.success : COLORS.warning }}>
            {status.transferReadiness.ready
              ? "This desktop can take over hosting now."
              : "Stop the blocking live work below before moving hosting."}
          </div>
          {status.transferReadiness.blockers.length > 0 ? (
            <div style={panelStyle}>
              <div style={LABEL_STYLE}>Blocking live work</div>
              <div style={{ display: "grid", gap: 8 }}>
                {status.transferReadiness.blockers.map((blocker) => (
                  <div key={`${blocker.kind}:${blocker.id}`}>
                    <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600 }}>
                      {blocker.label}
                    </div>
                    <div style={helperTextStyle}>{blocker.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
