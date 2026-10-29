import {
  AGENT_CHAT_WORKFLOW_TEXT_MAX_CHARS,
  type AgentChatEvent,
  type AgentChatEventEnvelope,
  type AgentChatSubagentTranscriptMessage,
  type AgentChatWorkflowProgress,
} from "./types/chat";
import { modelMentionEffortLabel } from "./modelMentions";
import { resolveModelDescriptor } from "./modelRegistry";
import { humanizeAgentIdentity } from "./agentIdentity";

export type SubagentSnapshot = {
  id: string;
  name: string;
  kind: "subagent" | "teammate";
  status: "running" | "completed" | "failed" | "stopped";
  summary: string;
  parentToolUseId?: string | null;
  parentAgentId?: string | null;
  provider?: string | null;
  turnId?: string | null;
  label?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  background?: boolean;
  taskType?: "subagent" | "background" | "local_workflow" | "cron" | "other";
  workflowName?: string;
  workflowProgress?: AgentChatWorkflowProgress;
  startedAt?: string | null;
  endedAt?: string | null;
  tokens?: number;
  /** Tool invocations the subagent made (Codex/OpenCode report this). */
  toolUses?: number;
  /** USD cost when the runtime reports a per-subagent figure (OpenCode). */
  costUsd?: number;
  durationMs?: number;
  lastToolName?: string;
  /** A spawned ADE chat behind this row is waiting on the user (from the session roster). */
  needsYou?: boolean;
};

const SUBAGENT_TASK_TYPES = new Set<NonNullable<SubagentSnapshot["taskType"]>>([
  "subagent",
  "background",
  "local_workflow",
  "cron",
  "other",
]);

/** True for the quiet spawn notice whose inline card already carries its announcement. */
export function isInlineCardSpawnNotice(
  event: unknown,
): boolean {
  if (!isRecord(event) || event.type !== "system_notice" || event.status !== "subagent_spawned") return false;
  return isRecord(event.detail) && event.detail.hasInlineCard === true;
}

function normalizeSubagentTaskType(value: unknown): SubagentSnapshot["taskType"] | undefined {
  return typeof value === "string" && SUBAGENT_TASK_TYPES.has(value as NonNullable<SubagentSnapshot["taskType"]>)
    ? value as SubagentSnapshot["taskType"]
    : undefined;
}

// iOS mirrors these caps, the pane storage-key/empty-state shapes, and the
// section-hint format in WorkChatRichCardViews.swift (WorkChatInfoDetailsSheet)
// — keep the twins in sync when changing any of them.
export const SUBAGENTS_ACTIVE_CAP = 12;
export const BACKGROUND_ACTIVE_CAP = 8;
export const SCHEDULE_ACTIVE_CAP = 10;
const MAX_WORKFLOW_AGENT_ENTRIES = 300;
const MAX_WORKFLOW_PHASE_ENTRIES = 50;
// The main-process preview clip keeps 240 source characters and appends one
// ellipsis character, so the stored boundary is one character wider.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length <= AGENT_CHAT_WORKFLOW_TEXT_MAX_CHARS;
}

function isWorkflowAgent(value: unknown): value is AgentChatWorkflowProgress["agents"][number] {
  if (!isRecord(value)) return false;
  if (
    !isBoundedString(value.key)
    || !isNonNegativeSafeInteger(value.index)
    || !isBoundedString(value.name)
    || (value.status !== "running" && value.status !== "completed" && value.status !== "failed" && value.status !== "stopped")
    || !isBoundedString(value.summary)
  ) return false;
  for (const key of ["agentId", "agentType", "model", "phaseTitle", "lastToolName", "lastActivityAt"] as const) {
    if (value[key] !== undefined && !isBoundedString(value[key])) return false;
  }
  for (const key of ["tokens", "toolCalls", "durationMs"] as const) {
    if (value[key] !== undefined && !isFiniteNonNegativeNumber(value[key])) return false;
  }
  return true;
}

/**
 * Runtime guard for workflow telemetry crossing a stored-event or remote
 * client boundary. The main-process parser clips and caps provider input, but
 * older history and paired clients can still hand the renderer an arbitrary
 * object. Keep malformed telemetry inert instead of letting it crash the chat
 * pane while preserving the ordinary subagent row.
 */
export function isAgentChatWorkflowProgress(value: unknown): value is AgentChatWorkflowProgress {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.phases) || value.phases.length > MAX_WORKFLOW_PHASE_ENTRIES) return false;
  if (!Array.isArray(value.agents) || value.agents.length > MAX_WORKFLOW_AGENT_ENTRIES) return false;
  if (!value.phases.every((phase) => (
    isRecord(phase)
    && isNonNegativeSafeInteger(phase.index)
    && isBoundedString(phase.title)
  ))) return false;
  if (!value.agents.every(isWorkflowAgent)) return false;
  return ["queuedCount", "runningCount", "doneCount", "failedCount"].every((key) => (
    isFiniteNonNegativeNumber(value[key])
  ));
}

export type PaneSectionKey = "progress" | "tasks" | "subagents" | "shells" | "background" | "schedule";

export function groupPaneSectionItems<T>(items: T[], opts: {
  isEarlier: (item: T) => boolean;
  isCleared: (item: T) => boolean;
  isPinned: (item: T) => boolean;
}): { active: T[]; earlier: T[]; clearedCount: number } {
  const active: T[] = [];
  const earlier: T[] = [];
  let clearedCount = 0;

  for (const item of items) {
    if (opts.isPinned(item)) {
      active.push(item);
    } else if (opts.isCleared(item)) {
      clearedCount += 1;
    } else if (opts.isEarlier(item)) {
      earlier.push(item);
    } else {
      active.push(item);
    }
  }

  return { active, earlier, clearedCount };
}

