import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentChatRemoteWorkUse } from "../../../shared/types/chat";
import { listRemoteWorkShells, useRemoteWorkPinResolver } from "../../lib/remoteWorkPins";

/**
 * How many of this chat's shells run on other machines right now, read there
 * (the same read as the terminal drawer's remote tabs), not guessed from its
 * calls: `ade shell start --machine …` without `--wait` returns while the
 * shell keeps running. Read when the pane opens, whenever `refreshKey` changes
 * (the agent's terminal activity), and when a shell on one of those machines
 * exits; never on a timer. `fallback` (the
 * agent's unfinished remote calls) stands in until the first read answers, or
 * when no machine can be reached.
 */
export function useRemoteShellCount(args: {
  active: boolean;
  remoteWork: readonly AgentChatRemoteWorkUse[] | null | undefined;
  refreshKey: string | number | null;
  fallback: number;
}): number {
  const { active, remoteWork, refreshKey, fallback } = args;
  const resolvePin = useRemoteWorkPinResolver(active && Boolean(remoteWork?.length));
  const targets = useMemo(() => (remoteWork ?? []).flatMap((use) => {
    const pin = resolvePin(use);
    return pin === "unreachable" || use.terminalIds.length === 0 ? [] : [{ use, pin }];
  }), [remoteWork, resolvePin]);
  const targetsKey = targets.map(({ use, pin }) => `${pin.key}|${use.terminalIds.join(",")}`).join(";");
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const [read, setRead] = useState<{ key: string; running: number } | null>(null);
  // A shell that ends on its own (its launch call answered long ago) says so
  // on its machine's pump, as the drawer hears it: count again then.
  const [exits, setExits] = useState(0);

  useEffect(() => {
    const ptyBridge = window.ade?.pty;
    if (!active || !ptyBridge?.onExit || !targetsKey) return undefined;
    const pins = new Map(targetsRef.current.map(({ pin }) => [pin.key, pin]));
    const unsubscribers = [...pins.values()].map((pin) => ptyBridge.onExit(() => setExits((count) => count + 1), pin));
    return () => { for (const unsubscribe of unsubscribers) unsubscribe?.(); };
  }, [active, targetsKey]);

  useEffect(() => {
    if (!active || !targetsKey) return undefined;
    let cancelled = false;
    void Promise.all(targetsRef.current.map(async ({ use, pin }) => {
      try {
        const rows = await listRemoteWorkShells(use, pin);
        return rows.filter((row) => row.status === "running").length;
      } catch (error) {
        console.warn(`[remote-work] could not count the shells on ${use.machineName}`, error);
        return null;
      }
    })).then((counts) => {
      if (cancelled) return;
      if (counts.every((count) => count === null)) return;
      setRead({ key: targetsKey, running: counts.reduce<number>((sum, count) => sum + (count ?? 0), 0) });
    });
    return () => { cancelled = true; };
  }, [active, targetsKey, refreshKey, exits]);

  if (!targetsKey) return fallback;
  return read && read.key === targetsKey ? Math.max(read.running, fallback) : fallback;
}
