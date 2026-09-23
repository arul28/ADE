import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { getWorkTerminalShellCount, subscribeWorkTerminalShells } from "./workTerminalShells";

export type AttachedTerminalShells = {
  /**
   * The count the terminal PANEL shows, or null when no panel is mounted for
   * this owner. The panel publishes on every tab change, so this moves in the
   * same commit that draws a new shell.
   */
  panelCount: number | null;
  /**
   * Titles of the owner's shells that are running or still marked active, from
   * the terminal list. Null while disabled, before the first read, or after a
   * failed read.
   */
  titles: string[] | null;
};

/**
 * The shells attached to one chat or CLI session.
 *
 * Attached shells have no status event of their own, so the list is read again
 * whenever one could have changed: a session is created or deleted, a PTY
 * exits, or the panel count changes. It is not a poll: every read has a cause.
 * The panel count is a trigger too, because when the panel unmounts the count
 * goes back to null and the list becomes the only answer.
 *
 * `refreshKey` is an extra trigger for callers that know a fresh read is due
 * (the Work tools pane passes the active tool). Pass `enabled: false` while the
 * machine is offline so nothing is read.
 */
export function useAttachedTerminalShells(
  ownerId: string | null | undefined,
  runtimePin: OpenProjectBinding | null,
  { enabled = true, refreshKey = null }: { enabled?: boolean; refreshKey?: unknown } = {},
): AttachedTerminalShells {
  const owner = ownerId ?? null;
  const panelCount = useSyncExternalStore(
    subscribeWorkTerminalShells,
    () => getWorkTerminalShellCount(owner),
    () => null,
  );
  const [titles, setTitles] = useState<string[] | null>(null);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const pinKey = runtimePin?.key ?? null;
  const active = enabled && Boolean(owner);

  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const bump = () => setEpoch((value) => value + 1);
    const disposers: Array<(() => void) | undefined> = [
      window.ade?.sessions?.onChanged?.(bump),
      window.ade?.pty?.onExit?.(bump, pinRef.current),
    ];
    return () => {
      for (const dispose of disposers) dispose?.();
    };
  }, [active, pinKey]);

  useEffect(() => {
    if (!active || !owner) {
      setTitles(null);
      return undefined;
    }
    const terminal = window.ade?.terminal;
    if (!terminal?.list) return undefined;
    let cancelled = false;
    void terminal.list({ chatSessionId: owner, limit: 20 }, pinRef.current)
      .then((sessions) => {
        if (cancelled) return;
        setTitles(
          sessions
            .filter((session) => session.status === "running" || session.active)
            .map((session) => session.title),
        );
      })
      .catch(() => {
        if (!cancelled) setTitles(null);
      });
    return () => {
      cancelled = true;
    };
    // `panelCount`, `epoch` and `refreshKey` are triggers, not inputs.
  }, [active, epoch, owner, panelCount, pinKey, refreshKey]);

  return { panelCount, titles };
}

/**
 * The shell count from whichever source can see the shells. A mounted panel's
 * count wins, because it is the list on screen; else the `terminal.list`
 * titles. Null when neither measured anything.
 */
export function attachedShellCount(titles: readonly string[] | null, panelCount: number | null): number | null {
  return panelCount ?? titles?.length ?? null;
}

/** Does the owner have at least one attached shell? */
export function hasAttachedTerminalShell({ panelCount, titles }: AttachedTerminalShells): boolean {
  return (attachedShellCount(titles, panelCount) ?? 0) > 0;
}
