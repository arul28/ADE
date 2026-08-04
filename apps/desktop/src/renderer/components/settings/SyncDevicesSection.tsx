import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  Check,
  Cloud,
  CloudSlash,
  Globe,
  Laptop,
} from "@phosphor-icons/react";
import { accountDirectorySummary } from "./accountDirectorySummary";
import { QRCodeSVG } from "qrcode.react";
import { createPortal } from "react-dom";
import { isBrainAccountSessionFailure } from "../../../shared/types";
import type {
  SyncDeviceRuntimeState,
  SyncPeerDeviceType,
  SyncPairingConnectInfo,
  SyncRoleSnapshot,
} from "../../../shared/types";
import { buildPairingQrPayload, encodePairingQrUrl } from "../../../shared/pairingQr";
import { publicAssetUrl } from "../onboarding/WelcomeVideoGate";
import { WEB_CLIENT_BASE_URL } from "../../../shared/webClientUrl";
import {
  isLocalReleaseBuildOutputError,
  isProjectRegistrationRequiredError,
} from "../../../shared/runtimeErrors";
import { openExternalUrl } from "../../lib/openExternal";
import { useBrainRepair } from "../../hooks/useBrainRepair";
import { BrainRepairButton } from "./BrainRepairButton";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
  dangerButton,
  inlineBadge,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import type { SyncConnections } from "./useSyncConnections";

export { useSyncConnections, type SyncConnections } from "./useSyncConnections";

const helperTextStyle: React.CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 12,
  lineHeight: 1.5,
};

/** Prompt shown before revoking a device; the caller resolves true to proceed. */
export type RevokeConfirm = (args: {
  name: string;
  connected: boolean;
}) => Promise<boolean>;

const detailBlockStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 12,
  padding: 14,
  background: "rgba(255,255,255,0.015)",
};

const panelStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 10,
  padding: 12,
  display: "grid",
  gap: 6,
};

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

function connectionLoadGuidance(error: string): string {
  if (isLocalReleaseBuildOutputError(error)) {
    return "Install this ADE build in Applications, reopen it, then try again.";
  }
  if (isProjectRegistrationRequiredError(error)) {
    return "Open a project in ADE, then try again.";
  }
  return "Restart ADE, then try again.";
}

export function isSyncHost(status: SyncRoleSnapshot): boolean {
  return status.runtimeRole === "host" || status.role === "brain";
}

// ---------------------------------------------------------------------------
// This-Mac card — persistent header block above the Connections tabs.
// ---------------------------------------------------------------------------

function platformLabel(platform: string | undefined): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "this computer";
  }
}

// Which of the three inbound routes are actually reachable right now. Unknown or
// down routes are omitted so the line only ever advertises a working path.
function reachableRouteLabels(status: SyncRoleSnapshot): string[] {
  const routes: string[] = [];
  const health = status.routeHealth;
  if (health?.listener?.listenerBound && health.listener.loopbackAdeValidated) {
    routes.push("Wi-Fi");
  }
  if (health?.tailscale?.tailscaleReachable) {
    routes.push("Tailscale");
  }
  if (
    health?.relay?.skipReason == null &&
    health?.relay?.relayControlConnected &&
    health?.relay?.relayBridgeValidated
  ) {
    routes.push("Relay");
  }
  return routes;
}

