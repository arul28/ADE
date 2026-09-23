import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AdeQuotaSample, AdeTurnUsageRecord } from "../../../shared/types";
import { resolveDiagnosticsUploadBaseUrl } from "../../../shared/diagnosticsUpload";
import {
  USAGE_RESEARCH_DAILY_LIMIT_ERROR,
  USAGE_RESEARCH_DAY_PATTERN,
  USAGE_RESEARCH_IDENTITY_LIMIT_ERROR,
  USAGE_RESEARCH_MAX_DAYS_BACK,
  USAGE_RESEARCH_STORAGE_FULL_ERROR,
  usageResearchDailyUrl,
} from "../../../shared/usageResearch";
import type { Logger } from "../logging/logger";
import { isEnvFlagOff, isRecord, writeTextAtomic } from "../shared/utils";
import { localDayKey, localDayOffset, localDayOrdinal, localDayStart } from "./localDay";
import { DEFAULT_BURN_LOOKBACK_MS, estimateQuotaBurnRates } from "./quotaBurnRate";
import { attachSharedByKey, type SharedByKeyRegistry } from "./sharedUsageTracking";
import { turnsOnLocalDay, type TurnUsageLedgerStore } from "./turnUsageLedger";
import {
  encodeUsageResearchDailyBody,
  usageResearchInstallId,
  usageResearchUtcOffsetMinutes,
} from "./usageResearchReport";

/**
 * Sends the daily usage research report (`shared/usageResearch.ts`): one
 * compact report for each finished local day, to the account directory
 * Worker's `POST /usage-research/daily`.
 *
 * - It sends only while product analytics is on (`getStatus().effective`),
 *   and only turns and quota readings from after the user last turned it on
 *   (`getExportConsentSince`). `ADE_USAGE_RESEARCH=0|false|off|no` turns it off.
 *   Both are checked again before every request, so turning analytics off
 *   mid-run stops the run, and `stop()` aborts the request in flight.
 * - It runs 2 minutes after start, then every hour. Each run looks at the last
 *   7 local days before today and sends each day that the state file does not
 *   list yet, oldest first, at most 7 requests.
 * - `<adeHome>/usage/research-uploads.json` holds the per-install salt and
 *   the outcome of each day (`sent` or `rejected`), so a day goes out once.
 *   The salt keys `accountRef` and derives `installId`. Nothing is sent until
 *   the salt is on disk: a salt that died with the process would send every
 *   day again under a new install id. The Worker upserts by install and day,
 *   so a repeat is harmless.
 * - A ledger read that fails is not a day with no turns: the run stops and
 *   the next hour reads again.
 * - A 429 stops the run and waits the `retry-after` seconds (the Worker's
 *   caps reset at the next UTC midnight). A 503, another 5xx, or a network
 *   error stops the run until the next hour. 400, 413, and 415 record the day
 *   as `rejected`.
 * - It never throws, and it logs one warning for each kind of failure. It
 *   never logs the install id.
 *
 * The upload is anonymous: no account token, the same as the desktop's
 * diagnostics upload, whose base URL rule it shares. The only identity in the
 * body is a hash of the per-install research salt, which nothing else ADE
 * sends is derived from, so it links to neither analytics nor the account.
 */

export const USAGE_RESEARCH_FIRST_RUN_DELAY_MS = 2 * 60_000;
export const USAGE_RESEARCH_INTERVAL_MS = 60 * 60_000;
export const USAGE_RESEARCH_TIMEOUT_MS = 15_000;
/** The longest a 429's `retry-after` may pause the uploader, whatever the header says. */
export const USAGE_RESEARCH_MAX_PAUSE_MS = 36 * 60 * 60_000;
/** Days the state file remembers; older entries are pruned. */
export const USAGE_RESEARCH_STATE_RETENTION_DAYS = 30;
const STATE_FILE_NAME = "research-uploads.json";
const SALT_PATTERN = /^[0-9a-f]{32}$/;

export type UsageResearchDayOutcome = "sent" | "rejected";

