import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  PencilSimple,
  Plugs,
  PlugsConnected,
  Pulse,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import type {
  RemoteRuntimeConnectResult,
  RemoteRuntimeSshHostKeyTrustStatus,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
} from "../../../shared/types";
import {
  COLORS,
  SANS_FONT,
  outlineButton,
} from "../lanes/laneDesignTokens";
import { ConnectionDoctorPanel } from "./ConnectionDoctorPanel";
import { HostStallNote } from "./HostStallNote";
import { ConnectionRouteDetails } from "./ConnectionRouteDetails";
import { HostKeyTrustCard } from "./HostKeyTrustCard";
import { MachineAvatar, PresenceDot, VersionChip, machineFormFactor, machinePlatform } from "./MachineIdentity";
import { UpdateSteps, type MachineUpdatePhase } from "./UpdateSteps";
import {
  autoConnectOffReason,
  connectionStateLabel,
  formatLastSeen,
  isVersionSkewWarning,
  machineColorKey,
  selectMachineErrorCard,
  type MachineSection,
  type SavedMachineRow as SavedMachineRowModel,
} from "./remoteMachineModel";
import { RemoteErrorCard } from "./RemoteErrorCard";
import { MachineActionsMenu } from "./MachineActionsMenu";
import { Banner } from "../ui/notice";
import {
  RemoteTargetForm,
  type RemoteTargetFormPrefill,
} from "./RemoteTargetForm";
import {
  helperTextStyle,
  connectButtonStyle,
  inlineDetailStyle,
  inlineSuccessTextStyle,
  machineRowStyle,
  nameStyle,
  subTextStyle,
} from "./remoteTargetListStyles";

const CONNECTING_STALE_MS = 20_000;

const ROUTE_KIND_LABELS: Record<string, string> = {
  lan: "Local network",
  tailnet: "Tailscale",
  relay: "ADE relay",
  ssh: "SSH",
};

function useStaleConnecting(connecting: boolean): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!connecting) {
      setStale(false);
      return;
    }
    const timer = window.setTimeout(() => setStale(true), CONNECTING_STALE_MS);
    return () => window.clearTimeout(timer);
  }, [connecting]);
  return stale;
}

type SavedMachineRowProps = {
  row: SavedMachineRowModel;
  section: MachineSection;
  selected: boolean;
  connected: RemoteRuntimeConnectResult | null;
  /** This computer is running a connect for this row right now. */
  connecting: boolean;
  /** A cancel, disconnect, remove or setting change on this row is in flight.
   * Other rows' work never sets it. */
  busy: boolean;
  /** An add/edit form submit is in flight; only locks this row's edit form. */
  saving: boolean;
  formPrefill: RemoteTargetFormPrefill | null;
  testOpen: boolean;
  error: string | null;
  stageLabel?: string | null;
  transientStatus?: string | null;
  /**
   * The version this computer wants the machine on. Non-null means the machine
   * is behind and can be offered "Update & restart"; null hides the button.
   */
  updateTargetVersion?: string | null;
  updating?: boolean;
  /** ADE is asking the machine what an update would stop, before it confirms. */
  checkingUpdate?: boolean;
  /** The machine's last power report, from the account directory: a battery means a laptop. */
  power?: { battery?: unknown } | null;
  /** Where an update to this machine is right now; null when none is running. */
  updatePhase?: MachineUpdatePhase | null;
  /** Outcome of the last update run on this machine. */
  updateStatus?: { ok: boolean; message: string } | null;
  onUpdateAndRestart?: (targetVersion: string | null) => void;
  hostKeyTrust: RemoteRuntimeSshHostKeyTrustStatus | null;
  trustingHostKey: boolean;
  onConnect: (targetId: string) => void;
  onDisconnect: (targetId: string) => void;
  onToggleTest: (targetId: string) => void;
  onToggleEdit: (target: RemoteRuntimeTarget) => void;
  onRemove: (targetId: string) => void;
  /** Stops a connect or reconnect that is in progress for this row. */
  onCancelConnect: (targetId: string) => void;
  onSaveAndConnect: (input: RemoteRuntimeTargetInput) => void | Promise<void>;
  onAutoConnectChange: (targetId: string, enabled: boolean) => void;
  onTrustAndConnect: () => void;
  onCancelHostKeyTrust: () => void;
  /** Re-runs account adoption for this machine. Offered only when the host
   * rejected the saved pairing and the machine is on this ADE account. */
  onPairAgain?: (() => void) | null;
};

