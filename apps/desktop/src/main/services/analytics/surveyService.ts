import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import { safeJsonParse, writeTextAtomic } from "../shared/utils";
import { localDayKey, localDayStart } from "../usage/localDay";
import {
  ADE_SURVEY_KEYS,
  type AdeSurveyKey,
  type ProductSurvey,
  type ProductSurveyAnswer,
  type ProductSurveyEventInput,
  type ProductSurveyEventResult,
  type ProductSurveyQuestion,
} from "../../../shared/types/productSurveys";
import type { ProductAnalyticsService } from "./productAnalyticsService";
import { resolveProductAnalyticsEndpoint } from "./productAnalyticsService";
import { scrubSurveyText } from "./productAnalyticsPolicy";

/**
 * In-app surveys without posthog-js.
 *
 * PostHog serves the project's active surveys to anyone holding the public
 * project token (`GET /api/surveys/?token=`, the same call posthog-js makes).
 * ADE reads that list at most once a day, keeps only `api` surveys whose name
 * starts with an ADE key (`[ade:pmf]`, `[ade:returning]`, `[ade:early]`), and
 * decides on this computer, from its own small history, whether this install
 * should see one now. Answers go back as PostHog's own survey events through
 * the product analytics service, so its consent, budget and kill switches
 * apply unchanged.
 *
 * Nothing here runs while analytics is off: no history is kept, nothing is
 * fetched, no survey is offered and no event is recorded.
 *
 * The history lives in `<ade>/secrets/product-analytics-surveys.json`: the
 * local days ADE was used (at most 60), the last time it was used, how many
 * times it launched, which surveys it showed, and the cached survey list.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;
export const SURVEY_FETCH_INTERVAL_MS = DAY_MS;
/** At most one survey per install in this window. */
export const SURVEY_GLOBAL_COOLDOWN_MS = 21 * DAY_MS;
const PMF_WINDOW_DAYS = 28;
const PMF_MIN_ACTIVE_DAYS = 7;
const RETURNING_MIN_GAP_MS = 10 * DAY_MS;
const EARLY_MIN_DAYS = 3;
const EARLY_MAX_DAYS = 10;
const EARLY_MAX_ACTIVE_DAYS = 2;
const MAX_ACTIVE_DAYS_KEPT = 60;
const MAX_SURVEYS_KEPT = 20;
const MAX_QUESTIONS = 10;
const MAX_CHOICES = 20;
const FETCH_TIMEOUT_MS = 5_000;
const SURVEY_ID = /^[A-Za-z0-9-]{1,64}$/;
const SURVEY_NAME_KEY = /^\s*\[ade:([a-z]+)\]/i;
/** `returning` is only true on the launch that ends the gap, so it goes first. */
const KEY_PRIORITY: readonly AdeSurveyKey[] = ["returning", "early", "pmf"];

/** What eligibility reads. Pure data, so it can be simulated. */
export type SurveyLocalHistory = {
  /** Launches with analytics on, this one included. */
  launchCount: number;
  firstSeenAtMs: number;
  /** Machine-local days ADE was launched or focused (`YYYY-MM-DD`). */
  activeDays: string[];
  /** The last activity before this launch, or null when there was none. */
  previousActiveAtMs: number | null;
  shownSurveyIds: string[];
  lastShownAtMs: number | null;
};

type SurveyState = {
  version: 1;
  firstSeenAtMs: number;
  launchCount: number;
  activeDays: string[];
  lastActiveAtMs: number | null;
  shown: Record<string, number>;
  lastShownAtMs: number | null;
  /** The ADE surveys from the last fetch, slimmed to the fields ADE reads; re-parsed on every read. */
  cache: { fetchedAtMs: number; surveys: unknown[] } | null;
};

function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function plainText(value: unknown, contentType: unknown, max: number): string | null {
  const raw = text(value, max * 4);
  if (!raw) return null;
  const stripped = contentType === "html"
    ? raw.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    : raw;
  return text(stripped, max);
}

