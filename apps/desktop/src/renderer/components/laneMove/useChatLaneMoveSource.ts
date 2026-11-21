import { useMemo } from "react";
import type { LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { laneDisplayName } from "../../../shared/laneDisplayName";
import { useAppStore } from "../../state/appStore";
import { useAdeCloudLaneForBinding, useMachineLabelForBinding } from "../../state/adeCloudLaneIndex";
import { adeCloudMoveSource } from "../../state/adeCloudLaneWake";
import { useCloudLaneWithoutComputerForChat } from "../chat/AdeCloudComposerParts";
import type { LaneMoveSourceKind } from "./laneMoveModel";
import type { LaneMoveSource } from "./useLaneMoveTargets";

/**
 * Where an open chat's lane can move from, for the composer's machine chip;
 * null when the chat can't move its lane (no chat yet, no lane, a CTO or
 * other host surface, which passes `enabled: false`).
 *
 * An ADE Cloud lane with an awake computer moves live, like any machine, and
 * its computer is deleted after. An asleep one waits for the person to wake
 * it. A lane whose computer was deleted comes back from its saved copies.
 */
export function useChatLaneMoveSource(input: {
  sessionId: string | null;
  laneId: string | null;
  /** The chat's own machine. */
  pin: OpenProjectBinding | null;
  enabled: boolean;
}): LaneMoveSource | null {
  const { sessionId, laneId, pin, enabled } = input;
  const cloudLane = useAdeCloudLaneForBinding(enabled ? pin : null);
  const keptLane = useCloudLaneWithoutComputerForChat(pin, enabled && Boolean(sessionId));
  const machineName = useMachineLabelForBinding(pin);
  const lane = useAppStore((s) => (laneId ? findLane(s.lanes, s.crossMachineLanesByMachineId, laneId) : null));
  // The cloud state is read when the chip renders; the index and the saved
  // chat locations it reads are the ones the chip's own label follows.
  const cloudKind = cloudLane && sessionId ? adeCloudMoveSource(pin, sessionId) : null;
  const pinKey = pin?.key ?? null;
  const laneName = lane ? laneDisplayName(lane) : null;

  return useMemo<LaneMoveSource | null>(() => {
    if (!enabled || !sessionId) return null;
    if (keptLane) {
      return {
        kind: "cloudGone",
        laneId: keptLane.laneId,
        laneName: keptLane.laneName,
        pin,
        sessionId,
        machineKey: keptLane.formerMachineKey,
        machineName: "ADE Cloud",
        cloudInstanceId: null,
      };
    }
    if (!laneId) return null;
    if (cloudLane) {
      const kind: LaneMoveSourceKind = cloudKind === "gone" ? "cloudGone" : cloudKind === "resting" ? "cloudAsleep" : "cloud";
      return {
        kind,
        laneId: kind === "cloudGone" ? cloudLane.laneId : laneId,
        laneName: cloudLane.laneName,
        pin,
        sessionId,
        machineKey: null,
        machineName,
        cloudInstanceId: cloudLane.instanceId,
      };
    }
    return {
      kind: "own",
      laneId,
      laneName: laneName ?? "This lane",
      pin,
      sessionId,
      machineKey: null,
      machineName,
      cloudInstanceId: null,
    };
    // Keyed on the pin's key: a rebuilt pin is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionId, laneId, pinKey, keptLane, cloudLane?.laneId, cloudLane?.laneName, cloudLane?.instanceId, cloudKind, laneName, machineName]);
}

function findLane(
  lanes: readonly LaneSummary[],
  slices: Record<string, { lanes: LaneSummary[] }>,
  laneId: string,
): LaneSummary | null {
  const own = lanes.find((lane) => lane.id === laneId);
  if (own) return own;
  for (const slice of Object.values(slices)) {
    const found = slice.lanes.find((lane) => lane.id === laneId);
    if (found) return found;
  }
  return null;
}
