import { normalizeSlowLinkPreference, type SlowLinkPreference } from "../../../shared/slowLinkMode";
import { SettingsSegmented, type SegmentedOption } from "../settings/primitives/SettingsControls";
import { isWebClientMode } from "../../lib/webClientMode";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  PencilSimple,
  Plugs,
  PlugsConnected,
  Pulse,
  Question,
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
import { HostStallNote, HostStorageWaitNote } from "./HostStallNote";
import { ConnectionRouteDetails } from "./ConnectionRouteDetails";
import { HostKeyTrustCard } from "./HostKeyTrustCard";
import { MachineAvatar, PresenceDot, VersionChip, machineFormFactor, machinePlatform } from "./MachineIdentity";
import { UpdateSteps, type MachineUpdatePhase } from "./UpdateSteps";
import {
  HELD_ELSEWHERE_ACTION_LABEL,
  HELD_ELSEWHERE_STATE_LABEL,
  autoConnectOffReason,
  connectionStateLabel,
  formatLastSeen,
  connectNeverReachedMachine,
  isVersionSkewWarning,
  machineColorKey,
  relativeLastSeenPhrase,
  selectMachineErrorCard,
  type MachineSection,
  type SavedMachineRow as SavedMachineRowModel,
} from "./remoteMachineModel";
import { RemoteErrorCard } from "./RemoteErrorCard";
import { MachineActionsMenu, type MachineAction } from "./MachineActionsMenu";
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
import { adeCloudMachineLabel, useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { BRAND } from "../../../shared/brand";

const CONNECTING_STALE_MS = 20_000;

const ROUTE_KIND_LABELS: Record<string, string> = {
  lan: "Local network",
  tailnet: "Tailscale",
  relay: `${BRAND.NAME} relay`,
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

/**
 * The word the state line leads with, or null for a plain "not connected"
 * machine (the hollow dot and the section already say it).
 */
function savedMachineStateWord({
  statusLabel,
  accountOnline,
  heldElsewhere,
  connectingStale,
  reachFailure,
}: {
  statusLabel: string;
  accountOnline: boolean | null | undefined;
  heldElsewhere: boolean;
  connectingStale: boolean;
  reachFailure: boolean;
}): string | null {
  // The account directory sees it offline: that is the state, whatever ADE's
  // own reconnects to it are doing.
  if (accountOnline === false && !heldElsewhere && !connectingStale) return "Offline";
  if (statusLabel === "Not connected") return null;
  if (reachFailure && !heldElsewhere) return "Can't reach";
  return statusLabel;
}

/** "last seen 5m ago" after a state word, "Last seen 5m ago" when it leads the line. */
function lastSeenWords(lastSeenAt: number | null, leads: boolean): string {
  const phrase = relativeLastSeenPhrase(lastSeenAt);
  if (lastSeenAt == null || phrase == null) return leads ? "Never connected" : "never connected";
  // A time that is not a date: formatLastSeen's own words for it.
  if (!Number.isFinite(new Date(lastSeenAt).getTime())) return formatLastSeen(lastSeenAt);
  return `${leads ? "Last seen" : "last seen"} ${phrase}`;
}

type TestItemMode = "hide" | "explain" | "test";

const TEST_ITEM: Record<TestItemMode, { label: string; ariaLabel: string | undefined; icon: ReactNode }> = {
  hide: { label: "Hide connection details", ariaLabel: undefined, icon: <Pulse size={14} /> },
  explain: { label: "Why offline?", ariaLabel: undefined, icon: <Question size={14} /> },
  test: { label: "Test connection", ariaLabel: "Test", icon: <Pulse size={14} /> },
};

const SLOW_LINK_MODE_OPTIONS: readonly SegmentedOption<SlowLinkPreference>[] = [
  { value: "auto", label: "Automatic" },
  { value: "on", label: "Always on" },
  { value: "off", label: "Off" },
];

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
  /**
   * The person pressed Connect (or Retry, Reconnect, Pair again) on this
   * machine in this window and that attempt has not succeeded or been
   * dismissed. Only then does a failure show as a full card on the row; a
   * failed automatic reconnect stays one line of state.
   */
  userAttempted?: boolean;
  /** The card's ✕: forget the person's failed attempt on this machine. */
  onDismissError?: () => void;
  stageLabel?: string | null;
  transientStatus?: string | null;
  /**
   * The version this computer wants the machine on. Non-null means the machine
   * is behind and can be offered "Update & restart"; null hides the button.
   */
  updateTargetVersion?: string | null;
  /** Undefined means in-place; null means manual download is unavailable. */
  manualDownloadUrl?: string | null;
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
  /** This computer's slow-connection setting for the machine. Absent: no control. */
  onSlowLinkModeChange?: (targetId: string, mode: SlowLinkPreference) => void;
  onTrustAndConnect: () => void;
  onCancelHostKeyTrust: () => void;
  /** Re-runs account adoption for this machine. Offered only when the host
   * rejected the saved pairing and the machine is on this ADE account. */
  onPairAgain?: (() => void) | null;
  /** More ⋯ items after the row's own: Remove from ADE, a cloud box's lifecycle. */
  extraActions?: MachineAction[];
  /** Hides "Remove from this computer" where an extra action already removes it (Remove from ADE). */
  hideLocalRemove?: boolean;
  /** A line under the row, inside it: a cloud box's state, size and price. */
  footer?: ReactNode;
  /**
   * A cloud box that is asleep or stopped: the line that replaces the row's
   * presence ("Asleep on the provider") and the button that replaces Connect
   * (Wake). A sleeping box can't take a connection, so the row never offers one.
   */
  parked?: { label: string; action: ReactNode } | null;
  /**
   * ADE Web holds a fixed number of computer connections per tab: the limit
   * while the tab holds that many, else null. A computer that waits for a
   * slot says so instead of looking broken.
   */
  sessionLimit?: number | null;
  /** The account directory sees this computer online (true) or offline (false); null when it does not list it. */
  accountOnline?: boolean | null;
  /** When the account directory last saw this computer online; null when it does not list it. */
  accountLastSeenAt?: number | null;
  /**
   * This computer is offline (`deriveThisComputerOffline`). A failure to reach
   * the machine is then this computer's, not the machine's: the row drops its
   * "may be asleep" card and its red dot, and the list says it once.
   */
  thisComputerOffline?: boolean;
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
  userAttempted = false,
  onDismissError,
  stageLabel = null,
  transientStatus = null,
  updateTargetVersion = null,
  manualDownloadUrl,
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
  onSlowLinkModeChange,
  onTrustAndConnect,
  onCancelHostKeyTrust,
  onPairAgain = null,
  extraActions = [],
  hideLocalRemove = false,
  footer = null,
  parked = null,
  sessionLimit = null,
  accountOnline = null,
  accountLastSeenAt = null,
  thisComputerOffline = false,
}: SavedMachineRowProps) {
  const { target, status } = row;
  const cloudIndex = useAdeCloudLaneComputers();
  // An ADE Cloud computer reads "ADE Cloud"; its own name moves to the tooltip.
  const cloudLabel = adeCloudMachineLabel({ hostname: target.hostname, machineKey: target.pairedMachine?.machineKey ?? null }, cloudIndex);
  const shownName = cloudLabel ?? target.name;
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
  const notConnected = statusLabel === "Not connected" && !row.connected && !targetConnecting;
  // Not connected only because this tab already holds its limit of
  // connections: the same words as the account row in that state.
  const slotReason = sessionLimit != null && status?.waitingForSlot === true && notConnected
    ? `This tab already has ${sessionLimit} computers connected`
    : null;
  // Says why a machine that is not connected will not come back on its own.
  const autoConnectOff = statusLabel === "Not connected" ? autoConnectOffReason(target) : null;
  // The account directory sees it online: it is up, only this app is not
  // connected to it. Say so and why, never "Last seen".
  const onlineLine = accountOnline === true && notConnected
    ? ["Online", slotReason ?? autoConnectOff].filter(Boolean).join(" · ")
    : null;
  // A computer the account sees offline keeps its "Last seen" line.
  const slotLine = slotReason && accountOnline !== false ? slotReason : null;
  // When the computer was last online: the account directory's time when it
  // lists the computer, else the end of this app's last connection to it, else
  // the start of that connection.
  const lastSeenAt = (accountOnline != null ? accountLastSeenAt : null)
    ?? status?.disconnectedAt
    ?? target.lastConnectedAt;
  const compatibilityWarnings = selected
    ? (status?.compatibilityWarnings ??
      (connected?.target.id === target.id
        ? connected.compatibilityWarnings
        : []) ??
      [])
    : (status?.compatibilityWarnings ?? []);
  // Version skew is the chip's job now; the rest are real warnings.
  const warnings = compatibilityWarnings.filter((warning) => !isVersionSkewWarning(warning));
  const selectedErrorCard = selectMachineErrorCard({
    errorInfo: status?.state === "error" ? status.lastErrorInfo : null,
    rawError: status?.state === "error" ? status.lastError : null,
    overrideMessage: selected ? error : null,
  });
  // Offline, "can't reach it" is no news about the machine. Any other failure
  // (a refused pairing, a host key) is still the machine's and still shows.
  const errorCard = thisComputerOffline
    && connectNeverReachedMachine(
      selectedErrorCard?.failure,
      status?.state === "error" ? status.lastErrorInfo?.attempts : null,
    )
    ? null
    : selectedErrorCard;
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
  // A machine restarting for an update drops its connection on purpose. That
  // is a step of the update, not a failure, so its error card stays hidden.
  const shownErrorCard = updatePhase === "restarting" ? null : errorCard;
  // The full card is the answer to a press: Connect, Retry or Reconnect here
  // failed. A machine that is simply off, and ADE's own reconnects to it,
  // stay one line of state; the card is one ··· item away ("Why offline?").
  const inlineErrorCard = shownErrorCard && (userAttempted || (selected && error != null))
    ? shownErrorCard
    : null;
  // Said in the state line instead of a card.
  const reachFailure = errorCard != null && (
    errorCard.kind === "unreachable" || errorCard.failure === "unreachable" || errorCard.failure === "timeout"
  );
  const heldElsewhere = statusLabel === HELD_ELSEWHERE_STATE_LABEL;
  const stateWord = savedMachineStateWord({ statusLabel, accountOnline, heldElsewhere, connectingStale, reachFailure });

  const parkedLine = parked && !row.connected && !updatePhase ? parked : null;
  const presence: "online" | "busy" | "offline" | "error" = updatePhase
    ? "busy"
    : parkedLine
      ? "offline"
      : row.connected
      ? "online"
      : inlineErrorCard && section !== "unavailable"
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
        : parkedLine
          ? parkedLine.label
          : section === "unavailable" && row.unavailableReason
          ? row.unavailableReason
          : row.connected
            ? [routeLabel ?? "Online", latency, status?.slowLink?.active ? "Slow connection" : null].filter(Boolean).join(" · ")
            : targetConnecting && !connectingStale
              ? "Connecting…"
              : onlineLine
                ? onlineLine
              : slotLine
                ? slotLine
              : lastSeenAt || stateWord
                ? [
                    // The hollow dot and the section already say "not connected".
                    stateWord,
                    autoConnectOff,
                    lastSeenWords(lastSeenAt, stateWord == null),
                  ].filter(Boolean).join(" · ")
                : formatLastSeen(null);
  const showFinalUpdateStatus = Boolean(updateStatus) && !updatePhase;
  // "Why offline?" in ···: a machine that is not connected and has a failure to explain.
  const explainsOffline = !row.connected && shownErrorCard != null && accountOnline !== true;
  const testItem = TEST_ITEM[testOpen ? "hide" : explainsOffline ? "explain" : "test"];
  const errorCardFor = (card: NonNullable<typeof shownErrorCard>, onDismiss: (() => void) | null) => (
    <RemoteErrorCard
      card={card}
      onRetry={!locked ? () => onConnect(target.id) : undefined}
      retrying={connecting}
      recovery={status?.state === "error" ? status.recovery ?? null : null}
      action={pairAgain && !locked
        ? { label: "Pair again", onClick: pairAgain }
        : null}
      onDismiss={onDismiss}
    />
  );
  const behind = row.connected && updateTargetVersion != null;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        style={{
          ...machineRowStyle,
          opacity: section === "unavailable" ? 0.7 : 1,
        }}
      >
        <div className="ade-cx-row-grid">
          <MachineAvatar
            colorKey={machineColorKey(target)}
            name={shownName}
            platform={machinePlatform(status?.arch, target.lastSeenArch)}
            formFactor={machineFormFactor({ name: target.name, power })}
            editable
            dimmed={section === "unavailable"}
          />
          <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
              {/* An ADE Cloud computer reads "ADE Cloud"; its own name stays in the tooltip for support. */}
              <span style={nameStyle} title={cloudLabel ? target.name : undefined}>{shownName}</span>
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
          <div className="ade-cx-row-actions" style={{ alignItems: "center", gap: 2 }}>
            {behind && onUpdateAndRestart && !updatePhase ? (
              <button
                type="button"
                disabled={busy || updating || checkingUpdate || (manualDownloadUrl !== undefined && !manualDownloadUrl)}
                onClick={() => onUpdateAndRestart(updateTargetVersion)}
                style={{
                  ...outlineButton({ height: 28, padding: "0 11px", fontSize: 11.5 }),
                  color: COLORS.accent,
                  borderColor: COLORS.accentBorder,
                  marginRight: 4,
                }}
              >
                <ArrowClockwise size={13} weight="bold" />
                {manualDownloadUrl !== undefined ? "Download update" : "Update"}
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
            {parkedLine ? parkedLine.action : null}
            {!parkedLine && !row.connected && section !== "unavailable" && !updatePhase && (!targetConnecting || connectingStale) ? (
              <button
                type="button"
                disabled={locked}
                onClick={() => onConnect(target.id)}
                style={{ ...connectButtonStyle, marginRight: 4, opacity: locked ? 0.5 : 1, cursor: locked ? "not-allowed" : "pointer" }}
              >
                <PlugsConnected size={13} weight="bold" />
                {connectingStale ? "Retry" : heldElsewhere ? HELD_ELSEWHERE_ACTION_LABEL : "Connect"}
              </button>
            ) : null}
            <MachineActionsMenu
              label={`Actions for ${target.name}`}
              actions={[
                ...(section !== "unavailable"
                  ? [{
                      key: "test",
                      ...testItem,
                      disabled: busy,
                      onSelect: () => onToggleTest(target.id),
                    },
                    // The settings are this computer's SSH route to the
                    // machine. ADE Web reaches it through the relay only, so
                    // it has none to edit.
                    ...(isWebClientMode() ? [] : [{
                      key: "edit",
                      label: formOpen ? "Close settings" : "Rename and settings",
                      ariaLabel: "Edit",
                      icon: <PencilSimple size={14} />,
                      disabled: locked,
                      onSelect: () => onToggleEdit(target),
                    }])]
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
                ...extraActions,
                ...(hideLocalRemove
                  ? []
                  : [{
                      key: "remove",
                      label: "Remove from this computer",
                      ariaLabel: `Remove ${target.name}`,
                      icon: <Trash size={14} />,
                      danger: true,
                      disabled: busy,
                      onSelect: () => onRemove(target.id),
                    }]),
              ]}
            />
          </div>
        </div>

        {footer}

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

        {inlineErrorCard ? errorCardFor(inlineErrorCard, onDismissError ?? null) : null}

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

        <HostStorageWaitNote
          wait={status?.hostStorageWait}
          machineName={target.name?.trim() || target.hostname}
        />

        <HostStallNote
          stall={status?.hostStall}
          machineName={target.name?.trim() || target.hostname}
        />

        {/* Which routes were tried lives with the failure, or under Test connection. */}
        {inlineErrorCard ? (
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
          {/* Why it is offline: the failure the row only names, opened from ···. */}
          {shownErrorCard && !inlineErrorCard ? errorCardFor(shownErrorCard, () => onToggleTest(target.id)) : null}
          {!inlineErrorCard ? (
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
                {BRAND.NAME} will reconnect when the app opens. LAN and Tailscale work without signing in; {BRAND.NAME} Relay needs the same account on both computers.
              </span>
            </span>
          </label>
          {onSlowLinkModeChange ? (
            <div
              style={{
                display: "grid",
                gap: 6,
                color: COLORS.textPrimary,
                fontFamily: SANS_FONT,
                fontSize: 12,
              }}
            >
              <span>Slow connection mode</span>
              <div style={{ justifySelf: "start" }}>
                <SettingsSegmented<SlowLinkPreference>
                  value={normalizeSlowLinkPreference(target.slowLinkMode)}
                  options={SLOW_LINK_MODE_OPTIONS}
                  disabled={busy}
                  ariaLabel="Slow connection mode"
                  onChange={(mode) => onSlowLinkModeChange(target.id, mode)}
                />
              </div>
              <span style={helperTextStyle}>
                On a slow or unsteady link to this machine, pictures load when you click them and terminals show what you type before the machine echoes it. Automatic turns it on from the measured link.
              </span>
            </div>
          ) : null}
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
