import { useCallback, useEffect, useRef, useState } from "react";
import { patchChatCompanionUiState, readChatCompanionUiState } from "../chat/chatCompanionUiState";

/**
 * The state every device Tools drawer shares (Apple and Android): which group
 * is open, the one settings snapshot every control reads from, and the one
 * serialized `act()` the controls run their commands through.
 *
 * Nothing in a drawer is optimistic: a control shows the value the DEVICE last
 * confirmed, and a write that the service refuses leaves the control where it
 * was. Actions run one at a time — a second click while one is in flight is
 * dropped, not queued — and every settled action re-reads the settings, unless
 * the command itself answered with them (`actWithSettings`).
 *
 * The generation counter makes hiding and re-showing safe. Hiding invalidates
 * the RESULT, not the command: the device is still running it, so when the
 * drawer reopens it must not paint a reply to a question it no longer
 * remembers asking. A stale action's answer is discarded and the settings are
 * read again under the new generation.
 */

export type DeviceDrawerActions<S> = {
  settings: S | null;
  pending: boolean;
  error: unknown;
  clearError: () => void;
  reportError: (error: unknown) => void;
  /**
   * Run one device command. Resolves true on success. A rejected command
   * shows through `error` and resolves false; it never throws, so a section
   * can `.then(accepted => …)` without its own try/catch.
   */
  act: (work: () => Promise<unknown>) => Promise<boolean>;
  /** `act` for a command that answers with the fresh settings: no second read. */
  actWithSettings: (work: () => Promise<S>) => Promise<boolean>;
  /** Re-read the settings snapshot without running a command. */
  refresh: () => void;
  /** `pending || !settings || !visible`. */
  disabled: boolean;
};

/**
 * `read` must be stable for one device (a `useCallback` keyed on the lane and
 * device, never on the pin object): a new `read` reads the settings again.
 */
export function useDeviceDrawerActions<S>({
  read,
  visible,
}: {
  read: () => Promise<S>;
  visible: boolean;
}): DeviceDrawerActions<S> {
  const [settings, setSettings] = useState<S | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const busy = useRef(false);
  const generation = useRef(0);

  const readSettings = useCallback(async (revision: number) => {
    try {
      const next = await read();
      if (generation.current === revision) setSettings(next);
    } catch (cause: unknown) {
      if (generation.current !== revision) return;
      setSettings(null);
      setError(cause);
    }
  }, [read]);

  useEffect(() => {
    const revision = ++generation.current;
    if (!visible) {
      setSettings(null);
      return undefined;
    }
    void readSettings(revision);
    return () => {
      generation.current += 1;
    };
  }, [readSettings, refreshNonce, visible]);

  const run = useCallback(async (work: () => Promise<unknown>, answersWithSettings: boolean): Promise<boolean> => {
    if (busy.current || !visible) return false;
    busy.current = true;
    const revision = ++generation.current;
    setPending(true);
    setError(null);
    let accepted = false;
    let answer: unknown = null;
    try {
      answer = await work();
      accepted = true;
    } catch (cause: unknown) {
      if (generation.current === revision) setError(cause);
    } finally {
      busy.current = false;
      setPending(false);
    }
    if (accepted && answersWithSettings && generation.current === revision) {
      setSettings(answer as S);
      return true;
    }
    // Confirm from the device either way: a refused write still leaves the
    // snapshot as the device has it, and a stale generation reads fresh.
    await readSettings(generation.current === revision ? revision : ++generation.current);
    return accepted;
  }, [readSettings, visible]);

  const act = useCallback((work: () => Promise<unknown>) => run(work, false), [run]);
  const actWithSettings = useCallback((work: () => Promise<S>) => run(work, true), [run]);
  const clearError = useCallback(() => setError(null), []);
  const reportError = useCallback((cause: unknown) => setError(cause), []);
  const refresh = useCallback(() => setRefreshNonce((nonce) => nonce + 1), []);

  return {
    settings,
    pending,
    error,
    clearError,
    reportError,
    act,
    actWithSettings,
    refresh,
    disabled: pending || !settings || !visible,
  };
}

/** Where each drawer remembers its open group in a chat's companion UI state. */
export type DeviceDrawerGroupKey = "appleToolsGroup" | "androidToolsGroup";

/**
 * The open group on a chatless surface, per drawer.
 *
 * Module-level rather than component state because a drawer is mounted lazily
 * and unmounted with its pane; a `useState` here would reopen on the default
 * group every time the tools pane is toggled. Not persisted: with no chat
 * there is no key to persist it under.
 */
const sessionGroups = new Map<DeviceDrawerGroupKey, string | null>();

/**
 * Which group is open, and the writer that remembers it: per chat, in the
 * `chatCompanionUiState` record every other per-chat drawer and pane flag
 * lives in. Clicking the open card's header closes it.
 */
export function useDeviceDrawerGroup<G extends string>({
  chatSessionId,
  groups,
  defaultGroup,
  storageKey,
}: {
  chatSessionId: string | null;
  groups: readonly G[];
  defaultGroup: G;
  storageKey: DeviceDrawerGroupKey;
}): { open: G | null; toggle: (id: G) => void } {
  const [open, setOpen] = useState<G | null>(() => {
    const stored = chatSessionId
      ? readChatCompanionUiState(chatSessionId)[storageKey]
      : sessionGroups.has(storageKey) ? sessionGroups.get(storageKey) ?? null : defaultGroup;
    if (stored === null) return null;
    return (groups as readonly string[]).includes(stored) ? (stored as G) : defaultGroup;
  });

  const toggle = useCallback((id: G) => {
    setOpen((current) => {
      const next = current === id ? null : id;
      if (chatSessionId) patchChatCompanionUiState(chatSessionId, { [storageKey]: next });
      else sessionGroups.set(storageKey, next);
      return next;
    });
  }, [chatSessionId, storageKey]);

  return { open, toggle };
}

/** Test seam: a chatless surface's remembered group must not leak between tests. */
export function resetDeviceDrawerGroupsForTests(): void {
  sessionGroups.clear();
}
