import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeRemoteWorkOnRow } from "../../../shared/chatRemoteWork";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { deviceKindRunsOnPlatform, type DeviceKind } from "../../../shared/types/deviceSources";
import { useRemoteWorkPinResolver } from "../../lib/remoteWorkPins";
import { setChatDeviceSource, useChatDeviceSources } from "./chatDeviceSources";
import { cleanUpRemoteWork } from "./remoteWorkCleanup";
import type { ToolMachine } from "./useToolMachines";
import { currentRemoteDeviceMachines, leftoverMachines } from "./workToolCatalog";

/**
 * Where this chat's devices are, and what it left on other machines: the tools
 * pane's device choice and Clean up wiring.
 *
 * - Where its devices are NOW: its device choice per kind (the same setting
 *   as `ade devices use`, kept by the chat's brain), read on the chat's
 *   machine, else the machine its CURRENT turn drives that kind on
 *   (`--machine` on each command). Never an earlier turn's machine.
 * - A pick in the open tool's machine row sets that choice. When the chat's
 *   brain keeps no choices (`unsupported`: an older ADE there), the pick is
 *   this panel's own view instead (`viewOnly`), so a device on another
 *   machine stays viewable after the turn that drove it.
 * - What it left on machines it is not using now: one Clean up line.
 *
 * `session` is the Work row on screen (its `remoteWork` and the machines its
 * turn uses now).
 */
export function useWorkToolCatalogState(args: {
  sessionId: string | null;
  chatPin: OpenProjectBinding | null;
  active: boolean;
  machines: readonly ToolMachine[];
  session: TerminalSessionSummary | null;
}) {
  const { sessionId, chatPin, active, machines, session } = args;
  const deviceSources = useChatDeviceSources(sessionId, chatPin, active);
  const chatPinKey = chatPin?.key ?? null;
  const chatPinRef = useRef(chatPin);
  chatPinRef.current = chatPin;

  const [viewPicks, setViewPicks] = useState<Partial<Record<DeviceKind, ToolMachine>>>({});
  useEffect(() => { setViewPicks({}); }, [sessionId, chatPinKey]);
  const viewOnly = Boolean(sessionId) && deviceSources.unsupported;
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;

  const activeRemoteUses = useMemo(() => activeRemoteWorkOnRow(session), [session]);
  const chosenRemote = useMemo(() => {
    const out = currentRemoteDeviceMachines(deviceSources.sources, machines, activeRemoteUses);
    if (!viewOnly) return out;
    for (const [kind, pick] of Object.entries(viewPicks) as Array<[DeviceKind, ToolMachine]>) {
      if (pick.isChat) delete out[kind];
      else if (deviceKindRunsOnPlatform(kind, pick.platform)) out[kind] = pick;
    }
    return out;
  }, [activeRemoteUses, deviceSources.sources, machines, viewOnly, viewPicks]);

  // The open tool's machine switch: `ade devices use <kind>@<machine>`, on the
  // chat's machine (its pin), the same setting the agent's commands read and
  // the tile shows. A view-only pick changes this panel alone.
  const chooseDeviceMachine = useCallback((kind: DeviceKind, machine: ToolMachine) => {
    if (!sessionId) return;
    if (viewOnlyRef.current) {
      setViewPicks((current) => ({ ...current, [kind]: machine }));
      return;
    }
    void setChatDeviceSource({
      sessionId,
      pin: chatPinRef.current,
      kind,
      machine: machine.isChat ? null : { key: machine.key, name: machine.name },
    });
  }, [sessionId]);

  let chooseUnavailableReason: string | null = null;
  if (!sessionId) chooseUnavailableReason = "A terminal session picks the machine on each command (--machine).";
  else if (viewOnly) chooseUnavailableReason = "This chat's machine can't keep a device choice; a pick here only changes what you see.";

  const remoteWork = session?.remoteWork;
  const [cleanedMachines, setCleanedMachines] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { setCleanedMachines(new Set()); }, [sessionId, chatPinKey]);
  const activeMachineKeys = session?.remoteWorkActiveMachineKeys;
  const leftovers = useMemo(
    () => leftoverMachines(remoteWork, deviceSources.sources, activeMachineKeys ?? [], cleanedMachines),
    [activeMachineKeys, cleanedMachines, deviceSources.sources, remoteWork],
  );
  const resolveLeftoverPin = useRemoteWorkPinResolver(active && leftovers.length > 0);
  const [cleaningUp, setCleaningUp] = useState(false);
  const cleanUp = useCallback(() => {
    if (!sessionId || cleaningUp) return;
    setCleaningUp(true);
    void cleanUpRemoteWork({ sessionId, leftovers, resolvePin: resolveLeftoverPin })
      .then((cleaned) => {
        if (!cleaned.length) return;
        setCleanedMachines((current) => {
          const next = new Set(current);
          for (const key of cleaned) next.add(key);
          return next;
        });
      })
      .finally(() => setCleaningUp(false));
  }, [cleaningUp, leftovers, sessionId, resolveLeftoverPin]);

  return {
    sources: deviceSources.sources,
    /** Re-reads the choice after the agent's own `ade devices use`. */
    refreshDeviceSources: deviceSources.refresh,
    chosenRemote,
    chooseDeviceMachine,
    /** A machine can be picked in the open tool's row (kept, or for this view only). */
    canChoose: Boolean(sessionId),
    viewOnly,
    chooseUnavailableReason,
    leftovers,
    cleaningUp,
    onCleanUp: sessionId ? cleanUp : null,
  };
}
