import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { ChatDeviceSources, DeviceKind } from "../../../shared/types/deviceSources";
import { normalizeChatDeviceSources } from "../../../shared/types/deviceSources";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { ipcErrorMessage } from "../../lib/format";
import { showToast } from "../app/toast/toastStore";

/*
 * A chat's device choice per kind, as the Work tools pane and its panels see
 * it: the SAME setting `ade devices use` writes (`chat.setDeviceSource`, kept
 * by the chat's own brain), so the cards and the agent never disagree about
 * where this chat's iPhone, Android, screen or app is.
 *
 * One entry per chat and machine, shared by every reader (the catalogue's
 * rails, the panels that open the chosen machine's device). It is read when a
 * reader mounts and after a write; the brain sends no event for a choice, so
 * the tools pane re-reads it (the hook's `refresh`) when the agent's own
 * `ade devices use` answers in the chat's activity feed. No timer.
 */

export type ChatDeviceSourcesState = {
  /** Null until the first read lands, or when this chat keeps no choices. */
  sources: ChatDeviceSources | null;
  /** The chat's machine cannot keep a choice (no brain, an older one, a CLI session). */
  unsupported: boolean;
};

type Entry = ChatDeviceSourcesState & {
  pin: OpenProjectBinding | null;
  sessionId: string;
  readSeq: number;
  listeners: Set<() => void>;
  /** What readers see: replaced on every change, so React notices it. */
  snapshot: ChatDeviceSourcesState;
};

const entries = new Map<string, Entry>();
const EMPTY_STATE: ChatDeviceSourcesState = { sources: null, unsupported: false };
const MAX_ENTRIES = 64;

function entryKey(sessionId: string, pin: OpenProjectBinding | null): string {
  return `${pin?.key ?? "bound"}\u0000${sessionId}`;
}

function emit(entry: Entry): void {
  entry.snapshot = { sources: entry.sources, unsupported: entry.unsupported };
  for (const listener of entry.listeners) listener();
}

/** Strips Electron's IPC wrapper so no caller ever shows it. */
export function deviceSourceErrorText(error: unknown): string {
  return error instanceof Error ? ipcErrorMessage(error) : String(error).trim();
}

function isUnsupportedAnswer(text: string): boolean {
  return /not callable|unknown action|not allowed|no ADE brain|device choice is kept for ADE chats|is not an agent chat session|was not found/i.test(text);
}

function apiOf() {
  const chat = typeof window === "undefined" ? undefined : window.ade?.agentChat;
  const get = chat?.getDeviceSources;
  const set = chat?.setDeviceSource;
  return {
    get: get && isAdeAvailable(get) ? get : null,
    set: set && isAdeAvailable(set) ? set : null,
  };
}

function readEntry(entry: Entry): void {
  const { get } = apiOf();
  if (!get) {
    if (!entry.unsupported) {
      entry.unsupported = true;
      emit(entry);
    }
    return;
  }
  const seq = ++entry.readSeq;
  void get({ sessionId: entry.sessionId }, entry.pin)
    .then((answer) => {
      if (seq !== entry.readSeq) return;
      entry.sources = normalizeChatDeviceSources(answer?.sources) ?? {};
      entry.unsupported = false;
      emit(entry);
    })
    .catch((error: unknown) => {
      if (seq !== entry.readSeq) return;
      if (isUnsupportedAnswer(deviceSourceErrorText(error))) {
        entry.unsupported = true;
        entry.sources = null;
        emit(entry);
        return;
      }
      // A failed read keeps a choice already known: the brain was only slow.
      console.warn("[tools-pane] could not read this chat's device choices", error);
    });
}

function ensureEntry(sessionId: string, pin: OpenProjectBinding | null): Entry {
  const key = entryKey(sessionId, pin);
  let entry = entries.get(key);
  if (!entry) {
    entry = { ...EMPTY_STATE, pin, sessionId, readSeq: 0, listeners: new Set(), snapshot: EMPTY_STATE };
    entries.set(key, entry);
    if (entries.size > MAX_ENTRIES) {
      for (const [oldKey, old] of entries) {
        if (old.listeners.size === 0) {
          entries.delete(oldKey);
          break;
        }
      }
    }
  } else {
    // The same machine under a rebuilt pin: keep the newest object for calls.
    entry.pin = pin;
  }
  return entry;
}

/**
 * Sets this chat's choice for one kind, on the chat's machine. Optimistic: the
 * rail moves at once and goes back if the brain refuses, with its reason in
 * plain words (never the IPC wrapper).
 */
export async function setChatDeviceSource(args: {
  sessionId: string;
  pin: OpenProjectBinding | null;
  kind: DeviceKind;
  machine: { key: string; name: string } | null;
}): Promise<boolean> {
  const { set } = apiOf();
  const entry = ensureEntry(args.sessionId, args.pin);
  if (!set) {
    showToast({ tone: "error", title: "This chat can't keep a device choice here", message: "Pick the machine on the device command instead (--machine).", report: false });
    return false;
  }
  const previous = entry.sources;
  const next: ChatDeviceSources = { ...(previous ?? {}) };
  if (args.machine) {
    next[args.kind] = { kind: "machine", machineKey: args.machine.key, machineName: args.machine.name, chosenAt: new Date().toISOString() };
  } else {
    delete next[args.kind];
  }
  entry.sources = next;
  entry.readSeq += 1;
  emit(entry);
  try {
    const answer = await set({
      sessionId: args.sessionId,
      kind: args.kind,
      source: args.machine
        ? { kind: "machine", machineKey: args.machine.key, machineName: args.machine.name }
        : { kind: "here" },
    }, args.pin);
    entry.sources = normalizeChatDeviceSources(answer?.sources) ?? {};
    emit(entry);
    return true;
  } catch (error) {
    entry.sources = previous;
    emit(entry);
    const reason = deviceSourceErrorText(error);
    showToast({
      tone: "error",
      title: "Couldn't change this chat's device",
      message: isUnsupportedAnswer(reason)
        ? "The ADE on this chat's machine can't keep a device choice. Update ADE there."
        : reason,
      report: false,
    });
    return false;
  }
}

/**
 * This chat's device choices, read from its machine when a reader mounts.
 * `sessionId` null (no chat) reads nothing and keeps no choice.
 */
export function useChatDeviceSources(
  sessionId: string | null,
  pin: OpenProjectBinding | null,
  active: boolean,
): ChatDeviceSourcesState & { refresh: () => void } {
  const pinKey = pin?.key ?? null;
  const key = sessionId ? entryKey(sessionId, pin) : null;
  const subscribe = useCallback((listener: () => void) => {
    if (!sessionId) return () => undefined;
    const entry = ensureEntry(sessionId, pin);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
    // Keyed on the pin's key: a rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const state = useSyncExternalStore(
    subscribe,
    () => (key ? entries.get(key)?.snapshot ?? EMPTY_STATE : EMPTY_STATE),
    () => EMPTY_STATE,
  );
  useEffect(() => {
    if (!active || !sessionId) return;
    readEntry(ensureEntry(sessionId, pin));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, pinKey]);
  const refresh = useCallback(() => {
    if (sessionId) readEntry(ensureEntry(sessionId, pin));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, pinKey]);
  return { sources: state.sources, unsupported: state.unsupported, refresh };
}
