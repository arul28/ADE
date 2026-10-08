import { randomUUID } from "node:crypto";

import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import {
  BUILT_IN_BROWSER_REMOTE_REQUEST_EVENT,
  type BuiltInBrowserForwardedToDesktop,
  type BuiltInBrowserRemoteRequest,
  type BuiltInBrowserRemoteRequestAck,
} from "../../../../desktop/src/shared/types/builtInBrowserRemote";
import { DesktopBridgeUnavailableError } from "./desktopBridgeClient";
import type { SessionInputOrigin } from "../../../../desktop/src/shared/sessionInputOrigin";
import {
  BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD,
  type BuiltInBrowserDesktopBridgeClient,
} from "./desktopBridgeMethods";

/**
 * `ade browser open` reaching the screen the user is actually looking at.
 *
 * With a desktop on this machine, that desktop takes every call: an agent
 * drives the tab it opened through this machine's bridge. A request to show
 * the user (`--panel`) is also sent to the desktop that sent the chat its last
 * message when that is another machine (a MacBook connected to this Mac
 * Studio), or to every connected desktop when nobody can tell.
 *
 * Without a desktop on this machine: the built-in browser is a
 * `WebContentsView` owned by an Electron main process, so a box running only `ade serve` has no browser to open — the
 * bridge socket simply isn't listening. But a desktop somewhere else may hold a
 * remote pin on this machine's lane, and that desktop can already reach this
 * machine's loopback ports over a port-forward. So instead of failing, the
 * daemon publishes the request on the runtime event stream those desktops are
 * already subscribed to and waits briefly for one of them to say it took it.
 *
 * Only `navigate` / `createTab` / `showPanel` forward: they are "put this URL on
 * a screen", which any attached desktop can satisfy. `observe` / `click` and
 * the rest act on a specific live tab and keep failing with the bridge error,
 * which now says where the browser actually runs.
 */

const ACK_TIMEOUT_MS = 5_000;

