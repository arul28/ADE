import { useSyncExternalStore } from "react";
import type { CloudSignInEnd } from "../../shared/cloudSignIns";
import {
  ADE_CLOUD_BLOCKED_SENTENCE,
  ADE_CLOUD_SIGNED_OUT_SENTENCE,
  type AdeCloudAccessState,
  type CloudAccessIpcAnswer,
} from "../../shared/adeCloudMachine";
import { accountScopedCopy } from "./accountScopedStorage";

/**
 * ADE Cloud's state in this window. ADE Cloud is one machine every account
 * always has, so it shows in every machine list and Run on menu also before
 * the server answers, and for a blocked account (read-only, with the
 * server's sentence). Only a window with no ADE account hides it.
 *
 * The answer comes from this desktop's main process, or on the web from the
 * account server. Read when a window opens or takes focus, and when the
 * answer changes (a sign-in, a sign-out, another computer's window). No
 * timer: the answer reaches the server at most once every 10 minutes
 * (`main/services/adeCloud/cloudAccess.ts`).
 *
 * The last answer is kept in this computer's storage, for the account signed
 * in here only, so a new window of that account starts with it (a blocked
 * account starts read-only, not on). It holds no secret: the state and the
 * server's sentence. A sign-out or another account deletes it; ADE Web keeps
 * it in memory.
 */

export type AdeCloudAccess = {
  state: AdeCloudAccessState;
  /** Why ADE Cloud can't do things now (blocked, signed out), or null while it can. */
  reason: string | null;
};

const STORAGE_KEY = "ade.cloudAccess.v1";

/** A saved answer: only a fact about the account is kept, "on" or "blocked". */
function parseSaved(value: unknown): AdeCloudAccess | null {
  const parsed = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (parsed && (parsed.state === "on" || parsed.state === "blocked")) {
    return {
      state: parsed.state,
      reason: parsed.state === "blocked" && typeof parsed.reason === "string" ? parsed.reason : null,
    };
  }
  return null;
}

let access: AdeCloudAccess = { state: "unknown", reason: null };
/** The end warning's pass, from the same read (desktop main fills it only while ADE Cloud is on). */
let signInEnd: CloudSignInEnd | null = null;
let reading = false;
let readAgain = false;
const listeners = new Set<() => void>();
let stopWatch: (() => void) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

// This computer's copy, for the account signed in here only (`accountScopedStorage.ts`):
// one account's blocked state never shows for the next one, and ADE Web keeps none.
const saved = accountScopedCopy({
  key: STORAGE_KEY,
  restore: (value) => {
    const next = parseSaved(value);
    // A read in this window already answered: that answer is newer.
    if (!next || access.state !== "unknown") return;
    access = next;
    emit();
  },
  forget: () => {
    access = { state: "unknown", reason: null };
    signInEnd = null;
    emit();
    if (stopWatch) read();
  },
});

function save(next: AdeCloudAccess): void {
  if (next.state === "on" || next.state === "blocked") saved.save({ state: next.state, reason: next.reason });
  else if (next.state === "signed_out") saved.clear();
}

/**
 * The window's state from one answer. A main process or web adapter that
 * sends only `enabled` reads as on or blocked: an old server says no only to
 * a blocked account.
 */
function accessOf(answer: CloudAccessIpcAnswer | null | undefined): AdeCloudAccess {
  const state: AdeCloudAccessState = answer?.state ?? (answer?.enabled === true ? "on" : "blocked");
  if (state === "blocked") return { state, reason: answer?.reason?.trim() || ADE_CLOUD_BLOCKED_SENTENCE };
  if (state === "signed_out") return { state, reason: ADE_CLOUD_SIGNED_OUT_SENTENCE };
  // Not known: keep what this window last knew (a saved blocked stays read-only).
  if (state === "unknown") return access.state === "signed_out" ? { state: "unknown", reason: null } : access;
  return { state, reason: null };
}

function read(): void {
  const bridge = typeof window === "undefined" ? undefined : window.ade?.cloudAccess;
  if (!bridge) return;
  if (reading) {
    readAgain = true;
    return;
  }
  reading = true;
  void bridge.read().then(
    (answer) => ({
      access: accessOf(answer),
      end: answer?.enabled === true ? answer.signInEnd ?? null : null,
    }),
    // A failed read is no answer: keep what this window knows.
    () => ({ access, end: signInEnd }),
  ).then((next) => {
    reading = false;
    const accessChanged = next.access.state !== access.state || next.access.reason !== access.reason;
    const endChanged = (next.end?.fingerprint ?? null) !== (signInEnd?.fingerprint ?? null)
      || (next.end?.endsInDays ?? null) !== (signInEnd?.endsInDays ?? null);
    if (accessChanged) {
      access = next.access;
      save(access);
    }
    // The same pass state keeps its object, so the warning does not render again for nothing.
    if (endChanged) signInEnd = next.end;
    if (accessChanged || endChanged) emit();
    if (readAgain) {
      readAgain = false;
      read();
    }
  });
}

function startWatch(): void {
  if (stopWatch || typeof window === "undefined") return;
  const onFocus = () => read();
  window.addEventListener("focus", onFocus);
  const offChanged = window.ade?.cloudAccess?.onChanged(read) ?? null;
  // A pass approved, renewed or removed in any window: the end warning reads again.
  const offSignIns = window.ade?.cloud?.onCloudSignInChanged?.(read) ?? null;
  stopWatch = () => {
    window.removeEventListener("focus", onFocus);
    offChanged?.();
    offSignIns?.();
    stopWatch = null;
  };
  read();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startWatch();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopWatch?.();
  };
}

const shown = (value: AdeCloudAccess) => value.state !== "signed_out";
function snapshot(): boolean {
  return shown(access);
}

function accessSnapshot(): AdeCloudAccess {
  return access;
}

function signInEndSnapshot(): CloudSignInEnd | null {
  return signInEnd;
}

/** The sign-in the end warning names (a Claude pass or a key), or null (always null while ADE Cloud is off). */
export function useCloudSignInEnd(): CloudSignInEnd | null {
  return useSyncExternalStore(subscribe, signInEndSnapshot, signInEndSnapshot);
}

/**
 * Whether ADE Cloud shows in this window: true for every state but signed
 * out. A surface that DOES something (wake, start, send) also reads
 * `useAdeCloudAccess` and stays off with its `reason` while blocked.
 */
export function useAdeCloudEnabled(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** ADE Cloud's state and, while it can't do things, the sentence why. One object per change. */
export function useAdeCloudAccess(): AdeCloudAccess {
  return useSyncExternalStore(subscribe, accessSnapshot, accessSnapshot);
}

/**
 * Why ADE Cloud can't wake or start anything now (blocked, signed out), or
 * null while it can. Unknown is never a block: the server refuses with its
 * own sentence.
 */
export function adeCloudDoBlock(value: AdeCloudAccess): string | null {
  return value.state === "blocked" || value.state === "signed_out" ? value.reason : null;
}

/** For code outside a component that has to act when the answer changes. */
export const subscribeAdeCloudAccess = subscribe;

/** For code outside a component (settings search, one-shot reads). Starts the watch if nothing has. */
export function adeCloudEnabled(): boolean {
  startWatch();
  return shown(access);
}

/** `useAdeCloudAccess` for code outside a component. Starts the watch if nothing has. */
export function adeCloudAccessNow(): AdeCloudAccess {
  startWatch();
  return access;
}
