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
 * The tap path takes device points. The helper's touch injection takes its
 * `x`/`y` in the same space, and the column divides the screenshot-pixel point
 * by `snapshot.screen.scale` before it calls `tap`. So `frame` is the tap space
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
  /**
   * Set when the match is not what the query literally asked for: a
   * `--label` that no element carries, found as an accessibility identifier.
   * The caller says so, so the agent can use the right flag next time.
   */
  note?: string | null;
};

/**
 * The centre of an element in device points, for the tap backend.
 *
 * The value is rounded because the helper's touch injection takes integers.
 * The result is null when neither frame has a positive width and height.
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

/**
 * True when the element's label starts with `wanted` as whole words: "Work"
 * names "Work, 3 need you" (a menu row with a subtitle) but not "Workspace".
 */
function labelStartsWithWords(element: IosScreenElement, wanted: string): boolean {
  const left = normalise(nonEmpty(element.label) ?? "");
  const right = normalise(wanted);
  if (!right || !left.startsWith(right)) return false;
  return !/[\p{L}\p{N}]/u.test(left.charAt(right.length));
}

function matchesCriterion(element: IosScreenElement, criterion: QueryCriterion): boolean {
  switch (criterion.field) {
    case "ref":
      // The tree-position `id` is accepted too: it is what older snapshots
      // printed, and it still names the element while the layout holds.
      return buildElementRef(element) === criterion.value || element.id === criterion.value;
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
 * True for an element ADE inferred rather than read from the screen: a
 * SwiftUI tab placed from the source's `.tabItem` labels and the Tab Bar's
 * frame (`synthesizeSwiftUITabBarElements`). Its frame is a guess.
 */
export function isInferredElement(element: IosScreenElement): boolean {
  return element.metadata?.synthetic === true;
}

/**
 * True for an element of an iPadOS window the helper could not place on the
 * screen (`ADEUnplaced`): its frame is still relative to its window, so a tap
 * at its centre lands somewhere else.
 */
export function isUnplacedElement(element: IosScreenElement): boolean {
  return element.metadata?.ADEUnplaced === true;
}

/** Roles a person acts on, as the helper and the inspector spell them. */
const ACTIONABLE_ROLE = /button|link|cell|tabitem|menuitem|switch|toggle|checkbox|radio|slider|stepper|segment|popup|combobox|textfield|searchfield|textarea|incrementor/i;

function isActionable(element: IosScreenElement): boolean {
  return [element.role, element.elementType].some((value) => Boolean(value && ACTIONABLE_ROLE.test(value)));
}

function frameContains(outer: IosInspectableFrame, inner: IosInspectableFrame): boolean {
  const slack = 0.5;
  return inner.x >= outer.x - slack
    && inner.y >= outer.y - slack
    && inner.x + inner.width <= outer.x + outer.width + slack
    && inner.y + inner.height <= outer.y + outer.height + slack
    && outer.width * outer.height > inner.width * inner.height;
}

/** Why a match sorted where it did, for the "tapped #k" note. */
type MatchRank = { layer: number; insideActionable: number; inferred: number };

function rankOf(element: IosScreenElement, matches: IosScreenElement[]): MatchRank {
  const frame = tapFrameOf(element);
  // Text or an image inside another match a person acts on (the button that
  // holds it): the button is the target, and its centre is where its own tap
  // lands, not wherever the text happens to sit.
  const insideActionable = !isActionable(element) && frame !== null && matches.some((other) => {
    if (other === element || !isActionable(other) || isInferredElement(other)) return false;
    const outer = tapFrameOf(other);
    return outer !== null && frameContains(outer, frame);
  });
  return {
    layer: element.layer === "app" ? 0 : 1,
    insideActionable: insideActionable ? 1 : 0,
    // Last of all: a frame ADE guessed is never preferred to one it read.
    inferred: isInferredElement(element) || isUnplacedElement(element) ? 1 : 0,
  };
}

/**
 * Orders the matches so the most useful element comes first.
 *
 * The snapshot order stays (smallest first), with three exceptions, in this
 * order of weight:
 *
 * - an element ADE inferred (a SwiftUI tab placed from source) goes after
 *   every element read from the screen, because its frame is a guess;
 * - an element of the `app` layer moves ahead of the `accessibility` layer.
 *   It carries the source file and line, so it tells the agent which code to
 *   edit after the action;
 * - text or an image that sits inside another match a person acts on (a
 *   Button, a cell, a link) goes after that element, so `--text-match` taps
 *   the tile rather than the caption inside it.
 */
function orderMatches(matches: IosScreenElement[]): IosScreenElement[] {
  return matches
    .map((element, position) => ({ element, position, rank: rankOf(element, matches) }))
    .sort((a, b) => {
      if (a.rank.inferred !== b.rank.inferred) return a.rank.inferred - b.rank.inferred;
      if (a.rank.layer !== b.rank.layer) return a.rank.layer - b.rank.layer;
      if (a.rank.insideActionable !== b.rank.insideActionable) return a.rank.insideActionable - b.rank.insideActionable;
      return a.position - b.position;
    })
    .map((entry) => entry.element);
}

/**
 * One sentence on which of several matches an action took, and why, so an
 * agent whose tap did nothing can see that it hit the wrong one and name the
 * right one with `--index`. Null for a single match.
 */
export function describeMatchChoice(
  outcome: Pick<ElementMatchOutcome, "matches" | "selected">,
  query: IosSimulatorElementQuery,
): string | null {
  const { matches, selected } = outcome;
  if (!selected || matches.length < 2) return null;
  const index = Math.max(0, matches.indexOf(selected));
  const others = matches.filter((element) => element !== selected);
  const selectedRank = rankOf(selected, matches);
  let why: string;
  if (query.index != null && query.index > 0) {
    why = `--index ${query.index} chose it`;
  } else if (others.some((other) => isInferredElement(other)) && !isInferredElement(selected)) {
    why = "it was read from the screen; the other matches are inferred from source";
  } else if (selected.layer === "app" && others.some((other) => other.layer !== "app")) {
    why = "it is the app's own element, with its source file";
  } else if (others.some((other) => rankOf(other, matches).insideActionable === 1) && selectedRank.insideActionable === 0 && isActionable(selected)) {
    why = "it is the control that holds the matching text";
  } else {
    why = "it comes first in the snapshot's order (smallest first)";
  }
  const listed = matches.slice(0, 4).map((element, position) => {
    const point = elementTapPoint(element);
    const where = point ? ` at ${point.x},${point.y}` : "";
    const name = nonEmpty(element.label) ?? nonEmpty(element.value) ?? nonEmpty(element.role) ?? "element";
    const inferred = isInferredElement(element) ? " (inferred)" : "";
    return `#${position} ${JSON.stringify(name)}${where}${inferred}`;
  });
  const more = matches.length > listed.length ? `, and ${matches.length - listed.length} more` : "";
  const next = index + 1 < matches.length ? index + 1 : 0;
  return `${matches.length} elements match; used #${index} because ${why}. Matches: ${listed.join(", ")}${more}. `
    + `Pick another with --index ${next}.`;
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
/** Which element field a near miss was found in, and the flag that queries it. */
type NearMissField = "label" | "value" | "identifier" | "role";

const NEAR_MISS_FLAG: Record<NearMissField, string> = {
  label: "--label",
  // A value has no exact flag; the substring query reads it.
  value: "--text-match",
  identifier: "--identifier",
  role: "--role",
};

function nearMiss(
  elements: IosScreenElement[],
  criteria: QueryCriterion[],
): { text: string; field: NearMissField } | null {
  const criterion = criteria.find((entry) => entry.field !== "ref");
  if (!criterion) return null;

  let best: { text: string; field: NearMissField; score: number } | null = null;
  for (const element of elements) {
    const candidates: Array<{ value: string | null | undefined; field: NearMissField }> = criterion.field === "role"
      ? [{ value: element.role, field: "role" }, { value: element.elementType, field: "role" }]
      : [
        { value: element.label, field: "label" },
        { value: element.value, field: "value" },
        ...identifiersOf(element).map((value) => ({ value, field: "identifier" as const })),
      ];
    for (const candidate of candidates) {
      const text = nonEmpty(candidate.value);
      if (!text) continue;
      const score = closeness(text, criterion.value);
      if (score < NEAR_MISS_FLOOR) continue;
      if (!best || score > best.score) best = { text, field: candidate.field, score };
    }
  }
  return best ? { text: best.text, field: best.field } : null;
}

function noMatchReason(elements: IosScreenElement[], query: IosSimulatorElementQuery, criteria: QueryCriterion[]): string {
  const head = criteria.length === 1 && criteria[0]
    ? singleCriterionSentence(criteria[0])
    : `No element matches ${describeQuery(query)}.`;
  const closest = nearMiss(elements, criteria);
  if (!closest) return head;
  // The field and the flag, not just the text: "BackButton" as an identifier
  // read as a label in the snapshot, and `--label BackButton` kept failing.
  const flag = NEAR_MISS_FLAG[closest.field];
  return `${head} The closest is the ${closest.field} ${JSON.stringify(closest.text)}; `
    + `query it with ${flag} ${JSON.stringify(closest.text)}.`;
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
  options: { labelPrefix?: boolean } = {},
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

  let matches = orderMatches(
    visible.filter((element) => criteria.every((criterion) => matchesCriterion(element, criterion))),
  );
  // No exact label: one label that starts with those words, so "Work" finds
  // the menu row "Work, 3 need you". Exact labels always win; two prefix
  // matches are a guess, and a wait or an assert never takes one ("Save" is
  // not gone while "Save draft" shows).
  if (!matches.length && options.labelPrefix && criteria.some((criterion) => criterion.field === "label")) {
    const prefixed = visible.filter((element) => criteria.every((criterion) => (
      criterion.field === "label" ? labelStartsWithWords(element, criterion.value) : matchesCriterion(element, criterion)
    )));
    if (prefixed.length === 1) matches = prefixed;
  }
  // Still nothing, and no element on screen carries that label at all: the
  // caller most likely read an accessibility identifier off the snapshot
  // ("BackButton"), so an EXACT identifier match answers, and says so.
  let note: string | null = null;
  const labelCriterion = criteria.find((criterion) => criterion.field === "label");
  if (!matches.length && labelCriterion && !visible.some((element) => matchesCriterion(element, labelCriterion))) {
    const asIdentifier: QueryCriterion = { field: "identifier", value: labelCriterion.value };
    const byIdentifier = orderMatches(visible.filter((element) => criteria.every((criterion) => (
      criterion === labelCriterion ? matchesCriterion(element, asIdentifier) : matchesCriterion(element, criterion)
    ))));
    if (byIdentifier.length) {
      matches = byIdentifier;
      note = `No element has the label ${JSON.stringify(labelCriterion.value)}; matched it as the accessibility `
        + `identifier instead. Use --identifier ${JSON.stringify(labelCriterion.value)} next time.`;
    }
  }

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

  return { matches, selected: matches[rawIndex] ?? null, reason: null, ...(note ? { note } : {}) };
}