// One-shot fetch of the local build/platform for the This-Mac detail line.
function useAppInfoLine(): { version: string; platform: string } | null {
  const [info, setInfo] = useState<{ version: string; platform: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.ade?.app
      ?.getInfo?.()
      ?.then((next) => {
        if (!cancelled && next) {
          setInfo({ version: next.appVersion, platform: platformLabel(next.platform) });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}

export function ThisMacCard({
  sync,
  accountSignedIn,
}: {
  sync: SyncConnections;
  accountSignedIn: boolean;
}) {
  const { status, busy, error, notice, isRemoteBound, boundMachineName } = sync;
  const appInfo = useAppInfoLine();
  // Restarting the brain is the fix when it cannot read the stored account
  // session; re-read the snapshot once it settles so the banner clears.
  const repair = useBrainRepair(sync.refresh);

  if (sync.loading) {
    return <div style={helperTextStyle}>Getting connection details…</div>;
  }
  if (error && !status) {
    return (
      <div style={{ ...detailBlockStyle, display: "grid", gap: 10 }}>
        <div style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
          Couldn't load connection details
        </div>
        <div style={helperTextStyle}>{connectionLoadGuidance(error)}</div>
        <button
          type="button"
          onClick={sync.retryInitialLoad}
          style={outlineButton({ width: "fit-content", height: 30, padding: "0 11px" })}
        >
          Try again
        </button>
      </div>
    );
  }
  if (!status) {
    return <div style={helperTextStyle}>Open a project in ADE before connecting another device.</div>;
  }

  const host = isSyncHost(status);
  const machineName = status.runtimeName?.trim() || status.localDevice.name || "This Mac";
  const acceptsConnections = acceptsConnectionsState(status, host);
  const routeLabels = reachableRouteLabels(status);
  const directorySummary = accountDirectorySummary(status, accountSignedIn);
  // A brain-side unreadable account session is the one directory failure a
  // restart clears — same test RemoteTargetList runs on its publish health.
  const showRepair = accountSignedIn
    && isBrainAccountSessionFailure(status.routeHealth?.accountDirectory?.state)
    && repair.available;

  return (
    <div style={{ ...detailBlockStyle, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            borderRadius: 9,
            flexShrink: 0,
            background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
            border: `1px solid ${COLORS.accentBorder}`,
          }}
        >
          <Laptop size={17} weight="duotone" color={COLORS.accent} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span
              style={{
                color: COLORS.textPrimary,
                fontFamily: SANS_FONT,
                fontSize: 14,
                fontWeight: 700,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {machineName}
            </span>
            <span style={inlineBadge(COLORS.accent, { fontSize: 10, padding: "2px 7px", flexShrink: 0 })}>
              This Mac
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
            {accountSignedIn ? (
              <Cloud
                size={13}
                weight="fill"
                color={directorySummary.healthy ? COLORS.accent : COLORS.warning}
                style={{ flexShrink: 0 }}
              />
            ) : (
              <CloudSlash size={13} weight="regular" color={COLORS.textMuted} style={{ flexShrink: 0 }} />
            )}
            <span
              style={{
                ...helperTextStyle,
                lineHeight: 1.35,
                color: directorySummary.healthy || !accountSignedIn
                  ? helperTextStyle.color
                  : COLORS.warning,
              }}
            >
              {directorySummary.label}
            </span>
            {showRepair ? <BrainRepairButton repair={repair} height={24} /> : null}
          </div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: SANS_FONT,
          fontSize: 12,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            flexShrink: 0,
            background: acceptsConnections.ready ? COLORS.success : COLORS.warning,
          }}
        />
        <span style={{ color: acceptsConnections.ready ? COLORS.textSecondary : COLORS.warning }}>
          {acceptsConnections.label}
        </span>
      </div>

      {(host && routeLabels.length > 0) || appInfo ? (
        <div style={{ display: "grid", gap: 3, paddingLeft: 16, marginTop: -6 }}>
          {host && routeLabels.length > 0 ? (
            <div style={{ ...helperTextStyle, lineHeight: 1.4 }}>
              Reachable via {routeLabels.join(" · ")}
            </div>
          ) : null}
          {appInfo ? (
            <div style={{ ...helperTextStyle, lineHeight: 1.4 }}>
              ADE {appInfo.version} · {appInfo.platform}
            </div>
          ) : null}
        </div>
      ) : null}

      {host ? (
        isRemoteBound ? (
          <PinManagerRemoteNote
            pin={status.pairingPin}
            pinConfigured={status.pairingPinConfigured}
            boundMachineName={boundMachineName}
          />
        ) : (
          <PinManager
            pin={status.pairingPin}
            pinConfigured={status.pairingPinConfigured}
            busy={busy}
            onSetPin={sync.setPinValue}
            onGenerate={sync.generatePin}
            onRemove={sync.clearPin}
          />
        )
      ) : null}

      {notice ? <div style={{ ...helperTextStyle, color: COLORS.success }}>{notice}</div> : null}
      {error && status ? (
        <div style={{ ...helperTextStyle, color: COLORS.danger }}>
          That did not work. Check that ADE is running, then try again.
        </div>
      ) : null}
    </div>
  );
}

function acceptsConnectionsState(
  status: SyncRoleSnapshot,
  host: boolean,
): { ready: boolean; label: string } {
  if (!host) {
    return { ready: false, label: "This Mac connects through your main Mac" };
  }
  if (!status.pairingConnectInfo) {
    return { ready: false, label: "Starting up — connection details will appear shortly" };
  }
  if (!status.pairingPinConfigured) {
    return { ready: false, label: "Set a pairing code below so new devices can connect" };
  }
  return { ready: true, label: "Ready to accept connections" };
}

// ---------------------------------------------------------------------------
// PIN manager — moved here from the old Mobile tab. Three states:
//   no PIN          → Set / Generate
//   visible PIN     → show + Copy + Change + Remove
//   configured-hidden (plaintext unrecoverable after restart) → Generate new / Remove
// ---------------------------------------------------------------------------

function PinManager({
  pin,
  pinConfigured,
  busy,
  onSetPin,
  onGenerate,
  onRemove,
}: {
  pin: string | null;
  pinConfigured: boolean;
  busy: boolean;
  onSetPin: (pin: string) => Promise<void>;
  onGenerate: () => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const handleSave = async (value: string) => {
    setPinError(null);
    try {
      await onSetPin(value);
      setEditing(false);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : String(err));
    }
  };

  if (editing) {
    return (
      <div style={panelStyle}>
        <PinEditor
          initial={pin ?? ""}
          busy={busy}
          onCancel={() => { setEditing(false); setPinError(null); }}
          onSave={handleSave}
          error={pinError}
        />
      </div>
    );
  }

  return (
    <div style={{ ...panelStyle, gap: 10 }}>
      <div style={LABEL_STYLE}>Pairing code</div>
      <div style={{ ...helperTextStyle, marginTop: -2 }}>
        New nearby devices enter this code the first time they connect to this Mac.
      </div>
      {!pinConfigured ? (
        <EmptyPinBlock
          busy={busy}
          onSet={() => { setPinError(null); setEditing(true); }}
          onGenerate={onGenerate}
        />
      ) : pin ? (
        <PinDisplay
          pin={pin}
          busy={busy}
          onChange={() => { setPinError(null); setEditing(true); }}
          onGenerate={onGenerate}
          onRemove={onRemove}
        />
      ) : (
        <HiddenPinBlock busy={busy} onGenerate={onGenerate} onRemove={onRemove} />
      )}
    </div>
  );
}

// Read-only pairing-code state shown while this window is remote-bound. Pin
// mutations still route to the bound machine, so we surface this Mac's current
// code (read from the local snapshot) without offering controls that would
// silently change the wrong machine.
function PinManagerRemoteNote({
  pin,
  pinConfigured,
  boundMachineName,
}: {
  pin: string | null;
  pinConfigured: boolean;
  boundMachineName: string | null;
}) {
  const stateLine = !pinConfigured
    ? "No pairing code set on this Mac yet."
    : pin
      ? `This Mac's pairing code is ${pin}.`
      : "This Mac has a pairing code set.";
  return (
    <div style={{ ...panelStyle, gap: 8 }}>
      <div style={LABEL_STYLE}>Pairing code</div>
      <div style={{ ...helperTextStyle, marginTop: -2 }}>{stateLine}</div>
      <div style={{ ...helperTextStyle, color: COLORS.textMuted }}>
        Pairing changes aren&rsquo;t available while this window is connected to{" "}
        {boundMachineName ?? "another Mac"}.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phone tab
// ---------------------------------------------------------------------------

// Section title that names which machine a device list belongs to. The list is
// always scoped to this physical Mac; the "on {name}" line only appears when a
// remote binding could otherwise make the reader assume it is the bound machine.
function ScopedListTitle({ title, sync }: { title: string; sync: SyncConnections }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600 }}>
        {title}
      </div>
      {sync.isRemoteBound ? (
        <div style={{ ...helperTextStyle, fontSize: 11 }}>on {sync.localMachineName}</div>
      ) : null}
    </div>
  );
}

export function PhoneConnectionsTab({
  sync,
  confirmRevoke,
}: {
  sync: SyncConnections;
  confirmRevoke: RevokeConfirm;
}) {
  const { status } = sync;
  if (sync.loading) return <div style={helperTextStyle}>Getting connection details…</div>;
  if (!status) return <div style={helperTextStyle}>Open a project in ADE before connecting a phone.</div>;

  const host = isSyncHost(status);
  const phones = sync.devices.filter((device) => !device.isLocal && device.deviceType === "phone");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gap: 10 }}>
        <ScopedListTitle title="Paired phones" sync={sync} />
        <DeviceList
          devices={phones}
          busy={sync.busy}
          emptyLabel="No phones connected yet."
          confirmRevoke={confirmRevoke}
          onForget={sync.forgetDevice}
          readOnly={!sync.canManageDevices}
        />
      </div>

      {host ? (
        <ConnectNewPhone status={status} />
      ) : (
        <div style={helperTextStyle}>
          Set up phones on the Mac that hosts your ADE projects.
        </div>
      )}
    </div>
  );
}

