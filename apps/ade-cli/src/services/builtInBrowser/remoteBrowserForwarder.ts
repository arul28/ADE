import { randomUUID } from "node:crypto";

import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import {
  BUILT_IN_BROWSER_REMOTE_REQUEST_EVENT,
  type BuiltInBrowserForwardedToDesktop,
  type BuiltInBrowserRemoteRequest,
  type BuiltInBrowserRemoteRequestAck,
} from "../../../../desktop/src/shared/types/builtInBrowserRemote";
import { DesktopBridgeUnavailableError } from "./desktopBridgeClient";
import {
  BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD,
  type BuiltInBrowserDesktopBridgeClient,
} from "./desktopBridgeMethods";

/**
 * `ade browser open` on a machine that has no desktop attached.
 *
 * The built-in browser is a `WebContentsView` owned by an Electron main
 * process, so a box running only `ade serve` has no browser to open — the
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
  /** Wrap a bridge call, forwarding to an attached desktop when there is none here. */
  forwardIfNoDesktop: (
    input: unknown,
    call: () => Promise<unknown>,
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

  async function forward(input: unknown): Promise<BuiltInBrowserForwardedToDesktop> {
    const record = isRecord(input) ? input : {};
    const url = stringOrNull(record.url) ?? "";
    const request: BuiltInBrowserRemoteRequest = {
      requestId: `bbr-${randomUUID()}`,
      url,
      laneId: stringOrNull(record.laneId),
      chatSessionId: stringOrNull(record.chatSessionId),
      openPanel: record.openPanel !== false,
      requestedAt: new Date().toISOString(),
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

  return {
    forwardIfNoDesktop: async (input, call) => {
      try {
        return await call();
      } catch (error) {
        if (!(error instanceof DesktopBridgeUnavailableError)) throw error;
        return await forward(input);
      }
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
export const FORWARDABLE_BUILT_IN_BROWSER_METHODS = new Set([
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
          forwarder.forwardIfNoDesktop(input, () => inner(input));
      }
      return Reflect.get(target, property, receiver);
    },
  }) as BuiltInBrowserDesktopBridgeClient;
}
