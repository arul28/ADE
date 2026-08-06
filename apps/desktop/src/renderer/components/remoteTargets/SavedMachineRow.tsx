import {
  ArrowClockwise,
  CaretDown,
  CaretUp,
  CheckCircle,
  PlugsConnected,
  Trash,
  Warning,
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
  primaryButton,
} from "../lanes/laneDesignTokens";
import { ConnectionDoctorPanel } from "./ConnectionDoctorPanel";
import { ConnectionRouteDetails } from "./ConnectionRouteDetails";
import { HostKeyTrustCard } from "./HostKeyTrustCard";
import {
  connectionStateLabel,
  formatLastSeen,
  selectMachineErrorCard,
  type MachineSection,
  type SavedMachineRow as SavedMachineRowModel,
} from "./remoteMachineModel";
import { RemoteErrorCard } from "./RemoteErrorCard";
import {
  RemoteTargetForm,
  type RemoteTargetFormPrefill,
} from "./RemoteTargetForm";
import {
  helperTextStyle,
  inlineDetailStyle,
  inlineErrorTextStyle,
  inlineSuccessTextStyle,
  machineRowStyle,
  nameStyle,
  subTextStyle,
} from "./remoteTargetListStyles";

type SavedMachineRowProps = {
  row: SavedMachineRowModel;
  section: MachineSection;
  selected: boolean;
  connected: RemoteRuntimeConnectResult | null;
  busyId: string | null;
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
  busyId,
  saving,
  formPrefill,
  testOpen,
  error,
  stageLabel = null,
  transientStatus = null,
  updateTargetVersion = null,
  updating = false,
  updateStatus = null,
  onUpdateAndRestart,
  hostKeyTrust,
  trustingHostKey,
  onConnect,
  onDisconnect,
  onToggleTest,
  onToggleEdit,
  onRemove,
  onSaveAndConnect,
  onAutoConnectChange,
  onTrustAndConnect,
  onCancelHostKeyTrust,
  onPairAgain = null,
}: SavedMachineRowProps) {
  const { target, status } = row;
  const targetConnecting =
    busyId === target.id || status?.state === "connecting";
  const statusLabel = connectionStateLabel(
    status ?? null,
    connected?.target.id === target.id,
  );
  const warnings = selected
    ? (status?.compatibilityWarnings ??
      (connected?.target.id === target.id
        ? connected.compatibilityWarnings
        : []) ??
      [])
    : (status?.compatibilityWarnings ?? []);
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

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        style={{
          ...machineRowStyle,
          opacity: section === "unavailable" ? 0.62 : 1,
          borderColor: selected ? COLORS.accent : COLORS.border,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) auto",
            gap: 12,
            alignItems: "start",
          }}
        >
          <div style={{ minWidth: 0, display: "grid", gap: 5 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
              }}
            >
              <span style={nameStyle}>{target.name}</span>
              {row.connected ? (
                <CheckCircle size={15} weight="fill" color={COLORS.success} />
              ) : null}
            </div>
            <div style={subTextStyle}>
              {target.transport === "paired" ? "Paired with this computer" : "Saved SSH connection"}
            </div>
            <div style={helperTextStyle}>
              {section === "unavailable" && row.unavailableReason ? (
                <span>{row.unavailableReason}</span>
              ) : (
                <>
                  <span>{statusLabel}</span>
                  <span>{` · ${formatLastSeen(target.lastConnectedAt)}`}</span>
                </>
              )}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            {row.connected && updateTargetVersion && onUpdateAndRestart ? (
              <button
                type="button"
                disabled={busyId != null || updating}
                onClick={() => onUpdateAndRestart(updateTargetVersion)}
                style={outlineButton({
                  height: 30,
                  padding: "0 10px",
                  fontSize: 11,
                })}
              >
                <ArrowClockwise size={14} weight="bold" />
                {updating ? "Updating…" : "Update & restart"}
              </button>
            ) : null}
            {row.connected ? (
              <button
                type="button"
                disabled={busyId != null || updating}
                onClick={() => onDisconnect(target.id)}
                style={outlineButton({
                  height: 30,
                  padding: "0 10px",
                  fontSize: 11,
                })}
              >
                Disconnect
              </button>
            ) : section !== "unavailable" ? (
              <>
                <button
                  type="button"
                  disabled={busyId != null}
                  onClick={() => onConnect(target.id)}
                  style={primaryButton({
                    height: 30,
                    padding: "0 10px",
                    fontSize: 11,
                  })}
                >
                  <PlugsConnected size={14} weight="bold" />
                  {targetConnecting ? "Connecting…" : "Connect"}
                </button>
                <button
                  type="button"
                  aria-controls={`remote-target-test-${target.id}`}
                  aria-expanded={testOpen}
                  disabled={busyId != null}
                  onClick={() => onToggleTest(target.id)}
                  style={outlineButton({
                    height: 30,
                    padding: "0 10px",
                    fontSize: 11,
                  })}
                >
                  Test
                </button>
              </>
            ) : null}
            {section !== "unavailable" ? (
              <button
                type="button"
                aria-controls={`remote-target-edit-${target.id}`}
                aria-expanded={formOpen}
                disabled={busyId != null}
                onClick={() => onToggleEdit(target)}
                style={outlineButton({
                  height: 30,
                  padding: "0 10px",
                  fontSize: 11,
                })}
              >
                Edit
                {formOpen ? (
                  <CaretUp size={12} weight="bold" />
                ) : (
                  <CaretDown size={12} weight="bold" />
                )}
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Remove ${target.name}`}
              disabled={busyId != null}
              onClick={() => onRemove(target.id)}
              style={outlineButton({
                height: 30,
                padding: "0 9px",
                fontSize: 11,
              })}
            >
              <Trash size={14} />
            </button>
          </div>
        </div>

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

        {updateStatus ? (
          <div
            role="status"
            style={updateStatus.ok ? inlineSuccessTextStyle : inlineErrorTextStyle}
          >
            {updateStatus.message}
          </div>
        ) : null}

        {errorCard ? (
          <RemoteErrorCard
            card={errorCard}
            onRetry={busyId == null ? () => onConnect(target.id) : undefined}
            retrying={busyId === target.id}
            action={pairAgain && busyId == null
              ? { label: "Pair again", onClick: pairAgain }
              : null}
          />
        ) : null}

        <ConnectionRouteDetails
          attempts={routeAttempts}
          correlationId={routeCorrelationId}
          omittedAttemptCount={omittedAttemptCount}
        />

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

        {selected && hostKeyTrust ? (
          <HostKeyTrustCard
            trust={hostKeyTrust}
            trusting={trustingHostKey}
            busy={busyId != null}
            onTrustAndConnect={onTrustAndConnect}
            onCancel={onCancelHostKeyTrust}
          />
        ) : null}
      </div>

      {testOpen ? (
        <div id={`remote-target-test-${target.id}`}>
          <ConnectionDoctorPanel machineId={target.id} />
        </div>
      ) : null}

      {formOpen ? (
        <div id={`remote-target-edit-${target.id}`} style={inlineDetailStyle}>
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
              disabled={busyId != null}
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
            busy={saving || busyId != null}
            prefill={formPrefill}
            submitLabel="Save and connect"
            onSubmit={onSaveAndConnect}
          />
        </div>
      ) : null}
    </div>
  );
}