function ConnectNewPhone({ status }: { status: SyncRoleSnapshot }) {
  const pinReadout = status.pairingPin
    ? status.pairingPin
    : status.pairingPinConfigured
      ? "Pairing code is set — see This Mac above"
      : "Set a pairing code in This Mac above";

  return (
    <div style={cardStyle({ display: "grid", gap: 14 })}>
      <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
        Connect a new phone
      </div>
      <div style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 13, lineHeight: 1.5 }}>
        Sign in to ADE on your iPhone — this Mac appears automatically.
      </div>
      {status.pairingConnectInfo ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr)",
            gap: 16,
            alignItems: "center",
            minWidth: 0,
          }}
        >
          <PairQrPanel
            connectInfo={status.pairingConnectInfo}
            pinConfigured={status.pairingPinConfigured}
            title="Pairing QR code"
          />
          <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
            <div style={helperTextStyle}>
              Or scan this code with your iPhone camera, then enter this Mac's pairing code.
            </div>
            <div style={{ ...panelStyle, gap: 4 }}>
              <span style={LABEL_STYLE}>Pairing code</span>
              <span
                style={{
                  color: status.pairingPin ? COLORS.textPrimary : COLORS.textMuted,
                  fontFamily: MONO_FONT,
                  fontSize: status.pairingPin ? 18 : 12,
                  letterSpacing: status.pairingPin ? "0.28em" : undefined,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {pinReadout}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div style={helperTextStyle}>No machine addresses are published yet.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Web tab — sign-in only, plus connected browsers list.
// ---------------------------------------------------------------------------

export function WebConnectionsTab({
  sync,
  accountSignedIn,
  confirmRevoke,
  onAccountRequested,
}: {
  sync: SyncConnections;
  accountSignedIn: boolean;
  confirmRevoke: RevokeConfirm;
  onAccountRequested?: () => void;
}) {
  const { status } = sync;
  if (sync.loading) return <div style={helperTextStyle}>Getting connection details…</div>;

  const browsers = sync.devices.filter((device) => !device.isLocal && device.deviceType === "browser");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={cardStyle({ display: "grid", gap: 12 })}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Globe size={18} weight="duotone" color={COLORS.accent} />
          <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
            ADE in the browser
          </div>
        </div>
        {accountSignedIn ? (
          <>
            <div style={helperTextStyle}>
              Open the web client and sign in with your ADE account to reach this Mac.
            </div>
            <button
              type="button"
              style={primaryButton({ height: 32, justifySelf: "start" })}
              onClick={() => openExternalUrl(WEB_CLIENT_BASE_URL)}
            >
              <ArrowSquareOut size={15} weight="bold" />
              Open ADE in browser
            </button>
          </>
        ) : (
          <>
            <div style={helperTextStyle}>
              Sign in to use the web client. Once you're signed in, this Mac appears in the browser
              automatically.
            </div>
            <button
              type="button"
              style={primaryButton({ height: 32, justifySelf: "start" })}
              onClick={() => onAccountRequested?.()}
            >
              Sign in to use the web client
            </button>
          </>
        )}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <ScopedListTitle title="Connected browsers" sync={sync} />
        <DeviceList
          devices={browsers}
          busy={sync.busy}
          emptyLabel="No browsers connected yet."
          confirmRevoke={confirmRevoke}
          onForget={sync.forgetDevice}
          readOnly={!sync.canManageDevices}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// QR tile (shared) — QR only, never carries the PIN.
// ---------------------------------------------------------------------------

// White tile, accent-tinted border, excavated ADE mark in the center (hence
// error-correction level H). Shared by the This-Mac card and Phone tab.
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

function PairQrPanel({
  connectInfo,
  pinConfigured,
  title,
}: {
  connectInfo: SyncPairingConnectInfo;
  pinConfigured: boolean;
  title: string;
}) {
  const qrUrl = useMemo(
    () => encodePairingQrUrl(buildPairingQrPayload({ connectInfo, pinConfigured })),
    [connectInfo, pinConfigured],
  );
  return <QrCodeBox value={qrUrl} title={title} />;
}

// ---------------------------------------------------------------------------
// Copy feedback (shared)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// PIN blocks
// ---------------------------------------------------------------------------

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
  // Two envelopes over one event: the shared hook owns the 1.5s "Copied" label,
  // and a 600ms highlight flashes the digits. The hook only calls `onCopy`
  // while mounted and its cleanup cancels the timer below, so no extra mounted
  // guard is needed here.
  const [flash, setFlash] = useState(false);
  const flashTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
  }, []);

  const { copy, copied } = useCopyToClipboard({
    write: async (value) => {
      // Writes through the main process; `navigator.clipboard` is not
      // guaranteed here. On failure the code stays visible to copy manually.
      const writeClipboardText = window.ade?.app?.writeClipboardText;
      if (!writeClipboardText) return false;
      await writeClipboardText(value);
      return true;
    },
    onCopy: () => {
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
      setFlash(true);
      flashTimerRef.current = window.setTimeout(() => {
        flashTimerRef.current = null;
        setFlash(false);
      }, 600);
    },
  });
  const showFeedback = useCallback(() => { void copy(pin); }, [copy, pin]);
  const digits = pin.padEnd(6, " ").slice(0, 6).split("");

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, ...flashHighlightStyle(flash) }}>
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={outlineButton()} disabled={busy} onClick={showFeedback}>
          <CopiedGlyphLabel copied={copied} idle="Copy" />
        </button>
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
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 13 }}>
        No pairing code set yet.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={primaryButton()} disabled={busy} onClick={onGenerate}>
          Generate code
        </button>
        <button type="button" style={outlineButton()} disabled={busy} onClick={onSet}>
          Set manually
        </button>
      </div>
    </div>
  );
}