export function SavedMachineRow({
  row,
  section,
  selected,
  connected,
  connecting,
  busy,
  saving,
  formPrefill,
  testOpen,
  error,
  stageLabel = null,
  transientStatus = null,
  updateTargetVersion = null,
  updating = false,
  checkingUpdate = false,
  updatePhase = null,
  power = null,
  updateStatus = null,
  onUpdateAndRestart,
  hostKeyTrust,
  trustingHostKey,
  onConnect,
  onDisconnect,
  onToggleTest,
  onToggleEdit,
  onRemove,
  onCancelConnect,
  onSaveAndConnect,
  onAutoConnectChange,
  onTrustAndConnect,
  onCancelHostKeyTrust,
  onPairAgain = null,
}: SavedMachineRowProps) {
  const { target, status } = row;
  // Covers this computer's own connect and main's automatic reconnect.
  const targetConnecting =
    connecting || (status?.state === "connecting" && !row.connected);
  // A live connect can take minutes for SSH bootstrap. Only treat
  // snapshot-stuck "connecting" with no in-flight action as hung.
  const connectingStale = useStaleConnecting(
    status?.state === "connecting" && !connecting && !row.connected,
  );
  // Remove stays available while connecting; it cancels the attempt first.
  const locked = busy || connecting;
  const statusLabel = connectingStale
    ? "Can't reach"
    : connectionStateLabel(
        status ?? null,
        connected?.target.id === target.id,
      );
  // Says why a machine that is not connected will not come back on its own.
  const autoConnectOff = statusLabel === "Not connected" ? autoConnectOffReason(target) : null;
  const compatibilityWarnings = selected
    ? (status?.compatibilityWarnings ??
      (connected?.target.id === target.id
        ? connected.compatibilityWarnings
        : []) ??
      [])
    : (status?.compatibilityWarnings ?? []);
  // Version skew is the chip's job now; the rest are real warnings.
  const warnings = compatibilityWarnings.filter((warning) => !isVersionSkewWarning(warning));
  const errorCard = selectMachineErrorCard({
    errorInfo: status?.state === "error" ? status.lastErrorInfo : null,
    rawError: status?.state === "error" ? status.lastError : null,
    overrideMessage: selected ? error : null,
  });
  const activeRoute = connected?.target.id === target.id
    ? connected.route
    : status?.route;
  const errorInfo = status?.state === "error" ? status.lastErrorInfo : null;
  const routeAttempts = (activeRoute?.attempts ?? errorInfo?.attempts ?? []).slice(0, 8);
  const routeCorrelationId = activeRoute?.correlationId ?? errorInfo?.correlationId ?? null;
  const omittedAttemptCount =
    activeRoute?.omittedAttemptCount ?? errorInfo?.omittedAttemptCount ?? 0;
  // Re-pairing only helps when the machine actually refused the pairing.
  const pairAgain = errorCard?.failure === "pairing" ? onPairAgain : null;
  const formOpen = formPrefill?.targetId === target.id;

  const presence: "online" | "busy" | "offline" | "error" = updatePhase
    ? "busy"
    : row.connected
      ? "online"
      : errorCard && section !== "unavailable"
        ? "error"
        : targetConnecting && !connectingStale
          ? "busy"
          : "offline";
  const routeLabel = activeRoute?.kind ? ROUTE_KIND_LABELS[activeRoute.kind] ?? null : null;
  const latency = typeof activeRoute?.latencyMs === "number" ? `${Math.round(activeRoute.latencyMs)} ms` : null;
  const detailLine = updatePhase === "checking"
    ? "Checking what's running there…"
    : updatePhase === "sending"
      ? "Sending the update…"
      : updatePhase === "restarting"
        ? `Restarting on ${updateTargetVersion ?? "the new version"}…`
        : section === "unavailable" && row.unavailableReason
          ? row.unavailableReason
          : row.connected
            ? [routeLabel ?? "Online", latency].filter(Boolean).join(" · ")
            : targetConnecting && !connectingStale
              ? "Connecting…"
              : target.lastConnectedAt || statusLabel !== "Not connected"
                ? [
                    // The hollow dot and the section already say "not connected".
                    statusLabel === "Not connected" ? null : statusLabel,
                    autoConnectOff,
                    statusLabel === "Not connected"
                      ? formatLastSeen(target.lastConnectedAt).replace(/^Last connected /, "Last seen ")
                      : formatLastSeen(target.lastConnectedAt).replace(/^Last connected /, "last seen "),
                  ].filter(Boolean).join(" · ")
                : formatLastSeen(null);
  // A machine restarting for an update drops its connection on purpose. That
  // is a step of the update, not a failure, so its error card stays hidden.
  const shownErrorCard = updatePhase === "restarting" ? null : errorCard;
  const showFinalUpdateStatus = Boolean(updateStatus) && !updatePhase;
  const behind = row.connected && updateTargetVersion != null;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        style={{
          ...machineRowStyle,
          opacity: section === "unavailable" ? 0.7 : 1,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0,1fr) auto",
            gap: 12,
            alignItems: "center",
          }}
        >
          <MachineAvatar
            colorKey={machineColorKey(target)}
            name={target.name}
            platform={machinePlatform(status?.arch, target.lastSeenArch)}
            formFactor={machineFormFactor({ name: target.name, power })}
            editable
            dimmed={section === "unavailable"}
          />
          <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
              <span style={nameStyle}>{target.name}</span>
              <PresenceDot state={presence} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
              {/* The version only shows when it needs attention: behind, updating, or just updated. */}
              {behind || updatePhase || (showFinalUpdateStatus && updateStatus?.ok) ? (
                <VersionChip
                  version={row.versionLabel ?? row.version}
                  target={behind || updatePhase ? updateTargetVersion : null}
                  tone={showFinalUpdateStatus && updateStatus?.ok && !behind ? "success" : "muted"}
                />
              ) : null}
              <span role={updatePhase ? "status" : undefined} style={subTextStyle}>{detailLine}</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 2, justifyContent: "flex-end" }}>
            {behind && onUpdateAndRestart && !updatePhase ? (
              <button
                type="button"
                disabled={busy || updating || checkingUpdate}
                onClick={() => onUpdateAndRestart(updateTargetVersion)}
                style={{
                  ...outlineButton({ height: 28, padding: "0 11px", fontSize: 11.5 }),
                  color: COLORS.accent,
                  borderColor: COLORS.accentBorder,
                  marginRight: 4,
                }}
              >
                <ArrowClockwise size={13} weight="bold" />
                Update
              </button>
            ) : null}
            {!row.connected && targetConnecting && !updatePhase ? (
              <button
                type="button"
                aria-label={`Cancel connecting to ${target.name}`}
                title="Stop connecting"
                disabled={busy}
                onClick={() => onCancelConnect(target.id)}
                style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 11 }), marginRight: 4 }}
              >
                <X size={13} weight="bold" />
                Cancel
              </button>
            ) : null}
            {!row.connected && section !== "unavailable" && !updatePhase && (!targetConnecting || connectingStale) ? (
              <button
                type="button"
                disabled={locked}
                onClick={() => onConnect(target.id)}
                style={{ ...connectButtonStyle, marginRight: 4, opacity: locked ? 0.5 : 1, cursor: locked ? "not-allowed" : "pointer" }}
              >
                <PlugsConnected size={13} weight="bold" />
                {connectingStale ? "Retry" : "Connect"}
              </button>
            ) : null}
            <MachineActionsMenu
              label={`Actions for ${target.name}`}
              actions={[
                ...(section !== "unavailable"
                  ? [{
                      key: "test",
                      label: testOpen ? "Hide connection details" : "Test connection",
                      ariaLabel: "Test",
                      icon: <Pulse size={14} />,
                      disabled: busy,
                      onSelect: () => onToggleTest(target.id),
                    }, {
                      key: "edit",
                      label: formOpen ? "Close settings" : "Rename and settings",
                      ariaLabel: "Edit",
                      icon: <PencilSimple size={14} />,
                      disabled: locked,
                      onSelect: () => onToggleEdit(target),
                    }]
                  : []),
                ...(row.connected
                  ? [{
                      key: "disconnect",
                      label: "Disconnect",
                      icon: <Plugs size={14} />,
                      disabled: busy || updating,
                      onSelect: () => onDisconnect(target.id),
                    }]
                  : []),
                {
                  key: "remove",
                  label: "Remove from this computer",
                  ariaLabel: `Remove ${target.name}`,
                  icon: <Trash size={14} />,
                  danger: true,
                  disabled: busy,
                  onSelect: () => onRemove(target.id),
                },
              ]}
            />
          </div>
        </div>

        {updatePhase === "sending" || updatePhase === "restarting" ? (
          <UpdateSteps phase={updatePhase} targetVersion={updateTargetVersion} />
        ) : null}

        {stageLabel ? (
          <div role="status" style={helperTextStyle}>
            {stageLabel}
          </div>
        ) : null}

        {transientStatus ? (
          <div role="status" style={inlineSuccessTextStyle}>
            {transientStatus}
          </div>
        ) : null}

        {showFinalUpdateStatus && updateStatus ? (
          updateStatus.ok ? (
            <div role="status" style={inlineSuccessTextStyle}>
              {updateStatus.message}
            </div>
          ) : (
            <Banner
              layout="inline"
              model={{
                id: "machine-update-error",
                tone: "error",
                title: `Couldn't update ${target.name}`,
                detail: updateStatus.message,
                report: { surface: "machine_update", code: "remote_update_failed", technicalDetail: updateStatus.message },
              }}
            />
          )
        ) : null}

        {shownErrorCard ? (
          <RemoteErrorCard
            card={shownErrorCard}
            onRetry={!locked ? () => onConnect(target.id) : undefined}
            retrying={connecting}
            action={pairAgain && !locked
              ? { label: "Pair again", onClick: pairAgain }
              : null}
          />
        ) : null}

        {warnings.length > 0 ? (
          <div
            style={{
              display: "grid",
              gap: 4,
              color: COLORS.warning,
              fontFamily: SANS_FONT,
              fontSize: 12,
            }}
          >
            {warnings.map((warning) => (
              <div key={warning} style={{ display: "flex", gap: 6 }}>
                <Warning
                  size={14}
                  weight="fill"
                  style={{ flexShrink: 0, marginTop: 1 }}
                />
                <span>{warning}</span>
              </div>
            ))}
          </div>
        ) : null}

        <HostStallNote
          stall={status?.hostStall}
          machineName={target.name?.trim() || target.hostname}
        />

        {/* Which routes were tried lives with the failure, or under Test connection. */}
        {shownErrorCard ? (
          <ConnectionRouteDetails
            attempts={routeAttempts}
            correlationId={routeCorrelationId}
            omittedAttemptCount={omittedAttemptCount}
          />
        ) : null}

        {selected && hostKeyTrust ? (
          <HostKeyTrustCard
            trust={hostKeyTrust}
            trusting={trustingHostKey}
            busy={locked}
            onTrustAndConnect={onTrustAndConnect}
            onCancel={onCancelHostKeyTrust}
          />
        ) : null}
      </div>

      {testOpen ? (
        <div id={`remote-target-test-${target.id}`} className="ade-cx-inset">
          {!shownErrorCard ? (
            <ConnectionRouteDetails
              attempts={routeAttempts}
              correlationId={routeCorrelationId}
              omittedAttemptCount={omittedAttemptCount}
            />
          ) : null}
          <ConnectionDoctorPanel
            machineId={target.id}
            machineName={target.name?.trim() || target.hostname}
            connected={Boolean(row.connected)}
          />
        </div>
      ) : null}

      {formOpen ? (
        <div id={`remote-target-edit-${target.id}`} className="ade-cx-inset" style={inlineDetailStyle}>
          <div
            style={{
              color: COLORS.textPrimary,
              fontFamily: SANS_FONT,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            Edit {target.name}
          </div>
          <label
            style={{
              display: "grid",
              gridTemplateColumns: "16px minmax(0, 1fr)",
              gap: 8,
              alignItems: "start",
              color: COLORS.textPrimary,
              fontFamily: SANS_FONT,
              fontSize: 12,
            }}
          >
            <input
              type="checkbox"
              checked={target.autoConnect ?? (
                target.lastConnectedAt != null && target.manuallyDisconnectedAt == null
              )}
              disabled={busy}
              onChange={(event) => onAutoConnectChange(target.id, event.target.checked)}
              style={{ margin: "2px 0 0" }}
            />
            <span>
              Reconnect automatically
              <span style={{ display: "block", ...helperTextStyle, marginTop: 2 }}>
                ADE will reconnect when the app opens. LAN and Tailscale work without signing in; ADE Relay needs the same account on both computers.
              </span>
            </span>
          </label>
          <RemoteTargetForm
            busy={saving || locked}
            prefill={formPrefill}
            submitLabel="Save and connect"
            onSubmit={onSaveAndConnect}
          />
        </div>
      ) : null}
    </div>
  );
}
