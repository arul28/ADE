// ---------------------------------------------------------------------------
// Thread entities — ADE things an agent names in plain output.
// ---------------------------------------------------------------------------
//
// Agents write "Lane: `opencode-harness-audit` (`4c90a638-…`)", "Model:
// `claude-opus-5-5`", "the NUL bytes at `agentChatService.ts:10081`, the case
// at `3461-3468`". Every one of those names a real ADE entity, but the
// transcript printed them as grey code. This module finds them so each surface
// can draw the same pill the composer draws (see `chips.ts`).
//
// Design invariants:
//   - **Only real things.** A span becomes a lane or chat chip only when it
//     matches a lane or chat in the index the surface passes in. Unknown ids
//     stay code. A guessed link is worse than no link.
//   - **Pure and synchronous.** No I/O; every surface (desktop, TUI, iOS port)
//     runs the same rules inline, at render time, over agent text.
//   - **Inline code is the strong signal.** Agents put identifiers in
//     backticks. Prose matching is limited to shapes that cannot be ordinary
//     words: full UUIDs, zoned ISO timestamps, `PR #123`, known Linear keys,
//     and the existing `@lane:` / `@model:` / `ade://` tokens.
//   - **Token stays the truth.** A chip built here carries the raw text the
//     agent wrote as its `token`, so a hover always shows the original.

import {
  chipFromDeeplinkTarget,
  chipFromMention,
  chipFromModelMention,
  parseChips,
  type Chip,
} from "./chips";
import { buildDeeplink, type DeeplinkTarget } from "./deeplinks";
import { getModelById, resolveModelDescriptor } from "./modelRegistry";
import { modelPermissionLabel } from "./modelPermissions";

export type ThreadEntityLane = { id: string; name: string };
export type ThreadEntitySession = { id: string };

/** The real ADE state a surface knows. Everything is optional except the lists. */
export type ThreadEntityIndex = {
  lanes: readonly ThreadEntityLane[];
  sessions: readonly ThreadEntitySession[];
  /** Linear team keys this project uses, e.g. `ADE`. Case-insensitive. */
  linearTeamKeys?: readonly string[];
  /** Slash commands and skills this chat can run, without the slash. */
  skillNames?: readonly string[];
};

/** A precomputed lookup. Build once per index change, not once per message. */
export type ThreadEntityLookup = {
  laneById: Map<string, ThreadEntityLane>;
  laneByName: Map<string, ThreadEntityLane>;
  sessionIds: Set<string>;
  /** All lane and session ids, for 8+ character prefix matching. */
  idPrefixes: Array<{ id: string; kind: "lane" | "chat" }>;
  linearTeamKeys: Set<string>;
  skillNames: Set<string>;
};

export type ThreadEntity =
  | { type: "chip"; chip: Chip }
  /**
   * A zoned ISO timestamp, or a same-day range (`2026-10-01T01:52Z–02:24Z`).
   * Surfaces show it in local time; hover shows `raw`.
   */
  | { type: "time"; iso: string; epochMs: number; endEpochMs: number | null; raw: string }
  /** A bare line or line range that refers back to the last file in the block. */
  | { type: "file_line"; path: string; line: number; endLine: number | null; raw: string };

export type ThreadEntityMatch = { start: number; end: number; entity: ThreadEntity };

/** Context a renderer carries through one block (paragraph, list item, cell). */
export type ThreadEntityBlockContext = {
  /** The last file path named in this block, for `3461-3468` follow-ups. */
  lastFilePath: string | null;
};

// Lane names that also mean a git branch or a role. `main` in backticks is far
// more often the branch than the primary lane, so these never chip by name.
const AMBIGUOUS_LANE_NAMES = new Set(["main", "master", "primary", "default", "head", "origin"]);

/** Permission values distinctive enough to chip on sight, with their provider. */
const PERMISSION_TOKENS: Record<string, string> = {
  bypassPermissions: "claude",
  acceptEdits: "claude",
  "full-auto": "opencode",
  "config-toml": "codex",
};

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, "i");
const ID_PREFIX_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{1,4}){0,3}$/i;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const PR_NUMBER_RE = /^#(\d{1,6})$/;
const LINEAR_ID_RE = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$/;
const SKILL_RE = /^\/([a-z][a-z0-9_-]*(?::[a-z0-9_-]+)?)$/i;
// `3461`, `3461-3468`, or the `:201-208` form that echoes a `file:line` anchor.
const LINE_REF_RE = /^:?(\d{1,7})(?:\s*[-–]\s*(\d{1,7}))?$/;
// Date, time with seconds, then Z or an offset. A bare `21:51:57` has no zone,
// so it cannot be converted and is left alone.
const ISO_SOURCE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:?\\d{2})";
// An optional range end on the same date: `…T01:52Z–02:24Z`.
const ISO_RANGE_END_SOURCE = "(?:\\s*[–-]\\s*(\\d{2}:\\d{2}(?::\\d{2})?(?:Z|[+-]\\d{2}:?\\d{2})))?";
const ISO_RE = new RegExp(`^(${ISO_SOURCE})${ISO_RANGE_END_SOURCE}$`);

