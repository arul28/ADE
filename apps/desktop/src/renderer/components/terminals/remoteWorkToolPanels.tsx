import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { remoteWorkUseKey, type RemoteWorkCopyUse } from "../../../shared/chatRemoteWork";
import { machineNameForBinding } from "../../../shared/machineIdentity";
import { useRemoteWorkReach } from "../../lib/remoteWorkPins";
import { useAppStore } from "../../state/appStore";
import type { AppleDriverChat } from "../apple/AppleDevicePane";
import { Banner } from "../ui/notice/Banner";
import { macDesktopStatusKey, useMacDesktopStatusEntry } from "../chat/macDesktopStatusStore";
import { HELD_ELSEWHERE_ACTION_LABEL, HELD_ELSEWHERE_STATE_LABEL } from "../remoteTargets/remoteMachineModel";
import { RemoteTargetSwitcher, useRemoteTargetChoice } from "./RemoteTargetSwitcher";
import { WORK_TOOL_CHROME_CHIP, WorkToolEmptyLine } from "./workToolChrome";

/** Says whether a use's machine has a device for it (`useRemoteTargetChoice`'s `reportDevice`). */
export type ReportRemoteDevice = (use: RemoteWorkCopyUse, hasDevice: boolean) => void;

/**
 * A tool's view of the chat's work copy on another machine, once this window
 * can reach that machine.
 *
 * The agent's commands go brain to brain, so the chat can drive a machine
 * this window never connected to. Mounted only while the tool is on screen,
 * this connects to it then (and on Retry), says so while it does, and hands
 * the pin for that machine to `children` once it can.
 */
function RemoteWorkReachGate({
  use,
  children,
}: {
  use: RemoteWorkCopyUse;
  children: (pin: OpenProjectBinding) => ReactNode;
}) {
  const reach = useRemoteWorkReach(use, true);
  if (reach.kind === "pin") return <>{children(reach.pin)}</>;
  if (reach.kind === "connecting") {
    return <WorkToolEmptyLine title={`Connecting to ${use.machineName}…`} testId="remote-work-connecting" />;
  }
  if (reach.kind === "failed") {
    return (
      <div className="p-3" data-testid="remote-work-connect-failed">
        <Banner
          layout="inline"
          model={{
            id: `remote-work-connect-${remoteWorkUseKey(use)}`,
            tone: "warning",
            title: `Couldn't connect to ${use.machineName}`,
            detail: reach.message,
            actions: [{ label: "Retry", onClick: reach.retry }],
            // A machine that is off or out of reach is not an ADE fault.
            report: false,
          }}
        />
      </div>
    );
  }
  if (reach.kind === "held_elsewhere") {
    // Not "disconnected": nobody here disconnected it, and Connect would
    // read as doing nothing. The Connections panel's state and action.
    return (
      <WorkToolEmptyLine
        title={`${use.machineName} · ${HELD_ELSEWHERE_STATE_LABEL}`}
        testId="remote-work-held-elsewhere"
        action={(
          <button type="button" className={WORK_TOOL_CHROME_CHIP} onClick={reach.useHere}>
            {HELD_ELSEWHERE_ACTION_LABEL}
          </button>
        )}
      />
    );
  }
  if (reach.kind === "disconnected") {
    return (
      <WorkToolEmptyLine
        title={`${use.machineName} is disconnected in this window`}
        testId="remote-work-disconnected"
        action={(
          <button type="button" className={WORK_TOOL_CHROME_CHIP} onClick={reach.retry}>
            Connect
          </button>
        )}
      />
    );
  }
  return <WorkToolEmptyLine title={`Update ADE on ${use.machineName} to see this chat's work there`} />;
}

/**
 * A tool that shows this lane's surface, or the one this chat drives on
 * another machine through its work copy there (`ade apple … --machine`,
 * `ade android … --machine`, `ade screen … --machine`,
 * `ade app-control … --machine`), chosen with one row when there is more than
 * one. The other machine's surface is read through that machine's pin, keyed
 * by the work copy's lane, once this window can reach it.
 */
export function RemoteOrLaneTool({
  uses,
  laneAvailable,
  remoteLabel,
  testId,
  stickyKey,
  renderLane,
  renderRemote,
}: {
  uses: RemoteWorkCopyUse[];
  laneAvailable: boolean;
  remoteLabel: string;
  testId: string;
  /** The chat and tool a person's pick of target holds for (`useRemoteTargetChoice`); null with no chat. */
  stickyKey: string | null;
  renderLane: () => ReactNode;
  /**
   * `reportDevice` says whether that machine has a device for this use, from
   * a read the panel makes anyway; the default target skips one that has none.
   */
  renderRemote: (use: RemoteWorkCopyUse, pin: OpenProjectBinding, reportDevice: ReportRemoteDevice) => ReactNode;
}) {
  const { options, chosen, choose, reportDevice } = useRemoteTargetChoice(uses, laneAvailable, stickyKey);
  const use = chosen?.use ?? null;
  if (!use && options.length <= 1) return <>{renderLane()}</>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RemoteTargetSwitcher
        options={options}
        chosenKey={chosen?.key ?? null}
        onChoose={choose}
        remoteLabel={remoteLabel}
        testId={testId}
      />
      <div className="min-h-0 flex-1">
        {use ? (
          <RemoteWorkReachGate key={remoteWorkUseKey(use)} use={use}>
            {(pin) => renderRemote(use, pin, reportDevice)}
          </RemoteWorkReachGate>
        ) : renderLane()}
      </div>
    </div>
  );
}

/**
 * The chat the pane serves, as a driver of a device: its title, and the
 * machine it runs on only when that is not this computer. Lets the pane say
 * which chat is driving instead of naming a computer by its platform.
 */
