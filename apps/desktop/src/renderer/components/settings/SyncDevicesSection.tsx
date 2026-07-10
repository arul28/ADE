import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check } from "@phosphor-icons/react";
import { QRCodeSVG } from "qrcode.react";
import { createPortal } from "react-dom";
import type {
  SyncAddressCandidate,
  SyncCloudRelayStatus,
  SyncDeviceRecord,
  SyncDeviceRuntimeState,
  SyncPeerDeviceType,
  SyncPairingConnectInfo,
  SyncRoleSnapshot,
  SyncTailnetDiscoveryStatus,
} from "../../../shared/types";
import { buildPairingQrPayload, encodePairingQrUrl } from "../../../shared/pairingQr";
import { publicAssetUrl } from "../onboarding/WelcomeVideoGate";
import { WEB_CLIENT_BASE_URL, buildWebClientPairUrl } from "../../../shared/webClientUrl";
import { openExternalUrl } from "../../lib/openExternal";
import { SettingsToggle } from "./settingsSectionUi";
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

export type SyncDevicesVariant = "all" | "phone" | "web";

function generateSixDigitPin(): string {
  const range = 1_000_000;
  const maxUnbiasedValue = Math.floor(0x1_0000_0000 / range) * range;
  const sample = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(sample);
  } while (sample[0] >= maxUnbiasedValue);
  return String(sample[0] % range).padStart(6, "0");
}

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

function deviceTypeLabel(deviceType: SyncPeerDeviceType): string {
  switch (deviceType) {
    case "desktop":
      return "Desktop";
    case "phone":
      return "Phone";
    case "vps":
      return "VPS";
    case "browser":
      return "Browser";
    case "unknown":
      return "Unknown";
  }
}

function formatEndpoint(host: string | null | undefined, port: number | null | undefined): string {
  if (!host) return "Not published yet";
  return port ? `${host}:${port}` : host;
}

function addressKindLabel(kind: SyncAddressCandidate["kind"]): string {
  switch (kind) {
    case "tailscale":
      return "Tailscale";
    case "lan":
      return "LAN";
    case "loopback":
      return "Loopback";
    case "saved":
      return "Saved";
    case "relay":
      return "ADE relay";
    default:
      return "Manual";
  }
}

function addressKindColor(kind: SyncAddressCandidate["kind"]): string {
  switch (kind) {
    case "tailscale":
      return COLORS.success;
    case "relay":
      return COLORS.accent;
    default:
      return COLORS.textMuted;
  }
}

function primaryPairingCandidate(connectInfo: SyncPairingConnectInfo | null): SyncAddressCandidate | null {
  const candidates = connectInfo?.addressCandidates ?? [];
  return candidates.find((candidate) => candidate.kind === "tailscale")
    ?? candidates.find((candidate) => candidate.kind === "lan")
    ?? candidates[0]
    ?? null;
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
      return "This machine";
    case "connected":
      return "Connected";
    default:
      return "Offline";
  }
}