export type UsageResearchUploadState = {
  /** Per-install salt of `accountRef` and `installId`. Never sent. */
  salt: string;
  days: Record<string, UsageResearchDayOutcome>;
};

/** Why a run stopped before it went through every unsent day. */
export type UsageResearchRetryReason =
  /** 429 `usage_research_identity_limit`: this install sent too much today. */
  | "identity_limit"
  /** 429 `usage_research_daily_limit`: the fleet's daily cap is spent. */
  | "fleet_limit"
  /** 429 `usage_research_storage_full`: the Worker's storage is full. */
  | "storage_full"
  /** A 429 with some other body. */
  | "rate_limited"
  | "unavailable"
  | "server_error"
  | "unexpected_status"
  | "network";

/** Keyed by a string the server sent, so a Map: `{"error":"constructor"}` must not look like a limit. */
const LIMIT_ERRORS: ReadonlyMap<string, UsageResearchRetryReason> = new Map([
  [USAGE_RESEARCH_IDENTITY_LIMIT_ERROR, "identity_limit"],
  [USAGE_RESEARCH_DAILY_LIMIT_ERROR, "fleet_limit"],
  [USAGE_RESEARCH_STORAGE_FULL_ERROR, "storage_full"],
]);

export type UsageResearchRunResult =
  /** `stopped`: `stop()` was called before or during the run. `failed`: the ledger or the state file could not be used. */
  | { status: "disabled" | "no_consent" | "stopped" | "paused" | "busy" | "nothing_to_send" | "failed" }
  | { status: "ran"; sent: string[]; rejected: string[]; retryLater: UsageResearchRetryReason | null };

/** What the uploader needs of the product analytics service. */
export type UsageResearchAnalytics = {
  getStatus(): { effective: boolean };
  getExportConsentSince(): string | null;
};

export type UsageResearchUploaderDeps = {
  /** The machine's ADE home; the state file lives under `<adeDir>/usage/`. */
  adeDir: string;
  store: Pick<TurnUsageLedgerStore, "readTurnsChecked" | "readQuotaSamples">;
  analytics: UsageResearchAnalytics;
  appVersion: string;
  logger?: Pick<Logger, "warn" | "debug"> | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  platform?: string;
  arch?: string;
  timeoutMs?: number;
  firstRunDelayMs?: number;
  intervalMs?: number;
};

export type UsageResearchUploader = {
  /** Arms the timers (2 minutes, then hourly). Unref'd, so they never hold the process open. */
  start(): void;
  stop(): void;
  /** One run now. Never throws. */
  runOnce(): Promise<UsageResearchRunResult>;
};

export function usageResearchStateFilePath(adeDir: string): string {
  return path.join(path.resolve(adeDir), "usage", STATE_FILE_NAME);
}

/** The state file, or null when it is missing or unreadable. Bad entries are dropped. */
export function readUsageResearchState(filePath: string): UsageResearchUploadState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.salt !== "string" || !SALT_PATTERN.test(parsed.salt)) return null;
  const days: Record<string, UsageResearchDayOutcome> = {};
  if (isRecord(parsed.days)) {
    for (const [day, outcome] of Object.entries(parsed.days)) {
      if (USAGE_RESEARCH_DAY_PATTERN.test(day) && (outcome === "sent" || outcome === "rejected")) days[day] = outcome;
    }
  }
  return { salt: parsed.salt, days };
}

/** Keeps the days within `USAGE_RESEARCH_STATE_RETENTION_DAYS` of `today`, sorted. */
export function pruneUsageResearchState(state: UsageResearchUploadState, today: string): UsageResearchUploadState {
  const todayOrdinal = localDayOrdinal(today);
  const days: Record<string, UsageResearchDayOutcome> = {};
  for (const day of Object.keys(state.days).sort()) {
    const ordinal = localDayOrdinal(day);
    if (ordinal == null || todayOrdinal == null) continue;
    if (todayOrdinal - ordinal > USAGE_RESEARCH_STATE_RETENTION_DAYS) continue;
    days[day] = state.days[day]!;
  }
  return { salt: state.salt, days };
}