export function surveyKeyFromName(name: unknown): AdeSurveyKey | null {
  if (typeof name !== "string") return null;
  const key = SURVEY_NAME_KEY.exec(name)?.[1]?.toLowerCase();
  return key && (ADE_SURVEY_KEYS as readonly string[]).includes(key) ? key as AdeSurveyKey : null;
}

function parseQuestion(raw: unknown): ProductSurveyQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && SURVEY_ID.test(value.id) ? value.id : null;
  const question = plainText(value.question, "text", 500);
  if (!id || !question) return null;
  const base = {
    id,
    question,
    description: plainText(value.description, value.descriptionContentType, 1_000),
    optional: value.optional === true,
    buttonText: text(value.buttonText, 40),
  };
  switch (value.type) {
    case "open":
      return { ...base, type: "open" };
    case "rating": {
      const scale = typeof value.scale === "number" && [2, 3, 5, 7, 10].includes(value.scale) ? value.scale : null;
      if (scale == null) return null;
      return {
        ...base,
        type: "rating",
        // PostHog's 10-point scale is NPS: 0 to 10. Every other scale starts at 1.
        min: scale === 10 ? 0 : 1,
        max: scale,
        lowerBoundLabel: text(value.lowerBoundLabel, 60),
        upperBoundLabel: text(value.upperBoundLabel, 60),
      };
    }
    case "single_choice":
    case "multiple_choice": {
      const choices = Array.isArray(value.choices)
        ? [...new Set(value.choices.flatMap((choice) => {
            const safe = text(choice, 200);
            return safe ? [safe] : [];
          }))].slice(0, MAX_CHOICES)
        : [];
      if (choices.length < 2) return null;
      return { ...base, type: value.type, choices, hasOpenChoice: value.hasOpenChoice === true };
    }
    case "link": {
      let link: string | null = null;
      try {
        const parsed = typeof value.link === "string" ? new URL(value.link) : null;
        link = parsed && parsed.protocol === "https:" ? parsed.toString() : null;
      } catch {
        link = null;
      }
      return { ...base, type: "link", link };
    }
    default:
      return null;
  }
}

/**
 * The ADE surveys in PostHog's `/api/surveys/` answer that are live now: type
 * `api`, a recognised `[ade:<key>]` name, started, not ended, and every
 * question one ADE can draw. Anything else is ignored rather than half-shown.
 */
export function parseSurveysResponse(body: unknown, nowMs: number): ProductSurvey[] {
  const list = body && typeof body === "object" && Array.isArray((body as { surveys?: unknown }).surveys)
    ? (body as { surveys: unknown[] }).surveys
    : [];
  const live: Array<ProductSurvey & { startMs: number }> = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    if (value.type !== "api") continue;
    const key = surveyKeyFromName(value.name);
    const id = typeof value.id === "string" && SURVEY_ID.test(value.id) ? value.id : null;
    const name = text(value.name, 200);
    if (!key || !id || !name) continue;
    const startMs = typeof value.start_date === "string" ? Date.parse(value.start_date) : Number.NaN;
    if (!Number.isFinite(startMs) || startMs > nowMs) continue;
    const endMs = typeof value.end_date === "string" ? Date.parse(value.end_date) : null;
    if (endMs != null && Number.isFinite(endMs) && endMs <= nowMs) continue;
    const rawQuestions = Array.isArray(value.questions) ? value.questions : [];
    if (rawQuestions.length === 0 || rawQuestions.length > MAX_QUESTIONS) continue;
    const questions = rawQuestions.map(parseQuestion);
    if (questions.some((question) => question == null)) continue;
    const iteration = typeof value.current_iteration === "number" && Number.isInteger(value.current_iteration)
      ? value.current_iteration
      : null;
    live.push({ id, name, key, iteration, questions: questions as ProductSurveyQuestion[], startMs });
  }
  return live
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, MAX_SURVEYS_KEPT)
    .map(({ startMs: _startMs, ...survey }) => survey);
}