export function SyncDevicesSection({ variant = "all" }: { variant?: SyncDevicesVariant } = {}) {
  const [status, setStatus] = useState<SyncRoleSnapshot | null>(null);
  const [devices, setDevices] = useState<SyncDeviceRuntimeState[]>([]);
  const [cloudRelay, setCloudRelay] = useState<SyncCloudRelayStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextStatus, nextDevices, nextCloudRelay] = await Promise.all([
      window.ade.sync.getStatus(),
      window.ade.sync.listDevices(),
      window.ade.sync.getCloudRelayStatus().catch(() => null),
    ]);
    setStatus(nextStatus);
    setDevices(nextDevices);
    setCloudRelay(nextCloudRelay);
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
    const refreshWhenVisible = () => {
      if (!cancelled) {
        void refresh().catch(() => {});
      }
    };
    const interval = window.setInterval(refreshWhenVisible, 5_000);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
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

  // Throwing variant used by the web pairing code's inline "Generate new PIN"
  // control so it can surface errors next to the button instead of at the
  // section level. The setter returns the authoritative snapshot, avoiding a
  // second refresh that could fail after the credential was already changed.
  const handleSetPinValue = useCallback(async (pin: string) => {
    const nextStatus = await window.ade.sync.setPin(pin);
    setStatus(nextStatus);
  }, []);

  const handleClearPin = useCallback(() => runAction(async () => {
    await window.ade.sync.clearPin();
    setNotice("PIN removed. Phones can no longer pair.");
  }), [runAction]);

  const handleGeneratePin = useCallback(() => runAction(async () => {
    await window.ade.sync.generatePin();
    setNotice("PIN generated.");
  }), [runAction]);

  const handleSetRuntimeName = useCallback((name: string) => runAction(async () => {
    const trimmed = name.trim();
    if (trimmed) {
      await window.ade.sync.setRuntimeName(trimmed);
      setNotice("Machine name updated.");
    } else {
      await window.ade.sync.clearRuntimeName();
      setNotice("Machine name cleared.");
    }
  }), [runAction]);

  const handleClearRuntimeName = useCallback(() => runAction(async () => {
    await window.ade.sync.clearRuntimeName();
    setNotice("Machine name cleared.");
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
    return <div style={helperTextStyle}>Phone sync is unavailable until ADE has a project to serve.</div>;
  }

  const peerType: "phone" | "browser" | null =
    variant === "phone" ? "phone" : variant === "web" ? "browser" : null;
  const connectedPeers = peerType
    ? status.connectedPeers.filter((peer) => peer.deviceType === peerType)
    : status.connectedPeers;
  const peerCount = connectedPeers.length;
  const phones = devices.filter((device) => !device.isLocal && device.deviceType === "phone");
  const phonesConnected = phones.filter((d) => d.connectionState === "connected").length;
  const phonesOffline = phones.length - phonesConnected;
  const browsers = devices.filter((device) => !device.isLocal && device.deviceType === "browser");
  const browsersConnected = browsers.filter((d) => d.connectionState === "connected").length;
  const browsersOffline = browsers.length - browsersConnected;
  const isLocalHost = status.runtimeRole === "host" || status.role === "brain";
  const hasTailscaleAddress = Boolean(status.localDevice.tailscaleIp);
  const showTailnetDiscovery = shouldShowTailnetDiscoveryPanel(status.tailnetDiscovery);

  // A "phone" surface keeps phone pairing, discovery, this-computer and the
  // phones list. A "web" surface keeps only the web client card, its relay row
  // and the web clients list. "all" (Settings > Sync) shows everything.
  const showPhone = variant === "all" || variant === "phone";
  const showWeb = variant === "all" || variant === "web";
  const onToggleCloudRelay = (enabled: boolean) => runAction(async () => {
    const next = await window.ade.sync.setCloudRelayEnabled(enabled);
    setCloudRelay(next);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <StatusBar
        connected={peerCount > 0}
        peerCount={peerCount}
        ready={isPhoneSyncReady(status)}
        readyLabel={variant === "web" ? "Ready - no web clients connected" : undefined}
      />

      {showPhone ? (
        isLocalHost ? (
          <PairPhoneCard
            connectInfo={status.pairingConnectInfo}
            pin={status.pairingPin}
            pinConfigured={status.pairingPinConfigured}
            runtimeName={status.runtimeName}
            busy={busy}
            cloudRelay={cloudRelay}
            onToggleCloudRelay={onToggleCloudRelay}
            onSavePin={handleSetPin}
            onGeneratePin={handleGeneratePin}
            onClearPin={handleClearPin}
            onSaveRuntimeName={handleSetRuntimeName}
            onClearRuntimeName={handleClearRuntimeName}
          />
        ) : (
          <ViewerPairingNotice />
        )
      ) : null}

      {showWeb && isLocalHost ? (
        <WebClientCard
          connectInfo={status.pairingConnectInfo}
          pinConfigured={status.pairingPinConfigured}
          pin={status.pairingPin}
          busy={busy}
          onSetPin={handleSetPinValue}
        />
      ) : null}

      {/* In "web" mode the relay lives standalone; in "all"/"phone" it renders
          inside the phone card so we do not duplicate the control. */}
      {showWeb && !showPhone && isLocalHost && cloudRelay ? (
        <CloudRelayRow
          cloudRelay={cloudRelay}
          busy={busy}
          onToggle={onToggleCloudRelay}
          description="Keeps web clients connected when no LAN or Tailscale route works. On by default; turn off to never route through the relay."
        />
      ) : null}

      {showPhone && showTailnetDiscovery ? (
        <TailnetDiscoveryPanel
          status={status.tailnetDiscovery}
          hasTailscaleAddress={hasTailscaleAddress}
          busy={busy}
          isLocalHost={isLocalHost}
          onRetry={handleRetryDiscovery}
        />
      ) : null}

      {notice ? <div style={{ ...helperTextStyle, color: COLORS.success }}>{notice}</div> : null}
      {error ? <div style={{ ...helperTextStyle, color: COLORS.danger }}>{error}</div> : null}

      {showPhone ? (
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
      ) : null}

      {showPhone ? (
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
      ) : null}

      {showWeb ? (
        <details style={detailBlockStyle}>
          <summary style={detailSummaryStyle}>
            <span>Web clients</span>
            <span style={helperTextStyle}>
              {browsers.length === 0
                ? "None paired"
                : `${browsersConnected} connected, ${browsersOffline} offline`}
            </span>
          </summary>
          <div style={{ marginTop: 12 }}>
            <BrowsersList devices={browsers} busy={busy} onForget={handleForgetDevice} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function CloudRelayRow({
  cloudRelay,
  busy,
  onToggle,
  description = "Keeps your phone connected when no LAN or Tailscale route works. On by default; turn off to never route through the relay.",
}: {
  cloudRelay: SyncCloudRelayStatus;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  description?: string;
}) {
  return (
    <div style={{ ...panelStyle, gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center" }}>
        <div style={{ display: "grid", gap: 4 }}>
          <div style={LABEL_STYLE}>ADE relay</div>
          <div style={helperTextStyle}>
            {description}
          </div>
        </div>
        <SettingsToggle
          id="sync-cloud-relay-toggle"
          checked={cloudRelay.enabled}
          disabled={busy}
          onChange={onToggle}
        />
      </div>
    </div>
  );
}

function isPhoneSyncReady(status: SyncRoleSnapshot): boolean {
  return (status.runtimeRole === "host" || status.role === "brain") && Boolean(status.pairingConnectInfo);
}

function StatusBar({
  connected,
  peerCount,
  ready,
  readyLabel = "Ready - no phones connected",
}: {
  connected: boolean;
  peerCount: number;
  ready: boolean;
  readyLabel?: string;
}) {
  let dotColor: string;
  if (connected) {
    dotColor = COLORS.accent;
  } else if (ready) {
    dotColor = COLORS.textMuted;
  } else {
    dotColor = COLORS.warning;
  }
  let label: string;
  if (!connected) {
    label = ready ? readyLabel : "Unavailable";
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
            boxShadow: connected ? `0 0 8px color-mix(in srgb, var(--color-accent) 55%, transparent)` : undefined,
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

function tailnetRequiresTaggedNode(status: SyncTailnetDiscoveryStatus): boolean {
  return /service hosts must be tagged nodes/i.test(
    [status.stderr, status.error].filter(Boolean).join("\n"),
  );
}

function shouldShowTailnetDiscoveryPanel(status: SyncTailnetDiscoveryStatus): boolean {
  if (status.state === "disabled" && !status.error && !status.stderr) return false;
  return true;
}

function tailnetStatusCopy(status: SyncTailnetDiscoveryStatus, args: {
  isLocalHost: boolean;
  hasTailscaleAddress: boolean;
}): {
  label: string;
  color: string;
  title: string;
  detail: string;
  canRetry: boolean;
} {
  const host = displayTailnetHost(status);
  if (tailnetRequiresTaggedNode(status)) {
    if (args.hasTailscaleAddress) {
      return {
        label: "Direct Tailscale ready",
        color: COLORS.success,
        title: "Phones can connect through Tailscale",
        detail: [
          "The machine address list includes this machine's normal Tailscale address, so pairing can work without extra setup.",
          "Only the optional stable shortcut is blocked by Tailscale policy.",
        ].join(" "),
        canRetry: false,
      };
    }
    return {
      label: "Tailscale setup needed",
      color: COLORS.warning,
      title: "Automatic phone discovery is blocked",
      detail: [
        "ADE tried to create a stable Tailscale address that phones can find automatically.",
        "Tailscale only allows that on computers configured by a tailnet admin for service hosting.",
        "Manual address pairing still works; retry after service hosting is enabled for this machine.",
      ].join(" "),
      canRetry: true,
    };
  }
  switch (status.state) {
    case "published":
      return {
        label: "Published",
        color: COLORS.success,
        title: `Published as ${host}`,
        detail: "Phones on this tailnet can find this machine automatically.",
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
        detail: status.stderr || status.error || "Install or open Tailscale on this machine, then retry.",
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
        title: args.isLocalHost ? `Not published as ${host}` : "Only the host runtime publishes tailnet discovery",
        detail: status.error || "Start the ADE runtime to publish tailnet discovery.",
        canRetry: false,
      };
  }
}

function TailnetDiscoveryPanel({
  status,
  hasTailscaleAddress,
  busy,
  isLocalHost,
  onRetry,
}: {
  status: SyncTailnetDiscoveryStatus;
  hasTailscaleAddress: boolean;
  busy: boolean;
  isLocalHost: boolean;
  onRetry: () => void;
}) {
  const copy = tailnetStatusCopy(status, { isLocalHost, hasTailscaleAddress });
  const disabled = busy || !copy.canRetry;
  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
              Automatic discovery
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
  connectInfo,
  pin,
  pinConfigured,
  runtimeName,
  busy,
  cloudRelay,
  onToggleCloudRelay,
  onSavePin,
  onGeneratePin,
  onClearPin,
  onSaveRuntimeName,
  onClearRuntimeName,
}: {
  connectInfo: SyncPairingConnectInfo | null;
  pin: string | null;
  pinConfigured: boolean;
  runtimeName: string | null;
  busy: boolean;
  cloudRelay: SyncCloudRelayStatus | null;
  onToggleCloudRelay: (enabled: boolean) => void;
  onSavePin: (pin: string) => Promise<void>;
  onGeneratePin: () => Promise<void>;
  onClearPin: () => Promise<void>;
  onSaveRuntimeName: (name: string) => Promise<void>;
  onClearRuntimeName: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const pinMissing = !pinConfigured;
  const primaryCandidate = primaryPairingCandidate(connectInfo);
  const primaryEndpoint = formatEndpoint(primaryCandidate?.host, connectInfo?.port ?? 8787);
  const hasAddresses = (connectInfo?.addressCandidates.length ?? 0) > 0;

  const handleSave = async (value: string) => {
    setPinError(null);
    try {
      await onSavePin(value);
      setEditing(false);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : String(err));
    }
  };

  const pinSection = editing ? (
    <PinEditor
      initial={pin ?? ""}
      busy={busy}
      onCancel={() => { setEditing(false); setPinError(null); }}
      onSave={handleSave}
      error={pinError}
    />
  ) : pinMissing ? (
    <EmptyPinBlock
      busy={busy}
      onSet={() => { setPinError(null); setEditing(true); }}
      onGenerate={() => { void onGeneratePin(); }}
    />
  ) : pin ? (
    <PinDisplay
      pin={pin}
      busy={busy}
      onChange={() => { setPinError(null); setEditing(true); }}
      onGenerate={() => { void onGeneratePin(); }}
      onRemove={() => { void onClearPin(); }}
    />
  ) : (
    <SavedPinBlock
      busy={busy}
      onChange={() => { setPinError(null); setEditing(true); }}
      onGenerate={() => { void onGeneratePin(); }}
      onRemove={() => { void onClearPin(); }}
    />
  );

  return (
    <div style={cardStyle({ display: "grid", gap: 16 })}>
      <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 15, fontWeight: 600 }}>
        Pair a phone
      </div>

      {hasAddresses ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr)",
            gap: 16,
            alignItems: "start",
            minWidth: 0,
          }}
        >
          <PairQrPanel connectInfo={connectInfo as SyncPairingConnectInfo} />
          <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
            <div style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 13 }}>
              Scan with the ADE app to pair.
            </div>
            {pinSection}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <div style={helperTextStyle}>No machine addresses are published yet.</div>
          {pinSection}
        </div>
      )}

      <HostNameEditor
        runtimeName={runtimeName}
        busy={busy}
        onSave={onSaveRuntimeName}
        onClear={onClearRuntimeName}
      />

      {cloudRelay ? (
        <CloudRelayRow cloudRelay={cloudRelay} busy={busy} onToggle={onToggleCloudRelay} />
      ) : null}

      <div style={{ display: "grid", gap: 10 }}>
        <button
          type="button"
          style={outlineButton({ justifySelf: "start", height: 30 })}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? "Hide connection details" : "Connection details"}
        </button>
        {detailsOpen ? (
          <div style={{ ...panelStyle, gap: 10 }}>
            <div style={LABEL_STYLE}>Machine address</div>
            <div style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 15, overflowWrap: "break-word" }}>
              {primaryEndpoint}
            </div>
            <div style={helperTextStyle}>
              Choose this machine in ADE mobile discovery. If it does not appear, enter one of these addresses manually.
            </div>
            <EndpointList connectInfo={connectInfo} />
          </div>
        ) : null}
      </div>

      <div style={helperTextStyle}>
        {pinMissing
          ? "No PIN set. Phones cannot pair."
          : pin
            ? "Scan the QR, then enter this PIN on your phone to pair."
            : "Scan the QR, then enter the saved PIN on your phone, or set a new one."}
      </div>
    </div>
  );
}