/** The finished local days a run may send, oldest first: 7 days ago to yesterday. */
export function usageResearchCandidateDays(nowMs: number): string[] {
  const days: string[] = [];
  for (let back = USAGE_RESEARCH_MAX_DAYS_BACK; back >= 1; back -= 1) {
    const start = localDayOffset(nowMs, -back);
    if (start) days.push(localDayKey(start));
  }
  return days;
}

type PostOutcome = {
  /** `stopped`: `stop()` aborted the request. */
  kind: "sent" | "rejected" | "stopped" | UsageResearchRetryReason;
  status: number | null;
  /** From a 429's `retry-after`: how long to wait before the next send. */
  retryAfterMs?: number | null;
};

/** The `error` code of a Worker response body, or null. */
function responseErrorCode(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

/** `retry-after` in ms: whole seconds or an HTTP date, capped at `USAGE_RESEARCH_MAX_PAUSE_MS`. Null when absent or unreadable. */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  const text = value?.trim();
  if (!text) return null;
  const ms = /^\d+$/.test(text) ? Number(text) * 1_000 : Date.parse(text) - nowMs;
  if (!Number.isFinite(ms)) return null;
  return Math.min(USAGE_RESEARCH_MAX_PAUSE_MS, Math.max(0, ms));
}

/** Ms from `nowMs` to the next UTC midnight: the Worker's caps reset then. */
function msToNextUtcMidnight(nowMs: number): number {
  const at = new Date(nowMs);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1) - nowMs;
}

