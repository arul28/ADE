/**
 * In-app surveys (PostHog "API" surveys, rendered by ADE itself; ADE ships no
 * posthog-js). The main process fetches the active surveys with the public
 * project token, keeps only the ones whose name starts with an ADE key prefix,
 * decides from local history whether this install should see one, and records
 * PostHog's own survey events through the product analytics service.
 *
 * A survey is about the person at THIS desktop app, never a chat, lane or
 * machine, so none of these calls take a runtime pin.
 */

/** The name prefixes ADE recognises, e.g. `[ade:pmf] Sean Ellis PMF`. */
export const ADE_SURVEY_KEYS = ["pmf", "returning", "early"] as const;
export type AdeSurveyKey = (typeof ADE_SURVEY_KEYS)[number];

/** The PostHog event names for a survey's life cycle (exact spelling matters). */
export const PRODUCT_SURVEY_EVENTS = ["survey shown", "survey dismissed", "survey sent"] as const;
export type ProductSurveyEventName = (typeof PRODUCT_SURVEY_EVENTS)[number];

/** Cap on one typed answer. Longer text is cut, never rejected. */
export const SURVEY_RESPONSE_MAX_LENGTH = 2_000;

type QuestionBase = {
  id: string;
  question: string;
  description: string | null;
  optional: boolean;
  buttonText: string | null;
};

export type ProductSurveyQuestion =
  | (QuestionBase & { type: "open" })
  | (QuestionBase & {
      type: "rating";
      /** Inclusive bounds: a 10-point scale is NPS (0–10), every other scale starts at 1. */
      min: number;
      max: number;
      lowerBoundLabel: string | null;
      upperBoundLabel: string | null;
    })
  | (QuestionBase & {
      type: "single_choice" | "multiple_choice";
      choices: string[];
      /** The last choice is "Other": picking it asks for the person's own words. */
      hasOpenChoice: boolean;
    })
  | (QuestionBase & { type: "link"; link: string | null });

export type ProductSurvey = {
  id: string;
  name: string;
  key: AdeSurveyKey;
  iteration: number | null;
  questions: ProductSurveyQuestion[];
};

/** A rating or a single choice is a string; a multiple choice is a list. */
export type ProductSurveyAnswer = string | string[];

export type ProductSurveyEventInput =
  | { kind: "shown"; surveyId: string }
  | { kind: "dismissed"; surveyId: string; partiallyCompleted?: boolean }
  | { kind: "sent"; surveyId: string; answers: Record<string, ProductSurveyAnswer> };

export type ProductSurveyEventResult = { accepted: boolean };

/** Desktop-only preload bridge. Absent on the hosted web client, which shows no surveys. */
export type ProductSurveyBridge = {
  getEligible: () => Promise<ProductSurvey | null>;
  record: (input: ProductSurveyEventInput) => Promise<ProductSurveyEventResult>;
};

/**
 * What a survey event hands the analytics service. Built only by the main
 * process from a cached survey and validated answers; the generic renderer
 * capture path never carries it.
 */
export type ProductSurveyEventPayload = {
  surveyId: string;
  surveyName: string;
  iteration: number | null;
  questions: Array<{ id: string; question: string }>;
  submissionId?: string;
  completed?: boolean;
  partiallyCompleted?: boolean;
  /** Keyed by question id. */
  responses?: Record<string, ProductSurveyAnswer>;
};