// Same ADE-branded treatment as the welcome modal's TestFlight QR: white tile,
// accent-tinted border, excavated ADE mark in the center (which is why the
// error-correction level is H). Shared by phone and web-client pairing panels.
function QrCodeSvgTile({ value, title, size }: { value: string; title: string; size: number }) {
  const iconSize = Math.round(size * (32 / 148));
  return (
    <QRCodeSVG
      value={value}
      size={size}
      level="H"
      marginSize={1}
      bgColor="#FFFFFF"
      fgColor="#111827"
      title={title}
      imageSettings={{
        src: publicAssetUrl("welcome/ade-icon.webp"),
        height: iconSize,
        width: iconSize,
        excavate: true,
      }}
    />
  );
}

function QrCodeBox({ value, title }: { value: string; title: string }) {
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!expanded) return;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setExpanded(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        dialogRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
      triggerRef.current?.focus();
    };
  }, [expanded]);

  return (
    <>
      <div
        ref={triggerRef}
        role="button"
        tabIndex={0}
        title="Click to enlarge"
        onClick={() => setExpanded(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded(true);
          }
        }}
        style={{ ...panelStyle, gap: 0, padding: 12, placeItems: "center", cursor: "pointer" }}
      >
        <div
          style={{
            display: "inline-flex",
            padding: 14,
            borderRadius: 14,
            background: "#FFFFFF",
            border: "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 30%, transparent)",
          }}
        >
          <QrCodeSvgTile value={value} title={title} size={148} />
        </div>
      </div>
      {expanded && typeof document !== "undefined"
        ? createPortal(
          <div
            onClick={() => setExpanded(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 200,
              display: "grid",
              placeItems: "center",
              background: "rgba(0,0,0,0.62)",
            }}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-label={title}
              tabIndex={-1}
              onClick={(event) => event.stopPropagation()}
              style={{
                display: "inline-flex",
                padding: 22,
                borderRadius: 20,
                background: "#FFFFFF",
                border: "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 30%, transparent)",
                boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
                outline: "none",
              }}
            >
              <QrCodeSvgTile value={value} title={title} size={360} />
            </div>
          </div>,
          document.body,
        )
        : null}
    </>
  );
}

