import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import { safeJsonParse, writeTextAtomic } from "../shared/utils";
import {
  PRODUCT_ANALYTICS_EVENTS,
  type ProductAnalyticsCapture,
  type ProductAnalyticsCaptureResult,
  type ProductAnalyticsEventName,
  type ProductAnalyticsStatus,
} from "../../../shared/types/productAnalytics";
import {
  DEDUPE_CACHE_LIMIT,
  DEFAULT_DAILY_BUDGET,
  DEFAULT_DEDUPE_WINDOW_MS,
  EVENT_DAILY_BUDGETS,
  EVENT_MINUTE_BUDGETS,
  INTERNAL_ONLY_EVENTS,
  MAX_HISTORICAL_EVENT_AGE_MS,
  MAX_LOCAL_IDENTIFIER_LENGTH,
  PROCESS_INGRESS_LIMIT_PER_MINUTE,
  safeProductAnalyticsString,
  sanitizeProductAnalyticsProperties,
} from "./productAnalyticsPolicy";

declare const __ADE_POSTHOG_PROJECT_TOKEN__: string | undefined;
declare const __ADE_POSTHOG_HOST__: string | undefined;

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const STATE_LOCK_WAIT_MS = 25;
const STATE_LOCK_STALE_MS = 5_000;
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PendingBudgetSummary = {
  sentCount: number;
  droppedCount: number;
  dropReason: string;
};

type ProductAnalyticsQuotaState = {
  day: string;
  accepted: number;
  dropped: number;
  acceptedByEvent: Partial<Record<ProductAnalyticsEventName, number>>;
  minuteWindows: Partial<Record<ProductAnalyticsEventName, number[]>>;
  dedupe: Record<string, number>;
  droppedByReason: Record<string, number>;
  pendingBudgetSummary?: PendingBudgetSummary;
};

type ProductAnalyticsState = {
  version: 1;
  installationId: string;
  hashSalt: string;
  enabled: boolean;
  /** Oldest usage-ledger timestamp that may be exported under current consent. */
  enabledSinceMs: number | null;
  quota: ProductAnalyticsQuotaState;
};

export type ProductAnalyticsClient = {
  capture(message: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    timestamp?: Date;
    uuid?: string;
  }): void;
  flush(): Promise<void>;
  shutdown(timeoutMs?: number, options?: { flush?: boolean }): Promise<void>;
};

type ProductAnalyticsServiceArgs = {
  stateFilePath: string;
  logger: Pick<Logger, "debug" | "warn">;
  appVersion?: string | null;
  runtimeMode: string;
  projectToken?: string | null;
  host?: string | null;
  dailyBudget?: number;
  now?: () => number;
  makeClient?: (token: string, host: string) => ProductAnalyticsClient;
};

function bundledProjectToken(): string {
  const bundled = typeof __ADE_POSTHOG_PROJECT_TOKEN__ === "string"
    ? __ADE_POSTHOG_PROJECT_TOKEN__.trim()
    : "";
  return process.env.ADE_POSTHOG_PROJECT_TOKEN?.trim() || bundled;
}

function normalizeProjectToken(value: string | null | undefined): string {
  const token = value?.trim() ?? "";
  return /^phc_[A-Za-z0-9_-]{8,}$/.test(token) ? token : "";
}

function bundledHost(): string {
  const bundled = typeof __ADE_POSTHOG_HOST__ === "string"
    ? __ADE_POSTHOG_HOST__.trim()
    : "";
  return process.env.ADE_POSTHOG_HOST?.trim() || bundled;
}

function normalizeHost(value: string | null | undefined): string | null {
  const configured = value?.trim();
  if (!configured) return DEFAULT_POSTHOG_HOST;
  try {
    const parsed = new URL(configured);
    const isLocalHttp = parsed.protocol === "http:"
      && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !isLocalHttp) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function freshQuotaState(nowMs: number): ProductAnalyticsQuotaState {
  return {
    day: utcDay(nowMs),
    accepted: 0,
    dropped: 0,
    acceptedByEvent: {},
    minuteWindows: {},
    dedupe: {},
    droppedByReason: {},
  };
}

function finiteCount(value: unknown, maximum = 1_000_000_000): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(maximum, Math.floor(value))
    : 0;
}

