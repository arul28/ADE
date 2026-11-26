import React from "react";
import { isAdeCloudBinding } from "../../shared/adeCloud/binding";
import type { OpenProjectBinding } from "../../shared/types";
import { ipcErrorMessage } from "../lib/format";
import { withMachineTimeout } from "./projectMachines";
import { copyMachineName, pinKeys, useActiveRepositoryCopies, useOnlineCopyPins, useTabCopyPin } from "./repositoryScope";

/**
 * One read from every computer with a copy of the open project, kept apart
 * per machine, for a list that shows them all at once (Deleted & Archived).
 *
 * Only online copies are read, so a computer that is asleep (an ADE Cloud
 * lane's) is never woken to list it. ADE Cloud itself is not read: it is the
 * account, not a computer, and each lane computer is its own copy. A machine
 * that comes online is read; one that goes away drops out. One slow or failed
 * machine never holds the others.
 *
 * `useForeignMachineReads` (`foreignMachineReads.ts`) is the sibling for the
 * lists that keep the tab's own read and add the other machines to it. This
 * one reads the tab's copy too, through its pin.
 */

export type CopyRead<T> = {
  pin: OpenProjectBinding;
  machineName: string;
  /** The last answer. Null until the machine answers; a failed read again keeps the old one. */
  value: T | null;
  /** Why the last read failed. */
  error: string | null;
  /** The machine answered at least once (or failed). */
  done: boolean;
};

type Answer<T> = Pick<CopyRead<T>, "value" | "error" | "done">;

const PENDING: Answer<never> = { value: null, error: null, done: false };

/**
 * `read` gets the pin, `timed`, which bounds a call to another machine (the
 * tab's own copy keeps no bound, as before), and the machine's last answer, so
 * a read made of several calls can keep the part whose call failed. `read`
 * may change on every render; the latest one is used.
 */
export function useEveryCopyRead<T>(
  read: (pin: OpenProjectBinding, timed: <R>(call: Promise<R>) => Promise<R>, previous: T | null) => Promise<T>,
  timeoutMs: number,
): {
  machines: Array<CopyRead<T>>;
  /** No computer with a copy of the project is online. */
  noCopy: boolean;
  /** Reads one machine again (by pin key), or all of them. */
  reload: (pinKey?: string) => void;
} {
  const onlinePins = useOnlineCopyPins();
  const copies = useActiveRepositoryCopies();
  const tabPinKey = useTabCopyPin()?.key ?? null;
  const [byKey, setByKey] = React.useState<Record<string, Answer<T>>>({});
  const byKeyRef = React.useRef(byKey);
  byKeyRef.current = byKey;
  // A newer read of a machine wins over an older one still in flight.
  const seqs = React.useRef(new Map<string, number>());
  // `onlinePins` keeps its identity while its keys stay the same.
  const pins = React.useMemo(() => onlinePins.filter((pin) => !isAdeCloudBinding(pin)), [onlinePins]);
  const keys = pinKeys(pins);
  const readRef = React.useRef(read);
  readRef.current = read;

  const names = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const copy of copies) {
      if (copy.address) map.set(copy.address.key, copy.machineName);
    }
    return map;
  }, [copies]);
  const nameFor = React.useCallback((pin: OpenProjectBinding) => copyMachineName(pin, names.get(pin.key)), [names]);
  const nameRef = React.useRef(nameFor);
  nameRef.current = nameFor;
  const pinsRef = React.useRef(pins);
  pinsRef.current = pins;

  const loadOne = React.useCallback(async (pin: OpenProjectBinding) => {
    const seq = (seqs.current.get(pin.key) ?? 0) + 1;
    seqs.current.set(pin.key, seq);
    // A read again keeps the old answer on screen until the new one comes.
    setByKey((prev) => (prev[pin.key] ? prev : { ...prev, [pin.key]: PENDING }));
    const name = nameRef.current(pin);
    const timed = <R,>(call: Promise<R>): Promise<R> =>
      pin.key === tabPinKey ? call : withMachineTimeout(call, name, timeoutMs);
    let value: T | null = null;
    let error: string | null = null;
    try {
      value = await readRef.current(pin, timed, byKeyRef.current[pin.key]?.value ?? null);
    } catch (caught) {
      error = ipcErrorMessage(caught) || "Something went wrong.";
    }
    if (seqs.current.get(pin.key) !== seq) return;
    // A failed read again (a slow machine after a restore) keeps the rows it had.
    setByKey((prev) => ({
      ...prev,
      [pin.key]: { value: error ? prev[pin.key]?.value ?? null : value, error, done: true },
    }));
  }, [tabPinKey, timeoutMs]);

  React.useEffect(() => {
    const live = new Set(pinsRef.current.map((pin) => pin.key));
    setByKey((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => live.has(key))));
    for (const pin of pinsRef.current) void loadOne(pin);
  }, [keys, loadOne]);

  const reload = React.useCallback((pinKey?: string) => {
    for (const pin of pinsRef.current) {
      if (!pinKey || pin.key === pinKey) void loadOne(pin);
    }
  }, [loadOne]);

  const machines = React.useMemo(
    () => pins.map((pin) => ({ pin, machineName: nameFor(pin), ...(byKey[pin.key] ?? PENDING) })),
    [byKey, nameFor, pins],
  );

  return { machines, noCopy: pins.length === 0, reload };
}