function PairQrPanel({ connectInfo }: { connectInfo: SyncPairingConnectInfo }) {
  const qrUrl = useMemo(
    () => encodePairingQrUrl(buildPairingQrPayload({ connectInfo })),
    [connectInfo],
  );
  return <QrCodeBox value={qrUrl} title="Pairing QR code" />;
}

function WebClientCard({
  connectInfo,
  pinConfigured,
  pin,
  busy,
  onSetPin,
}: {
  connectInfo: SyncPairingConnectInfo | null;
  pinConfigured: boolean;
  pin: string | null;
  busy: boolean;
  onSetPin: (pin: string) => Promise<void>;
}) {
  const hasAddresses = (connectInfo?.addressCandidates.length ?? 0) > 0;
  const pinMissing = !pinConfigured;
  const pinHidden = pinConfigured && !pin;
  // The hidden-PIN case is handled inline by the pairing code block below, so
  // the card-level helper stays terse and only covers the other states.
  let pairingHelpText = "Open the link, enter the pairing code in the browser, and the browser pairs to this machine.";
  if (pinMissing) {
    pairingHelpText = "No PIN set. Browsers cannot pair. Set a PIN in the phone pairing section.";
  } else if (pinHidden) {
    pairingHelpText = "";
  }

  return (
    <div style={cardStyle({ display: "grid", gap: 16 })}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 15, fontWeight: 600 }}>
          Web client
        </div>
        <button
          type="button"
          style={outlineButton({ height: 30 })}
          onClick={() => openExternalUrl(WEB_CLIENT_BASE_URL)}
        >
          Open in browser
        </button>
      </div>

      {hasAddresses ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr)",
            gap: 16,
            alignItems: "start",
            minWidth: 0,
          }}
        >
          <WebPairQrPanel connectInfo={connectInfo as SyncPairingConnectInfo} />
          <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
            <div style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 13 }}>
              Scan the QR, or open the pairing link in a browser to pair.
            </div>
            <WebPairLink connectInfo={connectInfo as SyncPairingConnectInfo} />
            <WebPairCode pin={pin} pinConfigured={pinConfigured} busy={busy} onSetPin={onSetPin} />
          </div>
        </div>
      ) : (
        <div style={helperTextStyle}>No machine addresses are published yet.</div>
      )}

      {pairingHelpText ? <div style={helperTextStyle}>{pairingHelpText}</div> : null}
    </div>
  );
}

