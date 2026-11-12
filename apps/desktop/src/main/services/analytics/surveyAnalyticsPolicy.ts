import { scrubFreeText } from "../../../shared/sentry/scrub";
import {
  PRODUCT_SURVEY_EVENTS,
  SURVEY_RESPONSE_MAX_LENGTH,
  type ProductSurveyEventPayload,
} from "../../../shared/types/productSurveys";
import type { ProductAnalyticsEventName } from "../../../shared/types/productAnalytics";

/**
 * The survey events' own sanitizer. Their properties are rebuilt from a
 * main-process payload here, never passed through the allowlists in
 * `productAnalyticsPolicy.ts`.
 */

const SURVEY_EVENT_SET: ReadonlySet<string> = new Set(PRODUCT_SURVEY_EVENTS);
const SURVEY_ID_VALUE = /^[A-Za-z0-9-]{1,64}$/;
const SURVEY_NAME_PREFIX = /^\[ade:[a-z]+\]/i;
const MAX_SURVEY_QUESTIONS = 10;
const MAX_SURVEY_CHOICES = 20;

export function isSurveyAnalyticsEvent(event: ProductAnalyticsEventName): boolean {
  return SURVEY_EVENT_SET.has(event);
}

/**
 * The person's own words, which they chose to send. Secrets, email addresses
 * and absolute paths are removed ({@link scrubFreeText}), and the text is cut
 * at {@link SURVEY_RESPONSE_MAX_LENGTH}.
 */
export function scrubSurveyText(value: unknown, maxLength = SURVEY_RESPONSE_MAX_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, maxLength);
  if (!trimmed) return null;
  return scrubFreeText(trimmed, { maxLength }).slice(0, maxLength);
}

/**
 * PostHog's survey properties (`$survey_id`, `$survey_name`,
 * `$survey_response_<question id>`, `$survey_questions`, ...), rebuilt from a
 * main-process payload. Anything malformed is left out; a payload without a
 * survey id or an ADE survey name yields null and the event is dropped.
 */
export function sanitizeSurveyEventProperties(
  event: ProductAnalyticsEventName,
  payload: ProductSurveyEventPayload | undefined,
): Record<string, unknown> | null {
  if (!isSurveyAnalyticsEvent(event) || !payload || typeof payload !== "object") return null;
  if (typeof payload.surveyId !== "string" || !SURVEY_ID_VALUE.test(payload.surveyId)) return null;
  const name = scrubSurveyText(payload.surveyName, 200);
  if (!name || !SURVEY_NAME_PREFIX.test(name)) return null;
  const properties: Record<string, unknown> = {
    $survey_id: payload.surveyId,
    $survey_name: name,
  };
  if (typeof payload.iteration === "number" && Number.isInteger(payload.iteration) && payload.iteration > 0) {
    properties.$survey_iteration = Math.min(payload.iteration, 10_000);
  }
  if (event === "survey shown") return properties;

  const questions = (Array.isArray(payload.questions) ? payload.questions : [])
    .slice(0, MAX_SURVEY_QUESTIONS)
    .flatMap((question) => {
      const text = scrubSurveyText(question?.question, 500);
      return typeof question?.id === "string" && SURVEY_ID_VALUE.test(question.id) && text
        ? [{ id: question.id, question: text }]
        : [];
    });
  properties.$survey_questions = questions;
  // Measured by the window, so it does not depend on when main got each call:
  // a "shown" and a "dismissed" one millisecond apart (2026-11-09) could not
  // be told from a stalled main process delivering both at once.
  if (typeof payload.shownForMs === "number" && Number.isFinite(payload.shownForMs) && payload.shownForMs >= 0) {
    properties.shown_for_ms = Math.min(Math.round(payload.shownForMs), 24 * 60 * 60 * 1_000);
  }
  if (event === "survey dismissed") {
    properties.$survey_partially_completed = payload.partiallyCompleted === true;
    return properties;
  }

  if (typeof payload.submissionId !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.submissionId)) return null;
  properties.$survey_submission_id = payload.submissionId.toLowerCase();
  properties.$survey_completed = payload.completed !== false;
  const responses = payload.responses && typeof payload.responses === "object" ? payload.responses : {};
  questions.forEach((question, index) => {
    if (!Object.prototype.hasOwnProperty.call(responses, question.id)) return;
    const raw = responses[question.id];
    let value: string | string[] | null = null;
    if (Array.isArray(raw)) {
      const items = raw.slice(0, MAX_SURVEY_CHOICES).flatMap((item) => {
        const safe = scrubSurveyText(item, 500);
        return safe ? [safe] : [];
      });
      value = items.length > 0 ? items : null;
    } else {
      value = scrubSurveyText(raw);
    }
    if (value == null) return;
    properties[`$survey_response_${question.id}`] = value;
    // PostHog's index-based key for the first question: dashboards break a
    // survey down by it without knowing the question's id.
    if (index === 0) properties.$survey_response = value;
  });
  return properties;
}