function normalizeQuotaState(value: unknown, nowMs: number): ProductAnalyticsQuotaState {
  if (!value || typeof value !== "object") return freshQuotaState(nowMs);
  const raw = value as Partial<ProductAnalyticsQuotaState>;
  const day = typeof raw.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.day)
    ? raw.day
    : utcDay(nowMs);
  const acceptedByEvent: Partial<Record<ProductAnalyticsEventName, number>> = {};
  const minuteWindows: Partial<Record<ProductAnalyticsEventName, number[]>> = {};
  for (const event of PRODUCT_ANALYTICS_EVENTS) {
    const accepted = finiteCount(raw.acceptedByEvent?.[event]);
    if (accepted > 0) acceptedByEvent[event] = accepted;
    const recent = Array.isArray(raw.minuteWindows?.[event])
      ? raw.minuteWindows[event]
          .filter((timestamp): timestamp is number =>
            typeof timestamp === "number"
            && Number.isFinite(timestamp)
            && timestamp >= nowMs - 60_000
            && timestamp <= nowMs + 60_000)
          .slice(-EVENT_MINUTE_BUDGETS[event])
      : [];
    if (recent.length > 0) minuteWindows[event] = recent;
  }
  const dedupeEntries = raw.dedupe && typeof raw.dedupe === "object"
    ? Object.entries(raw.dedupe)
        .filter((entry): entry is [string, number] =>
          /^[0-9a-f]{32}$/i.test(entry[0])
          && typeof entry[1] === "number"
          && Number.isFinite(entry[1])
          && entry[1] >= nowMs - MAX_HISTORICAL_EVENT_AGE_MS
          && entry[1] <= nowMs + 60_000)
        .sort((a, b) => a[1] - b[1])
        .slice(-DEDUPE_CACHE_LIMIT)
    : [];
  const droppedByReason: Record<string, number> = {};
  if (raw.droppedByReason && typeof raw.droppedByReason === "object") {
    for (const [reason, count] of Object.entries(raw.droppedByReason)) {
      if (/^[a-z_]{1,40}$/.test(reason)) droppedByReason[reason] = finiteCount(count);
    }
  }
  const pending = raw.pendingBudgetSummary;
  const pendingBudgetSummary = pending && typeof pending === "object"
    ? {
        sentCount: finiteCount(pending.sentCount),
        droppedCount: finiteCount(pending.droppedCount),
        dropReason: typeof pending.dropReason === "string" && /^[a-z_]{1,40}$/.test(pending.dropReason)
          ? pending.dropReason
          : "none",
      }
    : undefined;
  return {
    day,
    accepted: finiteCount(raw.accepted),
    dropped: finiteCount(raw.dropped),
    acceptedByEvent,
    minuteWindows,
    dedupe: Object.fromEntries(dedupeEntries),
    droppedByReason,
    ...(pendingBudgetSummary ? { pendingBudgetSummary } : {}),
  };
}

function createInitialState(nowMs: number): ProductAnalyticsState {
  return {
    version: 1,
    installationId: `ade_${randomBytes(16).toString("hex")}`,
    hashSalt: randomBytes(32).toString("hex"),
    enabled: true,
    enabledSinceMs: nowMs,
    quota: freshQuotaState(nowMs),
  };
}

function createFailClosedState(nowMs: number): ProductAnalyticsState {
  const state = createInitialState(nowMs);
  state.enabled = false;
  state.enabledSinceMs = null;
  state.quota.accepted = 1_000_000_000;
  state.quota.dropped = 1_000_000_000;
  state.quota.droppedByReason.state_invalid = 1_000_000_000;
  return state;
}

function normalizeState(value: unknown, nowMs: number): ProductAnalyticsState | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<ProductAnalyticsState>;
  if (
    parsed.version !== 1
    || typeof parsed.installationId !== "string"
    || !/^ade_[0-9a-f]{32}$/i.test(parsed.installationId)
  ) return null;
  const enabled = parsed.enabled !== false;
  return {
    version: 1,
    installationId: parsed.installationId,
    hashSalt: typeof parsed.hashSalt === "string" && /^[0-9a-f]{64}$/i.test(parsed.hashSalt)
      ? parsed.hashSalt
      : randomBytes(32).toString("hex"),
    enabled,
    enabledSinceMs: enabled
      ? (typeof parsed.enabledSinceMs === "number" && Number.isFinite(parsed.enabledSinceMs)
          ? Math.max(0, Math.min(nowMs, Math.floor(parsed.enabledSinceMs)))
          : nowMs)
      : null,
    quota: normalizeQuotaState(parsed.quota, nowMs),
  };
}

