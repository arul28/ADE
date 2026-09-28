/**
 * The PRs workflow views (Rebase/Merge, Integration) across every machine.
 *
 * Rebase needs, auto-rebase statuses and integration proposals live in the
 * `.ade` database of the machine that owns the lanes, so the tab's machine can
 * only report its own. This module reads every other machine's copy (timed out,
 * each landing on its own, never gating the tab machine's list), tags every
 * item with its machine, and hands callers one routing answer per lane or
 * proposal: which pin to pass, whether that machine is reachable, and which
 * chip to draw. Routing goes through the shared lane router
 * (`state/laneMachineRouting`) with the machine the item was read from, so a
 * lane id that exists on two machines can never be resolved to the wrong one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AutoRebaseLaneStatus,
  IntegrationProposal,
  LaneSummary,
  OpenProjectBinding,
  RebaseNeed,
} from "../../../../shared/types";
import {
  createLaneMachineRouter,
  shouldShowMachineChips,
  useAllMachineLanes,
  type LaneMachine,
} from "../../../state/laneMachineRouting";
import type { MachineChipModel } from "../../history/projectMachines";
import { withMachineTimeout } from "../../history/projectMachines";

/** Where one workflow item's calls go. */
export type WorkflowItemMachine = {
  machineId: string;
  machineName: string;
  /** `null` = the tab's machine (unpinned). */
  pin: OpenProjectBinding | null;
  online: boolean;
  /** False when the machine is known but cannot be addressed, or unknown. */
  routable: boolean;
  /** Null on a one-machine project. */
  chip: MachineChipModel | null;
};

/** Why an action on this item can't run right now, or null. */
export function workflowBlockedReason(machine: WorkflowItemMachine | null | undefined): string | null {
  if (!machine) return null;
  if (!machine.online) return `${machine.machineName} is offline`;
  if (!machine.routable) return `Open on ${machine.machineName} to do this`;
  return null;
}

/** Trailing pin argument: nothing for the tab's machine, `[pin]` otherwise. */
export function workflowPinArg(machine: WorkflowItemMachine | null | undefined): [] | [OpenProjectBinding] {
  return machine?.pin ? [machine.pin] : [];
}

type ForeignMachineWorkflowState = {
  rebaseNeeds: RebaseNeed[];
  autoRebaseStatuses: AutoRebaseLaneStatus[];
  proposals: IntegrationProposal[];
  workflows: IntegrationProposal[];
};

export type WorkflowMachines = {
  machines: readonly LaneMachine[];
  /** Every machine's lanes, the tab machine's first; ids deduped. */
  lanes: LaneSummary[];
  /** Other machines' items, not already reported by the tab's machine. */
  foreignRebaseNeeds: RebaseNeed[];
  foreignAutoRebaseStatuses: AutoRebaseLaneStatus[];
  foreignProposals: IntegrationProposal[];
  foreignWorkflows: IntegrationProposal[];
  /** The machine that owns a lane (bound machine when not foreign). */
  machineForLane: (laneId: string | null | undefined) => WorkflowItemMachine | null;
  /** The machine that owns a proposal/workflow (bound machine when not foreign). */
  machineForProposal: (proposalId: string | null | undefined) => WorkflowItemMachine | null;
  /** Re-read every other machine now (after an action, on Refresh). */
  refreshForeign: () => void;
  /** Re-read one machine (after an action that ran there). */
  refreshMachine: (machineId: string) => void;
};

const EMPTY_STATE: ForeignMachineWorkflowState = {
  rebaseNeeds: [],
  autoRebaseStatuses: [],
  proposals: [],
  workflows: [],
};

