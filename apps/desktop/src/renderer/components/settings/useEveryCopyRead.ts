import React from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { ipcErrorMessage } from "../../lib/format";
import { withMachineTimeout } from "../../state/projectMachines";
import { pinKeys, useActiveRepositoryCopies, useOnlineCopyPins, useTabCopyPin } from "../../state/repositoryScope";

/**
 * One read from every computer with a copy of the open project, kept apart
 * per machine, for a list that shows them all at once (Deleted & Archived).
 * Only online copies are read, so a computer that is asleep (an ADE Cloud
 * lane's) is never woken to list it. A machine that comes online is read; one
 * that goes away drops out. One slow or failed machine never holds the others.
 */

export type CopyRead<T> = {
  pin: OpenProjectBinding;
  machineName: string;
  /** Null until the machine answers, and after it failed. */
  value: T | null;
  /** Why the read failed. */
  error: string | null;
};

type Answer<T> = Pick<CopyRead<T>, "value" | "error"> & { done: boolean };

const PENDING: Answer<never> = { value: null, error: null, done: false };

/**
 * `read` gets the pin and `timed`, which bounds a call to another machine
 * (the tab's own copy keeps no bound, as before). `read` may change on every
 * render; the latest one is used.
 */
export function useEveryCopyRead<T>(
  read: (pin: OpenProjectBinding, timed: <R>(call: Promise<R>) => Promise<R>) => Promise<T>,
  timeoutMs: number,
): {
  machines: Array<CopyRead<T> & { done: boolean }>;
  /** No computer with a copy of the project is online. */
  noCopy: boolean;
  /** Reads one machine again (by pin key), or all of them. */
  reload: (pinKey?: string) => void;
} {
  const pins = useOnlineCopyPins();
  const copies = useActiveRepositoryCopies();
  const tabPinKey = useTabCopyPin()?.key ?? null;
  const [byKey, setByKey] = React.useState<Record<string, Answer<T>>>({});
  // A newer read of a machine wins over an older one still in flight.
  const seqs = React.useRef(new Map<string, number>());
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
  const nameFor = React.useCallback(
    (pin: OpenProjectBinding) => names.get(pin.key) ?? (pin.kind === "remote" ? pin.runtimeName || pin.hostname || pin.displayName : "This computer"),
    [names],
  );
  const nameRef = React.useRef(nameFor);
  nameRef.current = nameFor;
  const pinsRef = React.useRef(pins);
  pinsRef.current = pins;

  const loadOne = React.useCallback(async (pin: OpenProjectBinding) => {
    const seq = (seqs.current.get(pin.key) ?? 0) + 1;
    seqs.current.set(pin.key, seq);
    // A read again keeps the old answer on screen until the new one lands.
    setByKey((prev) => (prev[pin.key] ? prev : { ...prev, [pin.key]: PENDING }));
    const name = nameRef.current(pin);
    const timed = <R,>(call: Promise<R>): Promise<R> =>
      pin.key === tabPinKey ? call : withMachineTimeout(call, name, timeoutMs);
    let answer: Answer<T>;
    try {
      answer = { value: await readRef.current(pin, timed), error: null, done: true };
    } catch (error) {
      answer = { value: null, error: ipcErrorMessage(error) || "Something went wrong.", done: true };
    }
    if (seqs.current.get(pin.key) !== seq) return;
    setByKey((prev) => ({ ...prev, [pin.key]: answer }));
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