export function buildThreadEntityLookup(index: ThreadEntityIndex): ThreadEntityLookup {
  const laneById = new Map<string, ThreadEntityLane>();
  const nameCounts = new Map<string, number>();
  for (const lane of index.lanes) {
    laneById.set(lane.id.toLowerCase(), lane);
    const name = lane.name.trim();
    if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const laneByName = new Map<string, ThreadEntityLane>();
  for (const lane of index.lanes) {
    const name = lane.name.trim();
    // Two lanes with one name is no identity; neither chips by name.
    if (name.length < 3 || nameCounts.get(name) !== 1) continue;
    if (AMBIGUOUS_LANE_NAMES.has(name.toLowerCase())) continue;
    laneByName.set(name, lane);
  }
  const sessionIds = new Set(index.sessions.map((session) => session.id.toLowerCase()));
  const idPrefixes: ThreadEntityLookup["idPrefixes"] = [
    ...index.lanes.map((lane) => ({ id: lane.id.toLowerCase(), kind: "lane" as const })),
    ...index.sessions.map((session) => ({ id: session.id.toLowerCase(), kind: "chat" as const })),
  ];
  return {
    laneById,
    laneByName,
    sessionIds,
    idPrefixes,
    linearTeamKeys: new Set((index.linearTeamKeys ?? []).map((key) => key.toUpperCase())),
    skillNames: new Set((index.skillNames ?? []).map((name) => name.toLowerCase())),
  };
}

export const EMPTY_THREAD_ENTITY_LOOKUP: ThreadEntityLookup = buildThreadEntityLookup({ lanes: [], sessions: [] });

function chipEntity(chip: Chip): ThreadEntity {
  return { type: "chip", chip };
}

function withToken(chip: Chip, token: string): Chip {
  return { ...chip, token };
}

function deeplinkChip(target: DeeplinkTarget, token: string): Chip {
  return withToken(chipFromDeeplinkTarget(buildDeeplink(target), target), token);
}

/** A lane or chat id, whole or as a unique 8+ character prefix. */
function resolveId(raw: string, lookup: ThreadEntityLookup): Chip | null {
  const value = raw.toLowerCase();
  if (UUID_RE.test(value)) {
    const lane = lookup.laneById.get(value);
    if (lane) return withToken(chipFromMention("lane", lane.id, lane.name), raw);
    if (lookup.sessionIds.has(value)) return withToken(chipFromMention("chat", value), raw);
    return null;
  }
  if (!ID_PREFIX_RE.test(value)) return null;
  // A prefix names an entity only when exactly one lane or chat starts with it.
  let found: { id: string; kind: "lane" | "chat" } | null = null;
  for (const candidate of lookup.idPrefixes) {
    if (!candidate.id.startsWith(value)) continue;
    if (found && found.id !== candidate.id) return null;
    found = candidate;
  }
  if (!found) return null;
  if (found.kind === "lane") {
    const lane = lookup.laneById.get(found.id);
    return lane ? withToken(chipFromMention("lane", lane.id, lane.name), raw) : null;
  }
  return withToken(chipFromMention("chat", found.id), raw);
}

/**
 * A registry model named by id: `claude-opus-5-5`, `anthropic/claude-opus-5-5`.
 * A bare alias like `opus` also resolves in the registry, but in backticks it
 * is as likely a word as a model, so the code must carry a `-` or `/`.
 */
function resolveModel(raw: string): Chip | null {
  if (!/[-/]/.test(raw) || !/[a-z]/i.test(raw) || /\s/.test(raw)) return null;
  const descriptor = getModelById(raw) ?? resolveModelDescriptor(raw);
  if (!descriptor) return null;
  // An agent naming a model says nothing about thinking or permission, so the
  // label is the model's name alone, not "Claude Opus 5.5 · Default".
  return { ...chipFromModelMention({ modelId: descriptor.id, effort: null, permission: null }, raw), label: descriptor.displayName };
}

function permissionChip(raw: string): Chip | null {
  const provider = PERMISSION_TOKENS[raw];
  if (!provider) return null;
  return {
    kind: "permission",
    token: raw,
    label: modelPermissionLabel(provider, raw),
    source: { origin: "permission", provider, value: raw },
  };
}

function skillChip(raw: string, lookup: ThreadEntityLookup): Chip | null {
  const match = SKILL_RE.exec(raw);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  if (!lookup.skillNames.has(name)) return null;
  return { kind: "skill", token: raw, label: `/${match[1]}`, source: { origin: "skill", name } };
}

function linearChip(raw: string, lookup: ThreadEntityLookup): Chip | null {
  const match = LINEAR_ID_RE.exec(raw);
  if (!match || !lookup.linearTeamKeys.has(match[1]!.toUpperCase())) return null;
  return deeplinkChip({ kind: "linear-issue", issueIdentifier: raw.toUpperCase() }, raw);
}

function timeEntity(raw: string): ThreadEntity | null {
  const match = ISO_RE.exec(raw);
  if (!match) return null;
  const epochMs = Date.parse(match[1]!);
  if (!Number.isFinite(epochMs)) return null;
  let endEpochMs: number | null = null;
  if (match[2]) {
    // The end shares the start's calendar date in ITS zone; a range that
    // crosses midnight (`23:50Z–00:10Z`) ends the next day.
    const datePart = match[1]!.slice(0, 10);
    const parsedEnd = Date.parse(`${datePart}T${match[2]}`);
    if (Number.isFinite(parsedEnd)) endEpochMs = parsedEnd < epochMs ? parsedEnd + 86_400_000 : parsedEnd;
  }
  return { type: "time", iso: new Date(epochMs).toISOString(), epochMs, endEpochMs, raw };
}

/**
 * What one inline code span names, or null when it is just code.
 *
 * `context.lastFilePath` lets a bare `3461-3468` that follows
 * `agentChatService.ts:10081` in the same block open that file at that line.
 * The renderer owns path detection (it already decides which code spans are
 * files), so it records the path into the context; this function only reads it.
 */
export function matchInlineCodeEntity(
  code: string,
  lookup: ThreadEntityLookup,
  context: ThreadEntityBlockContext = { lastFilePath: null },
): ThreadEntity | null {
  const raw = code.trim();
  if (!raw || raw.length > 200 || raw.includes("\n")) return null;

  // An explicit token (`@lane:…`, `@model:…`, an `ade://` link) wins outright,
  // but only when it is the whole span.
  const tokens = parseChips(raw, 2);
  if (tokens.length === 1 && tokens[0]!.start === 0 && tokens[0]!.end === raw.length) {
    const { start: _start, end: _end, ...chip } = tokens[0]!;
    return chipEntity(chip);
  }

  const id = resolveId(raw, lookup);
  if (id) return chipEntity(id);

  const lane = lookup.laneByName.get(raw);
  if (lane) return chipEntity(withToken(chipFromMention("lane", lane.id, lane.name), raw));

  const permission = permissionChip(raw);
  if (permission) return chipEntity(permission);

  const pr = PR_NUMBER_RE.exec(raw);
  if (pr) return chipEntity(deeplinkChip({ kind: "pr", prNumber: Number(pr[1]) }, raw));

  const skill = skillChip(raw, lookup);
  if (skill) return chipEntity(skill);

  const linear = linearChip(raw, lookup);
  if (linear) return chipEntity(linear);

  const time = timeEntity(raw);
  if (time) return time;

  const lineRef = LINE_REF_RE.exec(raw);
  if (lineRef) {
    if (!context.lastFilePath) return null;
    const line = Number(lineRef[1]);
    const endLine = lineRef[2] ? Number(lineRef[2]) : null;
    if (line < 1 || (endLine !== null && endLine < line)) return null;
    return { type: "file_line", path: context.lastFilePath, line, endLine, raw };
  }

  // A commit needs a letter AND a digit: all-digit spans are numbers, and
  // all-letter spans (`deadbeef`, `cafe`) are words far more often than SHAs.
  // Exactly 8 hex characters is the short form of a lane or chat id, so an
  // unresolved one stays code rather than becoming a commit that does not exist.
  if (SHA_RE.test(raw) && raw.length !== 8 && /\d/.test(raw) && /[a-f]/.test(raw)) {
    return chipEntity(deeplinkChip({ kind: "commit", sha: raw }, raw));
  }

  const model = resolveModel(raw);
  if (model) return chipEntity(model);

  return null;
}

// Prose shapes. Each is anchored on both sides so it never matches inside a
// longer word, path or URL.
const PROSE_UUID_RE = new RegExp(`(?<![\\w/.-])${UUID_SOURCE}(?![\\w/-])`, "gi");
const PROSE_ISO_RE = new RegExp(`(?<![\\w-])${ISO_SOURCE}${ISO_RANGE_END_SOURCE}(?![\\w:])`, "g");
const PROSE_PR_RE = /\b(?:PR|pull request)\s+(#\d{1,6})\b/gi;
const PROSE_LINEAR_RE = /(?<![\w/#-])([A-Za-z][A-Za-z0-9]{0,9}-\d{1,9})(?![\w-])/g;

/**
 * Entities in plain prose (text outside code), in document order, with no
 * overlaps. Narrower than `matchInlineCodeEntity` on purpose — see the header.
 */
export function findProseEntities(text: string, lookup: ThreadEntityLookup): ThreadEntityMatch[] {
  if (!text) return [];
  const matches: ThreadEntityMatch[] = [];

  // Explicit tokens. Path mentions are left to the code path: in agent prose
  // an `@` before a word is a handle far more often than a file pick.
  for (const match of parseChips(text)) {
    if (match.kind === "file" || match.kind === "folder" || match.kind === "web_page") continue;
    const { start, end, ...chip } = match;
    matches.push({ start, end, entity: chipEntity(chip) });
  }

  for (const match of text.matchAll(PROSE_UUID_RE)) {
    const chip = resolveId(match[0], lookup);
    if (chip) matches.push({ start: match.index!, end: match.index! + match[0].length, entity: chipEntity(chip) });
  }

  for (const match of text.matchAll(PROSE_ISO_RE)) {
    const time = timeEntity(match[0]);
    if (time) matches.push({ start: match.index!, end: match.index! + match[0].length, entity: time });
  }

  for (const match of text.matchAll(PROSE_PR_RE)) {
    const number = match[1]!;
    const start = match.index! + match[0].length - number.length;
    matches.push({
      start,
      end: start + number.length,
      entity: chipEntity(deeplinkChip({ kind: "pr", prNumber: Number(number.slice(1)) }, number)),
    });
  }

  if (lookup.linearTeamKeys.size > 0) {
    for (const match of text.matchAll(PROSE_LINEAR_RE)) {
      const chip = linearChip(match[1]!, lookup);
      if (chip) matches.push({ start: match.index!, end: match.index! + match[1]!.length, entity: chipEntity(chip) });
    }
  }

  matches.sort((a, b) => a.start - b.start);
  const out: ThreadEntityMatch[] = [];
  let consumedTo = -1;
  for (const match of matches) {
    if (match.start < consumedTo) continue;
    out.push(match);
    consumedTo = match.end;
  }
  return out;
}

/** The Linear team key of an issue identifier (`ADE` for `ADE-159`), or null. */
export function linearTeamKeyFromIdentifier(identifier: string | null | undefined): string | null {
  const match = identifier ? LINEAR_ID_RE.exec(identifier.trim()) : null;
  return match ? match[1]!.toUpperCase() : null;
}

const TIME_SAME_DAY = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const TIME_OTHER_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const TIME_RANGE = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const TIME_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/**
 * A zoned timestamp (or same-day range) in the reader's local time, the one
 * format every surface shows: "1:20:04 AM" today, "Sep 30, 10:24 PM" on
 * another day, "Sep 30, 9:52 – 10:24 PM" for a range.
 */
export function formatThreadEntityTimestamp(
  epochMs: number,
  endEpochMs: number | null = null,
  now: number = Date.now(),
): string {
  const date = new Date(epochMs);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (endEpochMs != null) {
    const range = TIME_RANGE.formatRange(date, new Date(endEpochMs));
    return sameDay ? range : `${TIME_DAY.format(date)}, ${range}`;
  }
  return (sameDay ? TIME_SAME_DAY : TIME_OTHER_DAY).format(date);
}

/** Stable identity for "these two chips point at the same thing". */
export function threadEntityKey(entity: ThreadEntity): string | null {
  if (entity.type !== "chip") return null;
  const source = entity.chip.source;
  if (source.origin === "mention") return `${source.mentionKind}:${source.id.toLowerCase()}`;
  return null;
}