function readState(filePath: string, nowMs: number): ProductAnalyticsState {
  let existingText: string | null = null;
  try {
    existingText = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return createFailClosedState(nowMs);
  }
  if (existingText != null) {
    const normalized = normalizeState(
      safeJsonParse<Partial<ProductAnalyticsState>>(existingText, {}),
      nowMs,
    );
    // Never replace an existing malformed state with default-on consent or a
    // fresh quota. A user can explicitly re-enable analytics to recover it.
    return normalized ?? createFailClosedState(nowMs);
  }
  const state = createInitialState(nowMs);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const winner = normalizeState(
        safeJsonParse<Partial<ProductAnalyticsState>>(fs.readFileSync(filePath, "utf8"), {}),
        nowMs,
      );
      return winner ?? createFailClosedState(nowMs);
    }
    writeTextAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return state;
  }
}

function readExistingState(filePath: string, nowMs: number): ProductAnalyticsState | null {
  try {
    const normalized = normalizeState(
      safeJsonParse<Partial<ProductAnalyticsState>>(fs.readFileSync(filePath, "utf8"), {}),
      nowMs,
    );
    return normalized ?? createFailClosedState(nowMs);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : createFailClosedState(nowMs);
  }
}

function writeState(filePath: string, state: ProductAnalyticsState): void {
  writeTextAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

const stateLockWaitArray = new Int32Array(new SharedArrayBuffer(4));

function acquireStateLock(filePath: string, waitMs: number): (() => void) | null {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + Math.max(0, waitMs);
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      return () => {
        try {
          fs.rmdirSync(lockPath);
        } catch {
          // A stale-lock cleanup racing this release is harmless.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STATE_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return null;
      Atomics.wait(stateLockWaitArray, 0, 0, 2);
    }
  }
}

function incrementDrop(quota: ProductAnalyticsQuotaState, reason: string): void {
  quota.dropped = Math.min(1_000_000_000, quota.dropped + 1);
  quota.droppedByReason[reason] = Math.min(
    1_000_000_000,
    (quota.droppedByReason[reason] ?? 0) + 1,
  );
}

function primaryDropReason(quota: ProductAnalyticsQuotaState): string {
  return Object.entries(quota.droppedByReason)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
}

function rollQuotaDay(state: ProductAnalyticsState, nowMs: number): ProductAnalyticsState {
  const nextDay = utcDay(nowMs);
  if (state.quota.day === nextDay) return state;
  const previous = state.quota;
  const existing = previous.pendingBudgetSummary;
  const hasCurrentSummary = previous.accepted > 0 || previous.dropped > 0;
  const pendingBudgetSummary = existing || hasCurrentSummary
    ? {
        sentCount: Math.min(1_000_000_000, (existing?.sentCount ?? 0) + previous.accepted),
        droppedCount: Math.min(1_000_000_000, (existing?.droppedCount ?? 0) + previous.dropped),
        dropReason: existing?.dropReason && existing.dropReason !== "none"
          ? existing.dropReason
          : primaryDropReason(previous),
      }
    : undefined;
  return {
    ...state,
    quota: {
      ...freshQuotaState(nowMs),
      ...(pendingBudgetSummary ? { pendingBudgetSummary } : {}),
    },
  };
}

function makePostHogClient(token: string, host: string): ProductAnalyticsClient {
  type Message = Parameters<ProductAnalyticsClient["capture"]>[0];
  const captureUrl = `${host}/i/v0/e/`;
  const queue: Message[] = [];
  const activeControllers = new Set<AbortController>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushPromise: Promise<void> | null = null;
  let stopped = false;

  const send = async (message: Message): Promise<void> => {
    const payload = {
      api_key: token,
      distinct_id: message.distinctId,
      event: message.event,
      properties: message.properties ?? {},
      ...(message.timestamp ? { timestamp: message.timestamp.toISOString() } : {}),
      ...(message.uuid ? { uuid: message.uuid } : {}),
    };
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (stopped) throw new Error("PostHog analytics client is stopped");
      const controller = new AbortController();
      activeControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 5_000);
      timeout.unref?.();
      try {
        const response = await fetch(captureUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        if (response.ok) return;
        lastError = new Error(`PostHog capture returned ${response.status}`);
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        lastError = error;
        if (stopped) break;
      } finally {
        clearTimeout(timeout);
        activeControllers.delete(controller);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("PostHog capture failed");
  };

  const drain = async (): Promise<void> => {
    const batch = queue.splice(0, 50);
    const results = await Promise.allSettled(batch.map(send));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };

  const flush = async (): Promise<void> => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = null;
    if (flushPromise) await flushPromise;
    while (queue.length > 0) {
      flushPromise = drain().finally(() => {
        flushPromise = null;
      });
      await flushPromise;
    }
  };

  const schedule = (): void => {
    if (queue.length >= 20) {
      void flush().catch(() => {});
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush().catch(() => {});
    }, 10_000);
    timer.unref?.();
  };

  const stopWithoutFlush = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    queue.splice(0, queue.length);
    for (const controller of activeControllers) controller.abort();
  };

  return {
    capture(message) {
      if (stopped) throw new Error("PostHog analytics client is stopped");
      if (queue.length >= 200) throw new Error("PostHog analytics queue is full");
      queue.push(message);
      schedule();
    },
    flush,
    async shutdown(timeoutMs = 2_000, options) {
      if (options?.flush === false) {
        stopWithoutFlush();
        await flushPromise?.catch(() => {});
        return;
      }
      const flushTask = flush();
      let deadline: ReturnType<typeof setTimeout> | null = null;
      const deadlineTask = new Promise<void>((resolve) => {
        deadline = setTimeout(() => {
          stopWithoutFlush();
          resolve();
        }, Math.max(0, timeoutMs));
        deadline.unref?.();
      });
      await Promise.race([flushTask.catch(() => {}), deadlineTask]);
      if (deadline) clearTimeout(deadline);
      stopWithoutFlush();
      await flushTask.catch(() => {});
    },
  };
}