export function useDriverChat(props: {
  activeSession: TerminalSessionSummary | null;
  panelSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
}): AppleDriverChat | null {
  const bound = useAppStore((s) => s.projectBinding);
  const { activeSession, panelSessionId, runtimePin } = props;
  if (!panelSessionId) return null;
  const binding = runtimePin ?? bound;
  return {
    sessionId: panelSessionId,
    title: activeSession?.id === panelSessionId ? activeSession.title?.trim() || null : null,
    machineName: binding?.kind === "remote" ? machineNameForBinding(binding) : null,
  };
}

type RemoteDeviceState = "loading" | "device" | "none" | { error: string };

/** A failed refresh keeps a device already shown: unmounting it would drop its stream. */
function failedRead(error: unknown): (current: RemoteDeviceState) => RemoteDeviceState {
  return (current) => (current === "device" ? current : { error: error instanceof Error ? error.message : String(error) });
}

/** How one kind of device on another machine is read and followed. */
type RemoteDeviceKind = {
  /** In ids and sentences: "simulator", "Android emulator". */
  noun: string;
  idPrefix: string;
  /** Whether the copy's lane there has a device now. */
  read: (laneId: string, pin: OpenProjectBinding) => Promise<boolean> | undefined;
  /** Calls `changed` when the agent starts or gives back the device there. */
  follow: (laneId: string, pin: OpenProjectBinding, changed: () => void) => (() => void) | undefined;
};

const REMOTE_SIMULATOR: RemoteDeviceKind = {
  noun: "simulator",
  idPrefix: "remote-simulator",
  read: (laneId, pin) => window.ade?.iosSimulator?.deviceList?.({ laneId, installed: false }, pin)
    .then((listed) => Boolean(listed?.lane)),
  follow: (laneId, pin, changed) => window.ade?.iosSimulator?.onEvent?.((event) => {
    if (event.type === "apple.device.state" && (!event.laneId || event.laneId === laneId)) changed();
  }, pin),
};

const REMOTE_ANDROID: RemoteDeviceKind = {
  noun: "Android emulator",
  idPrefix: "remote-android",
  read: (laneId, pin) => window.ade?.androidEmulator?.getStatus?.({ laneId }, pin)
    .then((status) => Boolean(status?.lane?.device)),
  follow: (laneId, pin, changed) => window.ade?.androidEmulator?.onEvent?.((event) => {
    if (event.type === "android.device.state" && event.laneId === laneId) changed();
  }, pin),
};

type RemoteDeviceProps = {
  use: RemoteWorkCopyUse;
  remotePin: OpenProjectBinding;
  renderDevice: () => ReactNode;
  /** Hears whether the copy's lane there has a device, from each read. */
  onDeviceState?: ReportRemoteDevice;
};

/**
 * The other machine's device for this chat's work copy, once that copy has
 * one. Nothing is started or picked from here: with no device yet, it says so.
 * `renderDevice` draws the device through `remotePin` on the copy's lane.
 */
function RemoteWorkDevice({ use, remotePin, renderDevice, onDeviceState, kind }: RemoteDeviceProps & { kind: RemoteDeviceKind }) {
  const laneId = use.workCopyLaneId;
  const [state, setState] = useState<RemoteDeviceState>("loading");
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void kind.read(laneId, remotePin)
        ?.then((has) => { if (!cancelled) setState(has ? "device" : "none"); })
        .catch((error: unknown) => { if (!cancelled) setState(failedRead(error)); });
    };
    read();
    const unsubscribe = kind.follow(laneId, remotePin, read);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // Keyed by the component's key (pin key + lane); the pin object is stable for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId, kind]);
  const hasDevice = state === "device" ? true : state === "none" ? false : null;
  useEffect(() => {
    if (hasDevice !== null) onDeviceState?.(use, hasDevice);
  }, [hasDevice, onDeviceState, use]);
  if (state === "loading") return <WorkToolEmptyLine title={`Reading ${use.machineName}…`} />;
  if (state === "none") return <WorkToolEmptyLine title={`No ${kind.noun} on ${use.machineName} for this chat right now`} />;
  if (typeof state === "object") {
    return (
      <div className="p-3">
        <Banner
          layout="inline"
          model={{ id: `${kind.idPrefix}-${remoteWorkUseKey(use)}`, tone: "error", title: `Couldn't read the ${kind.noun} on ${use.machineName}`, error: state.error }}
        />
      </div>
    );
  }
  return <>{renderDevice()}</>;
}

/** The other machine's simulator for this chat's work copy (`RemoteWorkDevice`). */
export function RemoteWorkSimulator(props: RemoteDeviceProps) {
  return <RemoteWorkDevice {...props} kind={REMOTE_SIMULATOR} />;
}

/** The other machine's Android emulator for this chat's work copy (`RemoteWorkDevice`). */
export function RemoteWorkAndroid(props: RemoteDeviceProps) {
  return <RemoteWorkDevice {...props} kind={REMOTE_ANDROID} />;
}

/**
 * Says whether the other machine's lane screen for this use is up, from the
 * status the screen pane itself reads into the store; reads nothing itself.
 */
export function RemoteScreenDeviceReport({
  use,
  pin,
  onDeviceState,
}: {
  use: RemoteWorkCopyUse;
  pin: OpenProjectBinding;
  onDeviceState: ReportRemoteDevice;
}) {
  const entry = useMacDesktopStatusEntry(macDesktopStatusKey(use.workCopyLaneId, pin));
  const known = entry?.confirmed !== false && entry?.status != null;
  const hasDevice = known ? Boolean(entry?.status?.display) : null;
  useEffect(() => {
    if (hasDevice !== null) onDeviceState(use, hasDevice);
  }, [hasDevice, onDeviceState, use]);
  return null;
}