const RAW_SURVEY_FIELDS = ["id", "name", "type", "start_date", "end_date", "current_iteration"] as const;
const RAW_QUESTION_FIELDS = [
  "id", "type", "question", "description", "descriptionContentType", "optional", "buttonText",
  "scale", "lowerBoundLabel", "upperBoundLabel", "choices", "hasOpenChoice", "link",
] as const;

function pick(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const out: Record<string, unknown> = {};
  for (const field of fields) if (source[field] !== undefined) out[field] = source[field];
  return out;
}

/** The ADE `api` surveys in a `/api/surveys/` answer, cut to the fields ADE reads, for the disk cache. */
export function slimSurveysForCache(body: unknown): unknown[] {
  const list = body && typeof body === "object" && Array.isArray((body as { surveys?: unknown }).surveys)
    ? (body as { surveys: unknown[] }).surveys
    : [];
  return list
    .filter((raw) => {
      const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
      return value?.type === "api" && surveyKeyFromName(value.name) != null;
    })
    .slice(0, MAX_SURVEYS_KEPT)
    .map((raw) => ({
      ...pick(raw, RAW_SURVEY_FIELDS),
      questions: Array.isArray((raw as { questions?: unknown }).questions)
        ? ((raw as { questions: unknown[] }).questions).slice(0, MAX_QUESTIONS + 1).map((question) => pick(question, RAW_QUESTION_FIELDS))
        : [],
    }));
}

function activeDaysWithin(history: SurveyLocalHistory, nowMs: number, days: number): number {
  const today = localDayStart(localDayKey(nowMs));
  if (!today) return 0;
  const oldest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)).getTime();
  return new Set(history.activeDays.filter((day) => {
    const start = localDayStart(day)?.getTime();
    return start != null && start >= oldest && start <= today.getTime();
  })).size;
}

/**
 * Which survey keys this install qualifies for right now, most urgent first.
 * Empty in the first session and inside the 21-day cooldown, which is what
 * lets ADE skip the network entirely.
 */
export function eligibleSurveyKeys(history: SurveyLocalHistory, nowMs: number): AdeSurveyKey[] {
  if (history.launchCount <= 1) return [];
  if (history.lastShownAtMs != null && nowMs - history.lastShownAtMs < SURVEY_GLOBAL_COOLDOWN_MS) return [];
  const keys: AdeSurveyKey[] = [];
  if (history.previousActiveAtMs != null && nowMs - history.previousActiveAtMs >= RETURNING_MIN_GAP_MS) {
    keys.push("returning");
  }
  const daysSinceFirst = Math.floor((nowMs - history.firstSeenAtMs) / DAY_MS);
  if (
    daysSinceFirst >= EARLY_MIN_DAYS
    && daysSinceFirst <= EARLY_MAX_DAYS
    && new Set(history.activeDays).size <= EARLY_MAX_ACTIVE_DAYS
  ) {
    keys.push("early");
  }
  if (activeDaysWithin(history, nowMs, PMF_WINDOW_DAYS) >= PMF_MIN_ACTIVE_DAYS) keys.push("pmf");
  return KEY_PRIORITY.filter((key) => keys.includes(key));
}

/** The one survey to offer now, or null. Never a survey this install already saw. */
export function pickEligibleSurvey(args: {
  surveys: readonly ProductSurvey[];
  history: SurveyLocalHistory;
  nowMs: number;
}): ProductSurvey | null {
  const shown = new Set(args.history.shownSurveyIds);
  for (const key of eligibleSurveyKeys(args.history, args.nowMs)) {
    const survey = args.surveys.find((candidate) => candidate.key === key && !shown.has(candidate.id));
    if (survey) return survey;
  }
  return null;
}

/**
 * Answers checked against the survey that was shown: a rating inside its
 * scale, choices from its list (or the person's own words where the survey
 * has an "Other"), text scrubbed and capped. Null when a required question is
 * missing or an answer does not fit its question.
 */