function HiddenPinBlock({
  busy,
  onGenerate,
  onRemove,
}: {
  busy: boolean;
  onGenerate: () => void;
  onRemove: () => void;
}) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 13 }}>
        A pairing code is set. It stays hidden after ADE restarts — generate a new one to see it again.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={outlineButton()} disabled={busy} onClick={onGenerate}>
          Generate new code
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
      <div style={LABEL_STYLE}>Set a 6-digit pairing code</div>
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
              aria-label={`Pairing code digit ${index + 1}`}
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
                boxShadow: isFocused ? `0 0 0 3px rgba(167, 139, 250, 0.18)` : "none",
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
          Save code
        </button>
        <button type="button" style={outlineButton()} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error ? <div style={{ ...helperTextStyle, color: COLORS.danger }}>{error}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Device rows (phones / browsers)
// ---------------------------------------------------------------------------

function DeviceRow({
  device,
  busy,
  confirmRevoke,
  onForget,
  readOnly = false,
}: {
  device: SyncDeviceRuntimeState;
  busy: boolean;
  confirmRevoke: RevokeConfirm;
  onForget: (device: SyncDeviceRuntimeState) => void;
  readOnly?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const connected = device.connectionState === "connected";

  const handleRevoke = async () => {
    const ok = await confirmRevoke({ name: device.name || "This device", connected });
    if (ok) onForget(device);
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
      <div style={{ display: "grid", gap: 4, minWidth: 160 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              flexShrink: 0,
              background: connected ? COLORS.success : COLORS.textDim,
            }}
          />
          <span style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600 }}>
            {device.name}
          </span>
        </div>
        <div style={helperTextStyle}>
          {device.platform} &middot; {deviceTypeLabel(device.deviceType)}
          {" · "}
          {connected
            ? `Connected · ${formatLatency(device.latencyMs)}`
            : `Last seen ${formatTimestamp(device.lastSeenAt)}`}
        </div>
      </div>

      {readOnly ? null : (
        <button
          type="button"
          style={{ ...dangerButton({ height: 30, padding: "0 12px", fontSize: 11 }), opacity: hovered ? 1 : 0.7 }}
          disabled={busy}
          onClick={() => void handleRevoke()}
        >
          Revoke
        </button>
      )}
    </div>
  );
}

function DeviceList({
  devices,
  busy,
  emptyLabel,
  confirmRevoke,
  onForget,
  readOnly = false,
}: {
  devices: SyncDeviceRuntimeState[];
  busy: boolean;
  emptyLabel: string;
  confirmRevoke: RevokeConfirm;
  onForget: (device: SyncDeviceRuntimeState) => void;
  readOnly?: boolean;
}) {
  if (devices.length === 0) {
    return <div style={helperTextStyle}>{emptyLabel}</div>;
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {devices.map((device) => (
        <DeviceRow
          key={device.deviceId}
          device={device}
          busy={busy}
          confirmRevoke={confirmRevoke}
          onForget={onForget}
          readOnly={readOnly}
        />
      ))}
    </div>
  );
}
