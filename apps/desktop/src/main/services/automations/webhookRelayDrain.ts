// Drains custom webhook requests held by ADE's relay. D1 on the relay is the
// durable stream; the wake socket only says "drain now", and a slow safety poll
// covers a missed hint. Each request is handed to the service's `receive`, and
// only the ones it took are acknowledged (which deletes them on the relay).

import { ACCOUNT_RELAY_TOKEN_HEADER } from "../github/githubRelayConfig";
import type { Logger } from "../logging/logger";
import { createRelayWakeSocket, type RelayWakeSocket, type RelayWakeTarget } from "./relayWakeSocket";
import { lowerCaseHeaders, queryRecord } from "./webhookRequest";
import type { WebhookIncomingRequest } from "./customWebhookService";

const RELAY_SAFETY_POLL_MS = 5 * 60_000;
const RELAY_PAGE_LIMIT = 100;
const RELAY_MAX_PAGES_PER_DRAIN = 20;

type HeldRequest = {
  eventId: string;
  hookId: string;
  method: string;
  query: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: string;
  receivedAt: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWebhookRelayDrain(deps: {
  /** Hooks registered with the relay, the only ones it holds requests for. */
  listRelayHookIds: () => string[];
  readAccountToken: () => Promise<string | null>;
  relayBaseUrl: () => string;
  fetchImpl: typeof fetch;
  logger: Logger;
  receive: (request: WebhookIncomingRequest) => Promise<unknown>;
}) {
  let stopped = true;
  let wakeSocket: RelayWakeSocket | null = null;
  let safetyTimer: ReturnType<typeof setInterval> | null = null;
  let drainInFlight: Promise<void> | null = null;
  let drainAgain = false;

  const drainOnce = async (): Promise<void> => {
    let hookIds = deps.listRelayHookIds();
    if (!hookIds.length) return;
    const accountToken = await deps.readAccountToken();
    if (!accountToken) return;
    const headers = { [ACCOUNT_RELAY_TOKEN_HEADER]: accountToken };
    for (let page = 0; page < RELAY_MAX_PAGES_PER_DRAIN && !stopped; page += 1) {
      const url = new URL(`${deps.relayBaseUrl()}/hooks/events`);
      url.searchParams.set("hooks", hookIds.join(","));
      url.searchParams.set("limit", String(RELAY_PAGE_LIMIT));
      const response = await deps.fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
      const payload = await response.json().catch(() => null) as {
        events?: HeldRequest[];
        hasMore?: boolean;
        error?: string;
      } | null;
      if (!response.ok || !payload || !Array.isArray(payload.events)) {
        throw new Error(payload?.error ?? `ADE relay answered HTTP ${response.status}.`);
      }
      if (!payload.events.length) return;
      const processed: string[] = [];
      for (const event of payload.events) {
        try {
          await deps.receive({
            hookId: event.hookId,
            method: event.method,
            headers: lowerCaseHeaders(event.headers ?? {}),
            query: queryRecord(event.query ?? ""),
            rawBody: Buffer.from(event.body ?? "", event.bodyEncoding === "base64" ? "base64" : "utf8"),
            via: "relay",
            receivedAt: event.receivedAt,
            relayDeliveryId: event.eventId,
          });
          processed.push(event.eventId);
        } catch (error) {
          // Not acknowledged: the relay keeps it (up to its hold limit) and the
          // next drain tries again, so a passing failure such as a locked
          // database loses nothing.
          deps.logger.warn("automations.webhook_relay_delivery_failed", { eventId: event.eventId, error: errorMessage(error) });
        }
      }
      if (!processed.length) {
        // Nothing in this page went through, and unacknowledged requests head
        // every page. Leave their hooks for the next drain and keep draining
        // the others, so one failing hook cannot hold up the rest.
        const failing = new Set(payload.events.map((event) => event.hookId));
        hookIds = hookIds.filter((hookId) => !failing.has(hookId));
        if (!hookIds.length) return;
        continue;
      }
      // Acknowledge after processing. If this call is lost, the same requests
      // come back next drain and the duplicate check (keyed on the relay's
      // delivery id) keeps them from running twice.
      const ack = await deps.fetchImpl(`${deps.relayBaseUrl()}/hooks/ack`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ eventIds: processed }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!ack.ok) throw new Error(`ADE relay did not accept the acknowledgement (HTTP ${ack.status}).`);
      if (!payload.hasMore) return;
    }
  };

  const drain = async (): Promise<void> => {
    if (drainInFlight) {
      drainAgain = true;
      return await drainInFlight;
    }
    drainInFlight = (async () => {
      do {
        drainAgain = false;
        try {
          await drainOnce();
        } catch (error) {
          if (!stopped) deps.logger.warn("automations.webhook_relay_drain_failed", { error: errorMessage(error) });
          return;
        }
      } while (drainAgain && !stopped);
    })().finally(() => {
      drainInFlight = null;
    });
    return await drainInFlight;
  };

  const resolveWakeTarget = async (): Promise<RelayWakeTarget | null> => {
    if (!deps.listRelayHookIds().length) return null;
    const accountToken = await deps.readAccountToken();
    if (!accountToken) return null;
    return {
      url: `${deps.relayBaseUrl().replace(/^http/, "ws")}/hooks/subscribe`,
      headers: { [ACCOUNT_RELAY_TOKEN_HEADER]: accountToken },
    };
  };

  /** Open the wake socket if it is not open yet, and drain now. */
  const ensureConnected = (): void => {
    if (stopped) return;
    if (!wakeSocket) {
      wakeSocket = createRelayWakeSocket({
        resolveTarget: resolveWakeTarget,
        frameType: "hook_delivery",
        onWake: () => void drain(),
        // A (re)connect may have missed hints; drain to catch up.
        onConnectedChange: (connected) => {
          if (connected) void drain();
        },
      });
    }
    void drain();
  };

  return {
    drain,
    ensureConnected,
    /** Returns false when it was already running. */
    start(): boolean {
      if (!stopped) return false;
      stopped = false;
      ensureConnected();
      safetyTimer = setInterval(() => void drain(), RELAY_SAFETY_POLL_MS);
      safetyTimer.unref?.();
      return true;
    },
    stop(): void {
      stopped = true;
      if (safetyTimer) {
        clearInterval(safetyTimer);
        safetyTimer = null;
      }
      wakeSocket?.stop();
      wakeSocket = null;
    },
  };
}
