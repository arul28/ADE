import { useEffect, useRef } from "react";
import type { OpenProjectBinding } from "../../shared/types";
import { THIS_MACHINE_NAME } from "../../shared/machineIdentity";
import type {
  WorkToolShowAckStatus,
  WorkToolShowRequest,
  WorkToolShowSurface,
} from "../../shared/types/workToolShow";

/**
 * Where `ade ui show` lands in the renderer.
 *
 * The request arrives once, on a window-wide subscription, but the thing that
 * can show a surface is whichever pane has that chat in front — and it may not
 * be mounted yet. So surfaces register a handler for the chat they show, a
 * request goes to the matching handler at once, and a request nobody can take
 * is held until one registers (the user opens that chat).
 *
 * Holds expire, so a chat opened tomorrow does not replay a show the agent
 * asked for today. Automatic floating offers are never held: they are about
 * what the agent is doing now, and the next one will come if it still is.
 */

export type WorkToolShowHandler = {
  chatSessionId: string;
  surfaces: readonly WorkToolShowSurface[];
  /**
   * Returns true when the surface is on screen now. Async for the floating
   * device, which may have to ask the runtime which device the lane holds.
   */
  show: (request: WorkToolShowRequest) => boolean | Promise<boolean>;
};

type HeldShow = { request: WorkToolShowRequest; heldAtMs: number };

/** Long enough for "I'll look in a minute"; short enough not to surprise. */
export const WORK_TOOL_SHOW_HOLD_TTL_MS = 10 * 60_000;
const HOLD_CAP = 16;
const SEEN_CAP = 64;

const handlers = new Set<WorkToolShowHandler>();
let holds: HeldShow[] = [];
const seen = new Set<string>();
let clockMs: number | null = null;

function nowMs(): number {
  return clockMs ?? Date.now();
}

function handles(handler: WorkToolShowHandler, request: WorkToolShowRequest): boolean {
  return handler.chatSessionId === request.chatSessionId && handler.surfaces.includes(request.surface);
}

function pruneExpired(): void {
  const now = nowMs();
  holds = holds.filter((held) => now - held.heldAtMs <= WORK_TOOL_SHOW_HOLD_TTL_MS);
}

async function tryShow(handler: WorkToolShowHandler, request: WorkToolShowRequest): Promise<boolean> {
  try {
    return (await handler.show(request)) === true;
  } catch {
    return false;
  }
}

async function offer(request: WorkToolShowRequest): Promise<boolean> {
  for (const handler of [...handlers]) {
    if (!handles(handler, request)) continue;
    if (await tryShow(handler, request)) return true;
  }
  return false;
}

function hold(request: WorkToolShowRequest, heldAtMs: number = nowMs()): void {
  pruneExpired();
  // A newer ask for the same surface of the same chat replaces the older one.
  holds = holds.filter((held) => !(
    held.request.chatSessionId === request.chatSessionId && held.request.surface === request.surface
  ));
  holds.push({ request, heldAtMs });
  while (holds.length > HOLD_CAP) holds.shift();
}

/**
 * Take a request off the wire. Returns what to tell the brain, or null for a
 * request already seen (the same request can arrive on two subscriptions) and
 * for an automatic offer nobody took.
 */
export async function receiveWorkToolShowRequest(
  request: WorkToolShowRequest,
): Promise<WorkToolShowAckStatus | null> {
  if (seen.has(request.requestId)) return null;
  seen.add(request.requestId);
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value;
    if (oldest) seen.delete(oldest);
  }
  if (await offer(request)) return "shown";
  if (request.auto) return null;
  hold(request);
  return "held";
}

/**
 * A surface that can show a chat's panes. Anything held for it is delivered
 * now, which is how a show asked for while the chat was in the background
 * appears when the user opens it.
 */
export function registerWorkToolShowHandler(handler: WorkToolShowHandler): () => void {
  handlers.add(handler);
  pruneExpired();
  // Claimed before showing, so a second handler registering in the same tick
  // cannot deliver the same request twice; put back if this one could not.
  const waiting = holds.filter((held) => handles(handler, held.request));
  holds = holds.filter((held) => !waiting.includes(held));
  for (const held of waiting) {
    void tryShow(handler, held.request).then((shown) => {
      if (!shown) hold(held.request, held.heldAtMs);
    });
  }
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Register a handler for as long as `chatSessionId` is set. The show function
 * is read through a ref, so a new closure every render does not re-register
 * (and re-drain) the handler.
 */
export function useWorkToolShowHandler(
  chatSessionId: string | null,
  surfaces: readonly WorkToolShowSurface[],
  show: (request: WorkToolShowRequest) => boolean | Promise<boolean>,
): void {
  const showRef = useRef(show);
  showRef.current = show;
  const surfacesKey = surfaces.join(",");
  useEffect(() => {
    if (!chatSessionId) return undefined;
    return registerWorkToolShowHandler({
      chatSessionId,
      surfaces: surfacesKey.split(",") as WorkToolShowSurface[],
      show: (request) => showRef.current(request),
    });
  }, [chatSessionId, surfacesKey]);
}

/**
 * Listen for show requests on one runtime and answer them there. The window's
 * own binding is `pin` null; a session on another machine passes its pin.
 */
export function useWorkToolShowRequestListener(
  enabled: boolean,
  pin: OpenProjectBinding | null = null,
): void {
  useEffect(() => {
    const api = window.ade?.workTools;
    if (!enabled || !api?.onShowRequest) return undefined;
    return api.onShowRequest((request) => {
      void receiveWorkToolShowRequest(request).then((status) => {
        if (!status || request.auto) return;
        return api.acknowledgeShow?.(
          { requestId: request.requestId, status, desktopLabel: THIS_MACHINE_NAME },
          pin,
        );
      }).catch(() => {});
    }, pin);
  }, [enabled, pin]);
}

/** Test seam: freeze the hold clock. */
export function setWorkToolShowClockForTests(ms: number | null): void {
  clockMs = ms;
}

/** Test seam: drops handlers and holds so one test cannot leak into the next. */
export function resetWorkToolShowRequestsForTests(): void {
  handlers.clear();
  holds = [];
  seen.clear();
  clockMs = null;
}
