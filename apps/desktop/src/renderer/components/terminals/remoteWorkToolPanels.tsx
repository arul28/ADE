import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { remoteWorkUseKey, type RemoteWorkCopyUse } from "../../../shared/chatRemoteWork";
import { machineNameForBinding } from "../../../shared/machineIdentity";
import { useRemoteWorkReach } from "../../lib/remoteWorkPins";
import { useAppStore } from "../../state/appStore";
import type { AppleDriverChat } from "../apple/AppleDevicePane";
import { Banner } from "../ui/notice/Banner";
import { RemoteTargetSwitcher, useRemoteTargetChoice } from "./RemoteTargetSwitcher";
import { WORK_TOOL_CHROME_CHIP, WorkToolEmptyLine } from "./workToolChrome";

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
  renderLane,
  renderRemote,
}: {
  uses: RemoteWorkCopyUse[];
  laneAvailable: boolean;
  remoteLabel: string;
  testId: string;
  renderLane: () => ReactNode;
  renderRemote: (use: RemoteWorkCopyUse, pin: OpenProjectBinding) => ReactNode;
}) {
  const { options, chosen, choose } = useRemoteTargetChoice(uses, laneAvailable);
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
            {(pin) => renderRemote(use, pin)}
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

/**
 * The other machine's simulator for this chat's work copy, once that copy
 * has one. Nothing is started from here: with no device yet, it says so.
 * `renderDevice` draws the device through `remotePin` on the copy's lane.
 */
export function RemoteWorkSimulator({
  use,
  remotePin,
  renderDevice,
}: {
  use: RemoteWorkCopyUse;
  remotePin: OpenProjectBinding;
  renderDevice: () => ReactNode;
}) {
  const laneId = use.workCopyLaneId;
  const [state, setState] = useState<RemoteDeviceState>("loading");
  useEffect(() => {
    let cancelled = false;
    const api = window.ade?.iosSimulator;
    const read = () => {
      void api?.deviceList?.({ laneId, installed: false }, remotePin)
        .then((listed) => { if (!cancelled) setState(listed?.lane ? "device" : "none"); })
        .catch((error: unknown) => { if (!cancelled) setState(failedRead(error)); });
    };
    read();
    // The agent starts or gives back the device there; follow it.
    const unsubscribe = api?.onEvent?.((event) => {
      if (event.type === "apple.device.state" && (!event.laneId || event.laneId === laneId)) read();
    }, remotePin);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // Keyed by the component's key (pin key + lane); the pin object is stable for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId]);
  if (state === "loading") return <WorkToolEmptyLine title={`Reading ${use.machineName}…`} />;
  if (state === "none") return <WorkToolEmptyLine title={`No simulator on ${use.machineName} for this chat right now`} />;
  if (typeof state === "object") {
    return (
      <div className="p-3">
        <Banner
          layout="inline"
          model={{ id: `remote-simulator-${remoteWorkUseKey(use)}`, tone: "error", title: `Couldn't read the simulator on ${use.machineName}`, error: state.error }}
        />
      </div>
    );
  }
  return <>{renderDevice()}</>;
}

/**
 * The other machine's emulator for this chat's work copy, once that copy has
 * one. Nothing is started or picked from here: with no device yet, it says so.
 * `renderDevice` draws the device through `remotePin` on the copy's lane.
 */
export function RemoteWorkAndroid({
  use,
  remotePin,
  renderDevice,
}: {
  use: RemoteWorkCopyUse;
  remotePin: OpenProjectBinding;
  renderDevice: () => ReactNode;
}) {
  const laneId = use.workCopyLaneId;
  const [state, setState] = useState<RemoteDeviceState>("loading");
  useEffect(() => {
    let cancelled = false;
    const api = window.ade?.androidEmulator;
    const read = () => {
      void api?.getStatus?.({ laneId }, remotePin)
        .then((status) => { if (!cancelled) setState(status?.lane?.device ? "device" : "none"); })
        .catch((error: unknown) => { if (!cancelled) setState(failedRead(error)); });
    };
    read();
    // The agent starts or gives back the device there; follow it.
    const unsubscribe = api?.onEvent?.((event) => {
      if (event.type === "android.device.state" && event.laneId === laneId) read();
    }, remotePin);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // Keyed by the component's key (pin key + lane); the pin object is stable for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId]);
  if (state === "loading") return <WorkToolEmptyLine title={`Reading ${use.machineName}…`} />;
  if (state === "none") return <WorkToolEmptyLine title={`No Android emulator on ${use.machineName} for this chat right now`} />;
  if (typeof state === "object") {
    return (
      <div className="p-3">
        <Banner
          layout="inline"
          model={{ id: `remote-android-${remoteWorkUseKey(use)}`, tone: "error", title: `Couldn't read the Android emulator on ${use.machineName}`, error: state.error }}
        />
      </div>
    );
  }
  return <>{renderDevice()}</>;
}
