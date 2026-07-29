/**
 * `ade_card` — the generic emittable chat card primitive.
 *
 * One payload contract, three surfaces (desktop renderer, ADE Code TUI, iOS).
 * This module is the all-client shared half: pure types + pure helpers, no React,
 * no Electron, no Node built-ins — mirroring `./chatActivityPhase.ts`, which is
 * likewise imported by the desktop renderer AND by `apps/ade-cli`.
 *
 * Two rules the whole design rests on:
 *
 * 1. **`cardId` is identity, not content.** A repeat emit with the same `cardId`
 *    MERGES into the row that is already in the transcript instead of appending
 *    a second one, so a long-running card (CI, a build, an artifact pull) stays
 *    one chronological row as it progresses.
 * 2. **`fallbackText` is required.** A surface that does not recognize `variant`
 *    renders `fallbackText` plus the deeplink rather than nothing. That is what
 *    makes one wire contract safe to ship across three independent release
 *    trains (desktop auto-update, App Store review, npm).
 *
 * Tone policy: there is deliberately **no `danger`/red tone**. Failures render
 * amber with the error detail behind a `Details` disclosure — the same house
 * rule stated at the top of
 * `apps/desktop/src/renderer/components/chat/SubagentActivityCards.tsx`.
 * {@link normalizeAdeCardTone} folds any red-ish value an emitter invents into
 * `warning` so the policy cannot be bypassed by a payload.
 */

import { buildDeeplink, type DeeplinkTarget } from "./deeplinks";
import type { AppNavigationTarget } from "./types/core";

/** No `danger`. Failure is amber. See the module comment. */
export type AdeCardTone = "neutral" | "accent" | "success" | "warning";

/**
 * Open string union: adding a variant must never be a breaking change for a
 * client compiled against an older copy of this file.
 */
export type AdeCardVariant =
  | "proof_artifact"
  | "pr_ci"
  | "pr_review"
  | "pr_merged"
  | "pr_merge_ready"
  | "pr_conflict"
  | (string & {});

/** Semantic row glyph. Surfaces map these to their own icon vocabulary. */
export type AdeCardIcon =
  | "pass"
  | "fail"
  | "running"
  | "queued"
  | "skipped"
  | "info"
  | "file";

export type AdeCardMetric = {
  label: string;
  value: string;
  tone?: AdeCardTone;
};

export type AdeCardRow = {
  icon?: AdeCardIcon;
  text: string;
  detail?: string | null;
  tone?: AdeCardTone;
};

export type AdeCardProgress = {
  passed: number;
  failed: number;
  running: number;
  queued: number;
};

export type AdeCardAction = {
  id: string;
  label: string;
  kind: "primary" | "default";
};

/**
 * The card body. Kept separate from the `AgentChatEvent` union member so this
 * module never has to import `./types/chat` (which would be circular — chat.ts
 * imports this file).
 */
export type AdeCardPayload = {
  /** Stable identity. A repeat emit with the same id merges into the existing row. */
  cardId: string;
  variant: AdeCardVariant;
  state: "live" | "terminal";
  title: string;
  subtitle?: string | null;
  metrics?: AdeCardMetric[];
  rows?: AdeCardRow[];
  progress?: AdeCardProgress | null;
  navTarget?: AppNavigationTarget | null;
  actions?: AdeCardAction[];
  /** REQUIRED. Rendered verbatim by any client that does not know `variant`. */
  fallbackText: string;
  turnId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /**
   * How long the work the card describes actually took.
   *
   * Distinct from `updatedAt − createdAt`, which is only the span between the
   * card's own status transitions. Rendering the span as if it were a duration
   * is how a 3-minute CI run came to read `176m`. Emitters set this only when
   * they genuinely know the run's wall time.
   */
  durationMs?: number | null;
  /**
   * Set when the emitter could NOT fetch the card's detail (API error, 403,
   * rate limit). A zero-count card is then honestly "detail unavailable"
   * instead of a content-free false-green.
   */
  degradedReason?: string | null;
  /**
   * Set by the transcript merge when a degraded re-emit lands on top of a card
   * that already had rich detail: the earlier `rows`/`progress`/`metrics` are
   * preserved and shown as stale rather than blanked.
   */
  stale?: boolean;
  /** Rows the emitter dropped to keep the card short. Rendered as `+N more`. */
  rowsTruncated?: number;
};

export const ADE_CARD_TONES: readonly AdeCardTone[] = ["neutral", "accent", "success", "warning"];

/**
 * Variants this build knows how to render richly. Anything else degrades to
 * `fallbackText` + deeplink on every surface — see {@link isKnownAdeCardVariant}.
 */
export const KNOWN_ADE_CARD_VARIANTS: readonly AdeCardVariant[] = [
  "proof_artifact",
  "pr_ci",
  "pr_review",
  "pr_merged",
  "pr_merge_ready",
  "pr_conflict",
];

export function isKnownAdeCardVariant(variant: string | null | undefined): boolean {
  if (!variant) return false;
  return KNOWN_ADE_CARD_VARIANTS.includes(variant.trim() as AdeCardVariant);
}

/**
 * Fold an arbitrary tone string onto the four allowed tones. Red-ish values
 * (`danger`, `error`, `failed`, `red`) become `warning`: failures are amber in
 * ADE chat, never a red error block.
 */
