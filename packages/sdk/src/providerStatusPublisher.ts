/**
 * The `client.providers` surface: probe, merge, fan out, poll.
 *
 * Lifted out of `createAdeChat` whole. It owns one question — "what does this
 * machine have installed and signed in, right now" — and it answers it from two
 * sources that disagree by design: the runtime's own probe knows what is on
 * disk, and only the model catalog knows how many models are selectable. The
 * merge rule lives in `providers.ts`; this file owns the caching, the listener
 * set, and the timer.
 */

import { errorMessage } from "./errors.js";
import {
  deriveProviderStatus,
  mergeProviderStatus,
  providerStatusFingerprint,
} from "./providers.js";
import type {
  AgentChatModelCatalog,
  ProviderStatus,
  ProviderStatusRpcResult,
  Unsubscribe,
} from "./types.js";

export const DEFAULT_PROVIDER_POLL_MS = 30_000;

export type ProviderStatusPublisherOptions = {
  /**
   * Whether the runtime serves the real probe. Absent on every 0.1.x runtime,
   * which is why the catalog derivation stays rather than being replaced.
   */
  probeSupported: boolean;
  /** Reads the model catalog. Returns null when the call failed. */
  readCatalog: (mode: "cached" | "refresh-stale") => Promise<AgentChatModelCatalog | null>;
  /** Calls the `providers.status` RPC. Throws on a transport failure. */
  requestProbe: (refresh: boolean) => Promise<ProviderStatusRpcResult>;
  /** Records an error against a scope, exactly as the client's own does. */
  recordError: (scope: string, error: unknown) => void;
  logger: (line: string) => void;
  /** Interval for the `onChange` re-derivation while listeners exist. */
  pollIntervalMs?: number | undefined;
  /** True once the owning client is disposed; stops the poll rescheduling. */
  isDisposed: () => boolean;
};

export type ProviderStatusPublisher = {
  /** Probe + derive + merge, fanning out to listeners on a real change. */
  publish(refresh?: boolean): Promise<Record<string, ProviderStatus>>;
  onChange(cb: (status: Record<string, ProviderStatus>) => void): Unsubscribe;
  /** Stops the timer and drops every listener. Idempotent. */
  dispose(): void;
};

export function createProviderStatusPublisher(
  options: ProviderStatusPublisherOptions,
): ProviderStatusPublisher {
  const { probeSupported, readCatalog, requestProbe, recordError, logger, isDisposed } = options;
  const pollMs = options.pollIntervalMs ?? DEFAULT_PROVIDER_POLL_MS;

  let fingerprint = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let warnedAboutDerived = false;
  const listeners = new Set<(status: Record<string, ProviderStatus>) => void>();

  const readProbe = async (refresh: boolean): Promise<ProviderStatusRpcResult | null> => {
    if (!probeSupported) {
      // Once per client. An embedder reading `installed: false` off a derived
      // record and printing "Claude is not installed" is the specific wrong
      // conclusion this line exists to head off.
      if (!warnedAboutDerived) {
        warnedAboutDerived = true;
        logger(
          "ade sdk: this runtime has no providers.status RPC, so provider records are derived from " +
            'the model catalog (source "derived"): installed is modelCount > 0, and binaryPath, ' +
            "version and the remediation commands are null",
        );
      }
      return null;
    }
    try {
      return await requestProbe(refresh);
    } catch (error) {
      recordError("providers.status", error);
      // Advertised and then unanswerable is a runtime problem, not a caller
      // problem: fall back to the catalog rather than failing a setup screen,
      // and say once that the records are now weaker than they claim to be.
      if (!warnedAboutDerived) {
        warnedAboutDerived = true;
        logger(
          `ade sdk: the runtime advertised providers.status but the call failed (${errorMessage(error)}); ` +
            `provider records fall back to catalog derivation with source "derived"`,
        );
      }
      return null;
    }
  };

  const publish = async (refresh = false): Promise<Record<string, ProviderStatus>> => {
    // Both halves in parallel: the probe spawns `--version` per provider and
    // the catalog is a round trip, and serialising them would double the
    // latency of the one call a setup screen makes on mount.
    const [catalog, probe] = await Promise.all([readCatalog("cached"), readProbe(refresh)]);
    const status = mergeProviderStatus(probe, deriveProviderStatus(catalog));
    const next = providerStatusFingerprint(status);
    if (next !== fingerprint) {
      fingerprint = next;
      for (const listener of [...listeners]) {
        try {
          listener(status);
        } catch {
          // A subscriber throwing must not stop the others.
        }
      }
    }
    return status;
  };

  const schedulePoll = (): void => {
    if (timer || isDisposed() || listeners.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void publish().finally(() => schedulePoll());
    }, pollMs);
    timer.unref?.();
  };

  return {
    publish,
    onChange: (cb) => {
      listeners.add(cb);
      // Seed the new listener with the current state, then start polling.
      void publish().catch(() => {});
      schedulePoll();
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0 && timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      listeners.clear();
    },
  };
}
