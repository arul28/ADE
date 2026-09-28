/**
 * The PRs workflow views (Rebase/Merge, Integration) across every machine.
 *
 * Rebase needs, auto-rebase statuses and integration proposals live in the
 * `.ade` database of the machine that owns the lanes, so the tab's machine can
 * only report its own. This module reads every other machine's copy through
 * the shared foreign-read loop (timed out, each landing on its own, never
 * gating the tab machine's list), tags every item with its machine, and hands
 * callers one routing answer per lane or proposal: which pin to pass, whether
 * that machine is reachable, and which chip to draw. Routing goes through the
 * shared lane router (`state/laneMachineRouting`) with the machine the item
 * was read from, so a lane id that exists on two machines can never be
 * resolved to the wrong one.
 */

import { useEffect, useMemo, useRef } from "react";
import type {
  AutoRebaseLaneStatus,
  IntegrationProposal,
  LaneSummary,
  RebaseNeed,
} from "../../../../shared/types";
import {
  createLaneMachineRouter,
  machineChipFor,
  shouldShowMachineChips,
  useAllMachineLanes,
  type LaneMachine,
  type MachineChipModel,
} from "../../../state/laneMachineRouting";
import { machineScopedId, useForeignMachineReads, type PinnedMachine } from "../../../state/foreignMachineReads";
import { withMachineTimeout } from "../../../state/projectMachines";

/** Where one workflow item's calls go: a view of its machine, plus its chip. */
export type WorkflowItemMachine = Pick<LaneMachine, "machineId" | "machineName" | "pin" | "online" | "routable"> & {
  /** Null on a one-machine project. */
  chip: MachineChipModel | null;
};

type ForeignMachineWorkflowState = {
  rebaseNeeds: RebaseNeed[];
  autoRebaseStatuses: AutoRebaseLaneStatus[];
  proposals: IntegrationProposal[];
  workflows: IntegrationProposal[];
};

export type WorkflowMachines = {
  machines: readonly LaneMachine[];
  /**
   * Every machine's lanes, the tab machine's first. Other machines' lanes carry
   * view ids (see `realLaneId`), so two machines' same-id lanes both appear.
   */
  lanes: LaneSummary[];
  /** Other machines' items, under view ids (lane ids for rebase items, proposal ids for proposals). */
  foreignRebaseNeeds: RebaseNeed[];
  foreignAutoRebaseStatuses: AutoRebaseLaneStatus[];
  foreignProposals: IntegrationProposal[];
  foreignWorkflows: IntegrationProposal[];
  /**
   * The machine that owns a lane (bare id or view id). `null`/empty is the
   * tab's machine. An id that neither the tab's machine nor any other machine
   * reports is unroutable: sending it anywhere would address a lane nobody
   * listed.
   */
  machineForLane: (laneId: string | null | undefined) => WorkflowItemMachine | null;
  /** The machine that owns a proposal/workflow (the tab's machine when not foreign). */
  machineForProposal: (proposalId: string | null | undefined) => WorkflowItemMachine | null;
  /** The id to send to the lane's own machine: a view id's real lane id, else the id itself. */
  realLaneId: (laneId: string) => string;
  /** The id to send to the proposal's own machine. */
  realProposalId: (proposalId: string) => string;
  /** The list id for a proposal a machine just returned (a view id unless it is the tab's machine). */
  viewProposalId: (machineId: string | null | undefined, proposalId: string) => string;
  /** The real lanes of the machine that owns a proposal, to name its contents' lane ids. */
  lanesForProposal: (proposalId: string | null | undefined) => LaneSummary[];
  /** Re-read every other machine now (after an action, on Refresh). */
  refreshForeign: () => void;
  /** Re-read one machine (after an action that ran there). */
  refreshMachine: (machineId: string) => void;
};

/** Read one machine's workflow items. A call that fails keeps what the machine last reported. */
async function readWorkflowState(
  machine: PinnedMachine,
  previous: ForeignMachineWorkflowState | undefined,
): Promise<ForeignMachineWorkflowState> {
  const settle = <T,>(promise: Promise<T>) =>
    withMachineTimeout(promise, machine.machineName).catch(() => null);
  const [needs, statuses, proposals, workflows] = await Promise.all([
    settle(window.ade.rebase.scanNeeds(machine.pin)),
    settle(window.ade.lanes.listAutoRebaseStatuses(machine.pin)),
    settle(window.ade.prs.listProposals(machine.pin)),
    settle(window.ade.prs.listIntegrationWorkflows({ view: "all" }, machine.pin)),
  ]);
  return {
    rebaseNeeds: Array.isArray(needs) ? needs : previous?.rebaseNeeds ?? [],
    autoRebaseStatuses: Array.isArray(statuses) ? statuses : previous?.autoRebaseStatuses ?? [],
    proposals: Array.isArray(proposals) ? proposals : previous?.proposals ?? [],
    workflows: Array.isArray(workflows) ? workflows : previous?.workflows ?? [],
  };
}