function flashHighlightStyle(active: boolean): React.CSSProperties {
  return {
    transition: "background 600ms ease, color 600ms ease",
    borderRadius: 6,
    background: active
      ? "color-mix(in srgb, var(--color-accent, #A78BFA) 22%, transparent)"
      : "transparent",
    color: active ? COLORS.textPrimary : undefined,
  };
}

function CopiedGlyphLabel({ copied, idle }: { copied: boolean; idle: string }) {
  if (!copied) return <>{idle}</>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <Check size={12} weight="bold" />
      Copied
    </span>
  );
}

function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const [flash, setFlash] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current);
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  const showFeedback = useCallback(() => {
    if (!mountedRef.current) return;
    if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current);
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    setCopied(true);
    setFlash(true);
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null;
      setCopied(false);
    }, 1500);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setFlash(false);
    }, 600);
  }, []);

  return { copied, flash, showFeedback };
}

function WebPairCode({
  pin,
  pinConfigured,
  busy,
  onSetPin,
}: {
  pin: string | null;
  pinConfigured: boolean;
  busy: boolean;
  onSetPin: (pin: string) => Promise<void>;
}) {
  const { copied, flash, showFeedback } = useCopyFeedback();
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const handleCopy = useCallback(async () => {
    if (!pin) return;
    try {
      const writeClipboardText = window.ade?.app?.writeClipboardText;
      if (!writeClipboardText) return;
      await writeClipboardText(pin);
      showFeedback();
    } catch {
      // Clipboard may be unavailable; the code stays visible to copy manually.
    }
  }, [pin, showFeedback]);

  const handleGenerate = useCallback(async () => {
    if (busy || generating) return;
    setGenError(null);
    setGenerating(true);
    try {
      await onSetPin(generateSixDigitPin());
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }, [busy, generating, onSetPin]);

  const hiddenPin = pinConfigured && !pin;

  return (
    <div style={{ ...panelStyle, gap: 8 }}>
      <div style={LABEL_STYLE}>Pairing code</div>
      <div
        style={{
          ...codeValueStyle,
          fontSize: 18,
          letterSpacing: "0.32em",
          fontVariantNumeric: "tabular-nums",
          alignSelf: "start",
          padding: "0 4px",
          ...flashHighlightStyle(flash),
        }}
      >
        {pin ? pin : pinConfigured ? "••••••" : "Not set"}
      </div>
      {hiddenPin ? (
        <>
          <button
            type="button"
            style={outlineButton({ justifySelf: "start", height: 30, opacity: busy || generating ? 0.6 : 1 })}
            onClick={() => void handleGenerate()}
            disabled={busy || generating}
          >
            {generating ? "Generating…" : "Generate new PIN"}
          </button>
          <div style={helperTextStyle}>Existing PIN still pairs if you know it.</div>
        </>
      ) : (
        <button
          type="button"
          style={outlineButton({ justifySelf: "start", height: 30 })}
          onClick={() => void handleCopy()}
          disabled={!pin}
          title={pin ? undefined : "Set a PIN in the phone pairing section to enable copy."}
        >
          <CopiedGlyphLabel copied={copied} idle="Copy code" />
        </button>
      )}
      {genError ? <div style={{ ...helperTextStyle, color: COLORS.danger }}>{genError}</div> : null}
    </div>
  );
}

function WebPairQrPanel({ connectInfo }: { connectInfo: SyncPairingConnectInfo }) {
  const qrUrl = useMemo(
    () => buildWebClientPairUrl(buildPairingQrPayload({ connectInfo })),
    [connectInfo],
  );
  return <QrCodeBox value={qrUrl} title="Web client pairing QR code" />;
}

function WebPairLink({ connectInfo }: { connectInfo: SyncPairingConnectInfo }) {
  const url = useMemo(
    () => buildWebClientPairUrl(buildPairingQrPayload({ connectInfo })),
    [connectInfo],
  );
  const { copied, flash, showFeedback } = useCopyFeedback();

  const handleCopy = useCallback(async () => {
    try {
      const writeClipboardText = window.ade?.app?.writeClipboardText;
      if (!writeClipboardText) return;
      await writeClipboardText(url);
      showFeedback();
    } catch {
      // Clipboard may be unavailable; leave the link visible to copy manually.
    }
  }, [showFeedback, url]);

  return (
    <div style={{ ...panelStyle, gap: 8 }}>
      <div style={LABEL_STYLE}>Pairing link</div>
      <div
        style={{
          ...codeValueStyle,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          padding: "0 4px",
          ...flashHighlightStyle(flash),
        }}
        title={url}
      >
        {url}
      </div>
      <button
        type="button"
        style={outlineButton({ justifySelf: "start", height: 30 })}
        onClick={() => void handleCopy()}
      >
        <CopiedGlyphLabel copied={copied} idle="Copy link" />
      </button>
    </div>
  );
}

function HostNameEditor({
  runtimeName,
  busy,
  onSave,
  onClear,
}: {
  runtimeName: string | null;
  busy: boolean;
  onSave: (name: string) => Promise<void> | void;
  onClear: () => Promise<void> | void;
}) {
  const [name, setName] = useState(runtimeName ?? "");

  useEffect(() => {
    setName(runtimeName ?? "");
  }, [runtimeName]);

  const trimmed = name.trim();
  const current = (runtimeName ?? "").trim();
  const dirty = trimmed !== current;

  return (
    <div style={{ ...panelStyle, gap: 10 }}>
      <div style={LABEL_STYLE}>Name this machine</div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) auto", gap: 8, alignItems: "center" }}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          style={inputStyle}
          placeholder="e.g. MacBook"
          disabled={busy}
        />
        <button
          type="button"
          style={primaryButton({ opacity: busy || !dirty ? 0.5 : 1 })}
          disabled={busy || !dirty}
          onClick={() => void onSave(name)}
        >
          Save
        </button>
      </div>
      <div style={helperTextStyle}>Name this machine for easy identification</div>
      {current ? (
        <button
          type="button"
          style={outlineButton({ justifySelf: "start" })}
          disabled={busy}
          onClick={() => void onClear()}
        >
          Clear name
        </button>
      ) : null}
    </div>
  );
}