export function normalizeAdeCardTone(value: string | null | undefined): AdeCardTone {
  const tone = (value ?? "").trim().toLowerCase();
  switch (tone) {
    case "accent":
      return "accent";
    case "success":
    case "passed":
    case "pass":
      return "success";
    case "warning":
    case "warn":
    case "danger":
    case "error":
    case "failed":
    case "fail":
    case "red":
      return "warning";
    default:
      return "neutral";
  }
}

/** Stable render key for the card's transcript row. Identity-derived, never index-derived. */
export function adeCardRowKey(cardId: string): string {
  return `ade-card:${cardId}`;
}

export function adeCardProgressTotal(progress: AdeCardProgress | null | undefined): number {
  if (!progress) return 0;
  return Math.max(0, progress.passed)
    + Math.max(0, progress.failed)
    + Math.max(0, progress.running)
    + Math.max(0, progress.queued);
}

/**
 * `ade://` URL for the card's `navTarget`, or null when the target has no
 * addressable deeplink form. Used by the surfaces that cannot dispatch an
 * in-process navigation object (TUI, iOS fallback rendering) and by
 * {@link describeAdeCard}.
 */
export function adeCardDeeplink(target: AppNavigationTarget | null | undefined): string | null {
  const deeplinkTarget = navigationTargetToDeeplinkTarget(target);
  if (!deeplinkTarget) return null;
  try {
    return buildDeeplink(deeplinkTarget, { form: "ade" });
  } catch {
    return null;
  }
}

function navigationTargetToDeeplinkTarget(
  target: AppNavigationTarget | null | undefined,
): DeeplinkTarget | null {
  if (!target) return null;
  switch (target.kind) {
    case "work":
    case "chat":
      return target.sessionId
        ? {
            kind: "session",
            sessionId: target.sessionId,
            ...(target.laneId ? { laneId: target.laneId } : {}),
          }
        : null;
    case "file":
      return {
        kind: "file",
        path: target.path,
        ...(typeof target.line === "number" ? { line: target.line } : {}),
        ...(target.laneId ? { laneId: target.laneId } : {}),
      };
    case "commit":
      return { kind: "commit", sha: target.sha, ...(target.laneId ? { laneId: target.laneId } : {}) };
    case "artifact":
      return { kind: "artifact", artifactId: target.artifactId };
    case "lane":
      return { kind: "lane", laneId: target.laneId };
    case "pr":
      return target.repoOwner && target.repoName && typeof target.prNumber === "number"
        ? {
            kind: "pr",
            repoOwner: target.repoOwner,
            repoName: target.repoName,
            prNumber: target.prNumber,
            ...(target.detailTab ? { detailTab: target.detailTab } : {}),
          }
        : null;
    case "branch":
      return {
        kind: "branch",
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        branch: target.branch,
        ...(typeof target.prNumber === "number" ? { prNumber: target.prNumber } : {}),
      };
    case "linear-issue":
      return {
        kind: "linear-issue",
        issueIdentifier: target.issueIdentifier,
        ...(target.branch ? { branch: target.branch } : {}),
      };
    default:
      // `route` / `files-external` are local-app concepts with no URL form.
      return null;
  }
}

/**
 * One-line, surface-independent description of a card.
 *
 * Emitters use it to BUILD `fallbackText` when they have nothing better to say,
 * and clients use it to VALIDATE — {@link adeCardFallbackText} substitutes it
 * whenever a payload arrives with an empty `fallbackText`, so the degradation
 * path can never render a blank row.
 */
export function describeAdeCard(card: AdeCardPayload): string {
  const head = [card.title.trim(), card.subtitle?.trim() || null]
    .filter((part): part is string => Boolean(part))
    .join(" — ");
  const metrics = (card.metrics ?? [])
    .map((metric) => `${metric.value} ${metric.label}`.trim())
    .filter((part) => part.length > 0);
  const rowCount = card.rows?.length ?? 0;
  const parts = [
    head || card.variant,
    ...metrics,
    rowCount > 0 && metrics.length === 0 ? `${rowCount} ${rowCount === 1 ? "item" : "items"}` : null,
    card.state === "live" ? "in progress" : null,
  ].filter((part): part is string => Boolean(part));
  const link = adeCardDeeplink(card.navTarget);
  const summary = parts.join(" · ");
  return link ? `${summary} · ${link}` : summary;
}

/** `fallbackText` if the emitter supplied one, otherwise a generated description. */
export function adeCardFallbackText(card: AdeCardPayload): string {
  const provided = card.fallbackText?.trim();
  return provided && provided.length > 0 ? provided : describeAdeCard(card);
}

/**
 * Content fingerprint used for the host's idempotency guard: a repeat emit whose
 * payload is byte-identical to the last card with the same `cardId` is skipped
 * rather than written to the transcript again. `updatedAt` is excluded on
 * purpose — a re-emit that only bumps a clock is not new information.
 */
export function adeCardFingerprint(card: AdeCardPayload): string {
  const {
    updatedAt: _updatedAt,
    createdAt: _createdAt,
    type: _eventType,
    ...rest
  } = card as AdeCardPayload & { type?: unknown };
  return stableStringify(rest);
}

/**
 * Key-order-independent JSON. `JSON.stringify`'s array replacer cannot be used
 * here: it filters keys at every depth, which would silently drop nested
 * `metrics`/`rows` fields from the fingerprint and make two different cards
 * compare equal.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}
