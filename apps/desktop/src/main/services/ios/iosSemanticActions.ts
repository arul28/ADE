/**
 * Names an element on the iOS simulator screen instead of a pixel.
 *
 * An agent taps raw coordinates today. A coordinate tap is a guess that the
 * layout did not move, and the guess fails silently: the tap lands on whatever
 * moved into that rectangle. This module turns a claim about the app — "the
 * button labelled Continue" — into one element of an `IosScreenSnapshot`.
 *
 * The module is pure. It reads a snapshot the caller already captured. It runs
 * no process, touches no disk, and imports `node:crypto` and nothing else, so
 * the matching rules stay testable without a booted simulator.
 */

import { createHash } from "node:crypto";
import type { IosInspectableFrame, IosScreenElement, IosSimulatorElementQuery } from "../../../shared/types/iosSimulator";

/**
 * How close two strings must be before the near-miss hint names one.
 *
 * A hint that names an unrelated element costs the reader more time than no
 * hint. "Continue" against "Continue with Apple" scores 0.42. "Continue"
 * against "Cancel" scores far below the floor.
 */
const NEAR_MISS_FLOOR = 0.25;

const REF_HASH_LENGTH = 12;

type QueryCriterion = {
  field: "ref" | "identifier" | "label" | "text" | "role";
  value: string;
};

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Joins the parts of a label-tier ref.
 *
 * The separator has to be a character no label, role, or value can contain, or
 * two different elements hash to one ref. It is written as an escape rather
 * than a literal: a raw NUL byte in the source makes git read the whole file as
 * binary, which costs every later reader its line-level diff and blame.
 */
const REF_FIELD_SEPARATOR = "\u0000";

function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, REF_HASH_LENGTH);
}

/**
 * Reads the accessibility identifier the snapshot kept outside the typed
 * fields.
 *
 * `collectAccessibilityElements` copies the raw accessibility node into
 * `metadata`, and the inspector spreads the SwiftUI metadata into the same
 * place. `IosScreenElement.identifier` is best-effort and falls back to the
 * component id, so the raw `accessibilityIdentifier` is the stronger value
 * when the app author set one.
 */
function accessibilityIdentifierOf(element: IosScreenElement): string | null {
  const raw = element.metadata?.accessibilityIdentifier;
  return typeof raw === "string" ? nonEmpty(raw) : null;
}

function identifiersOf(element: IosScreenElement): string[] {
  const values = [accessibilityIdentifierOf(element), nonEmpty(element.identifier)];
  return values.filter((value): value is string => value !== null);
}

function isUsableFrame(frame: IosInspectableFrame | null | undefined): frame is IosInspectableFrame {
  if (!frame) return false;
  if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y)) return false;
  if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height)) return false;
  return frame.width > 0 && frame.height > 0;
}

/**
 * Picks the frame the tap backend understands.
 *
 * `frame` holds device points. `pixelFrame` holds screenshot pixels:
 * `scaleAccessibilityElementsToScreenshot` multiplies `frame` by the device
 * scale to build it, so on a 3x device the two differ by a factor of three.
 *
 * The tap path takes device points. `runIdbTap` passes its `x`/`y` straight to
 * `idb ui tap`, and the drawer divides the screenshot-pixel point by
 * `snapshot.screen.scale` before it calls `tap`. So `frame` is the tap space
 * and this function returns `frame` first.
 *
 * `pixelFrame` is only a fallback for an element whose `frame` never arrived.
 * Note that `inspectPoint` reads its `x`/`y` in the OTHER space — it hit-tests
 * `pixelFrame` — so never reuse a tap point as an inspect point.
 */
function tapFrameOf(element: IosScreenElement): IosInspectableFrame | null {
  if (isUsableFrame(element.frame)) return element.frame;
  if (isUsableFrame(element.pixelFrame)) return element.pixelFrame;
  return null;
}

/**
 * A reference that survives a re-render.
 *
 * The positional id of an accessibility element is a tree path such as
 * `accessibility:0.3.1`. That path changes when a sibling appears, so an agent
 * that stores the id points at a different element after the next render. The
 * ref replaces the path with the most durable identity the element carries.
 *
 * The tier name stays in the ref so a reader can see how much to trust it:
 *
 * - `id:` — the author set an accessibility identifier. The identifier is part
 *   of the source, so the ref survives a re-render and a layout change.
 * - `component:` — the ADE inspector matched a SwiftUI component. The ref
 *   survives a re-render. It does not survive a rename of the component.
 * - `label:` — the role, the element type, the label and the value together.
 *   The ref survives a re-render. It changes when the copy changes, and two
 *   identical rows in a list share one ref.
 * - `pos:` — the positional id, and nothing better was available. THIS TIER
 *   DOES NOT SURVIVE A RE-RENDER. It is the reason the other tiers exist. Read
 *   a `pos:` ref as a warning that the element carries no identity, and ask the
 *   app author for an accessibility identifier.
 */