export function useWorkflowMachines(args: {
  active: boolean;
  /** The tab machine's own lanes, needs and proposals, which win on overlap. */
  boundLanes: readonly LaneSummary[];
  boundRebaseNeeds: readonly RebaseNeed[];
  boundAutoRebaseStatuses: readonly AutoRebaseLaneStatus[];
  boundWorkflows: readonly IntegrationProposal[];
}): WorkflowMachines {
  const all = useAllMachineLanes(args.active);
  const router = useMemo(() => createLaneMachineRouter(all), [all]);
  const [stateByMachine, setStateByMachine] = useState<Record<string, ForeignMachineWorkflowState>>({});
  const readSeqRef = useRef(new Map<string, number>());

  const foreignMachines = useMemo(
    () => all.machines.filter((machine) => !machine.isActiveBinding),
    [all.machines],
  );
  const foreignRef = useRef(foreignMachines);
  foreignRef.current = foreignMachines;

  const readMachine = useCallback((machine: LaneMachine) => {
    const pin = machine.pin;
    if (!pin || !machine.routable || !machine.online) return;
    const seq = (readSeqRef.current.get(machine.machineId) ?? 0) + 1;
    readSeqRef.current.set(machine.machineId, seq);
    const settle = <T,>(promise: Promise<T>, fallback: T) =>
      withMachineTimeout(promise, machine.machineName).catch(() => fallback);
    void Promise.all([
      settle(window.ade.rebase.scanNeeds(pin), null as RebaseNeed[] | null),
      settle(window.ade.lanes.listAutoRebaseStatuses(pin), null as AutoRebaseLaneStatus[] | null),
      settle(window.ade.prs.listProposals(pin), null as IntegrationProposal[] | null),
      settle(window.ade.prs.listIntegrationWorkflows({ view: "all" }, pin), null as IntegrationProposal[] | null),
    ]).then(([needs, statuses, proposals, workflows]) => {
      if (readSeqRef.current.get(machine.machineId) !== seq) return;
      setStateByMachine((current) => {
        const previous = current[machine.machineId] ?? EMPTY_STATE;
        // A read that failed keeps what the machine last reported.
        return {
          ...current,
          [machine.machineId]: {
            rebaseNeeds: Array.isArray(needs) ? needs : previous.rebaseNeeds,
            autoRebaseStatuses: Array.isArray(statuses) ? statuses : previous.autoRebaseStatuses,
            proposals: Array.isArray(proposals) ? proposals : previous.proposals,
            workflows: Array.isArray(workflows) ? workflows : previous.workflows,
          },
        };
      });
    });
  }, []);

  const refreshForeign = useCallback(() => {
    for (const machine of foreignRef.current) readMachine(machine);
  }, [readMachine]);

  const refreshMachine = useCallback((machineId: string) => {
    const machine = foreignRef.current.find((candidate) => candidate.machineId === machineId);
    if (machine) readMachine(machine);
  }, [readMachine]);

  // Membership and reachability decide when to re-read, not lane churn.
  const foreignSignature = foreignMachines
    .map((machine) => `${machine.machineId}\u0000${machine.online ? 1 : 0}\u0000${machine.routable ? 1 : 0}`)
    .join("\u0001");
  useEffect(() => {
    if (!args.active) return;
    const ids = new Set(foreignRef.current.map((machine) => machine.machineId));
    setStateByMachine((current) => {
      const kept = Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)));
      return Object.keys(kept).length === Object.keys(current).length ? current : kept;
    });
    refreshForeign();
  }, [args.active, foreignSignature, refreshForeign]);

  // Live: each reachable machine's own rebase feed (a pinned event stream)
  // re-reads that machine when its needs change.
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
  }, [args.active, foreignSignature, refreshMachine]);

  return useMemo(() => {
    const showChips = shouldShowMachineChips(all);
    const itemMachine = (machine: LaneMachine | null): WorkflowItemMachine | null => {
      if (!machine) return null;
      return {
        machineId: machine.machineId,
        machineName: machine.machineName,
        pin: machine.isActiveBinding ? null : machine.pin,
        online: machine.online,
        routable: machine.isActiveBinding || (machine.routable && machine.pin != null),
        chip: showChips
          ? {
              machineId: machine.machineId,
              machineName: machine.machineName,
              online: machine.online,
              isThisMachine: machine.isThisMachine,
            }
          : null,
      };
    };
    const boundMachine = all.machines.find((machine) => machine.isActiveBinding) ?? null;
    const unroutable = (machineId: string): WorkflowItemMachine => ({
      machineId,
      machineName: "its machine",
      pin: null,
      online: true,
      routable: false,
      chip: null,
    });

    const boundLaneIds = new Set(args.boundLanes.map((lane) => lane.id));
    const boundNeedLaneIds = new Set(args.boundRebaseNeeds.map((need) => need.laneId));
    const boundStatusLaneIds = new Set(args.boundAutoRebaseStatuses.map((status) => status.laneId));
    const boundProposalIds = new Set(args.boundWorkflows.map((proposal) => proposal.proposalId));

    // Every lane id the tab's machine reports is the tab machine's, full stop:
    // a foreign entry may never shadow it, or the tab machine's own items
    // would be sent to another machine. Foreign items are routed by the
    // machine they were read from, and one lane id belongs to one foreign
    // machine at most (first reader wins; a second machine's same-id items are
    // left out rather than shown under the wrong owner).
    const boundIds = new Set<string>([...boundLaneIds, ...boundNeedLaneIds, ...boundStatusLaneIds]);
    const lanes: LaneSummary[] = [...args.boundLanes];
    const machineIdByLaneId = new Map<string, string>();
    const claimForeignLane = (laneId: string, machineId: string): boolean => {
      if (boundIds.has(laneId)) return false;
      const owner = machineIdByLaneId.get(laneId);
      if (owner && owner !== machineId) return false;
      machineIdByLaneId.set(laneId, machineId);
      return true;
    };
    for (const row of all.lanes) {
      if (row.isActiveBinding || machineIdByLaneId.has(row.lane.id)) continue;
      if (claimForeignLane(row.lane.id, row.machineId)) lanes.push(row.lane);
    }

    const foreignRebaseNeeds: RebaseNeed[] = [];
    const foreignAutoRebaseStatuses: AutoRebaseLaneStatus[] = [];
    const foreignProposals: IntegrationProposal[] = [];
    const foreignWorkflows: IntegrationProposal[] = [];
    const machineIdByProposalId = new Map<string, string>();
    for (const machine of foreignMachines) {
      const state = stateByMachine[machine.machineId];
      if (!state) continue;
      for (const need of state.rebaseNeeds) {
        if (claimForeignLane(need.laneId, machine.machineId)) foreignRebaseNeeds.push(need);
      }
      for (const status of state.autoRebaseStatuses) {
        if (claimForeignLane(status.laneId, machine.machineId)) foreignAutoRebaseStatuses.push(status);
      }
      for (const proposal of [...state.proposals, ...state.workflows]) {
        if (boundProposalIds.has(proposal.proposalId) || machineIdByProposalId.has(proposal.proposalId)) continue;
        machineIdByProposalId.set(proposal.proposalId, machine.machineId);
      }
      foreignProposals.push(...state.proposals.filter((proposal) => machineIdByProposalId.get(proposal.proposalId) === machine.machineId));
      foreignWorkflows.push(...state.workflows.filter((workflow) => machineIdByProposalId.get(workflow.proposalId) === machine.machineId));
    }

    const machineForLane = (laneId: string | null | undefined): WorkflowItemMachine | null => {
      const id = laneId?.trim();
      if (!id || boundIds.has(id)) return itemMachine(boundMachine);
      const machineId = machineIdByLaneId.get(id);
      if (!machineId) return itemMachine(boundMachine);
      // The machine the item was read from names the route: never a bare id.
      const route = router.route(id, machineId);
      const routed = itemMachine(route.machine ?? all.machinesById.get(machineId) ?? null);
      // Unknown or unaddressable: refuse rather than fall back to the tab's
      // machine, which would run the call against the wrong checkout.
      if (!routed) return unroutable(machineId);
      if (route.kind === "unknown" || route.kind === "unroutable") return { ...routed, pin: null, routable: false };
      return routed;
    };
    const machineForProposal = (proposalId: string | null | undefined): WorkflowItemMachine | null => {
      const machineId = proposalId ? machineIdByProposalId.get(proposalId) : undefined;
      if (!machineId) return itemMachine(boundMachine);
      return itemMachine(all.machinesById.get(machineId) ?? null) ?? unroutable(machineId);
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
      refreshForeign,
      refreshMachine,
    };
  }, [
    all, args.boundAutoRebaseStatuses, args.boundLanes, args.boundRebaseNeeds, args.boundWorkflows,
    foreignMachines, refreshForeign, refreshMachine, router, stateByMachine,
  ]);
}
