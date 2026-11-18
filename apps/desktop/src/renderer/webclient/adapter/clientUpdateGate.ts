import {
  EMPTY_CLIENT_UPDATE_GATE_STATE,
  type ClientUpdateGateState,
} from "../../../shared/clientUpdateGate";
import { createClientMinimumReader, fetchClientMinimumBody } from "../../../shared/clientMinimumReader";
import type { BrowserAccountClient } from "../account/client";

const READ_INTERVAL_MS = 3 * 60 * 60_000;
const FOCUS_REREAD_MS = 30 * 60_000;

/**
 * ADE Web's `clientUpdateGate`. This tab is always the deployed build, so it
 * never blocks itself (`self` is never required); the minimum is read only so
 * another machine's surfaces can say it runs an old ADE. `/client/minimum` is
 * public (no bearer, CORS *). Read when a window first asks, every 3 hours
 * while one listens, and when the tab regains focus after 30 minutes.
 */
export function createWebClientUpdateGate(accountClient: BrowserAccountClient) {
  const reader = createClientMinimumReader({
    fetchBody: () => fetchClientMinimumBody(accountClient.getDirectoryBaseUrl() ?? ""),
  });
  const listeners = new Set<(state: ClientUpdateGateState) => void>();
  let state: ClientUpdateGateState = EMPTY_CLIENT_UPDATE_GATE_STATE;
  let started = false;

  const compute = async (): Promise<ClientUpdateGateState> => {
    const minimum = reader.current();
    // The newest builds come from the account (`/releases/latest`); only
    // needed when a minimum is set.
    const latest = minimum ? await accountClient.readLatestReleases() : accountClient.peekLatestReleases();
    return {
      ...EMPTY_CLIENT_UPDATE_GATE_STATE,
      minimum: minimum ? { desktop: minimum.desktop } : null,
      latest: { stable: latest.stable, beta: latest.beta },
      downloadUrl: minimum?.links.download ?? EMPTY_CLIENT_UPDATE_GATE_STATE.downloadUrl,
      answeredAt: reader.answeredAtMs(),
    };
  };

  const read = async (): Promise<ClientUpdateGateState> => {
    await reader.refresh();
    const next = await compute();
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      state = next;
      for (const listener of listeners) listener(next);
    }
    return state;
  };

  const start = () => {
    if (started || typeof window === "undefined") return;
    started = true;
    const tick = () => {
      window.setTimeout(() => {
        void read().finally(tick);
      }, READ_INTERVAL_MS);
    };
    tick();
    window.addEventListener("focus", () => {
      const attempted = reader.attemptedAtMs();
      if (attempted == null || Date.now() - attempted > FOCUS_REREAD_MS) void read();
    });
  };

  return {
    getState: async (): Promise<ClientUpdateGateState> => {
      start();
      return reader.attemptedAtMs() == null ? await read() : state;
    },
    refresh: read,
    onChange: (listener: (next: ClientUpdateGateState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
