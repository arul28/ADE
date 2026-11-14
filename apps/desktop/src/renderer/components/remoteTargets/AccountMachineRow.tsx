import { useEffect, useState, type ReactNode } from "react";
import { MachineAvatar, machineFormFactor, machinePlatform } from "./MachineIdentity";
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretUp,
  Check,
  PencilSimple,
  PlugsConnected,
  X,
} from "@phosphor-icons/react";
import type {
  AdeAccountMachine,
  RemoteRuntimeConnectErrorInfo,
} from "../../../shared/types";
import {
  accountMachineConnectionState,
  accountMachineDisplayName,
  accountMachineInstallLabel,
  accountMachineRowName,
} from "../../../shared/accountDirectory";
import type { MachinePresence } from "../../../shared/types/power";
import {
  accountMachinePresence,
  machineActionLabel,
  machineIsAwake,
  machineStatusLine,
} from "../../../shared/machinePresence";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { ConnectionDoctorPanel } from "./ConnectionDoctorPanel";
import { ConnectionRouteDetails } from "./ConnectionRouteDetails";
import { Banner } from "../ui/notice";
import { MachineActionsMenu, type MachineAction } from "./MachineActionsMenu";
import {
  formatMachineEndpoint,
  isMachineStateConnectError,
  relativeLastSeenPhrase,
  type AccountMachineRow as AccountMachineRowModel,
  type MachineSection,
} from "./remoteMachineModel";
import {
  helperTextStyle,
  inlineDetailStyle,
  inlineSuccessTextStyle,
  machineRowStyle,
  nameStyle,
  connectButtonStyle,

  subTextStyle,
} from "./remoteTargetListStyles";
import { machineLabelForMachine, useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";

type AccountMachineRowProps = {
  row: AccountMachineRowModel;
  section: MachineSection;
  /**
   * This row is locked: its connect is in flight, or a cancelled pairing is
   * still finishing in main (`"stopping"` in useRowActions; busy while
   * not connecting). Other rows' work never sets it.
   */
  busy: boolean;
  connecting: boolean;
  /**
   * This computer holds a live runtime channel to the machine right now.
   *
   * Resolved from the connection snapshot rather than from the row's section:
   * a machine usually folds into its saved target's row once connected, but a
   * target that predates its account pairing does not fold, and that row must
   * not describe a machine we are talking to as one we have only heard from.
   */
  connected?: boolean;
  error?: string | null;
  /** Structured failure for the machine's saved target, when one exists. Feeds
   * the collapsed route list; the headline stays the plain-language `error`. */
  errorInfo?: RemoteRuntimeConnectErrorInfo | null;
  stageLabel?: string | null;
  successLabel?: string | null;
  onPairNearby?: (() => void) | null;
  detailOpen: boolean;
  onToggleDetail: (rowId: string) => void;
  onConnect: (machine: AdeAccountMachine) => void;
  /** Stops this row's connect while it is in progress. */
  onCancelConnect: (machine: AdeAccountMachine) => void;
  onRenamed?: () => void;
  /** More ⋯ items after Rename: Remove from ADE, a cloud box's lifecycle. */
  extraActions?: MachineAction[];
  /** A line under the row, inside it: a cloud box's state, size and price. */
  footer?: ReactNode;
  /**
   * A cloud box that is asleep or stopped: the line that replaces the row's
   * presence ("Asleep on the provider") and the button that replaces Connect
   * (Wake). A sleeping box can't take a connection, so the row never offers one.
   */
  parked?: { label: string; action: ReactNode } | null;
};

function relativeLastSeen(lastSeenAt: number | null): string {
  const phrase = relativeLastSeenPhrase(lastSeenAt);
  return phrase ? `Last seen ${phrase}` : "Never seen";
}

/**
 * The row's one status line.
 *
 * Presence and power come first when the machine reported them — "Asleep · 82%
 * battery" is the answer to the question someone scanning a list of computers
 * actually has. The older sentences stay for the cases presence cannot
 * explain: a machine that is online but has no route we can dial, and one that
 * has been silent long enough that the fix is to open ADE over there.
 */
function accountMachineStatusLabel(
  machine: AdeAccountMachine,
  connectionState: ReturnType<typeof accountMachineConnectionState>,
  presence: MachinePresence,
): string {
  if (presence === "asleep") {
    return machineStatusLine(machine, { presence }) ?? "Asleep";
  }
  if (presence === "connected") {
    // The check beside the name already says connected, so the line spends
    // itself on the power reading instead of repeating the word.
    return machineStatusLine(machine, { presence }) ?? "Connected";
  }
  if (connectionState === "unreachable") {
    return "Can't reach this computer right now — make sure it's online and up to date.";
  }
  if (presence === "online") {
    return machineStatusLine(machine, { presence }) ?? "Ready to connect";
  }
  return `${relativeLastSeen(machine.lastSeenAt)} · Open ADE on that computer`;
}

export function AccountMachineRow({
  row,
  section,
  busy,
  connecting,
  connected = false,
  error = null,
  errorInfo = null,
  stageLabel = null,
  successLabel = null,
  onPairNearby = null,
  detailOpen,
  onToggleDetail,
  onConnect,
  onCancelConnect,
  onRenamed,
  extraActions = [],
  footer = null,
  parked = null,
}: AccountMachineRowProps) {
  const { machine } = row;
  const displayName = accountMachineDisplayName(machine) ?? "Unnamed machine";
  // What the row shows: a cloud lane computer reads "Cloud · <lane>" (its own name stays in the tooltip and rename field).
  const { computers: cloudComputers } = useAdeCloudLaneComputers();
  const shownName = machineLabelForMachine({ machineKey: machine.machineKey, hostname: machine.name, name: displayName }, cloudComputers);
  const installLabel = accountMachineInstallLabel(machine);
  const installTag = installLabel && installLabel !== "ADE" ? installLabel : null;
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(displayName);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  useEffect(() => {
    if (!renaming) setRenameValue(displayName);
  }, [displayName, renaming]);
  const connectionState = accountMachineConnectionState(machine);
  // Presence is resolved once, here, and passed down. Never re-derive it from
  // `online` / `lastSeenAt` further in — that is the disagreement this helper
  // exists to prevent.
  const presence = accountMachinePresence(machine, { connected });
  const available = connectionState === "available";
  const parkedLine = parked && !connected && !connecting ? parked : null;
  const awake = !parkedLine && machineIsAwake(presence);
  // "Why offline?" is offered about an OFFLINE machine, not a sleeping one:
  // the row that says "Asleep · 82% battery" and offers to explain why the
  // machine is offline is the same one-row contradiction as the green dot.
  const offline = presence === "offline";
  const needsSetup = connectionState === "unreachable";
  const canExplain = !parkedLine && (offline || needsSetup);

  const saveRename = async (customName?: string | null) => {
    const api = window.ade.account;
    if (!api?.renameMachine) return;
    const nextName = customName === undefined ? renameValue.trim() : customName;
    if (nextName !== null && !nextName) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      await api.renameMachine(machine.machineKey, nextName);
      setRenaming(false);
      onRenamed?.();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "Couldn't rename this computer.");
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <div
      data-account-machine-key={machine.machineKey}
      style={{ display: "grid", gap: 8 }}
    >
      <div style={{ ...machineRowStyle, opacity: !awake && section === "unavailable" ? 0.62 : 1 }}>
        <div className="ade-cx-row-grid">
          <MachineAvatar
            colorKey={machine.machineKey}
            name={shownName}
            platform={machinePlatform(machine.platform)}
            formFactor={machineFormFactor({ name: displayName, power: machine.power })}
            editable
            dimmed={!awake && section === "unavailable"}
          />
          <div style={{ minWidth: 0, display: "grid", gap: 5 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              {renaming ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveRename();
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}
                >
                  <input
                    aria-label="Machine name"
                    autoFocus
                    maxLength={80}
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    disabled={renameBusy}
                    style={{
                      minWidth: 0,
                      width: "100%",
                      height: 30,
                      borderRadius: 8,
                      border: `1px solid ${COLORS.borderMuted}`,
                      background: COLORS.recessedBg,
                      color: COLORS.textPrimary,
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                      padding: "0 9px",
                      outline: "none",
                    }}
                  />
                  <button
                    type="submit"
                    aria-label="Save machine name"
                    disabled={renameBusy || !renameValue.trim()}
                    style={outlineButton({ height: 30, padding: "0 8px", fontSize: 11 })}
                  >
                    <Check size={13} weight="bold" />
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel rename"
                    disabled={renameBusy}
                    onClick={() => {
                      setRenaming(false);
                      setRenameError(null);
                    }}
                    style={outlineButton({ height: 30, padding: "0 8px", fontSize: 11 })}
                  >
                    <X size={13} weight="bold" />
                  </button>
                </form>
              ) : (
                <>
                  <span style={nameStyle} title={shownName !== displayName ? displayName : machine.adeHome ?? undefined}>
                    {shownName !== displayName ? shownName : installTag ? accountMachineRowName(machine) ?? displayName : displayName}
                  </span>
                  {/* The install is named only when it is not the regular
                      app, which is the case where two rows share a name. */}
                  {installTag ? (
                    <span style={{ ...helperTextStyle, fontSize: 11, whiteSpace: "nowrap" }}>{installTag}</span>
                  ) : null}
                </>
              )}
              {/* The dot states the SAME presence as the line below it. The
                  attribute is how a test pins that, since a CSS variable does
                  not survive to a style assertion. */}
              <span
                {...(presence === "connected"
                  ? { role: "img", "aria-label": "Connected" }
                  : { "aria-hidden": true })}
                data-machine-presence={parkedLine ? "asleep" : presence}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: awake ? COLORS.success : COLORS.textDim,
                }}
              />
            </div>
            <div style={helperTextStyle}>
              {parkedLine ? parkedLine.label : accountMachineStatusLabel(machine, connectionState, presence)}
            </div>
          </div>

          <div className="ade-cx-row-actions" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {connecting ? (
              <button
                type="button"
                aria-label={`Cancel connecting to ${displayName}`}
                title="Stop connecting"
                onClick={() => onCancelConnect(machine)}
                style={outlineButton({ height: 30, padding: "0 10px", fontSize: 11 })}
              >
                <X size={13} weight="bold" />
                Cancel
              </button>
            ) : parkedLine ? (
              parkedLine.action
            ) : available ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onConnect(machine)}
                style={{ ...connectButtonStyle, opacity: busy ? 0.5 : 1, cursor: busy ? "not-allowed" : "pointer" }}
              >
                <PlugsConnected size={14} weight="bold" />
                {/* Busy and not connecting: a cancelled pairing is finishing. */}
                {busy ? "Stopping…" : machineActionLabel(presence)}
              </button>
            ) : null}
            {canExplain ? (
              <button
                type="button"
                aria-expanded={detailOpen}
                aria-controls={`account-machine-detail-${row.id}`}
                onClick={() => onToggleDetail(row.id)}
                style={outlineButton({ height: 30, padding: "0 10px", fontSize: 11 })}
              >
                {needsSetup ? "How to connect" : "Why offline?"}
                {detailOpen ? <CaretUp size={12} weight="bold" /> : <CaretDown size={12} weight="bold" />}
              </button>
            ) : null}
            {!renaming ? (
              <MachineActionsMenu
                label={`Actions for ${displayName}`}
                actions={[
                  {
                    key: "rename",
                    label: "Rename",
                    ariaLabel: `Rename ${displayName}`,
                    icon: <PencilSimple size={14} />,
                    disabled: busy,
                    onSelect: () => setRenaming(true),
                  },
                  ...(machine.customName
                    ? [{
                        key: "hostname",
                        label: "Use hostname",
                        icon: <ArrowCounterClockwise size={14} />,
                        disabled: busy || renameBusy,
                        onSelect: () => void saveRename(null),
                      }]
                    : []),
                  ...extraActions,
                ]}
              />
            ) : null}
          </div>
        </div>

        {footer}

        {connecting && stageLabel ? (
          <div role="status" style={helperTextStyle}>
            {stageLabel}
          </div>
        ) : null}

        {successLabel ? (
          <div role="status" style={inlineSuccessTextStyle}>
            {successLabel}
          </div>
        ) : null}

        {error ? (
          <Banner
            layout="inline"
            model={{
              id: `account-machine-connect-error-${row.id}`,
              tone: isMachineStateConnectError(errorInfo?.kind) ? "warning" : "error",
              title: error,
              actions: onPairNearby
                ? [{ label: "It's on your network — Pair nearby instead ›", onClick: onPairNearby, variant: "link" }]
                : undefined,
              report: {
                surface: "account_machine_connect",
                code: errorInfo ? `connect_${errorInfo.kind}` : null,
                technicalDetail: errorInfo?.detail ?? null,
              },
            }}
          />
        ) : null}

        {error ? (
          <ConnectionRouteDetails
            attempts={errorInfo?.attempts ?? []}
            correlationId={errorInfo?.correlationId ?? null}
            omittedAttemptCount={errorInfo?.omittedAttemptCount ?? 0}
          />
        ) : null}

        {renameError ? (
          <Banner
            layout="inline"
            model={{
              id: `account-machine-rename-error-${row.id}`,
              tone: "error",
              title: renameError,
              report: { surface: "account_machine_rename" },
              dismiss: { onDismiss: () => setRenameError(null) },
            }}
          />
        ) : null}
      </div>

      {canExplain && detailOpen ? (
        <div id={`account-machine-detail-${row.id}`} className="ade-cx-inset" style={inlineDetailStyle}>
          <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600 }}>
            {needsSetup ? "Finish setup on the other computer" : relativeLastSeen(machine.lastSeenAt)}
          </div>
          <div style={helperTextStyle}>
            {needsSetup
              ? "On that computer, open ADE and sign in to this same ADE account. Once it's online and up to date, it appears here automatically."
              : "This computer hasn't checked in recently. Open ADE on it, then try again."}
          </div>
          {!needsSetup && machine.reachableEndpoints.length > 0 ? (
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600 }}>
                Last-known routes
              </div>
              {machine.reachableEndpoints.map((endpoint, index) => (
                <div key={`${endpoint.kind}-${index}`} style={subTextStyle}>
                  {formatMachineEndpoint(endpoint)}
                </div>
              ))}
            </div>
          ) : null}
          {row.matchedTargetId ? <ConnectionDoctorPanel machineId={row.matchedTargetId} machineName={displayName} /> : null}
        </div>
      ) : null}
    </div>
  );
}