export function capPaneSectionItems<T>(
  items: T[],
  cap: number,
  isExempt: (item: T) => boolean,
): { visible: T[]; hiddenCount: number } {
  if (items.length <= cap) return { visible: items, hiddenCount: 0 };
  const visible = items.filter((item, index) => index < cap || isExempt(item));
  return { visible, hiddenCount: items.length - visible.length };
}

export function isEarlierSubagentSnapshot(snapshot: Pick<SubagentSnapshot, "status">): boolean {
  return snapshot.status === "completed" || snapshot.status === "stopped";
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const SUBAGENT_MODEL_INHERITED_SUFFIX = "inherited";

export type SubagentModelAttribution = {
  label: string;
  inherited: boolean;
  /** The effort the child reported ("Medium"); null when it reported none. */
  effortLabel?: string | null;
};

/** Pretty-print a reported subagent model id. Does not invent a parent fallback. */
export function formatSubagentModelLabel(model: string | null | undefined): string | null {
  const raw = textField(model);
  if (!raw) return null;
  return resolveModelDescriptor(raw)?.displayName ?? raw;
}

/**
 * Display-only attribution for Chat Info header/roster chips.
 * A reported snapshot model is ground truth. Missing model falls back to the
 * parent session label and is marked inherited — never written onto the envelope.
 */
export function subagentModelAttribution(args: {
  snapshotModel?: string | null;
  sessionModelLabel?: string | null;
  /** The effort the child reported. A parent's effort is never shown as the child's. */
  reasoningEffort?: string | null;
}): SubagentModelAttribution | null {
  const effort = textField(args.reasoningEffort);
  const effortLabel = effort ? modelMentionEffortLabel(effort) : null;
  const reported = formatSubagentModelLabel(args.snapshotModel);
  if (reported) return { label: reported, inherited: false, ...(effortLabel ? { effortLabel } : {}) };
  const session = formatSubagentModelLabel(args.sessionModelLabel);
  if (!session) return null;
  return { label: session, inherited: true, ...(effortLabel ? { effortLabel } : {}) };
}

export function formatSubagentModelChip(attribution: SubagentModelAttribution | null): string | null {
  if (!attribution) return null;
  const effort = attribution.effortLabel ? ` · ${attribution.effortLabel}` : "";
  return attribution.inherited
    ? `${attribution.label}${effort} · ${SUBAGENT_MODEL_INHERITED_SUFFIX}`
    : `${attribution.label}${effort}`;
}

export function subagentAgentKey(event: { agentId?: string | null; taskId?: string | null }): string | null {
  const taskId = textField(event.taskId);
  // A spawned ADE chat's stable id is `chat:<sessionId>`. Resume events repeat
  // a short agentId (`cli-child`); the card key stays on the chat id so the
  // same row reopens.
  if (taskId?.startsWith("chat:")) return taskId;
  return textField(event.agentId) ?? taskId;
}

/**
 * Collapses the legacy `subagent_result` + `subagent.completed` PAIR that old
 * transcripts contain.
 *
 * The host used to commit both for every subagent end. It now commits only
 * `subagent_result`, but replayed history still carries pairs, and a client
 * that reads both counts one finished subagent twice — a duplicate timeline
 * row, a doubled "n agents" rollup, a status that flips as the second copy
 * lands. Collapsing is keyed on the agent identity (`agentId`, falling back to
 * `taskId`), which is what the two halves of a pair share.
 *
 * Only the `subagent.completed` half is ever dropped, and only when a
 * `subagent_result` for the same agent exists somewhere in the same list. Two
 * genuine end events for one agent — a stopped result at teardown after an
 * earlier completion, say — are both `subagent_result` and both survive.
 */
export function collapseLegacySubagentEndEvents<T>(
  entries: T[],
  eventOf: (entry: T) => AgentChatEvent,
): T[] {
  const canonicalEndAgentKeys = new Set<string>();
  for (const entry of entries) {
    const event = eventOf(entry);
    if (event.type !== "subagent_result") continue;
    const agentKey = subagentAgentKey(event);
    if (agentKey) canonicalEndAgentKeys.add(agentKey);
  }
  // Nothing to collapse: hand back the same array rather than a copy. This is
  // the overwhelmingly common case (modern transcripts have no pairs), and it
  // runs on every transcript render.
  if (canonicalEndAgentKeys.size === 0) return entries;
  return entries.filter((entry) => {
    const event = eventOf(entry);
    if (event.type !== "subagent.completed") return true;
    const agentKey = subagentAgentKey(event);
    return !agentKey || !canonicalEndAgentKeys.has(agentKey);
  });
}

/**
 * Filler a runtime writes where no report exists: Claude's "Status: …" /
 * "Task updated" ticks and Codex's `subAgentActivity` lines ("Agent active",
 * "Agent received input") plus its fallback terminal words ("Agent completed").
 * None of these is ever a report — never shown or stored as one.
 */
export const SUBAGENT_PLACEHOLDER_SUMMARY =
  /^(status:\s|task updated$|agent (active|received input|started|running|completed|finished|stopped|failed|interrupted)[.!]*$)/i;

/** True when `value` is empty or runtime filler rather than something the agent wrote. */
export function isSubagentPlaceholderSummary(value: string | null | undefined): boolean {
  const text = value?.trim();
  return !text || SUBAGENT_PLACEHOLDER_SUMMARY.test(text);
}

export function preferSubagentSummary(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const current = textField(existing);
  const next = textField(incoming);
  if (!current) return next;
  if (!next) return current;

  const currentIsPlaceholder = SUBAGENT_PLACEHOLDER_SUMMARY.test(current);
  const nextIsPlaceholder = SUBAGENT_PLACEHOLDER_SUMMARY.test(next);
  if (currentIsPlaceholder !== nextIsPlaceholder) {
    return currentIsPlaceholder ? next : current;
  }
  if (currentIsPlaceholder) return next;
  return next.length >= current.length ? next : current;
}

const TERMINAL_PUNCTUATION = /[.!?:;,…]$/;

/** Inline markdown → its visible text: links, images, code spans, emphasis. */
function plainInlineMarkdown(line: string): string {
  // Code spans keep their text verbatim (`__init__.py` is not emphasis), so
  // they are set aside before the emphasis passes and put back after.
  const codeSpans: string[] = [];
  const withoutCode = line.replace(/(`+)([^`]*?)\1/g, (_match, _ticks: string, code: string) => {
    codeSpans.push(code.trim());
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  return withoutCode
    // ![alt](src) → alt; [text](href) and [text][ref] → text.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    // <https://…> autolinks keep the URL; other simple tags drop.
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, "")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?![\w_])/g, "$1$2")
    // A preview clipped mid-span leaves an unmatched marker behind.
    .replace(/\*\*|~~|`/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? "");
}

/**
 * A subagent's report reduced to one plain-text paragraph for a clamped card
 * or pane line. Reports are markdown (`## Summary`, `**ADE** is…`, bullets,
 * fences, links); a three-line preview has no room for block layout, and
 * raw markers read as noise. Headings, list and quote markers, rules, and
 * fence lines drop; emphasis and code spans keep their text; a link keeps
 * its text. Lines join with a space, a heading or list item that ends
 * without punctuation gets `:` / `;` so the run still reads as prose.
 * Returns null for empty input. Presentation only; the report is unchanged.
 */
