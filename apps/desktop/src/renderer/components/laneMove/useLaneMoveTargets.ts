import { useEffect, useMemo, useState } from "react";
import type {
  AgentChatCrossMachineHandoffOptionsResult,
  OpenProjectBinding,
} from "../../../shared/types";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME, machineNameForBinding } from "../../../shared/machineIdentity";
import { useAppStore } from "../../state/appStore";
import { isAdeCloudComputer, useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { readLocalMachineKey } from "../chat/useMachineFacts";
import { ownMoveMachines } from "../chat/crossMachineMoveTargets";
import { laneMoveRestores, orderLaneMoveMachines, type LaneMoveSourceKind } from "./laneMoveModel";

/** One place a lane can move to, from either kind of move. */
export type LaneMoveTarget = {
  /** A live move names this machine key; a move from saved copies keys it by its slice. */
  key: string;
  name: string;
  thisComputer: boolean;
  /** It can take the lane now. */
  ready: boolean;
  /** Why it can't, when it can't. */
  reason: string | null;
  /** The project is there; false: a live move clones it first; null: not known. */
  hasRepository: boolean | null;
  /** A move from saved copies runs on this pin (the project on that machine). */
  pin: OpenProjectBinding | null;
};

/** Where the lane is, as the move needs it. */
export type LaneMoveSource = {
  kind: LaneMoveSourceKind;
  laneId: string;
  laneName: string;
  /** The lane's own machine: a live move runs there. */
  pin: OpenProjectBinding | null;
  /** A chat on the lane: a live move reads its options through it. */
  sessionId: string | null;
  machineKey: string | null;
  machineName: string;
  /** The lane's ADE Cloud computer, deleted once the move is done. */
  cloudInstanceId: string | null;
};

type LiveOptions = Pick<AgentChatCrossMachineHandoffOptionsResult, "machines" | "blockers" | "changes">;

export type LaneMoveTargetsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      targets: LaneMoveTarget[];
      /** A live move: what blocks it, and the work that travels. */
      blockers: AgentChatCrossMachineHandoffOptionsResult["blockers"];
      changes: AgentChatCrossMachineHandoffOptionsResult["changes"] | null;
    };

type LiveRead = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; options: LiveOptions };

function errorText(error: unknown): string {
  return stripElectronErrorWrapper(error instanceof Error ? error.message : String(error));
}

function sameKey(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function remoteHostname(binding: OpenProjectBinding): string | null {
  return binding.kind === "remote" ? binding.hostname ?? null : null;
}

/**
 * The targets of a lane move, read when `enabled` turns on (the menu opens).
 * A live move asks the lane's own brain, which knows the person's machines
 * and whether each has the repository. A move from saved copies runs on the
 * destination, so its targets are the machines this window can already
 * address for this project: this computer, the tab's machine, and each other
 * computer of the person's with the project open in ADE. Nothing is polled.
 */
export function useLaneMoveTargets(source: LaneMoveSource, enabled: boolean): LaneMoveTargetsState {
  const [live, setLive] = useState<LiveRead>({ status: "loading" });
  const [thisMachineKey, setThisMachineKey] = useState<string | null>(null);
  const restores = laneMoveRestores(source.kind);
  const cloudIndex = useAdeCloudLaneComputers();
  const projectBinding = useAppStore((s) => s.projectBinding);
  const slices = useAppStore((s) => s.crossMachineLanesByMachineId);
  const pinKey = source.pin?.key ?? null;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void readLocalMachineKey().then((key) => { if (!cancelled) setThisMachineKey(key); });
    return () => { cancelled = true; };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || restores) return;
    const pin = source.pin;
    const sessionId = source.sessionId;
    if (!pin || !sessionId) {
      setLive({ status: "error", message: "This lane has no chat yet. Start a chat on it, then move it." });
      return;
    }
    let cancelled = false;
    setLive({ status: "loading" });
    window.ade.agentChat.getCrossMachineHandoffOptions({ sourceSessionId: sessionId }, pin)
      .then((result) => {
        if (!cancelled) setLive({ status: "ready", options: result });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLive({ status: "error", message: errorText(error) });
      });
    return () => { cancelled = true; };
    // The pin's key, not the object: a rebuilt pin is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, restores, pinKey, source.sessionId]);

  return useMemo<LaneMoveTargetsState>(() => {
    if (restores) {
      const targets: LaneMoveTarget[] = [];
      const seen = new Set<string>();
      const add = (target: LaneMoveTarget) => {
        if (!target.pin || seen.has(target.pin.key)) return;
        seen.add(target.pin.key);
        targets.push(target);
      };
      const thisPin = projectBinding?.kind === "local" ? projectBinding : slices[THIS_MACHINE_ID]?.binding ?? null;
      if (thisPin) {
        add({ key: THIS_MACHINE_ID, name: THIS_MACHINE_NAME, thisComputer: true, ready: true, reason: null, hasRepository: true, pin: thisPin });
      } else {
        targets.push({
          key: THIS_MACHINE_ID,
          name: THIS_MACHINE_NAME,
          thisComputer: true,
          ready: false,
          reason: "Open this project on this computer first.",
          hasRepository: false,
          pin: null,
        });
      }
      if (projectBinding?.kind === "remote" && !isAdeCloudComputer({ hostname: remoteHostname(projectBinding) }, cloudIndex)) {
        const name = machineNameForBinding(projectBinding);
        add({ key: projectBinding.targetId, name, thisComputer: false, ready: true, reason: null, hasRepository: true, pin: projectBinding });
      }
      for (const slice of Object.values(slices)) {
        const binding = slice.binding;
        if (slice.machineId === THIS_MACHINE_ID || slice.computerGone || !binding) continue;
        if (isAdeCloudComputer({ hostname: remoteHostname(binding) }, cloudIndex)) continue;
        add({
          key: slice.machineId,
          name: slice.machineName,
          thisComputer: false,
          ready: slice.online,
          reason: slice.online ? null : `${slice.machineName} is not on.`,
          hasRepository: true,
          pin: binding,
        });
      }
      return { status: "ready", targets, blockers: [], changes: null };
    }
    if (live.status !== "ready") return live;
    const ordered = orderLaneMoveMachines(ownMoveMachines(live.options.machines, cloudIndex), {
      thisMachineKey,
      sourceMachineKey: source.machineKey,
    });
    return {
      status: "ready",
      blockers: live.options.blockers,
      changes: live.options.changes,
      targets: ordered.map((machine) => ({
        key: machine.machineKey,
        name: machine.name,
        thisComputer: sameKey(machine.machineKey, thisMachineKey),
        ready: machine.online && !machine.unavailableReason,
        reason: machine.unavailableReason ?? (machine.online ? null : `${machine.name} is not on.`),
        hasRepository: machine.hasRepository,
        pin: null,
      })),
    };
  }, [restores, projectBinding, slices, cloudIndex, live, thisMachineKey, source.machineKey]);
}