function EndpointList({ connectInfo }: { connectInfo: SyncPairingConnectInfo | null }) {
  const candidates = connectInfo?.addressCandidates ?? [];
  if (candidates.length === 0) {
    return <div style={helperTextStyle}>No machine addresses are published yet.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {candidates.map((candidate) => (
        <div
          key={`${candidate.kind}:${candidate.host}`}
          style={{
            display: "grid",
            gridTemplateColumns: "76px minmax(0, 1fr)",
            gap: 8,
            alignItems: "baseline",
            minWidth: 0,
          }}
        >
          <span style={tagStyle(addressKindColor(candidate.kind))}>
            {addressKindLabel(candidate.kind)}
          </span>
          <span style={{ ...codeValueStyle, overflowWrap: "break-word" }}>
            {formatEndpoint(candidate.host, connectInfo?.port ?? 8787)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ViewerPairingNotice() {
  return (
    <div style={cardStyle({ display: "grid", gap: 10 })}>
      <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 15, fontWeight: 600 }}>
        Phone pairing lives on the host runtime
      </div>
      <div style={helperTextStyle}>
        Open Sync settings on the machine running the host runtime to set the phone PIN and copy a machine address.
      </div>
    </div>
  );
}

function PinDisplay({
  pin,
  busy,
  onChange,
  onGenerate,
  onRemove,
}: {
  pin: string;
  busy: boolean;
  onChange: () => void;
  onGenerate: () => void;
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
        <button type="button" style={outlineButton()} disabled={busy} onClick={onGenerate}>
          Generate
        </button>
        <button type="button" style={dangerButton()} disabled={busy} onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

function EmptyPinBlock({
  busy,
  onSet,
  onGenerate,
}: {
  busy: boolean;
  onSet: () => void;
  onGenerate: () => void;
}) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={LABEL_STYLE}>PIN</div>
      <div style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 13 }}>
        No PIN set yet.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={primaryButton()} disabled={busy} onClick={onGenerate}>
          Generate PIN
        </button>
        <button type="button" style={outlineButton()} disabled={busy} onClick={onSet}>
          Set manually
        </button>
      </div>
    </div>
  );
}

function SavedPinBlock({
  busy,
  onChange,
  onGenerate,
  onRemove,
}: {
  busy: boolean;
  onChange: () => void;
  onGenerate: () => void;
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
        <button type="button" style={outlineButton()} disabled={busy} onClick={onGenerate}>
          Generate
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
            placeholder="This machine"
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
          <div>Type: {deviceTypeLabel(localDevice.deviceType)}</div>
        </div>
      </div>
    </div>
  );
}

function PairedDeviceRow({
  device,
  busy,
  onForget,
}: {
  device: SyncDeviceRuntimeState;
  busy: boolean;
  onForget: (device: SyncDeviceRuntimeState) => Promise<void> | void;
}) {
  const connected = device.connectionState === "connected";
  const pillColor = connectionColor(device.connectionState);
  return (
    <div
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
          {device.platform} &middot; {deviceTypeLabel(device.deviceType)}
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
      {devices.map((device) => (
        <PairedDeviceRow key={device.deviceId} device={device} busy={busy} onForget={onForget} />
      ))}
    </div>
  );
}

function BrowsersList({
  devices,
  busy,
  onForget,
}: {
  devices: SyncDeviceRuntimeState[];
  busy: boolean;
  onForget: (device: SyncDeviceRuntimeState) => Promise<void> | void;
}) {
  if (devices.length === 0) {
    return <div style={helperTextStyle}>No browsers paired yet.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {devices.map((device) => (
        <PairedDeviceRow key={device.deviceId} device={device} busy={busy} onForget={onForget} />
      ))}
    </div>
  );
}