export function createProductAnalyticsService(args: ProductAnalyticsServiceArgs) {
  const now = args.now ?? Date.now;
  const token = normalizeProjectToken(args.projectToken?.trim() || bundledProjectToken());
  const host = normalizeHost(args.host ?? bundledHost());
  const appVersion = safeProductAnalyticsString(args.appVersion?.trim() ?? "") ?? "unknown";
  const dailyBudget = Math.max(25, Math.min(2_000, Math.floor(args.dailyBudget ?? DEFAULT_DAILY_BUDGET)));
  // State stays lazy so builds without a valid public project token have zero
  // analytics filesystem or module-startup cost. Every configured path catches
  // state failures and fails closed without affecting ADE startup.
  let state = createInitialState(now());
  let client: ProductAnalyticsClient | null = null;
  let ingressTimestamps: number[] = [];
  let pendingIngressDrops = 0;
  const optOutMarkerPath = `${args.stateFilePath}.disabled`;
  let volatileOptOut = false;
  let optOutCanRecoverFromPersistedOptIn = false;
  let optOutWatcherStarted = false;

  const cancelClientForOptOut = (canRecoverFromPersistedOptIn = false): void => {
    volatileOptOut = true;
    optOutCanRecoverFromPersistedOptIn ||= canRecoverFromPersistedOptIn;
    state = { ...state, enabled: false, enabledSinceMs: null };
    const current = client;
    client = null;
    if (current) {
      void current.shutdown(1_500, { flush: false }).catch(() => {});
    }
  };

  const reconcileOptOutMarker = (): boolean => {
    if (fs.existsSync(optOutMarkerPath)) {
      cancelClientForOptOut(true);
      return true;
    }

    // Another ADE process may have completed an explicit opt-in by first
    // persisting enabled=true and then removing the shared disable marker.
    // Re-read that durable preference before clearing the process-local latch;
    // a missing/malformed/disabled state remains fail-closed.
    if (volatileOptOut && optOutCanRecoverFromPersistedOptIn) {
      const persisted = readExistingState(args.stateFilePath, now());
      if (persisted?.enabled) {
        state = rollQuotaDay(persisted, now());
        volatileOptOut = false;
        optOutCanRecoverFromPersistedOptIn = false;
      }
    }
    return volatileOptOut;
  };

  const isLocallyOptedOut = (): boolean => reconcileOptOutMarker();

  const onOptOutMarkerChanged = (): void => {
    reconcileOptOutMarker();
  };

  const startOptOutWatcher = (): void => {
    if (optOutWatcherStarted) return;
    optOutWatcherStarted = true;
    fs.watchFile(optOutMarkerPath, { interval: 100, persistent: false }, onOptOutMarkerChanged);
  };

  const stopOptOutWatcher = (): void => {
    if (!optOutWatcherStarted) return;
    optOutWatcherStarted = false;
    fs.unwatchFile(optOutMarkerPath, onOptOutMarkerChanged);
  };

  const isRuntimeDisabled = () =>
    process.env.ADE_DISABLE_PRODUCT_ANALYTICS === "1"
    || process.env.NODE_ENV === "test"
    || process.env.VITEST === "true";

  const effective = (currentState = state) =>
    Boolean(token && host)
    && currentState.enabled
    && !isLocallyOptedOut()
    && !isRuntimeDisabled();

  const ensureClient = (currentState: ProductAnalyticsState): ProductAnalyticsClient | null => {
    if (!effective(currentState) || !host) return null;
    if (!client) {
      client = (args.makeClient ?? makePostHogClient)(token, host);
      startOptOutWatcher();
      if (isLocallyOptedOut()) {
        cancelClientForOptOut();
        return null;
      }
    }
    return client;
  };

  const emitPendingBudgetSummary = (
    currentState: ProductAnalyticsState,
    posthog: ProductAnalyticsClient,
  ): void => {
    const summary = currentState.quota.pendingBudgetSummary;
    if (!summary) return;
    delete currentState.quota.pendingBudgetSummary;
    if (
      currentState.quota.accepted >= dailyBudget
      || (currentState.quota.acceptedByEvent.ade_analytics_budget ?? 0) >= EVENT_DAILY_BUDGETS.ade_analytics_budget
    ) {
      incrementDrop(currentState.quota, "daily_budget");
      return;
    }
    try {
      currentState.quota.accepted += 1;
      currentState.quota.acceptedByEvent.ade_analytics_budget =
        (currentState.quota.acceptedByEvent.ade_analytics_budget ?? 0) + 1;
      currentState.quota.minuteWindows.ade_analytics_budget = [now()];
      writeState(args.stateFilePath, currentState);
      posthog.capture({
        distinctId: currentState.installationId,
        event: "ade_analytics_budget",
        properties: {
          surface: "api",
          sent_count: summary.sentCount,
          dropped_count: summary.droppedCount,
          drop_reason: summary.dropReason,
          app_version: appVersion,
          runtime_mode: safeProductAnalyticsString(args.runtimeMode) ?? "unknown",
          platform: process.platform,
          arch: process.arch,
          $process_person_profile: false,
          $geoip_disable: true,
        },
        uuid: randomUUID(),
      });
    } catch (error) {
      incrementDrop(currentState.quota, "transport_error");
      writeState(args.stateFilePath, currentState);
      args.logger.debug("product_analytics.budget_capture_failed", {
        errorKind: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  const opaqueId = (kind: "project" | "session", value: string | null | undefined): string | null => {
    if (typeof value !== "string" || value.length > MAX_LOCAL_IDENTIFIER_LENGTH) return null;
    const normalized = value.trim();
    if (!normalized) return null;
    return createHash("sha256")
      .update(`${state.hashSalt}:${kind}:${normalized}`)
      .digest("hex")
      .slice(0, 24);
  };

  const captureImpl = (
    input: ProductAnalyticsCapture,
    allowInternal: boolean,
  ): ProductAnalyticsCaptureResult => {
    if (!token || !host) return { accepted: false, reason: "not_configured" };
    if (isRuntimeDisabled() || isLocallyOptedOut()) {
      if (isLocallyOptedOut()) cancelClientForOptOut();
      return { accepted: false, reason: "disabled" };
    }
    const ingressNow = now();
    ingressTimestamps = ingressTimestamps.filter((timestamp) => timestamp >= ingressNow - 60_000);
    if (ingressTimestamps.length >= PROCESS_INGRESS_LIMIT_PER_MINUTE) {
      pendingIngressDrops = Math.min(1_000_000, pendingIngressDrops + 1);
      return { accepted: false, reason: "rate_limited" };
    }
    ingressTimestamps.push(ingressNow);
    let release: (() => void) | null = null;
    try {
      release = acquireStateLock(args.stateFilePath, STATE_LOCK_WAIT_MS);
      if (!release) {
        pendingIngressDrops = Math.min(1_000_000, pendingIngressDrops + 1);
        return { accepted: false, reason: "rate_limited" };
      }
      state = rollQuotaDay(readState(args.stateFilePath, now()), now());
      if (pendingIngressDrops > 0) {
        state.quota.dropped = Math.min(1_000_000_000, state.quota.dropped + pendingIngressDrops);
        state.quota.droppedByReason.rate_limited = Math.min(
          1_000_000_000,
          (state.quota.droppedByReason.rate_limited ?? 0) + pendingIngressDrops,
        );
        pendingIngressDrops = 0;
      }
      const drop = (reason: ProductAnalyticsCaptureResult["reason"]): ProductAnalyticsCaptureResult => {
        if (reason !== "not_configured" && reason !== "disabled") incrementDrop(state.quota, reason);
        writeState(args.stateFilePath, state);
        return { accepted: false, reason };
      };
      if (!state.enabled) return { accepted: false, reason: "disabled" };
      if (!input || typeof input !== "object" || !(PRODUCT_ANALYTICS_EVENTS as readonly string[]).includes(input.event)) {
        return drop("invalid_event");
      }
      if (!allowInternal && INTERNAL_ONLY_EVENTS.has(input.event)) return drop("invalid_event");
      if (!["desktop", "mobile", "tui", "web", "api"].includes(input.surface)) {
        return drop("invalid_surface");
      }

      const posthog = ensureClient(state);
      if (!posthog) return { accepted: false, reason: "disabled" };
      emitPendingBudgetSummary(state, posthog);
      if (state.quota.accepted >= dailyBudget) return drop("daily_budget");
      if ((state.quota.acceptedByEvent[input.event] ?? 0) >= EVENT_DAILY_BUDGETS[input.event]) {
        return drop("daily_budget");
      }

      const nowMs = now();
      const minuteCutoff = nowMs - 60_000;
      const recent = (state.quota.minuteWindows[input.event] ?? [])
        .filter((timestamp) => timestamp >= minuteCutoff);
      if (recent.length >= EVENT_MINUTE_BUDGETS[input.event]) return drop("rate_limited");

      const rawDedupeKey = typeof input.dedupeKey === "string"
        && input.dedupeKey.length <= MAX_LOCAL_IDENTIFIER_LENGTH
        ? input.dedupeKey.trim()
        : "";
      const dedupeKey = rawDedupeKey
        ? createHash("sha256")
            .update(`${state.hashSalt}:dedupe:${rawDedupeKey}`)
            .digest("hex")
            .slice(0, 32)
        : null;
      if (dedupeKey) {
        const minimumIntervalMs = Math.max(
          1_000,
          Math.min(
            MAX_HISTORICAL_EVENT_AGE_MS,
          Number.isFinite(input.minimumIntervalMs)
            ? Math.floor(input.minimumIntervalMs as number)
            : DEFAULT_DEDUPE_WINDOW_MS,
          ),
        );
        const previous = state.quota.dedupe[dedupeKey];
        if (previous != null && nowMs - previous < minimumIntervalMs) return drop("duplicate");
      }

      const properties: Record<string, unknown> = {
        ...sanitizeProductAnalyticsProperties(input.event, input.properties),
        surface: input.surface,
        app_version: appVersion,
        runtime_mode: safeProductAnalyticsString(args.runtimeMode) ?? "unknown",
        platform: process.platform,
        arch: process.arch,
        $process_person_profile: false,
        $geoip_disable: true,
      };
      const projectId = opaqueId("project", input.projectId);
      const sessionId = opaqueId("session", input.sessionId);
      if (projectId) properties.project_id = projectId;
      if (sessionId) properties.session_id = sessionId;

      let timestamp: Date | undefined;
      if (input.occurredAt && input.occurredAt.length <= 64) {
        const parsed = Date.parse(input.occurredAt);
        if (Number.isFinite(parsed) && parsed <= nowMs + 60_000 && nowMs - parsed <= MAX_HISTORICAL_EVENT_AGE_MS) {
          timestamp = new Date(parsed);
        }
      }
      const uuid = input.clientEventId?.length === 36 && UUID_VALUE.test(input.clientEventId)
        ? input.clientEventId.toLowerCase()
        : randomUUID();
      state.quota.accepted += 1;
      state.quota.acceptedByEvent[input.event] = (state.quota.acceptedByEvent[input.event] ?? 0) + 1;
      recent.push(nowMs);
      state.quota.minuteWindows[input.event] = recent;
      if (dedupeKey) {
        state.quota.dedupe[dedupeKey] = nowMs;
        const dedupeEntries = Object.entries(state.quota.dedupe);
        if (dedupeEntries.length > DEDUPE_CACHE_LIMIT) {
          dedupeEntries
            .sort((a, b) => a[1] - b[1])
            .slice(0, dedupeEntries.length - DEDUPE_CACHE_LIMIT)
            .forEach(([key]) => delete state.quota.dedupe[key]);
        }
      }
      // Reserve quota before enqueueing. If the process crashes or disk is
      // unhealthy, ADE fails closed and may undercount rather than exceed its
      // installation-wide event ceiling.
      writeState(args.stateFilePath, state);
      try {
        posthog.capture({
          distinctId: state.installationId,
          event: input.event,
          properties,
          ...(timestamp ? { timestamp } : {}),
          uuid,
        });
      } catch (error) {
        args.logger.debug("product_analytics.capture_failed", {
          event: input.event,
          errorKind: error instanceof Error ? error.name : "unknown",
        });
        incrementDrop(state.quota, "transport_error");
        writeState(args.stateFilePath, state);
        return { accepted: false, reason: "transport_error" };
      }
      return { accepted: true, reason: "accepted" };
    } catch (error) {
      args.logger.debug("product_analytics.state_failed", {
        errorKind: error instanceof Error ? error.name : "unknown",
      });
      return { accepted: false, reason: "transport_error" };
    } finally {
      release?.();
    }
  };

  const capture = (input: ProductAnalyticsCapture): ProductAnalyticsCaptureResult =>
    captureImpl(input, false);

  const captureInternal = (input: ProductAnalyticsCapture): ProductAnalyticsCaptureResult =>
    captureImpl(input, true);

  const getStatus = (): ProductAnalyticsStatus => {
    if (isLocallyOptedOut()) cancelClientForOptOut();
    if (!token || !host) {
      // Preserve the durable preference across unconfigured builds without
      // creating analytics directories/state merely to render Settings.
      if (fs.existsSync(args.stateFilePath)) {
        const persisted = readExistingState(args.stateFilePath, now());
        if (persisted) state = rollQuotaDay(persisted, now());
      }
      return {
        configured: false,
        enabled: state.enabled && !isLocallyOptedOut(),
        effective: false,
        host: host ?? "invalid",
        dailyBudget,
        acceptedToday: 0,
        droppedToday: 0,
        day: utcDay(now()),
      };
    }
    let release: (() => void) | null = null;
    try {
      release = acquireStateLock(args.stateFilePath, STATE_LOCK_WAIT_MS);
      if (release) {
        const nextState = rollQuotaDay(readState(args.stateFilePath, now()), now());
        if (nextState.quota.day !== state.quota.day) writeState(args.stateFilePath, nextState);
        state = nextState;
      }
    } catch (error) {
      args.logger.debug("product_analytics.status_state_failed", {
        errorKind: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      release?.();
    }
    return {
      configured: Boolean(token && host),
      enabled: state.enabled && !isLocallyOptedOut(),
      effective: effective(),
      host: host ?? "invalid",
      dailyBudget,
      acceptedToday: state.quota.accepted,
      droppedToday: state.quota.dropped,
      day: state.quota.day,
    };
  };

  const setEnabled = (enabled: boolean): ProductAnalyticsStatus => {
    const enablingAfterWithdrawal = enabled
      && (volatileOptOut || fs.existsSync(optOutMarkerPath));
    if (!enabled) {
      // Withdrawal is fail-closed before any contended state-file work. The
      // separate marker makes that boundary restart-safe even if another ADE
      // process currently owns the quota-state lock.
      let markerPersisted = false;
      try {
        fs.mkdirSync(path.dirname(optOutMarkerPath), { recursive: true, mode: 0o700 });
        writeTextAtomic(optOutMarkerPath, "disabled\n", { mode: 0o600 });
        markerPersisted = true;
      } catch (error) {
        args.logger.warn("product_analytics.opt_out_marker_write_failed", {
          errorKind: error instanceof Error ? error.name : "unknown",
        });
      }
      // Opt-out is network-silent immediately: queued events are discarded and
      // in-flight requests are aborted instead of being flushed after consent
      // has been withdrawn.
      cancelClientForOptOut(markerPersisted);
    }

    let release: (() => void) | null = null;
    let preferencePersisted = false;
    try {
      release = acquireStateLock(args.stateFilePath, 250);
      if (release) {
        state = rollQuotaDay(readState(args.stateFilePath, now()), now());
        state = {
          ...state,
          enabled,
          enabledSinceMs: enabled
            ? (enablingAfterWithdrawal
                ? now()
                : state.enabled ? state.enabledSinceMs ?? now() : now())
            : null,
        };
        writeState(args.stateFilePath, state);
        preferencePersisted = true;
      } else {
        args.logger.warn("product_analytics.preference_write_failed", {
          errorKind: "state_lock_timeout",
        });
      }
    } catch (error) {
      args.logger.warn("product_analytics.preference_write_failed", {
        errorKind: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      release?.();
    }

    if (enabled && preferencePersisted) {
      try {
        fs.rmSync(optOutMarkerPath, { force: true });
        volatileOptOut = fs.existsSync(optOutMarkerPath);
        optOutCanRecoverFromPersistedOptIn = volatileOptOut;
      } catch (error) {
        volatileOptOut = true;
        optOutCanRecoverFromPersistedOptIn = true;
        args.logger.warn("product_analytics.opt_out_marker_remove_failed", {
          errorKind: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    return getStatus();
  };

  const flush = async (): Promise<boolean> => {
    if (isLocallyOptedOut()) {
      cancelClientForOptOut();
      return true;
    }
    if (!client) return true;
    try {
      await client.flush();
      return true;
    } catch (error) {
      args.logger.debug("product_analytics.flush_failed", {
        errorKind: error instanceof Error ? error.name : "unknown",
      });
      return false;
    }
  };

  const shutdown = async (): Promise<void> => {
    stopOptOutWatcher();
    const current = client;
    client = null;
    if (!current) return;
    try {
      await current.shutdown(2_000);
    } catch (error) {
      args.logger.warn("product_analytics.shutdown_failed", {
        errorKind: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  return {
    capture,
    captureInternal,
    flush,
    getStatus,
    setEnabled,
    shutdown,
    getExportConsentSince: (): string | null => {
      const status = getStatus();
      if (!status.effective || state.enabledSinceMs == null) return null;
      return new Date(state.enabledSinceMs).toISOString();
    },
    hashProjectId: (value: string) => opaqueId("project", value),
    installationIdForTesting: () => state.installationId,
  };
}

export type ProductAnalyticsService = ReturnType<typeof createProductAnalyticsService>;

const sharedServices = new Map<string, ProductAnalyticsService>();

export function defaultProductAnalyticsStateFile(adeHome?: string): string {
  return path.join(adeHome?.trim() || process.env.ADE_HOME?.trim() || path.join(os.homedir(), ".ade"), "secrets", "product-analytics.json");
}

export function getSharedProductAnalyticsService(
  key: string,
  make: () => ProductAnalyticsService,
): ProductAnalyticsService {
  let service = sharedServices.get(key);
  if (!service) {
    service = make();
    sharedServices.set(key, service);
  }
  return service;
}

export function peekSharedProductAnalyticsService(key: string): ProductAnalyticsService | undefined {
  return sharedServices.get(key);
}

export async function shutdownAllSharedProductAnalyticsServices(): Promise<void> {
  const services = [...sharedServices.values()];
  sharedServices.clear();
  await Promise.allSettled(services.map((service) => service.shutdown()));
}

export function clearSharedProductAnalyticsServicesForTesting(): void {
  sharedServices.clear();
}