export function buildElementRef(element: IosScreenElement): string {
  const identifier = accessibilityIdentifierOf(element) ?? nonEmpty(element.identifier);
  if (identifier) return `id:${shortHash(identifier)}`;

  const componentId = nonEmpty(element.componentId);
  if (componentId) return `component:${shortHash(componentId)}`;

  const descriptive = [
    element.role ?? "",
    element.elementType ?? "",
    element.label ?? "",
    element.value ?? "",
  ];
  if (descriptive.some((part) => part.trim().length > 0)) {
    return `label:${shortHash(descriptive.join(REF_FIELD_SEPARATOR))}`;
  }

  return `pos:${shortHash(element.id)}`;
}

export type ElementMatchOutcome = {
  matches: IosScreenElement[];
  /** The element the caller should act on, after `index` is applied. */
  selected: IosScreenElement | null;
  /** Why nothing matched, in words a human can act on. */
  reason: string | null;
};

/**
 * The centre of an element in device points, for the tap backend.
 *
 * The value is rounded because `idb ui tap` takes integers. The result is null
 * when neither frame has a positive width and height.
 */
export function elementTapPoint(element: IosScreenElement): { x: number; y: number } | null {
  const frame = tapFrameOf(element);
  if (!frame) return null;
  return {
    x: Math.round(frame.x + frame.width / 2),
    y: Math.round(frame.y + frame.height / 2),
  };
}

/** One-line description of an element for a log row or an error message. */
export function describeElement(element: IosScreenElement): string {
  const parts: string[] = [`[${element.layer}]`];
  parts.push(nonEmpty(element.role) ?? nonEmpty(element.elementType) ?? "element");

  const label = nonEmpty(element.label);
  const value = nonEmpty(element.value);
  if (label) parts.push(JSON.stringify(label));
  if (!label && value) parts.push(`value=${JSON.stringify(value)}`);

  const identifier = identifiersOf(element)[0];
  if (identifier) parts.push(`#${identifier}`);

  const frame = tapFrameOf(element);
  if (frame) {
    parts.push(`at ${Math.round(frame.x)},${Math.round(frame.y)} ${Math.round(frame.width)}x${Math.round(frame.height)}`);
  }

  const sourceFile = nonEmpty(element.sourceFile);
  if (sourceFile) {
    parts.push(element.sourceLine == null ? `(${sourceFile})` : `(${sourceFile}:${element.sourceLine})`);
  }

  return parts.join(" ");
}

function criteriaOf(query: IosSimulatorElementQuery): QueryCriterion[] {
  const criteria: QueryCriterion[] = [];
  const push = (field: QueryCriterion["field"], raw: string | null | undefined) => {
    const value = nonEmpty(raw);
    if (value) criteria.push({ field, value });
  };
  push("ref", query.ref);
  push("identifier", query.identifier);
  push("label", query.label);
  push("text", query.text);
  push("role", query.role);
  return criteria;
}