type PendingRequest = {
  resolve: (ack: BuiltInBrowserRemoteRequestAck | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RemoteBrowserForwarder = {
  /**
   * Run a "put this URL on a screen" call. The desktop on this machine takes it
   * when there is one; a request to show the user also reaches the desktop
   * the user is talking from; with no desktop here, it goes to one elsewhere.
   */
  route: (
    input: unknown,
    call: (input: unknown) => Promise<unknown>,
    method: string,
  ) => Promise<unknown>;
  /** Runtime action a desktop calls once it has taken (or refused) a request. */
  acknowledgeRemoteRequest: (input: unknown) => { ok: boolean };
  dispose: () => void;
};

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createRemoteBrowserForwarder(args: {
  emitEvent: (payload: Record<string, unknown>) => void;
  logger: Logger;
  /** The desktop that sent a chat its last message, when one is known. */
  resolveOrigin?: (chatSessionId: string) => SessionInputOrigin | null;
  ackTimeoutMs?: number;
}): RemoteBrowserForwarder {
  const pending = new Map<string, PendingRequest>();
  const ackTimeoutMs = args.ackTimeoutMs ?? ACK_TIMEOUT_MS;

  function settle(requestId: string, ack: BuiltInBrowserRemoteRequestAck | null): boolean {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(ack);
    return true;
  }

  async function forward(
    input: unknown,
    targetClientId: string | null,
  ): Promise<BuiltInBrowserForwardedToDesktop> {
    const record = isRecord(input) ? input : {};
    const url = stringOrNull(record.url) ?? "";
    const request: BuiltInBrowserRemoteRequest = {
      requestId: `bbr-${randomUUID()}`,
      url,
      laneId: stringOrNull(record.laneId),
      chatSessionId: stringOrNull(record.chatSessionId),
      openPanel: record.openPanel !== false,
      requestedAt: new Date().toISOString(),
      targetClientId,
    };
    const ack = await new Promise<BuiltInBrowserRemoteRequestAck | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(request.requestId);
        resolve(null);
      }, ackTimeoutMs);
      timer.unref?.();
      pending.set(request.requestId, { resolve, timer });
      try {
        args.emitEvent({ type: BUILT_IN_BROWSER_REMOTE_REQUEST_EVENT, event: request });
      } catch (error) {
        settle(request.requestId, null);
        args.logger.warn("built_in_browser.remote_request_emit_failed", {
          requestId: request.requestId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });
    args.logger.info("built_in_browser.remote_request_forwarded", {
      requestId: request.requestId,
      url: request.url,
      targeted: Boolean(targetClientId),
      acknowledged: Boolean(ack?.accepted),
    });
    return {
      status: "forwarded_to_desktop",
      requestId: request.requestId,
      url: request.url,
      acknowledged: ack?.accepted === true,
      // The desktop acks the moment it takes the request, even when the port
      // still needs a human "Allow" — a first-use approval cannot be answered
      // inside the 5s ack window, and without this the CLI printed a failure
      // for a request that was about to succeed.
      ...(ack?.awaitingApproval === true ? { awaitingApproval: true } : {}),
      desktopLabel: ack?.desktopLabel ?? null,
      reason: ack?.reason ?? null,
    };
  }

  /** To the desktop the user is at; if it does not answer, to any desktop. */
  async function forwardToUser(
    input: unknown,
    targetClientId: string | null,
  ): Promise<BuiltInBrowserForwardedToDesktop> {
    const forwarded = await forward(input, targetClientId);
    if (!targetClientId || forwarded.acknowledged) return forwarded;
    return await forward(input, null);
  }

  return {
    route: async (input, call, method) => {
      const record = isRecord(input) ? input : {};
      const chatSessionId = stringOrNull(record.chatSessionId);
      const origin = chatSessionId ? args.resolveOrigin?.(chatSessionId) ?? null : null;
      // The desktop the user talks from, when that is not this machine's.
      const remoteTargetId = origin && !origin.local ? origin.clientId : null;
      // "Show the user": `showPanel` always, a navigation with `--panel` (or a
      // person's own call). An agent opening a tab for itself to drive is not
      // that and stays on this machine.
      const showToUser = method === "showPanel" || record.openPanel === true;
      // An isolated sign-in exists only in this machine's desktop. A copy
      // opened anywhere else would land in the user's own sign-in, which is
      // exactly what an isolated tab is for avoiding.
      const isolated = record.isolated === true || Boolean(stringOrNull(record.profile));
      // Revealing a panel on this machine has no use when the user is
      // elsewhere and nothing here loads a page an agent drives.
      let forwarded: BuiltInBrowserForwardedToDesktop | null = null;
      if (method === "showPanel" && remoteTargetId) {
        forwarded = await forwardToUser(input, remoteTargetId);
        if (forwarded.acknowledged) return forwarded;
      }
      // This machine's desktop takes the call either way: an agent drives the
      // tab it opened through this machine's bridge. It reveals its panel only
      // when the user is at this machine, or nobody can tell where they are.
      const localInput = showToUser && remoteTargetId ? { ...record, openPanel: false } : input;
      let result: unknown;
      try {
        result = await call(localInput);
      } catch (error) {
        if (!(error instanceof DesktopBridgeUnavailableError)) throw error;
        if (isolated) {
          throw new Error(
            "An isolated tab (--isolated or --profile) opens only in ADE Desktop on this machine, and none is attached. It was not forwarded, because another desktop would open it in the user's own sign-in. Open ADE Desktop here with this project.",
          );
        }
        return forwarded ?? await forwardToUser(input, remoteTargetId);
      }
      if (showToUser && !forwarded && !isolated && (remoteTargetId || !origin)) {
        // Also put it on the other screen: the one the user is talking from,
        // or every connected one when nobody can tell.
        void forwardToUser(input, remoteTargetId).catch(() => {});
      }
      return result;
    },
    acknowledgeRemoteRequest: (input) => {
      const record = isRecord(input) ? input : {};
      const requestId = stringOrNull(record.requestId);
      if (!requestId) return { ok: false };
      return {
        ok: settle(requestId, {
          requestId,
          desktopLabel: stringOrNull(record.desktopLabel) ?? "ADE Desktop",
          accepted: record.accepted !== false,
          ...(record.awaitingApproval === true ? { awaitingApproval: true } : {}),
          reason: stringOrNull(record.reason),
        }),
      };
    },
    dispose: () => {
      for (const requestId of [...pending.keys()]) settle(requestId, null);
    },
  };
}

/** Browser methods that a desktop elsewhere can satisfy on this machine's behalf. */
const FORWARDABLE_BUILT_IN_BROWSER_METHODS = new Set([
  "navigate",
  "createTab",
  "showPanel",
]);

/**
 * Wrap a desktop bridge client so the three "put this URL on a screen" methods
 * fall back to a pinned desktop, and `acknowledgeRemoteRequest` is served
 * locally. Every other method passes straight through.
 */
export function withRemoteBrowserForwarding(
  bridge: BuiltInBrowserDesktopBridgeClient,
  forwarder: RemoteBrowserForwarder,
): BuiltInBrowserDesktopBridgeClient {
  return new Proxy(bridge, {
    get(target, property, receiver) {
      if (property === BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD) {
        return (input?: unknown) => forwarder.acknowledgeRemoteRequest(input);
      }
      if (typeof property === "string" && FORWARDABLE_BUILT_IN_BROWSER_METHODS.has(property)) {
        const inner = Reflect.get(target, property, receiver) as
          | ((input?: unknown) => Promise<unknown>)
          | undefined;
        if (typeof inner !== "function") return inner;
        return (input?: unknown) =>
          forwarder.route(input, (next) => inner(next), property);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as BuiltInBrowserDesktopBridgeClient;
}
