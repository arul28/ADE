import type {
  ProductAnalyticsCapture,
  ProductAnalyticsCaptureResult,
  ProductAnalyticsStatus,
} from "../../../shared/types/productAnalytics";
import type { AdapterInfra } from "./types";

export type WebAnalyticsNamespace = {
  capture(input: Omit<ProductAnalyticsCapture, "surface">): Promise<ProductAnalyticsCaptureResult>;
  getStatus(): Promise<ProductAnalyticsStatus>;
  setEnabled(enabled: boolean): Promise<ProductAnalyticsStatus>;
};

const WEB_ANALYTICS_ENABLED_KEY = "ade:web-product-analytics-enabled";
const DEFAULT_DAILY_BUDGET = 200;
const NOT_CONFIGURED: ProductAnalyticsCaptureResult = {
  accepted: false,
  reason: "not_configured",
};
const DISABLED: ProductAnalyticsCaptureResult = {
  accepted: false,
  reason: "disabled",
};
const CONSENT_SYNC_ATTEMPTS = 3;

function fallbackStatus(enabled: boolean): ProductAnalyticsStatus {
  return {
    configured: false,
    enabled,
    effective: false,
    host: "not_configured",
    dailyBudget: DEFAULT_DAILY_BUDGET,
    acceptedToday: 0,
    droppedToday: 0,
    day: new Date().toISOString().slice(0, 10),
    consentRequired: hasEnabledPreference() === false,
  };
}

function hasEnabledPreference(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(WEB_ANALYTICS_ENABLED_KEY) !== null;
  } catch {
    return false;
  }
}

function readEnabledPreference(): boolean {
  try {
    return typeof window === "undefined"
      || window.localStorage.getItem(WEB_ANALYTICS_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeEnabledPreference(enabled: boolean): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(WEB_ANALYTICS_ENABLED_KEY, String(enabled));
    }
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
  }
}

export function createAnalyticsNamespace(infra: AdapterInfra): WebAnalyticsNamespace {
  let enabled = readEnabledPreference();
  let consentSyncTail: Promise<void> = Promise.resolve();
  let disconnectedForFailedDisable = false;

  const combineStatus = (remote: ProductAnalyticsStatus): ProductAnalyticsStatus => ({
    ...remote,
    enabled,
    effective: enabled && remote.effective,
    consentRequired: hasEnabledPreference() === false,
  });

  const getStatus = async (): Promise<ProductAnalyticsStatus> => {
    if (!infra.commands.hasAction("analytics.getStatus")) return fallbackStatus(enabled);
    const remote = await infra.commands.call<ProductAnalyticsStatus>(
      "analytics.getStatus",
      {},
      { fallback: fallbackStatus(enabled), requireProject: false },
    );
    return combineStatus(remote);
  };

  const syncClientConsent = (): Promise<ProductAnalyticsStatus> => {
    const requestedEnabled = enabled;
    const run = async (): Promise<ProductAnalyticsStatus> => {
      if (!infra.commands.hasAction("analytics.setClientEnabled")) return await getStatus();
      for (let attempt = 1; attempt <= CONSENT_SYNC_ATTEMPTS; attempt += 1) {
        try {
          const remote = await infra.client.sendCommand(
            "analytics.setClientEnabled",
            { enabled: requestedEnabled },
            { projectId: null, timeoutMs: 5_000 },
          ) as ProductAnalyticsStatus;
          disconnectedForFailedDisable = false;
          return combineStatus(remote);
        } catch {
          if (attempt < CONSENT_SYNC_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 50));
          }
        }
      }
      if (!requestedEnabled && !disconnectedForFailedDisable) {
        // Preserve the fail-closed consent boundary only after retries are
        // exhausted. A reconnect starts with peer analytics disabled.
        disconnectedForFailedDisable = true;
        infra.client.disconnect();
      }
      return fallbackStatus(enabled);
    };
    const result = consentSyncTail.then(run, run);
    consentSyncTail = result.then(() => undefined, () => undefined);
    return result;
  };

  // Re-assert the browser-local preference whenever a new adapter/connection
  // is created so the host never records opted-out web mutations for later
  // export through its local usage ledger.
  void syncClientConsent().catch(() => undefined);
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== WEB_ANALYTICS_ENABLED_KEY) return;
      const nextEnabled = event.newValue === "true";
      if (nextEnabled === enabled) return;
      enabled = nextEnabled;
      void syncClientConsent().catch(() => undefined);
    };
    window.addEventListener("storage", onStorage);
    infra.addDispose(() => window.removeEventListener("storage", onStorage));
  }

  return {
    capture: async (input) => {
      if (!enabled) return DISABLED;
      return await infra.commands.call<ProductAnalyticsCaptureResult>(
        "analytics.capture",
        { ...input, surface: "web" },
        {
          fallback: NOT_CONFIGURED,
          requireProject: false,
        },
      );
    },
    getStatus,
    setEnabled: async (nextEnabled) => {
      enabled = nextEnabled;
      writeEnabledPreference(enabled);
      return await syncClientConsent();
    },
  };
}
