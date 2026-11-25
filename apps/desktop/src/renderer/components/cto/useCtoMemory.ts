import { useCallback, useEffect, useRef, useState } from "react";
import { ipcErrorMessage } from "../../lib/format";
import type {
  CtoMemorySnapshot,
  CtoRecallArchivedArgs,
  CtoUpdateNotesArgs,
  CtoUpdateOpenWorkArgs,
  OpenProjectBinding,
} from "../../../shared/types";

export type CtoMemoryState = {
  memory: CtoMemorySnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Writes a whole notes file. Rejects (and keeps the old snapshot) when the host refuses it. */
  updateNotes: (args: CtoUpdateNotesArgs) => Promise<void>;
  /** Adds, completes, reopens or removes one open-work item. */
  updateOpenWork: (args: CtoUpdateOpenWorkArgs) => Promise<void>;
  /** Pins an archived note, fact or discovery as a note again. */
  recallArchived: (args: CtoRecallArchivedArgs) => Promise<void>;
};

function errorText(err: unknown, fallback: string): string {
  return ipcErrorMessage(err) || fallback;
}

/**
 * The CTO's notes and open work, read from and written to its home machine.
 *
 * `pin` is the CTO home's binding; null means the home is not reachable, so
 * nothing is read or written. Every write answers the whole new snapshot,
 * which replaces the local one: the host normalizes (scrubs secrets, trims
 * done items) and the page must show what it kept, not what was sent.
 */
export function useCtoMemory(pin: OpenProjectBinding | null): CtoMemoryState {
  const [memory, setMemory] = useState<CtoMemorySnapshot | null>(null);
  const [loading, setLoading] = useState(Boolean(pin));
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  /** Drops a read that answers after the pin moved to another machine. */
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const target = pinRef.current;
    const bridge = window.ade?.cto;
    if (!target || !bridge) {
      setMemory(null);
      setLoading(false);
      return;
    }
    const generation = generationRef.current;
    setLoading(true);
    try {
      const next = await bridge.getMemory(target);
      if (generation !== generationRef.current) return;
      setMemory(next);
      setError(null);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(errorText(err, "Couldn't read notes."));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    setMemory(null);
    setError(null);
    void refresh();
    // Keyed on the pin's key: a rebuilt pin for the same machine reloads nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key, refresh]);

  const write = useCallback(async (run: (target: OpenProjectBinding) => Promise<CtoMemorySnapshot>) => {
    const target = pinRef.current;
    if (!target) throw new Error("Home machine unreachable");
    const generation = generationRef.current;
    const next = await run(target);
    if (generation === generationRef.current) {
      setMemory(next);
      setError(null);
    }
  }, []);

  const updateNotes = useCallback(
    (args: CtoUpdateNotesArgs) => write((target) => window.ade.cto!.updateNotes(args, target)),
    [write],
  );

  const updateOpenWork = useCallback(
    (args: CtoUpdateOpenWorkArgs) => write((target) => window.ade.cto!.updateOpenWork(args, target)),
    [write],
  );

  const recallArchived = useCallback(
    (args: CtoRecallArchivedArgs) => write((target) => window.ade.cto!.recallArchivedNote(args, target)),
    [write],
  );

  return { memory, loading, error, refresh, updateNotes, updateOpenWork, recallArchived };
}