export function useWorkflowMachines(args: {
  active: boolean;
  /** The tab machine's own lanes and rebase items; they keep their bare ids. */
  boundLanes: readonly LaneSummary[];
  boundRebaseNeeds: readonly RebaseNeed[];
  boundAutoRebaseStatuses: readonly AutoRebaseLaneStatus[];
}): WorkflowMachines {
  const all = useAllMachineLanes(args.active);
  const router = useMemo(() => createLaneMachineRouter(all), [all]);
  const {
    dataByMachine: stateByMachine,
    refresh: refreshForeign,
    refreshMachine,
  } = useForeignMachineReads(all.machines, readWorkflowState, args.active);

  const foreignMachines = useMemo(
    () => all.machines.filter((machine) => !machine.isActiveBinding),
    [all.machines],
  );

  // Live: each reachable machine's own rebase feed (a pinned event stream)
  // re-reads that machine when its needs change. Re-subscribed only when a
  // machine's membership, reachability or pin changes.
  const liveSignature = foreignMachines
    .map((machine) => `${machine.machineId}\u0000${machine.online ? 1 : 0}\u0000${machine.pin?.key ?? ""}`)
    .join("\u0001");
  const foreignRef = useRef(foreignMachines);
  foreignRef.current = foreignMachines;
  useEffect(() => {
    if (!args.active) return undefined;
    const unsubscribers: Array<() => void> = [];
    for (const machine of foreignRef.current) {
      if (!machine.pin || !machine.online || !machine.routable) continue;
      const machineId = machine.machineId;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = window.ade.rebase.onEvent(() => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          refreshMachine(machineId);
        }, 400);
      }, machine.pin);
      unsubscribers.push(() => {
        if (timer) clearTimeout(timer);
        unsubscribe();
      });
    }
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [args.active, liveSignature, refreshMachine]);

  return useMemo(() => {
    const showChips = shouldShowMachineChips(all.machines.length);
    const itemMachine = (machine: LaneMachine | null): WorkflowItemMachine | null => {
      if (!machine) return null;
      return {
        machineId: machine.machineId,
        machineName: machine.machineName,
        pin: machine.pin,
        online: machine.online,
        routable: machine.routable,
        chip: showChips ? machineChipFor(machine) : null,
      };
    };
    const boundMachine = all.machines.find((machine) => machine.isActiveBinding) ?? null;
    /** A lane or proposal no known machine reports: nothing may be sent for it. */
    const unroutable = (machine: LaneMachine | null, machineId: string | null): WorkflowItemMachine => ({
      ...(itemMachine(machine) ?? {
        machineId: machineId ?? "",
        machineName: "Its machine",
        online: true,
        chip: null,
      }),
      pin: null,
      routable: false,
    });

    // Lane and proposal ids are unique per machine, not globally. The tab
    // machine's items keep their bare ids. Every other machine's item is
    // listed under a view id (`machineScopedId(machineId, id)`), which is never
    // a real id on any machine: two machines reporting the same id both show,
    // each routed to its own machine, and a path that forgets to translate a
    // view id back (`realLaneId` / `realProposalId`) fails as "not found"
    // instead of reaching a same-id item somewhere else.
    const boundIds = new Set<string>([
      ...args.boundLanes.map((lane) => lane.id),
      ...args.boundRebaseNeeds.map((need) => need.laneId),
      ...args.boundAutoRebaseStatuses.map((status) => status.laneId),
    ]);
    const foreignLaneById = new Map<string, { machineId: string; laneId: string }>();
    const foreignProposalById = new Map<string, { machineId: string; proposalId: string }>();
    const laneViewId = (machineId: string, laneId: string) => {
      const viewId = machineScopedId(machineId, laneId);
      foreignLaneById.set(viewId, { machineId, laneId });
      return viewId;
    };
    const proposalViewId = (machineId: string, proposalId: string) => {
      const viewId = machineScopedId(machineId, proposalId);
      foreignProposalById.set(viewId, { machineId, proposalId });
      return viewId;
    };

    const lanes: LaneSummary[] = [...args.boundLanes];
    const lanesByMachineId = new Map<string, LaneSummary[]>();
    if (boundMachine) lanesByMachineId.set(boundMachine.machineId, [...args.boundLanes]);
    for (const machine of foreignMachines) {
      const machineLanes = all.lanesByMachineId.get(machine.machineId) ?? [];
      lanesByMachineId.set(machine.machineId, machineLanes);
      for (const lane of machineLanes) {
        lanes.push({
          ...lane,
          id: laneViewId(machine.machineId, lane.id),
          parentLaneId: lane.parentLaneId ? laneViewId(machine.machineId, lane.parentLaneId) : null,
        });
      }
    }

    const foreignRebaseNeeds: RebaseNeed[] = [];
    const foreignAutoRebaseStatuses: AutoRebaseLaneStatus[] = [];
    const foreignProposals: IntegrationProposal[] = [];
    const foreignWorkflows: IntegrationProposal[] = [];
    for (const machine of foreignMachines) {
      const state = stateByMachine[machine.machineId];
      if (!state) continue;
      for (const need of state.rebaseNeeds) {
        // `prId` is a row in that machine's database; nothing here can open it.
        foreignRebaseNeeds.push({ ...need, laneId: laneViewId(machine.machineId, need.laneId), prId: null });
      }
      for (const status of state.autoRebaseStatuses) {
        foreignAutoRebaseStatuses.push({ ...status, laneId: laneViewId(machine.machineId, status.laneId) });
      }
      // A proposal's contents (source lanes, integration lane) stay that
      // machine's real ids; `lanesForProposal` names them.
      for (const proposal of state.proposals) {
        foreignProposals.push({ ...proposal, proposalId: proposalViewId(machine.machineId, proposal.proposalId) });
      }
      for (const workflow of state.workflows) {
        foreignWorkflows.push({ ...workflow, proposalId: proposalViewId(machine.machineId, workflow.proposalId) });
      }
    }

    /** Items read from a machine route to that machine, whatever its lane list says. */
    const machineRoute = (machineId: string): WorkflowItemMachine => {
      const route = router.route(null, machineId);
      const machine = route.machine ?? all.machinesById.get(machineId) ?? null;
      // Unknown or unaddressable: refuse rather than fall back to the tab's
      // machine, which would run the call against the wrong checkout.
      if (route.kind === "unknown" || route.kind === "unroutable") return unroutable(machine, machineId);
      return itemMachine(machine) ?? unroutable(null, machineId);
    };
    const machineForLane = (laneId: string | null | undefined): WorkflowItemMachine | null => {
      const id = laneId?.trim();
      if (!id) return itemMachine(boundMachine);
      const foreign = foreignLaneById.get(id);
      if (foreign) return machineRoute(foreign.machineId);
      if (boundIds.has(id)) return itemMachine(boundMachine);
      // Neither the tab's machine nor any other machine lists this lane.
      return unroutable(null, null);
    };
    const machineForProposal = (proposalId: string | null | undefined): WorkflowItemMachine | null => {
      const id = proposalId?.trim();
      if (!id) return itemMachine(boundMachine);
      const foreign = foreignProposalById.get(id);
      // A bare id is always the tab machine's: its proposals are listed there.
      return foreign ? machineRoute(foreign.machineId) : itemMachine(boundMachine);
    };
    const realLaneId = (laneId: string): string => foreignLaneById.get(laneId)?.laneId ?? laneId;
    const realProposalId = (proposalId: string): string => foreignProposalById.get(proposalId)?.proposalId ?? proposalId;
    const viewProposalId = (machineId: string | null | undefined, proposalId: string): string =>
      machineId && machineId !== boundMachine?.machineId ? proposalViewId(machineId, proposalId) : proposalId;
    const lanesForProposal = (proposalId: string | null | undefined): LaneSummary[] => {
      const owner = proposalId ? foreignProposalById.get(proposalId)?.machineId : undefined;
      return owner ? lanesByMachineId.get(owner) ?? [] : [...args.boundLanes];
    };

    return {
      machines: all.machines,
      lanes,
      foreignRebaseNeeds,
      foreignAutoRebaseStatuses,
      foreignProposals,
      foreignWorkflows,
      machineForLane,
      machineForProposal,
      realLaneId,
      realProposalId,
      viewProposalId,
      lanesForProposal,
      refreshForeign,
      refreshMachine,
    };
  }, [
    all, args.boundAutoRebaseStatuses, args.boundLanes, args.boundRebaseNeeds,
    foreignMachines, refreshForeign, refreshMachine, router, stateByMachine,
  ]);
}
