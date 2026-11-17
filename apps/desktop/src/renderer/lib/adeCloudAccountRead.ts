/**
 * One account read for a surface with no computer on (`shared/adeCloud/accountCalls.ts`):
 * the CTO copy, the automations list, Linear and Jira, the account lane index.
 *
 * - It reads when the surface opens, when the call changes, when the window
 *   comes back to the front (at most once a minute), and on Retry. No timer.
 * - A failure is a state with the server's sentence, never an empty list:
 *   the surface shows "couldn't load" with Retry.
 * - `unsupported`: this ADE has no account bridge, or the server has no such
 *   route (an older server answers 404). The surface keeps today's behavior.
 * - A read never wakes a computer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdeCloudAccountAnswer,
  AdeCloudAccountCall,
  AdeCloudAccountCallFn,
  AdeCloudAccountResults,
} from "../../shared/adeCloud/accountCalls";

export type AdeCloudAccountReadState<T> =
  | { status: "idle"; data: null }
  | { status: "loading"; data: T | null }
  | { status: "ready"; data: T; readAt: number }
  | { status: "unsupported"; data: null }
  | { status: "failed"; data: T | null; code: string; message: string };

const FOCUS_REREAD_MS = 60_000;

/** The account bridge, or null on an ADE without it. */
export function adeCloudAccountCallFn(): AdeCloudAccountCallFn | null {
  if (typeof window === "undefined") return null;
  const bridge = (window.ade as { adeCloud?: { accountCall?: AdeCloudAccountCallFn } } | undefined)?.adeCloud;
  return typeof bridge?.accountCall === "function" ? bridge.accountCall : null;
}

/** One call, outside React (a click, a save). Null result: an older server. */
export async function runAccountCall<C extends AdeCloudAccountCall>(
  call: C,
): Promise<AdeCloudAccountAnswer<AdeCloudAccountResults[C["call"]]> | null> {
  const fn = adeCloudAccountCallFn();
  if (!fn) return null;
  try {
    return await fn(call);
  } catch (error) {
    return {
      ok: false,
      code: "network",
      status: 0,
      message: error instanceof Error && error.message ? error.message : "ADE couldn't reach your ADE account. Try again.",
    };
  }
}

/**
 * Reads `call` while `call` is not null. The call is keyed by its JSON, so a
 * caller may build it inline.
 */
export function useAdeCloudAccountRead<C extends AdeCloudAccountCall>(
  call: C | null,
): { state: AdeCloudAccountReadState<NonNullable<AdeCloudAccountResults[C["call"]]>>; retry: () => void } {
  type Result = NonNullable<AdeCloudAccountResults[C["call"]]>;
  const key = call ? JSON.stringify(call) : null;
  const [state, setState] = useState<AdeCloudAccountReadState<Result>>({ status: "idle", data: null });
  const [attempt, setAttempt] = useState(0);
  const callRef = useRef(call);
  callRef.current = call;
  const readAtRef = useRef(0);
  const keyRef = useRef(key);

  useEffect(() => {
    const current = callRef.current;
    if (!key || !current) {
      setState({ status: "idle", data: null });
      return;
    }
    if (keyRef.current !== key) {
      keyRef.current = key;
      setState({ status: "loading", data: null });
    } else {
      setState((previous) => ({ status: "loading", data: previous.data as Result | null }));
    }
    let cancelled = false;
    void runAccountCall(current).then((answer) => {
      if (cancelled) return;
      readAtRef.current = Date.now();
      if (!answer) {
        setState({ status: "unsupported", data: null });
      } else if (answer.ok) {
        setState(answer.result == null
          ? { status: "unsupported", data: null }
          : { status: "ready", data: answer.result as Result, readAt: Date.now() });
      } else {
        setState((previous) => ({ status: "failed", data: previous.data as Result | null, code: answer.code, message: answer.message }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, attempt]);

  // The window coming back to the front reads again, at most once a minute.
  useEffect(() => {
    if (!key || typeof window === "undefined") return;
    const onFocus = () => {
      if (Date.now() - readAtRef.current < FOCUS_REREAD_MS) return;
      setAttempt((value) => value + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [key]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, retry };
}

/** "Saved 4 min ago", "Saved yesterday at 14:02": when a copy at rest was saved. */
export function savedAgoLabel(at: number | string | null | undefined, verb = "Saved", now = Date.now()): string | null {
  const ms = typeof at === "string" ? Date.parse(at) : at ?? NaN;
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.round((now - (ms as number)) / 1000));
  if (seconds < 60) return `${verb} just now`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${verb} ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${verb} ${hours} h ago`;
  const date = new Date(ms as number);
  return `${verb} ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}