export function createUsageResearchUploader(deps: UsageResearchUploaderDeps): UsageResearchUploader {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const statePath = usageResearchStateFilePath(deps.adeDir);
  const timeoutMs = deps.timeoutMs ?? USAGE_RESEARCH_TIMEOUT_MS;
  const warned = new Set<string>();
  /** Outcomes this process recorded, in case the state file cannot be written. */
  const recorded = new Map<string, UsageResearchDayOutcome>();
  /** Days this process found no turns for; a finished day cannot gain turns. */
  const emptyDays = new Set<string>();
  /** After a 429: no send before this time. */
  let pausedUntilMs: number | null = null;
  let salt: string | null = null;
  let inFlight: Promise<UsageResearchRunResult> | null = null;
  /** Aborted by `stop()`, so a request in flight does not outlive the uploader. */
  let runAbort: AbortController | null = null;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  /** Why the uploader may not send right now, or null when it may. Checked at the start of a run and before every request. */
  const blocked = (): "stopped" | "disabled" | "no_consent" | null => {
    if (stopped) return "stopped";
    if (isEnvFlagOff(env.ADE_USAGE_RESEARCH)) return "disabled";
    if (!deps.analytics.getStatus().effective) return "no_consent";
    return null;
  };

  const warnOnce = (kind: string, meta: Record<string, unknown> = {}) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    deps.logger?.warn("usage_research.upload_failed", { kind, ...meta });
  };

  /** The state on disk plus what this process recorded; `onDisk` is false when there was no readable file. */
  const loadState = (today: string): { state: UsageResearchUploadState; onDisk: boolean } => {
    const fromDisk = readUsageResearchState(statePath);
    // The file's salt wins; else the one this process already used, so every
    // day it sends shares one salt.
    salt = fromDisk?.salt ?? salt ?? randomBytes(16).toString("hex");
    const days = { ...(fromDisk?.days ?? {}) };
    for (const [day, outcome] of recorded) days[day] = outcome;
    const state = pruneUsageResearchState({ salt, days }, today);
    for (const day of recorded.keys()) if (!state.days[day]) recorded.delete(day);
    return { state, onDisk: fromDisk != null };
  };

  /** True when the state file now holds `state`. */
  const saveState = (state: UsageResearchUploadState): boolean => {
    try {
      writeTextAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return true;
    } catch (error) {
      warnOnce("state_write", { error: error instanceof Error ? error.name : "unknown" });
      return false;
    }
  };

  const post = async (json: string, runSignal: AbortSignal): Promise<PostOutcome> => {
    const send = deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const abort = () => controller.abort();
    // The timeout covers the body as well as the headers: a server that
    // answers and then stalls must not hold the run open.
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    runSignal.addEventListener("abort", abort, { once: true });
    try {
      let response: Response;
      try {
        response = await send(usageResearchDailyUrl(resolveDiagnosticsUploadBaseUrl(env.ADE_ACCOUNT_DIRECTORY_URL)), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: json,
          signal: controller.signal,
        });
      } catch {
        return { kind: runSignal.aborted ? "stopped" : "network", status: null };
      }
      const status = response.status;
      let text = "";
      try {
        text = await response.text();
      } catch {
        text = "";
      }
      if (status >= 200 && status < 300) return { kind: "sent", status };
      if (status === 400 || status === 413 || status === 415) return { kind: "rejected", status };
      if (status === 429) {
        const code = responseErrorCode(text);
        return {
          kind: (code != null ? LIMIT_ERRORS.get(code) : undefined) ?? "rate_limited",
          status,
          retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"), now()),
        };
      }
      if (status === 503) return { kind: "unavailable", status };
      if (status >= 500) return { kind: "server_error", status };
      return { kind: "unexpected_status", status };
    } finally {
      clearTimeout(timer);
      runSignal.removeEventListener("abort", abort);
    }
  };

  const execute = async (runSignal: AbortSignal): Promise<UsageResearchRunResult> => {
    const gate = blocked();
    if (gate) return { status: gate };
    const consentSinceMs = Date.parse(deps.analytics.getExportConsentSince() ?? "");
    if (!Number.isFinite(consentSinceMs)) return { status: "no_consent" };

    const nowMs = now();
    if (pausedUntilMs != null && nowMs < pausedUntilMs) return { status: "paused" };
    pausedUntilMs = null;
    const today = localDayKey(nowMs);

    const loaded = loadState(today);
    let state = loaded.state;
    const candidates = usageResearchCandidateDays(nowMs);
    for (const day of emptyDays) if (!candidates.includes(day)) emptyDays.delete(day);
    const pending = candidates.filter((day) => !state.days[day] && !emptyDays.has(day));
    if (!pending.length) return { status: "nothing_to_send" };
    // The salt is on disk before the first report that used it leaves. When it
    // cannot be written, nothing goes: the next start would mint a new salt,
    // so a new install id, and send every day again under it.
    if (!loaded.onDisk && !saveState(state)) return { status: "failed" };
    const installId = usageResearchInstallId(state.salt);

    // One read covers every pending day and the burn-rate lookback before the
    // oldest. Nothing from before the user last turned analytics on is read.
    const oldestStartMs = localDayStart(pending[0]!)?.getTime() ?? nowMs;
    const sinceMs = Math.max(oldestStartMs - DEFAULT_BURN_LOOKBACK_MS, consentSinceMs);
    const [turnsRead, samples] = await Promise.all([
      deps.store.readTurnsChecked({ sinceMs }),
      deps.store.readQuotaSamples({ sinceMs }),
    ]);
    // A failed read is not a run of empty days: nothing is sent, no day is
    // remembered as empty, and the next hour reads again.
    if (!turnsRead.ok) {
      warnOnce("ledger_read");
      return { status: "failed" };
    }
    const consented = <T extends { at: string }>(rows: T[]): T[] => rows.filter((row) => Date.parse(row.at) >= consentSinceMs);
    const allTurns: AdeTurnUsageRecord[] = consented(turnsRead.rows);
    const allSamples: AdeQuotaSample[] = consented(samples);

    const sent: string[] = [];
    const rejected: string[] = [];
    const record = (day: string, outcome: UsageResearchDayOutcome) => {
      recorded.set(day, outcome);
      state = { salt: state.salt, days: { ...state.days, [day]: outcome } };
      saveState(pruneUsageResearchState(state, today));
      (outcome === "sent" ? sent : rejected).push(day);
    };

    for (const day of pending) {
      const dayTurns = turnsOnLocalDay(allTurns, day);
      if (!dayTurns.length) {
        emptyDays.add(day);
        continue;
      }
      const endMs = (localDayOffset(day, 1)?.getTime() ?? nowMs) - 1;
      const encoded = encodeUsageResearchDailyBody(
        {
          installId,
          day,
          appVersion: deps.appVersion,
          platform: deps.platform ?? process.platform,
          arch: deps.arch ?? process.arch,
          utcOffsetMinutes: usageResearchUtcOffsetMinutes(day),
        },
        {
          turns: dayTurns,
          quotaSamples: allSamples.filter((sample) => localDayKey(sample.at) === day),
          burnRates: estimateQuotaBurnRates({ samples: allSamples, turns: allTurns, nowMs: endMs }),
          salt: state.salt,
        },
      );
      if (!encoded.ok) {
        warnOnce("too_large", { bytes: encoded.bytes });
        record(day, "rejected");
        continue;
      }
      // Analytics can be turned off, or the uploader stopped, while a run is
      // part way through its days.
      const gateNow = blocked();
      if (gateNow) return { status: gateNow };
      const outcome = await post(encoded.json, runSignal);
      if (outcome.kind === "stopped") return { status: "stopped" };
      if (outcome.kind === "sent" || outcome.kind === "rejected") {
        if (outcome.kind === "rejected") warnOnce("rejected", { status: outcome.status });
        else deps.logger?.debug("usage_research.sent", { day, bytes: encoded.bytes, groups: encoded.body.report.groups.length });
        record(day, outcome.kind);
        continue;
      }
      warnOnce(outcome.kind, { status: outcome.status });
      if (outcome.status === 429) {
        // A named cap resets at the next UTC midnight; any other 429 waits for
        // its `retry-after`, else for the next hourly run.
        const named = outcome.kind !== "rate_limited";
        const waitMs = outcome.retryAfterMs ?? (named ? msToNextUtcMidnight(now()) : null);
        if (waitMs != null) pausedUntilMs = now() + waitMs;
      }
      return { status: "ran", sent, rejected, retryLater: outcome.kind };
    }
    return { status: "ran", sent, rejected, retryLater: null };
  };

  const runOnce = (): Promise<UsageResearchRunResult> => {
    if (inFlight) return Promise.resolve({ status: "busy" });
    const run = new AbortController();
    runAbort = run;
    const current = execute(run.signal)
      .catch((error: unknown): UsageResearchRunResult => {
        warnOnce("internal", { error: error instanceof Error ? error.name : "unknown" });
        return { status: "failed" };
      })
      .finally(() => {
        if (inFlight === current) inFlight = null;
        if (runAbort === run) runAbort = null;
      });
    inFlight = current;
    return current;
  };

  return {
    start() {
      if (stopped || firstTimer || intervalTimer) return;
      firstTimer = setTimeout(() => {
        firstTimer = null;
        if (stopped) return;
        void runOnce();
        intervalTimer = setInterval(() => void runOnce(), deps.intervalMs ?? USAGE_RESEARCH_INTERVAL_MS);
        intervalTimer.unref?.();
      }, deps.firstRunDelayMs ?? USAGE_RESEARCH_FIRST_RUN_DELAY_MS);
      firstTimer.unref?.();
    },
    stop() {
      stopped = true;
      runAbort?.abort();
      if (firstTimer) clearTimeout(firstTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      firstTimer = null;
      intervalTimer = null;
    },
    runOnce,
  };
}

const sharedUploaders: SharedByKeyRegistry<UsageResearchUploader> = new Map();

/**
 * One uploader per ADE home, like the quota poller: every project scope in a
 * brain attaches, the first one starts it, and the last one to detach stops it.
 * Returns the detach function.
 */
export function attachSharedUsageResearchUploader(key: string, make: () => UsageResearchUploader): () => void {
  return attachSharedByKey(
    sharedUploaders,
    key,
    () => {
      const uploader = make();
      uploader.start();
      return uploader;
    },
    (uploader) => uploader.stop(),
  ).release;
}