export function validateSurveyAnswers(
  survey: ProductSurvey,
  answers: unknown,
): Record<string, ProductSurveyAnswer> | null {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const input = answers as Record<string, unknown>;
  const out: Record<string, ProductSurveyAnswer> = {};
  for (const question of survey.questions) {
    const raw = Object.prototype.hasOwnProperty.call(input, question.id) ? input[question.id] : undefined;
    const empty = raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0);
    if (empty) {
      if (question.optional || question.type === "link") continue;
      return null;
    }
    switch (question.type) {
      case "open": {
        const safe = scrubSurveyText(raw);
        if (!safe) return null;
        out[question.id] = safe;
        break;
      }
      case "rating": {
        const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
        if (!Number.isInteger(value) || value < question.min || value > question.max) return null;
        out[question.id] = String(value);
        break;
      }
      case "single_choice": {
        if (typeof raw !== "string") return null;
        if (question.choices.includes(raw)) out[question.id] = raw;
        else if (question.hasOpenChoice) {
          const safe = scrubSurveyText(raw);
          if (!safe) return null;
          out[question.id] = safe;
        } else return null;
        break;
      }
      case "multiple_choice": {
        if (!Array.isArray(raw) || raw.length > MAX_CHOICES) return null;
        const picked: string[] = [];
        let openUsed = false;
        for (const item of raw) {
          if (typeof item !== "string") return null;
          if (question.choices.includes(item)) {
            if (!picked.includes(item)) picked.push(item);
          } else if (question.hasOpenChoice && !openUsed) {
            const safe = scrubSurveyText(item);
            if (!safe) return null;
            picked.push(safe);
            openUsed = true;
          } else return null;
        }
        out[question.id] = picked;
        break;
      }
      case "link":
        if (raw !== "link clicked") return null;
        out[question.id] = "link clicked";
        break;
    }
  }
  return out;
}

function normalizeSurveyState(value: unknown, nowMs: number, firstSeenFallbackMs: () => number): SurveyState {
  const raw = value && typeof value === "object" ? value as Partial<SurveyState> : {};
  const shown: Record<string, number> = {};
  if (raw.shown && typeof raw.shown === "object") {
    for (const [id, at] of Object.entries(raw.shown)) {
      const atMs = finiteMs(at);
      if (SURVEY_ID.test(id) && atMs != null) shown[id] = atMs;
    }
  }
  return {
    version: 1,
    // A new history starts at the analytics install time, so an install that
    // predates surveys is not mistaken for a brand-new one.
    firstSeenAtMs: Math.min(nowMs, finiteMs(raw.firstSeenAtMs) ?? firstSeenFallbackMs()),
    launchCount: Math.min(1_000_000, finiteMs(raw.launchCount) ?? 0),
    activeDays: Array.isArray(raw.activeDays)
      ? [...new Set(raw.activeDays.filter((day): day is string => typeof day === "string" && localDayStart(day) != null))]
          .sort()
          .slice(-MAX_ACTIVE_DAYS_KEPT)
      : [],
    lastActiveAtMs: finiteMs(raw.lastActiveAtMs),
    shown,
    lastShownAtMs: finiteMs(raw.lastShownAtMs),
    cache: raw.cache && finiteMs(raw.cache.fetchedAtMs) != null
      ? {
          fetchedAtMs: finiteMs(raw.cache.fetchedAtMs) as number,
          surveys: slimSurveysForCache({ surveys: raw.cache.surveys }),
        }
      : null,
  };
}

function addActiveDay(state: SurveyState, nowMs: number): void {
  const day = localDayKey(nowMs);
  if (day && !state.activeDays.includes(day)) {
    state.activeDays = [...state.activeDays, day].sort().slice(-MAX_ACTIVE_DAYS_KEPT);
  }
  state.lastActiveAtMs = nowMs;
}

