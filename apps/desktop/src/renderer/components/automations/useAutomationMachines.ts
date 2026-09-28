import { useCallback, useMemo } from "react";
import type { AutomationRuleSummary, LaneSummary } from "../../../shared/types";
import {
  machineBlockedReason,
  machineChipFor,
  routableMachines,
  shouldShowMachineChips,
  useAllMachineLanes,
  type LaneMachine,
} from "../../state/laneMachineRouting";
import {
  machineScopedId,
  parseMachineScopedId,
  useForeignMachineReads,
  type MachineReadLoad,
} from "../../state/foreignMachineReads";
import type { RuleMachineView } from "./list/RuleList";

/**
 * One rule on one machine. Rules come from every machine that holds the
 * project; a rule id is only unique on its own machine, so the list key is
 * machine-scoped for every machine but the tab's own, whose keys are the bare
 * rule id.
 */
export type MachineRule = {
  key: string;
  rule: AutomationRuleSummary;
  machine: LaneMachine;
};

export function machineRuleKey(machine: LaneMachine, ruleId: string): string {
  return machine.isActiveBinding ? ruleId : machineScopedId(machine.machineId, ruleId);
}

const NO_RULES: readonly AutomationRuleSummary[] = [];

/**
 * Automations across every machine: the tab machine's rules (read by the
 * workspace, passed in as `rules`) plus every other machine's, read through the
 * shared foreign-read loop, each tagged with the machine it runs on.
 */
export function useAutomationMachines({
  active,
  rules,
  setRules,
  lanes,
}: {
  active: boolean;
  /** The tab machine's rules. */
  rules: readonly AutomationRuleSummary[];
  setRules: (next: AutomationRuleSummary[]) => void;
  /** The tab machine's lanes. */
  lanes: readonly LaneSummary[];
}) {
  const all = useAllMachineLanes(active);
  /** Every machine a rule can run on: the tab's own first. */
  const machines = useMemo(() => routableMachines(all.machines), [all.machines]);
  const boundMachine = machines.find((machine) => machine.isActiveBinding) ?? null;
  const readRules = useCallback(
    (machine: LaneMachine & { pin: NonNullable<LaneMachine["pin"]> }) =>
      window.ade.automations.list(machine.pin).then((next) => (Array.isArray(next) ? next : [])),
    [],
  );
  const foreign = useForeignMachineReads<AutomationRuleSummary[]>(machines, readRules, active);
  const foreignRules = foreign.dataByMachine;

  const entries = useMemo<MachineRule[]>(() => {
    const next: MachineRule[] = [];
    for (const machine of machines) {
      const machineRules = machine.isActiveBinding ? rules : foreignRules[machine.machineId] ?? NO_RULES;
      for (const rule of machineRules) {
        next.push({ key: machineRuleKey(machine, rule.id), rule, machine });
      }
    }
    return next;
  }, [foreignRules, machines, rules]);
  const entryByKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries]);
  const entryByRule = useMemo(() => {
    const map = new WeakMap<AutomationRuleSummary, MachineRule>();
    for (const entry of entries) map.set(entry.rule, entry);
    return map;
  }, [entries]);

  // The chip rule counts the machines this list can hold, not every machine
  // the union knows: an unaddressable machine holds no rules.
  const showChips = shouldShowMachineChips(machines.length);
  const machineOfRule = useCallback((rule: AutomationRuleSummary): RuleMachineView | null => {
    const entry = entryByRule.get(rule);
    if (!entry) return null;
    return {
      chip: showChips ? machineChipFor(entry.machine) : null,
      offlineMessage: machineBlockedReason(entry.machine),
      isActiveBinding: entry.machine.isActiveBinding,
    };
  }, [entryByRule, showChips]);

  /** The live state of a machine; a captured one may be stale. */
  const liveMachine = useCallback(
    (machine: LaneMachine | null) =>
      machine ? machines.find((candidate) => candidate.machineId === machine.machineId) ?? machine : null,
    [machines],
  );
  /** Why an action on this machine can't run right now, or null. */
  const blockedReason = useCallback(
    (machine: LaneMachine | null): string | null => machineBlockedReason(liveMachine(machine)),
    [liveMachine],
  );

  /** Store one machine's rules as returned by a call that ran there. */
  const { setMachineData } = foreign;
  const commitMachineRules = useCallback((machine: LaneMachine | null, next: AutomationRuleSummary[]) => {
    if (!machine || machine.isActiveBinding || !machine.pin) {
      setRules(next);
      return;
    }
    setMachineData(machine.machineId, next);
  }, [setMachineData, setRules]);

  /**
   * Whether a machine-scoped rule key can still resolve: `pending` while its
   * machine is listed but has not answered yet, `present` once it lists the
   * rule, `gone` when the machine left or answered without it. A bare key (the
   * tab machine's) is `gone` here; the tab machine's own list decides it.
   */
  const foreignRuleKeyState = useCallback((key: string): "present" | "pending" | "gone" => {
    const scoped = parseMachineScopedId(key);
    if (!scoped) return "gone";
    if (entryByKey.has(key)) return "present";
    const machine = machines.find((candidate) => candidate.machineId === scoped.machineId);
    if (!machine || machine.isActiveBinding) return "gone";
    return foreignRules[scoped.machineId] === undefined ? "pending" : "gone";
  }, [entryByKey, foreignRules, machines]);

  /** A machine's lanes for picking a run target: the tab's own list, or the union's. */
  const lanesForMachine = useCallback(
    (machine: LaneMachine | null): LaneSummary[] =>
      !machine || machine.isActiveBinding
        ? [...lanes]
        : (all.lanesByMachineId.get(machine.machineId) ?? []).filter((lane) => !lane.archivedAt),
    [all.lanesByMachineId, lanes],
  );

  return {
    machines,
    boundMachine,
    entries,
    entryByKey,
    entryByRule,
    machineOfRule,
    foreignRuleKeyState,
    blockedReason,
    commitMachineRules,
    lanesForMachine,
    /** Per-machine read state for machines other than the tab's. */
    loads: foreign.loadByMachine as Readonly<Record<string, MachineReadLoad>>,
    refreshForeign: foreign.refresh,
    refreshMachine: foreign.refreshMachine,
  };
}
