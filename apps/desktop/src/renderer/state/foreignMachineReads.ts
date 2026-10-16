/**
 * One loop for reading the same thing from every other machine.
 *
 * Automations, the PRs workflow views and History each show one list merged
 * from every machine that holds the project. The tab's own machine keeps its
 * existing (unpinned) read; this hook reads every OTHER machine through its
 * pin. Each machine is timed out and lands on its own, so one slow or wedged
 * machine never holds the list. An offline machine is not asked: it keeps what
 * it last reported (callers dim it). A read that fails keeps the previous data
 * and reports the error.
 *
 * Reads happen when a machine joins, leaves, changes reachability or changes
 * pin, and whenever the caller asks (`refresh`, `refreshMachine`). No timer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../shared/types";
import { machineBlockedReason, type LaneMachine } from "./laneMachineRouting";
import { withMachineTimeout } from "./projectMachines";

/** Why one machine's part of a merged list is missing or stale. */
export type MachineReadLoad = {
  machineName: string;
  status: "loading" | "offline" | "error";
  message: string | null;
};

/**
 * An id that is unique per machine, made unique across machines. Rule ids,
 * operation ids and the like double as row keys and selection; two machines
 * can report the same one.
 */
export function machineScopedId(machineId: string, id: string): string {
  return `${machineId}::${id}`;
}

/** The parts of a `machineScopedId`, or null for an id that is not one. */
export function parseMachineScopedId(value: string): { machineId: string; id: string } | null {
  const split = value.indexOf("::");
  if (split <= 0 || split + 2 >= value.length) return null;
  return { machineId: value.slice(0, split), id: value.slice(split + 2) };
}

/** A machine the hook can send a read to. */
export type PinnedMachine = LaneMachine & { pin: OpenProjectBinding };

export type ForeignMachineReads<T> = {
  /** The last successful read per machine id. */
  dataByMachine: Readonly<Record<string, T>>;
  /** Machines that are loading, offline, or failed, by machine id. */
  loadByMachine: Readonly<Record<string, MachineReadLoad>>;
  /** Re-read every other machine now. */
  refresh: () => void;
  /** Re-read one machine (after an action that ran there). */
  refreshMachine: (machineId: string) => void;
  /**
   * Store what an action that ran on a machine returned (its fresh list), in
   * place of a re-read. Supersedes any read still in flight for it.
   */
  setMachineData: (machineId: string, data: T) => void;
};

/**
 * Read `read(machine, previous)` from every machine in `machines` that is not
 * the tab's own. Only while `active`.
 */
export function useForeignMachineReads<T>(
  machines: readonly LaneMachine[],
  read: (machine: PinnedMachine, previous: T | undefined) => Promise<T>,
  active: boolean,
): ForeignMachineReads<T> {
  const [dataByMachine, setDataByMachine] = useState<Record<string, T>>({});
  const [loadByMachine, setLoadByMachine] = useState<Record<string, MachineReadLoad>>({});
  const readRef = useRef(read);
  readRef.current = read;
  const dataRef = useRef(dataByMachine);
  dataRef.current = dataByMachine;
  const seqRef = useRef(new Map<string, number>());
  /** The pin each machine's data was read through; data from an older pin is dropped. */
  const dataPinKeyRef = useRef(new Map<string, string>());

  const foreign = useMemo(() => machines.filter((machine) => !machine.isActiveBinding), [machines]);
  const foreignRef = useRef(foreign);
  foreignRef.current = foreign;

  const setLoad = useCallback((machineId: string, load: MachineReadLoad | null) => {
    setLoadByMachine((current) => {
      if (!load) {
        if (!current[machineId]) return current;
        const rest = { ...current };
        delete rest[machineId];
        return rest;
      }
      const existing = current[machineId];
      if (existing && existing.status === load.status && existing.message === load.message) return current;
      return { ...current, [machineId]: load };
    });
  }, []);

  const readMachine = useCallback((machine: LaneMachine) => {
    const offline = !machine.online ? machineBlockedReason(machine) : null;
    if (offline) {
      setLoad(machine.machineId, { machineName: machine.machineName, status: "offline", message: offline });
      return;
    }
    const pin = machine.pin;
    if (!pin || !machine.routable) {
      setLoad(machine.machineId, null);
      return;
    }
    const seq = (seqRef.current.get(machine.machineId) ?? 0) + 1;
    seqRef.current.set(machine.machineId, seq);
    const previous = dataPinKeyRef.current.get(machine.machineId) === pin.key
      ? dataRef.current[machine.machineId]
      : undefined;
    if (previous === undefined) {
      setLoad(machine.machineId, { machineName: machine.machineName, status: "loading", message: null });
    }
    void withMachineTimeout(readRef.current({ ...machine, pin }, previous), machine.machineName)
      .then((next) => {
        if (seqRef.current.get(machine.machineId) !== seq) return;
        if (!foreignRef.current.some((candidate) => candidate.machineId === machine.machineId)) return;
        dataPinKeyRef.current.set(machine.machineId, pin.key);
        setDataByMachine((current) => ({ ...current, [machine.machineId]: next }));
        setLoad(machine.machineId, null);
      })
      .catch((err: unknown) => {
        if (seqRef.current.get(machine.machineId) !== seq) return;
        setLoad(machine.machineId, {
          machineName: machine.machineName,
          status: "error",
          message: err instanceof Error ? err.message : `Couldn't reach ${machine.machineName}`,
        });
      });
  }, [setLoad]);

  const refresh = useCallback(() => {
    for (const machine of foreignRef.current) readMachine(machine);
  }, [readMachine]);

  const setMachineData = useCallback((machineId: string, data: T) => {
    const machine = foreignRef.current.find((candidate) => candidate.machineId === machineId);
    if (!machine?.pin) return;
    seqRef.current.set(machineId, (seqRef.current.get(machineId) ?? 0) + 1);
    dataPinKeyRef.current.set(machineId, machine.pin.key);
    setDataByMachine((current) => ({ ...current, [machineId]: data }));
    setLoad(machineId, null);
  }, [setLoad]);

  const refreshMachine = useCallback((machineId: string) => {
    const machine = foreignRef.current.find((candidate) => candidate.machineId === machineId);
    if (machine) readMachine(machine);
  }, [readMachine]);

  // Membership, reachability and the pin decide when to re-read, not lane churn.
  const signature = foreign
    .map((machine) => [
      machine.machineId,
      machine.online ? 1 : 0,
      machine.routable ? 1 : 0,
      machine.pin?.key ?? "",
    ].join("\u0000"))
    .join("\u0001");
  useEffect(() => {
    if (!active) return;
    const pinKeyById = new Map(foreignRef.current.map((machine) => [machine.machineId, machine.pin?.key ?? null]));
    const keep = <V,>(current: Record<string, V>, samePin: boolean): Record<string, V> => {
      const kept = Object.fromEntries(Object.entries(current).filter(([id]) => {
        if (!pinKeyById.has(id)) return false;
        // Another checkout answers through a new pin; its old rows are not its own.
        const readThrough = dataPinKeyRef.current.get(id);
        return !samePin || readThrough == null || readThrough === pinKeyById.get(id);
      }));
      return Object.keys(kept).length === Object.keys(current).length ? current : kept;
    };
    setDataByMachine((current) => keep(current, true));
    setLoadByMachine((current) => keep(current, false));
    refresh();
  }, [active, refresh, signature]);

  return { dataByMachine, loadByMachine, refresh, refreshMachine, setMachineData };
}