export function defaultSurveyStateFile(productAnalyticsStateFile: string): string {
  return path.join(path.dirname(productAnalyticsStateFile), "product-analytics-surveys.json");
}

export function createSurveyService(args: {
  stateFilePath: string;
  analytics: Pick<ProductAnalyticsService, "getStatus" | "captureInternal" | "getInstalledAtMs">;
  logger: Pick<Logger, "debug">;
  now?: () => number;
  fetchImpl?: typeof fetch;
  endpoint?: () => { token: string; host: string } | null;
}) {
  const now = args.now ?? Date.now;
  const endpoint = args.endpoint ?? (() => resolveProductAnalyticsEndpoint());
  const fetchImpl = args.fetchImpl ?? fetch;
  /** The last activity before this launch, read once when the launch is noted. */
  let previousActiveAtMs: number | null = null;
  let launchNoted = false;
  let lastNotedDay: string | null = null;
  let refresh: Promise<void> | null = null;
  /** One survey per launch, however many windows ask. */
  let offeredThisLaunch = false;
  let offered: ProductSurvey | null = null;
  const sentThisLaunch = new Set<string>();

  const analyticsOn = (): boolean => {
    try {
      return args.analytics.getStatus().effective;
    } catch {
      return false;
    }
  };

  const read = (): SurveyState => {
    let rawText: string | null = null;
    try {
      rawText = fs.readFileSync(args.stateFilePath, "utf8");
    } catch {
      rawText = null;
    }
    const nowMs = now();
    return normalizeSurveyState(
      safeJsonParse<unknown>(rawText, {}),
      nowMs,
      () => args.analytics.getInstalledAtMs() ?? nowMs,
    );
  };

  const write = (state: SurveyState): void => {
    writeTextAtomic(args.stateFilePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  };

  const update = (mutate: (state: SurveyState) => void): SurveyState | null => {
    try {
      const state = read();
      mutate(state);
      write(state);
      return state;
    } catch (error) {
      args.logger.debug("product_surveys.state_failed", {
        errorKind: error instanceof Error ? error.name : "unknown",
      });
      return null;
    }
  };

  const history = (state: SurveyState): SurveyLocalHistory => ({
    launchCount: state.launchCount,
    firstSeenAtMs: state.firstSeenAtMs,
    activeDays: state.activeDays,
    previousActiveAtMs,
    shownSurveyIds: Object.keys(state.shown),
    lastShownAtMs: state.lastShownAtMs,
  });

  /** Once per launch, at startup. */
  const noteLaunch = (): void => {
    if (launchNoted || !analyticsOn()) return;
    launchNoted = true;
    update((state) => {
      previousActiveAtMs = state.lastActiveAtMs;
      state.launchCount += 1;
      addActiveDay(state, now());
    });
    lastNotedDay = localDayKey(now());
  };

  /** On window focus: records the day once; any other focus that day does no I/O. */
  const noteActive = (): void => {
    const day = localDayKey(now());
    if (!day || day === lastNotedDay) return;
    // Latched before the consent check, so with analytics off a focus costs
    // one status read a day, not one per focus.
    lastNotedDay = day;
    if (!launchNoted) {
      noteLaunch();
      return;
    }
    if (!analyticsOn()) return;
    update((state) => addActiveDay(state, now()));
  };

  const fetchSurveys = async (target: { token: string; host: string }): Promise<unknown> => {
    // PostHog's own SDK path first; the slashless spelling is its documented alias.
    for (const route of ["/api/surveys/", "/api/surveys"]) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      timeout.unref?.();
      try {
        const response = await fetchImpl(`${target.host}${route}?token=${encodeURIComponent(target.token)}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        if (response.ok) return await response.json();
        if (response.status !== 404) return null;
      } catch {
        // Offline or blocked: try again tomorrow with whatever was cached.
      } finally {
        clearTimeout(timeout);
      }
    }
    return null;
  };

  const refreshCache = (): Promise<void> => {
    if (refresh) return refresh;
    const target = endpoint();
    if (!target) return Promise.resolve();
    refresh = (async () => {
      const body = await fetchSurveys(target);
      const nowMs = now();
      const surveys = body == null ? null : slimSurveysForCache(body);
      // A failed fetch still stamps the attempt, so a dead network costs one
      // request a day, not one per launch.
      update((state) => {
        state.cache = { fetchedAtMs: nowMs, surveys: surveys ?? state.cache?.surveys ?? [] };
      });
    })().finally(() => {
      refresh = null;
    });
    return refresh;
  };

  const getEligibleSurvey = async (): Promise<ProductSurvey | null> => {
    if (offeredThisLaunch || !analyticsOn()) return null;
    if (!launchNoted) noteLaunch();
    let state = read();
    // Nothing local qualifies (first session, cooldown, no signal): no fetch.
    if (eligibleSurveyKeys(history(state), now()).length === 0) return null;
    if (!state.cache || now() - state.cache.fetchedAtMs >= SURVEY_FETCH_INTERVAL_MS || state.cache.fetchedAtMs > now()) {
      await refreshCache();
      if (!analyticsOn()) return null;
      state = read();
    }
    const survey = pickEligibleSurvey({
      surveys: parseSurveysResponse({ surveys: state.cache?.surveys ?? [] }, now()),
      history: history(state),
      nowMs: now(),
    });
    if (!survey || offeredThisLaunch) return null;
    offeredThisLaunch = true;
    offered = survey;
    return survey;
  };

  const record = (input: ProductSurveyEventInput): ProductSurveyEventResult => {
    if (!input || typeof input !== "object" || typeof input.surveyId !== "string") return { accepted: false };
    const survey = offered;
    if (!survey || survey.id !== input.surveyId || !analyticsOn()) return { accepted: false };
    const base = {
      surveyId: survey.id,
      surveyName: survey.name,
      iteration: survey.iteration,
      questions: survey.questions.map((question) => ({ id: question.id, question: question.question })),
    };
    if (input.kind === "shown") {
      // Counted as seen whether or not the event goes out: the person saw it.
      const nowMs = now();
      let firstShow = true;
      update((state) => {
        firstShow = state.shown[survey.id] == null;
        if (firstShow) state.shown[survey.id] = nowMs;
        state.lastShownAtMs = nowMs;
      });
      if (!firstShow) return { accepted: false };
      return {
        accepted: args.analytics.captureInternal({
          event: "survey shown",
          surface: "desktop",
          survey: base,
          dedupeKey: `survey-shown:${survey.id}`,
          minimumIntervalMs: SURVEY_GLOBAL_COOLDOWN_MS,
        }).accepted,
      };
    }
    if (sentThisLaunch.has(survey.id)) return { accepted: false };
    if (input.kind === "dismissed") {
      sentThisLaunch.add(survey.id);
      return {
        accepted: args.analytics.captureInternal({
          event: "survey dismissed",
          surface: "desktop",
          survey: { ...base, partiallyCompleted: input.partiallyCompleted === true },
          dedupeKey: `survey-dismissed:${survey.id}`,
          minimumIntervalMs: SURVEY_GLOBAL_COOLDOWN_MS,
        }).accepted,
      };
    }
    if (input.kind !== "sent") return { accepted: false };
    const responses = validateSurveyAnswers(survey, input.answers);
    if (!responses) return { accepted: false };
    sentThisLaunch.add(survey.id);
    const submissionId = randomUUID();
    return {
      accepted: args.analytics.captureInternal({
        event: "survey sent",
        surface: "desktop",
        survey: { ...base, submissionId, completed: true, responses },
        clientEventId: submissionId,
        dedupeKey: `survey-sent:${survey.id}`,
        minimumIntervalMs: SURVEY_GLOBAL_COOLDOWN_MS,
      }).accepted,
    };
  };

  return { noteLaunch, noteActive, getEligibleSurvey, record };
}

export type SurveyService = ReturnType<typeof createSurveyService>;
