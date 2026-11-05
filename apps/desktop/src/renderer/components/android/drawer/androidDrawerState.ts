import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { AndroidDeviceSettings } from "../../../../shared/types/androidEmulator";
import { patchChatCompanionUiState, readChatCompanionUiState } from "../../chat/chatCompanionUiState";

/*
 * The Android Tools drawer's state: which group is open, the one settings
 * snapshot the controls read, and the one serialized `act()` they share.
 *
 * The same rules as the Apple drawer: nothing is optimistic (a control shows
 * what the DEVICE last reported), one action runs at a time (a second click
 * while one runs is dropped), and hiding the drawer drops the answer of a
 * command that was still running.
 */

/** The groups, in the order the drawer stacks them (plan §5). Logs comes in P2. */
export const ANDROID_DRAWER_GROUPS = ["device", "app", "capture", "emulator"] as const;
export type AndroidDrawerGroupId = (typeof ANDROID_DRAWER_GROUPS)[number];

export function isAndroidDrawerGroupId(value: unknown): value is AndroidDrawerGroupId {
  return typeof value === "string" && (ANDROID_DRAWER_GROUPS as readonly string[]).includes(value);
}

const DEFAULT_GROUP: AndroidDrawerGroupId = "device";

/** The open group on a chatless surface: kept for the session, as the Apple drawer does. */
let sessionGroup: AndroidDrawerGroupId | null = DEFAULT_GROUP;

/** Which group is open; remembered per chat in the chat's companion UI state. */
export function useAndroidDrawerGroup(chatSessionId: string | null): {
  open: AndroidDrawerGroupId | null;
  toggle: (id: AndroidDrawerGroupId) => void;
} {
  const [open, setOpen] = useState<AndroidDrawerGroupId | null>(() => {
    if (!chatSessionId) return sessionGroup;
    const stored = readChatCompanionUiState(chatSessionId).androidToolsGroup;
    if (stored === null) return null;
    return isAndroidDrawerGroupId(stored) ? stored : DEFAULT_GROUP;
  });
  const toggle = useCallback((id: AndroidDrawerGroupId) => {
    setOpen((current) => {
      const next = current === id ? null : id;
      if (chatSessionId) patchChatCompanionUiState(chatSessionId, { androidToolsGroup: next });
      else sessionGroup = next;
      return next;
    });
  }, [chatSessionId]);
  return { open, toggle };
}

export type AndroidDrawerActions = {
  settings: AndroidDeviceSettings | null;
  pending: boolean;
  error: unknown;
  clearError: () => void;
  reportError: (error: unknown) => void;
  /**
   * Runs one device command and resolves true on success. A refusal shows
   * through `error` and resolves false; it never throws. A command that
   * answers with fresh settings (`setDeviceSetting`) replaces the snapshot
   * with them; any other is followed by one read.
   */
  act: (work: () => Promise<unknown>) => Promise<boolean>;
  refresh: () => void;
  /** `pending || !settings || !visible`. */
  disabled: boolean;
};

function isSettings(value: unknown): value is AndroidDeviceSettings {
  return Boolean(value && typeof value === "object" && "fontScale" in value && "network" in value);
}

export function useAndroidDrawerActions({
  laneId,
  pinRef,
  visible,
}: {
  laneId: string;
  pinRef: MutableRefObject<OpenProjectBinding | null>;
  visible: boolean;
}): AndroidDrawerActions {
  const [settings, setSettings] = useState<AndroidDeviceSettings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const busy = useRef(false);
  const generation = useRef(0);

  const readSettings = useCallback(async (revision: number) => {
    try {
      const next = await window.ade.androidEmulator.getDeviceSettings({ laneId }, pinRef.current);
      if (generation.current === revision) setSettings(next);
    } catch (cause: unknown) {
      if (generation.current !== revision) return;
      setSettings(null);
      setError(cause);
    }
  }, [laneId, pinRef]);

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

  const act = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
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
    if (accepted && generation.current === revision && isSettings(answer)) {
      setSettings(answer);
      return true;
    }
    await readSettings(generation.current === revision ? revision : ++generation.current);
    return accepted;
  }, [readSettings, visible]);

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
    refresh,
    disabled: pending || !settings || !visible,
  };
}

/** What every section gets from the drawer. */
export type AndroidDrawerContext = {
  laneId: string;
  pinRef: MutableRefObject<OpenProjectBinding | null>;
  visible: boolean;
  actions: AndroidDrawerActions;
  /** The machine that runs the emulator, when it is not this one. Files there cannot be revealed here. */
  remoteMachineName: string | null;
};