function joinPhrases(phrases: string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/**
 * Formats "3 elements match this query" style guidance.
 *
 * The result names the supplied fields only. It leaves `index` out, because the
 * caller that reports an out-of-range index states the index itself.
 */
export function describeQuery(query: IosSimulatorElementQuery): string {
  const criteria = criteriaOf(query);
  if (!criteria.length) return "an empty query";
  return joinPhrases(criteria.map((criterion) => `${criterion.field} ${JSON.stringify(criterion.value)}`));
}

/**
 * An element the user can see and touch.
 *
 * A frame with a zero or negative width or height covers no pixels, so a tap
 * on it does nothing. Such an element NEVER matches a query, and it never
 * appears as a near miss either. A collapsed row and a hidden accessibility
 * container both arrive in the snapshot with a zero-size frame, and a match on
 * one of them reports success for a tap that the app ignored.
 */
function isVisible(element: IosScreenElement): boolean {
  return tapFrameOf(element) !== null;
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function matchesCriterion(element: IosScreenElement, criterion: QueryCriterion): boolean {
  switch (criterion.field) {
    case "ref":
      return buildElementRef(element) === criterion.value;
    case "identifier":
      // Exact and case-sensitive. An identifier is source code, not copy, and
      // two identifiers that differ only in case are two different elements.
      return identifiersOf(element).includes(criterion.value);
    case "label": {
      const label = nonEmpty(element.label);
      return label !== null && label.toLowerCase() === criterion.value.toLowerCase();
    }
    case "text": {
      const needle = normalise(criterion.value);
      return [element.label, element.value]
        .map((candidate) => nonEmpty(candidate))
        .some((candidate) => candidate !== null && normalise(candidate).includes(needle));
    }
    case "role": {
      const wanted = criterion.value.toLowerCase();
      return [element.role, element.elementType]
        .map((candidate) => nonEmpty(candidate))
        .some((candidate) => candidate !== null && candidate.toLowerCase() === wanted);
    }
    default:
      return false;
  }
}

/**
 * Orders the matches so the most useful element comes first.
 *
 * The snapshot order stays, with one exception: an element of the `app` layer
 * moves ahead of an element of the `accessibility` layer. An app-layer element
 * carries the source file and the source line, so it tells the agent which code
 * to edit after the action.
 */
function orderMatches(matches: IosScreenElement[]): IosScreenElement[] {
  return matches
    .map((element, position) => ({ element, position }))
    .sort((a, b) => {
      const rankA = a.element.layer === "app" ? 0 : 1;
      const rankB = b.element.layer === "app" ? 0 : 1;
      if (rankA !== rankB) return rankA - rankB;
      return a.position - b.position;
    })
    .map((entry) => entry.element);
}

/**
 * Scores two strings for the near-miss hint.
 *
 * The comparison is a normalised substring test. It adds no dependency and it
 * answers the one question the reader has: did the author write nearly this
 * text? A shared prefix scores at half weight, so "Continue" still points at
 * "Continue with Apple" when no element contains the whole word.
 */
function closeness(candidate: string, needle: string): number {
  const left = normalise(candidate);
  const right = normalise(needle);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const longest = Math.max(left.length, right.length);
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / longest;
  }
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  return (prefix / longest) * 0.5;
}

/**
 * Names the element that came closest, so the reader can fix the query.
 *
 * A ref is a hash, so a near miss on a ref says nothing. The hint uses the
 * first human-readable field of the query instead.
 */
function nearMiss(elements: IosScreenElement[], criteria: QueryCriterion[]): string | null {
  const criterion = criteria.find((entry) => entry.field !== "ref");
  if (!criterion) return null;

  let best: { text: string; score: number } | null = null;
  for (const element of elements) {
    const candidates = criterion.field === "role"
      ? [element.role, element.elementType]
      : [element.label, element.value, ...identifiersOf(element)];
    for (const candidate of candidates) {
      const text = nonEmpty(candidate);
      if (!text) continue;
      const score = closeness(text, criterion.value);
      if (score < NEAR_MISS_FLOOR) continue;
      if (!best || score > best.score) best = { text, score };
    }
  }
  return best ? best.text : null;
}

function noMatchReason(elements: IosScreenElement[], query: IosSimulatorElementQuery, criteria: QueryCriterion[]): string {
  const head = criteria.length === 1 && criteria[0]
    ? singleCriterionSentence(criteria[0])
    : `No element matches ${describeQuery(query)}.`;
  const closest = nearMiss(elements, criteria);
  return closest ? `${head} The closest is ${JSON.stringify(closest)}.` : head;
}

function singleCriterionSentence(criterion: QueryCriterion): string {
  const value = JSON.stringify(criterion.value);
  switch (criterion.field) {
    case "ref":
      return `No element matches the ref ${value}.`;
    case "identifier":
      return `No element has the identifier ${value}.`;
    case "label":
      return `No element has the label ${value}.`;
    case "text":
      return `No element contains the text ${value}.`;
    case "role":
      return `No element has the role ${value}.`;
    default:
      return `No element matches ${value}.`;
  }
}

/**
 * Finds every element the query names, then selects one.
 *
 * Every supplied field must match. The fields combine with AND, never with OR,
 * because a query that widens as the caller adds detail is a trap: the caller
 * adds `role` to disambiguate a label and gets more matches, not fewer.
 *
 * An empty query matches nothing. An empty query that matched everything would
 * tap the first element of the screen for a caller that forgot a field.
 */
export function matchElements(
  elements: IosScreenElement[],
  query: IosSimulatorElementQuery,
): ElementMatchOutcome {
  const visible = elements.filter(isVisible);
  const criteria = criteriaOf(query);

  if (!criteria.length) {
    return {
      matches: [],
      selected: null,
      reason: "The query is empty. Supply ref, identifier, label, text or role to name an element.",
    };
  }

  const matches = orderMatches(
    visible.filter((element) => criteria.every((criterion) => matchesCriterion(element, criterion))),
  );

  if (!matches.length) {
    return { matches, selected: null, reason: noMatchReason(visible, query, criteria) };
  }

  const rawIndex = query.index ?? 0;
  if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= matches.length) {
    const countPhrase = matches.length === 1 ? "1 element matches" : `${matches.length} elements match`;
    return {
      matches,
      selected: null,
      reason: `${countPhrase} ${describeQuery(query)}. Index ${rawIndex} is out of range.`,
    };
  }

  return { matches, selected: matches[rawIndex] ?? null, reason: null };
}