export function subagentSummaryPlainText(value: string | null | undefined): string | null {
  if (!value) return null;
  // A card asks for the same report on every render, and a whole report costs
  // a dozen regex passes per line.
  const known = subagentSummaryPlainTextCache.get(value);
  if (known !== undefined) return known;
  const plain = reduceSubagentSummaryToPlainText(value);
  if (subagentSummaryPlainTextCache.size >= SUBAGENT_SUMMARY_PLAIN_TEXT_CACHE_LIMIT) {
    subagentSummaryPlainTextCache.clear();
  }
  subagentSummaryPlainTextCache.set(value, plain);
  return plain;
}

const SUBAGENT_SUMMARY_PLAIN_TEXT_CACHE_LIMIT = 256;
const subagentSummaryPlainTextCache = new Map<string, string | null>();

/**
 * Plain text past this is never shown: the card is one line and the pane three.
 * A long report (hundreds of KB from some providers) stops being read here.
 */
const SUBAGENT_SUMMARY_MAX_PLAIN_CHARS = 1_000;

function reduceSubagentSummaryToPlainText(value: string): string | null {
  const parts: string[] = [];
  let produced = 0;
  let pendingSeparator: string | null = null;
  const lineBreak = /\r\n?|\n/g;
  let lineStart = 0;
  while (lineStart <= value.length && produced < SUBAGENT_SUMMARY_MAX_PLAIN_CHARS) {
    const match = lineBreak.exec(value);
    const rawLine = value.slice(lineStart, match ? match.index : value.length);
    lineStart = match ? match.index + match[0].length : value.length + 1;
    let line = rawLine.trim();
    // Fence lines, horizontal rules, and table separator rows carry no text.
    if (/^(`{3,}|~{3,})/.test(line)) continue;
    if (/^([-*_])(\s*\1){2,}$/.test(line)) continue;
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) continue;
    let kind: "heading" | "item" | "text" = "text";
    const heading = /^#{1,6}(?:\s+(.*?))?(?:\s+#+)?$/.exec(line);
    if (heading) {
      line = heading[1] ?? "";
      kind = "heading";
    }
    line = line.replace(/^(>\s?)+/, "");
    const item = /^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (item) {
      line = item[1]!;
      kind = "item";
    }
    if (line.startsWith("|") || line.endsWith("|")) {
      // A table row reads as its cells; rows separate like list items.
      line = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()).filter(Boolean).join(" · ");
      kind = "item";
    }
    line = plainInlineMarkdown(line).replace(/\s+/g, " ").trim();
    if (!line) continue;
    // One long line stops at the budget too, separator included.
    const separator = parts.length ? pendingSeparator ?? " " : "";
    line = line.slice(0, Math.max(0, SUBAGENT_SUMMARY_MAX_PLAIN_CHARS - produced - separator.length));
    if (!line) break;
    if (separator) parts.push(separator);
    parts.push(line);
    produced += separator.length + line.length;
    pendingSeparator = kind !== "text" && !TERMINAL_PUNCTUATION.test(line)
      ? (kind === "heading" ? ": " : "; ")
      : null;
  }
  const text = parts.join("").trim();
  return text || null;
}

type SubagentClassificationInput = {
  taskType?: string | null;
  agentType?: string | null;
  command?: string | null;
  description?: string | null;
};

export function isBackgroundShellCommand(input: SubagentClassificationInput): boolean {
  const taskType = textField(input.taskType);
  const agentType = textField(input.agentType);
  // The Claude Agent SDK tags a `Bash` run_in_background shell with task_type
  // "local_bash" (older builds said "background"). Either one, with no real
  // subagent agentType, is a background shell — it belongs in the background
  // pane, never the subagent roster.
  return (taskType === "background" || taskType === "local_bash")
    && (!agentType || agentType === "background");
}

export function isRealSubagent(input: SubagentClassificationInput): boolean {
  if (isBackgroundShellCommand(input)) return false;
  const taskType = textField(input.taskType);
  const agentType = textField(input.agentType);
  return Boolean(
    (agentType && agentType !== "background")
      || taskType === "subagent"
      || taskType === "local_workflow",
  );
}

/**
 * An explicit task_type "other" with no agent metadata (no agentType, no
 * agentId, no stashed Task/Agent tool input) is a plain Claude Code task run —
 * e.g. "Re-run affected test files" — not a subagent, so it must never surface
 * subagent rows. Shared so the idle-turn and foreground task_started handlers
 * classify identically; keeping this in one place is what stops the two paths
 * from drifting apart. A bare task_started with no task_type stays a subagent
 * for back-compat.
 */
export function isNonAgentTaskRun(input: {
  taskType?: string | null;
  agentType?: string | null;
  agentId?: string | null;
  hasStashedToolInput?: boolean;
}): boolean {
  const taskType = textField(input.taskType);
  const hasAgentMetadata = Boolean(
    textField(input.agentType)
      || textField(input.agentId)
      || input.hasStashedToolInput
      || taskType === "subagent"
      || taskType === "local_workflow",
  );
  return taskType === "other" && !hasAgentMetadata;
}

type SubagentTimelineStatus = "running" | "completed" | "stopped" | "failed";
type SubagentTimelineTerminalStatus = Exclude<SubagentTimelineStatus, "running">;

export type SubagentTimelineRow =
  | {
      kind: "spawn";
      agentKey: string;
      description: string;
      agentType: string | null;
      background: boolean;
      status: SubagentTimelineStatus;
      statusLine: string | null;
      lastToolName: string | null;
      toolCount: number | null;
      startedAtEventIndex: number;
    }
  | {
      kind: "result";
      agentKey: string;
      status: SubagentTimelineTerminalStatus;
      summary: string | null;
      resultAtEventIndex: number;
    }
  | {
      kind: "background_chip";
      agentKey: string;
      label: string;
      status: SubagentTimelineTerminalStatus;
      settledAtEventIndex: number;
    };

type SubagentTimelineSpawnRow = Extract<SubagentTimelineRow, { kind: "spawn" }>;
type SubagentTimelineResultRow = Extract<SubagentTimelineRow, { kind: "result" }>;
type SubagentTimelineBackgroundRow = Extract<SubagentTimelineRow, { kind: "background_chip" }>;

type SubagentTimelineState = {
  agentKey: string;
  aliases: Set<string>;
  firstSeenEventIndex: number;
  firstLifecycleEventIndex: number | null;
  description: string | null;
  agentType: string | null;
  taskType: string | null;
  command: string | null;
  background: boolean;
  progressSummary: string | null;
  lastProgressEventIndex: number;
  lastResultEventIndex: number;
  lastSettledEventIndex: number;
  spawn: SubagentTimelineSpawnRow | null;
  result: SubagentTimelineResultRow | null;
  backgroundChip: SubagentTimelineBackgroundRow | null;
};

export function longerSubagentText(existing: string | null, incoming: string | null): string | null {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return incoming.length > existing.length ? incoming : existing;
}

export function preferredSubagentAgentType(
  existing: string | null,
  incoming: string | null,
): string | null {
  if (!incoming) return existing;
  if (!existing || (existing === "background" && incoming !== "background")) return incoming;
  return existing;
}

export { humanizeAgentIdentity, type AgentIdentityLabel } from "./agentIdentity";

/**
 * Values runtimes stamp where no real name exists: placeholder agent types
 * (legacy OpenCode, the bare word "subagent") and the collapse pass's own
 * fallbacks for a spawn with no description.
 */
const GENERIC_SUBAGENT_NAMES: ReadonlySet<string> = new Set([
  "agent",
  "background",
  "background work",
  "delegated task",
  "opencode-subagent",
  "subagent",
  "subagent task",
  "task",
]);

/** True for a placeholder a runtime stamps where no real name exists. */
export function isGenericSubagentName(value: string | null | undefined): boolean {
  const raw = value?.trim();
  return !raw || GENERIC_SUBAGENT_NAMES.has(raw.toLowerCase());
}

/**
 * An internal id rather than words: a path (`/root/desktop_scan`) or a single
 * snake_case token (`desktop_scan`). Anything with a space is prose and is
 * shown as written.
 */
function isAgentIdentifierLike(value: string): boolean {
  if (/\s/.test(value)) return false;
  return /[/\\]/.test(value) || value.includes("_");
}

/**
 * OpenCode titles a child session with the agent it runs appended:
 * `Explore renderer UI (@explore subagent)`. The card already says it is a
 * subagent, and the suffix is what truncates, so it is dropped: a trailing
 * `(@<agent> subagent)` or `(@<agent>)`.
 */
const AGENT_MENTION_SUFFIX = /\s*\(@[^()\s]+(?:\s+subagent)?\)\s*$/i;

function stripAgentMentionSuffix(value: string): string {
  return value.replace(AGENT_MENTION_SUFFIX, "").trim();
}

function subagentNameCandidate(value: string | null | undefined): string | null {
  const raw = value ? stripAgentMentionSuffix(value.trim()) : null;
  if (!raw || isGenericSubagentName(raw)) return null;
  if (!isAgentIdentifierLike(raw)) return raw;
  const identity = humanizeAgentIdentity(raw);
  if (!identity) return null;
  return identity.ref ? `${identity.label} ${identity.ref}` : identity.label;
}

export type SubagentCardNameInput = {
  description?: string | null;
  label?: string | null;
  agentType?: string | null;
};

/**
 * The human name an inline subagent card is titled with. Same rule for every
 * provider; the first candidate that yields a name wins:
 *
 * 1. `description` — Claude's Task description, OpenCode's session title,
 *    Cursor's and Droid's task description, and for Codex the agent path the
 *    parent chose (`/root/desktop_scan`).
 * 2. `label` — the explicit display name when the description is missing or a
 *    placeholder: Claude's Task `name`, a Codex nickname, Cursor's label.
 * 3. `agentType` — Claude's `subagent_type` (`Explore`), a Codex path.
 *
 * A path or snake_case id is humanized from its last segment
 * (`/root/desktop_scan` -> `Desktop scan`, `/ROOT/SHIP_POLL_927` ->
 * `Ship poll #927`), so a raw `/root/...` path is never the title. A trailing
 * OpenCode agent mention (`(@explore subagent)`, `(@explore)`) is dropped.
 * Generic placeholders are skipped. Nothing usable reads "Subagent".
 */
export function deriveSubagentCardName(input: SubagentCardNameInput): string {
  return subagentNameCandidate(input.description)
    ?? subagentNameCandidate(input.label)
    ?? subagentNameCandidate(input.agentType)
    ?? "Subagent";
}

function removeTimelineRow(rows: SubagentTimelineRow[], row: SubagentTimelineRow | null): void {
  if (!row) return;
  const index = rows.indexOf(row);
  if (index >= 0) rows.splice(index, 1);
}

export function deriveSubagentTimelineRows(rawEvents: AgentChatEvent[]): SubagentTimelineRow[] {
  const events = collapseLegacySubagentEndEvents(rawEvents, (event) => event);
  const rows: SubagentTimelineRow[] = [];
  const statesByAlias = new Map<string, SubagentTimelineState>();

  const setAgentKey = (state: SubagentTimelineState, agentKey: string): void => {
    state.agentKey = agentKey;
    if (state.spawn) state.spawn.agentKey = agentKey;
    if (state.result) state.result.agentKey = agentKey;
    if (state.backgroundChip) state.backgroundChip.agentKey = agentKey;
  };

  const mergeStates = (
    left: SubagentTimelineState,
    right: SubagentTimelineState,
  ): SubagentTimelineState => {
    if (left === right) return left;
    const primary = left.firstSeenEventIndex <= right.firstSeenEventIndex ? left : right;
    const secondary = primary === left ? right : left;
    primary.firstSeenEventIndex = Math.min(primary.firstSeenEventIndex, secondary.firstSeenEventIndex);
    if (secondary.firstLifecycleEventIndex != null) {
      primary.firstLifecycleEventIndex = primary.firstLifecycleEventIndex == null
        ? secondary.firstLifecycleEventIndex
        : Math.min(primary.firstLifecycleEventIndex, secondary.firstLifecycleEventIndex);
    }
    primary.description = longerSubagentText(primary.description, secondary.description);
    primary.agentType = preferredSubagentAgentType(primary.agentType, secondary.agentType);
    primary.taskType = primary.taskType ?? secondary.taskType;
    primary.command = longerSubagentText(primary.command, secondary.command);
    primary.background = primary.background || secondary.background;
    primary.progressSummary = preferSubagentSummary(primary.progressSummary, secondary.progressSummary);

    if (!primary.spawn && secondary.spawn) {
      primary.spawn = secondary.spawn;
    } else if (primary.spawn && secondary.spawn) {
      primary.spawn.description = longerSubagentText(primary.spawn.description, secondary.spawn.description) ?? "Subagent task";
      primary.spawn.agentType = preferredSubagentAgentType(primary.spawn.agentType, secondary.spawn.agentType);
      primary.spawn.background = primary.spawn.background || secondary.spawn.background;
      primary.spawn.startedAtEventIndex = Math.min(
        primary.spawn.startedAtEventIndex,
        secondary.spawn.startedAtEventIndex,
      );
      if (secondary.lastProgressEventIndex > primary.lastProgressEventIndex) {
        primary.spawn.lastToolName = secondary.spawn.lastToolName;
        primary.spawn.toolCount = secondary.spawn.toolCount;
      }
      removeTimelineRow(rows, secondary.spawn);
    }
    if (!primary.result && secondary.result) {
      primary.result = secondary.result;
    } else if (primary.result && secondary.result) {
      primary.result.summary = preferSubagentSummary(primary.result.summary, secondary.result.summary);
      primary.result.resultAtEventIndex = Math.min(
        primary.result.resultAtEventIndex,
        secondary.result.resultAtEventIndex,
      );
      if (secondary.lastResultEventIndex > primary.lastResultEventIndex) {
        primary.result.status = secondary.result.status;
      }
      removeTimelineRow(rows, secondary.result);
    }
    if (!primary.backgroundChip && secondary.backgroundChip) {
      primary.backgroundChip = secondary.backgroundChip;
    } else if (primary.backgroundChip && secondary.backgroundChip) {
      primary.backgroundChip.label = longerSubagentText(
        primary.backgroundChip.label,
        secondary.backgroundChip.label,
      ) ?? "Background command";
      primary.backgroundChip.settledAtEventIndex = Math.min(
        primary.backgroundChip.settledAtEventIndex,
        secondary.backgroundChip.settledAtEventIndex,
      );
      if (secondary.lastSettledEventIndex > primary.lastSettledEventIndex) {
        primary.backgroundChip.status = secondary.backgroundChip.status;
      }
      removeTimelineRow(rows, secondary.backgroundChip);
    }

    primary.lastProgressEventIndex = Math.max(primary.lastProgressEventIndex, secondary.lastProgressEventIndex);
    primary.lastResultEventIndex = Math.max(primary.lastResultEventIndex, secondary.lastResultEventIndex);
    primary.lastSettledEventIndex = Math.max(primary.lastSettledEventIndex, secondary.lastSettledEventIndex);
    for (const alias of secondary.aliases) {
      primary.aliases.add(alias);
      statesByAlias.set(alias, primary);
    }
    setAgentKey(primary, primary.agentKey);
    return primary;
  };

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const originalEvent = events[eventIndex]!;
    const event = normalizeSubagentLifecycleEvent(originalEvent);
    if (!event) continue;

    const taskId = textField(event.taskId);
    const agentId = textField(event.agentId);
    const initialKey = subagentAgentKey(event);
    if (!initialKey) continue;

    const taskState = taskId ? statesByAlias.get(taskId) : undefined;
    const agentState = agentId ? statesByAlias.get(agentId) : undefined;
    let state = taskState && agentState && taskState !== agentState
      ? mergeStates(taskState, agentState)
      : agentState ?? taskState;
    if (!state) {
      state = {
        agentKey: initialKey,
        aliases: new Set(),
        firstSeenEventIndex: eventIndex,
        firstLifecycleEventIndex: null,
        description: null,
        agentType: null,
        taskType: null,
        command: null,
        background: false,
        progressSummary: null,
        lastProgressEventIndex: -1,
        lastResultEventIndex: -1,
        lastSettledEventIndex: -1,
        spawn: null,
        result: null,
        backgroundChip: null,
      };
    }

    for (const alias of [taskId, agentId]) {
      if (!alias) continue;
      state.aliases.add(alias);
      statesByAlias.set(alias, state);
    }
    if (agentId) setAgentKey(state, agentId);

    const lifecycleRecord = event as NormalizedSubagentLifecycleEvent & {
      background?: unknown;
      description?: unknown;
    };
    const eventRecord = originalEvent as AgentChatEvent & { command?: unknown; description?: unknown };
    state.description = longerSubagentText(
      state.description,
      textField(lifecycleRecord.description ?? eventRecord.description),
    );
    state.agentType = preferredSubagentAgentType(state.agentType, textField(event.agentType));
    state.taskType = textField(event.taskType) ?? state.taskType;
    state.command = longerSubagentText(state.command, textField(eventRecord.command));
    state.background = state.background || lifecycleRecord.background === true;

    const backgroundShell = isBackgroundShellCommand(state);
    const realSubagent = isRealSubagent(state);
    if (backgroundShell) {
      removeTimelineRow(rows, state.spawn);
      removeTimelineRow(rows, state.result);
      state.spawn = null;
      state.result = null;
    }

    if (event.type === "subagent_started" || event.type === "subagent_progress") {
      state.firstLifecycleEventIndex ??= eventIndex;
      if (!realSubagent) continue;
      if (event.type === "subagent_progress" && state.lastResultEventIndex >= 0) continue;
      if (!state.spawn) {
        state.spawn = {
          kind: "spawn",
          agentKey: state.agentKey,
          description: state.description ?? "Subagent task",
          agentType: state.agentType,
          background: state.background,
          status: state.result?.status ?? "running",
          statusLine: state.description ?? null,
          lastToolName: null,
          toolCount: null,
          startedAtEventIndex: state.firstLifecycleEventIndex,
        };
        rows.push(state.spawn);
      } else {
        state.spawn.description = state.description ?? state.spawn.description;
        state.spawn.agentType = state.agentType ?? state.spawn.agentType;
        state.spawn.background = state.spawn.background || state.background;
      }

      if (event.type === "subagent_progress") {
        state.lastProgressEventIndex = eventIndex;
        state.spawn.status = "running";
        state.progressSummary = preferSubagentSummary(state.progressSummary, event.summary);
        const lastToolName = textField(event.lastToolName);
        if (lastToolName) state.spawn.lastToolName = lastToolName;
        if (typeof event.usage?.toolUses === "number") state.spawn.toolCount = event.usage.toolUses;
        const meaningfulSummary = state.progressSummary
          && !SUBAGENT_PLACEHOLDER_SUMMARY.test(state.progressSummary)
          ? state.progressSummary
          : null;
        state.spawn.statusLine = meaningfulSummary
          ?? state.spawn.lastToolName
          ?? state.spawn.description;
      } else if (!state.progressSummary) {
        state.spawn.statusLine = state.spawn.lastToolName ?? state.spawn.description;
      }
      continue;
    }

    const incomingSummary = preferSubagentSummary(event.summary, event.finalSummary);
    if (backgroundShell) {
      const label = state.command ?? state.description ?? "Background command";
      if (!state.backgroundChip) {
        state.backgroundChip = {
          kind: "background_chip",
          agentKey: state.agentKey,
          label,
          status: event.status,
          settledAtEventIndex: eventIndex,
        };
        rows.push(state.backgroundChip);
      } else {
        state.backgroundChip.label = longerSubagentText(state.backgroundChip.label, label) ?? "Background command";
        state.backgroundChip.status = event.status;
      }
      state.lastSettledEventIndex = eventIndex;
      continue;
    }
    if (!realSubagent) continue;

    if (!state.result) {
      state.result = {
        kind: "result",
        agentKey: state.agentKey,
        status: event.status,
        summary: incomingSummary,
        resultAtEventIndex: eventIndex,
      };
      rows.push(state.result);
    } else {
      state.result.summary = preferSubagentSummary(state.result.summary, incomingSummary);
      state.result.status = event.status;
    }
    state.lastResultEventIndex = eventIndex;
    if (state.spawn) state.spawn.status = event.status;
  }

  return rows;
}

export type NormalizedSubagentLifecycleEvent = Extract<
  AgentChatEvent,
  { type: "subagent_started" | "subagent_progress" | "subagent_result" }
>;

export function normalizeSubagentLifecycleEvent(event: AgentChatEvent): NormalizedSubagentLifecycleEvent | null {
  if (
    event.type === "subagent_started"
    || event.type === "subagent_progress"
    || event.type === "subagent_result"
  ) {
    return event;
  }

  if (event.type === "subagent.started") {
    const agentId = textField(event.agentId);
    if (!agentId) return null;
    return {
      type: "subagent_started",
      taskId: agentId,
      agentId,
      provider: event.provider,
      parentToolUseId: textField(event.parentToolUseId),
      agentType: event.agentType,
      model: textField(event.model),
      reasoningEffort: textField(event.reasoningEffort),
      label: textField(event.label),
      description: textField(event.description) ?? "Subagent task",
      background: event.background,
      turnId: event.turnId,
    };
  }

  if (event.type === "subagent.progress") {
    const agentId = textField(event.agentId);
    if (!agentId) return null;
    return {
      type: "subagent_progress",
      taskId: agentId,
      agentId,
      provider: event.provider,
      parentToolUseId: textField(event.parentToolUseId),
      agentType: event.agentType,
      model: textField(event.model),
      reasoningEffort: textField(event.reasoningEffort),
      label: textField(event.label),
      summary: textField(event.text) ?? textField(event.lastToolName) ?? "Running",
      ...(typeof event.tokens === "number" ? { usage: { totalTokens: event.tokens } } : {}),
      lastToolName: event.lastToolName,
      turnId: event.turnId,
    };
  }

  if (event.type === "subagent.completed") {
    const agentId = textField(event.agentId);
    if (!agentId) return null;
    return {
      type: "subagent_result",
      taskId: agentId,
      agentId,
      provider: event.provider,
      parentToolUseId: textField(event.parentToolUseId),
      agentType: event.agentType,
      model: textField(event.model),
      reasoningEffort: textField(event.reasoningEffort),
      label: textField(event.label),
      status: event.status ?? "completed",
      summary: textField(event.summary) ?? "Completed",
      usage: event.usage,
      turnId: event.turnId,
    };
  }

  return null;
}

function buildResolvedSubagentIdsByParent(events: AgentChatEventEnvelope[]): Map<string, Set<string>> {
  const idsByParent = new Map<string, Set<string>>();
  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    if (!type.startsWith("subagent")) continue;
    const parent = textField(event.parentToolUseId) ?? textField(event.parentAgentId);
    if (!parent) continue;
    const taskId = typeof event.taskId === "string" && event.taskId.trim() ? event.taskId.trim() : null;
    const agentId = typeof event.agentId === "string" && event.agentId.trim() ? event.agentId.trim() : null;
    const id = agentId ?? taskId;
    if (!id || id === parent) continue;
    const ids = idsByParent.get(parent) ?? new Set<string>();
    ids.add(id);
    idsByParent.set(parent, ids);
  }
  return idsByParent;
}

function isParentSubagentPlaceholder(snapshot: SubagentSnapshot | undefined, parentToolUseId: string): snapshot is SubagentSnapshot {
  return Boolean(
    snapshot
      && snapshot.id === parentToolUseId
      && snapshot.parentToolUseId === parentToolUseId,
  );
}

export function subagentSnapshotsFromEvents(rawEvents: AgentChatEventEnvelope[]): SubagentSnapshot[] {
  const events = collapseLegacySubagentEndEvents(rawEvents, (envelope) => envelope.event);
  const snapshots = new Map<string, SubagentSnapshot>();
  const resolvedIdsByParent = buildResolvedSubagentIdsByParent(events);

  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "teammate.idle") {
      const teamName = typeof event.teamName === "string" ? event.teamName : "";
      const teammateName = typeof event.teammateName === "string" ? event.teammateName : "";
      if (!teammateName) continue;
      const id = `teammate:${teamName}:${teammateName}`;
      const existing = snapshots.get(id);
      snapshots.set(id, {
        id,
        name: teamName ? `${teamName}/${teammateName}` : teammateName,
        kind: "teammate",
        status: "running",
        summary: existing?.summary ?? "idle",
        turnId: typeof event.turnId === "string" ? event.turnId : existing?.turnId,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        tokens: existing?.tokens,
      durationMs: existing?.durationMs,
      lastToolName: existing?.lastToolName,
      label: existing?.label,
      model: existing?.model,
      reasoningEffort: existing?.reasoningEffort,
    });
      continue;
    }

    if (type === "task.completed") {
      const teamName = typeof event.teamName === "string" ? event.teamName : "";
      const teammateName = typeof event.teammateName === "string" ? event.teammateName : "";
      const subject = typeof event.subject === "string" ? event.subject : "";
      if (!teammateName) continue;
      const id = `teammate:${teamName}:${teammateName}`;
      const existing = snapshots.get(id);
      snapshots.set(id, {
        id,
        name: existing?.name ?? (teamName ? `${teamName}/${teammateName}` : teammateName),
        kind: "teammate",
        status: "completed",
        summary: subject || existing?.summary || "",
        turnId: typeof event.turnId === "string" ? event.turnId : existing?.turnId,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        endedAt: envelope.timestamp,
        tokens: existing?.tokens,
      durationMs: existing?.durationMs,
      lastToolName: existing?.lastToolName,
      label: existing?.label,
      model: existing?.model,
      reasoningEffort: existing?.reasoningEffort,
    });
      continue;
    }

    if (!type.startsWith("subagent")) continue;
    const taskId = typeof event.taskId === "string" && event.taskId.trim() ? event.taskId.trim() : null;
    const agentId = typeof event.agentId === "string" && event.agentId.trim() ? event.agentId.trim() : null;
    const id = agentId ?? taskId;
    if (!id) continue;
    const incomingParentToolUseId = textField(event.parentToolUseId) ?? textField(event.parentAgentId);
    const incomingParentAgentId = textField(event.parentAgentId);
    const parentPlaceholder = incomingParentToolUseId ? snapshots.get(incomingParentToolUseId) : undefined;
    const parentResolvedIds = incomingParentToolUseId ? resolvedIdsByParent.get(incomingParentToolUseId) : undefined;
    const parentIsPlaceholder = Boolean(
      incomingParentToolUseId
        && isParentSubagentPlaceholder(parentPlaceholder, incomingParentToolUseId),
    );
    const canAdoptParentPlaceholder = parentIsPlaceholder
      && parentResolvedIds?.size === 1
      && parentResolvedIds.has(id);
    const taskAlias = taskId && taskId !== id ? snapshots.get(taskId) : undefined;
    const existing = snapshots.get(id) ?? taskAlias ?? (canAdoptParentPlaceholder ? parentPlaceholder : undefined);
    if (taskId && id !== taskId) snapshots.delete(taskId);
    if (
      incomingParentToolUseId
      && parentIsPlaceholder
      && (canAdoptParentPlaceholder || (parentResolvedIds && parentResolvedIds.size > 1))
    ) {
      snapshots.delete(incomingParentToolUseId);
    }
    const agentType = typeof event.agentType === "string" ? event.agentType : "subagent";
    const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : {};
    const parentToolUseId = incomingParentToolUseId ?? existing?.parentToolUseId ?? null;
    const isTerminalEvent = type === "subagent_result" || type === "subagent.completed";
    // A progress tick after the agent's terminal result is a late echo (Codex
    // re-announces the child's `subAgentActivity` item on item/completed), not
    // a resumption: it must not reopen the row, move its end, or overwrite the
    // report. Only a fresh `subagent_started` reopens a settled agent.
    const settled = existing != null && existing.status !== "running";
    if (settled && !isTerminalEvent && !type.includes("started")) {
      // The alias/placeholder entries above are already gone; keep the row
      // under its canonical id unchanged.
      snapshots.set(id, existing);
      continue;
    }
    const reopened = settled && !isTerminalEvent;
    const startedAt = existing?.startedAt ?? envelope.timestamp;
    const endedAt = isTerminalEvent ? envelope.timestamp : reopened ? undefined : existing?.endedAt;
    const parsedDurationMs = endedAt && startedAt ? Date.parse(endedAt) - Date.parse(startedAt) : Number.NaN;
    const fallbackDurationMs = Number.isFinite(parsedDurationMs) ? Math.max(0, parsedDurationMs) : existing?.durationMs;
    const summaryFromEvent = [event.summary, event.finalSummary, event.text, event.description]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const summary = summaryFromEvent ?? existing?.summary ?? "";
    const incomingTaskType = normalizeSubagentTaskType(event.taskType);
    const existingTaskType = normalizeSubagentTaskType(existing?.taskType);
    const incomingWorkflowName = typeof event.workflowName === "string" && event.workflowName.trim().length
      ? event.workflowName.trim()
      : undefined;
    const incomingWorkflowProgress = "workflowProgress" in event
      && isAgentChatWorkflowProgress(event.workflowProgress)
      ? event.workflowProgress
      : undefined;
    const existingWorkflowProgress = isAgentChatWorkflowProgress(existing?.workflowProgress)
      ? existing.workflowProgress
      : undefined;
    const base: SubagentSnapshot = {
      id,
      name: typeof event.description === "string" ? event.description : existing?.name ?? agentType,
      kind: "subagent",
      status: existing?.status ?? "running",
      summary,
      parentToolUseId,
      parentAgentId: incomingParentAgentId ?? existing?.parentAgentId ?? null,
      ...(textField(event.provider) ?? existing?.provider
        ? { provider: textField(event.provider) ?? existing?.provider }
        : {}),
      turnId: typeof event.turnId === "string" ? event.turnId : existing?.turnId ?? null,
      label: typeof event.label === "string" ? event.label : existing?.label ?? null,
      model: typeof event.model === "string" ? event.model : existing?.model ?? null,
      reasoningEffort: typeof event.reasoningEffort === "string" ? event.reasoningEffort : existing?.reasoningEffort ?? null,
      background: event.background === true || existing?.background === true,
      ...(incomingTaskType || existingTaskType
        ? { taskType: incomingTaskType ?? existingTaskType }
        : {}),
      ...(incomingWorkflowName || existing?.workflowName
        ? { workflowName: incomingWorkflowName ?? existing?.workflowName }
        : {}),
      ...(incomingWorkflowProgress ?? existingWorkflowProgress
        ? { workflowProgress: incomingWorkflowProgress ?? existingWorkflowProgress }
        : {}),
      startedAt,
      endedAt,
      tokens: typeof usage.totalTokens === "number" ? usage.totalTokens : typeof event.tokens === "number" ? event.tokens : existing?.tokens,
      toolUses: typeof usage.toolUses === "number" ? usage.toolUses : existing?.toolUses,
      costUsd: typeof usage.costUsd === "number" ? usage.costUsd : existing?.costUsd,
      durationMs: typeof usage.durationMs === "number" ? usage.durationMs : fallbackDurationMs,
      lastToolName: typeof event.lastToolName === "string" ? event.lastToolName : existing?.lastToolName,
    };
    if (type === "subagent_result" || type === "subagent.completed") {
      const status = event.status === "failed" || event.status === "stopped" || event.status === "completed" ? event.status : "completed";
      snapshots.set(id, { ...base, status });
    } else {
      snapshots.set(id, { ...base, status: "running" });
    }
  }

  return [...snapshots.values()];
}

