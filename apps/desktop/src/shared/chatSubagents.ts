import {
  AGENT_CHAT_WORKFLOW_TEXT_MAX_CHARS,
  type AgentChatEvent,
  type AgentChatEventEnvelope,
  type AgentChatSessionSummary,
  type AgentChatSubagentTranscriptMessage,
  type AgentChatWorkflowProgress,
} from "./types/chat";
import { resolveModelDescriptor } from "./modelRegistry";

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

export type ChatInfoPlanStep = {
  text: string;
  status: "pending" | "in_progress" | "completed" | "failed";
};

// iOS mirrors these caps, the pane storage-key/empty-state shapes, and the
// section-hint format in WorkChatRichCardViews.swift (WorkChatInfoDetailsSheet)
// — keep the twins in sync when changing any of them.
export const SUBAGENTS_ACTIVE_CAP = 12;
export const BACKGROUND_ACTIVE_CAP = 8;
export const SCHEDULE_ACTIVE_CAP = 10;
export const SUBAGENT_PANE_ROSTER_CAPACITY = 5;

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
  for (const key of ["agentId", "agentType", "model", "phaseTitle", "lastToolName"] as const) {
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

export type PaneSectionKey = "progress" | "tasks" | "subagents" | "background" | "schedule";

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

export type SubagentPaneSection = "main" | "subagents" | "teammates" | "background";

export type SubagentPaneDisclosureSection = Exclude<SubagentPaneSection, "main">;
export type SubagentPaneViewSection = SubagentPaneDisclosureSection | "schedule";

export type SubagentPaneViewState = {
  collapsed?: Partial<Record<SubagentPaneViewSection, boolean>>;
  earlierExpanded?: Partial<Record<SubagentPaneViewSection, boolean>>;
  showAll?: Partial<Record<SubagentPaneViewSection, boolean>>;
  cleared?: Partial<Record<SubagentPaneViewSection, readonly string[] | ReadonlySet<string>>>;
  pinnedIds?: readonly string[] | ReadonlySet<string>;
  /** TUI chat-info: omit the ghost "main" row; selection 0 still means the parent chat. */
  hideMain?: boolean;
};

export type SubagentPaneRow =
  | { kind: "main"; key: "main"; section: "main"; label: string }
  | {
      kind: "section-header";
      key: string;
      section: SubagentPaneDisclosureSection;
      label: string;
      activeCount: number;
      earlierCount: number;
      clearedCount: number;
      collapsible: boolean;
      collapsed: boolean;
      hasClear: boolean;
    }
  | {
      kind: "snapshot";
      key: string;
      section: SubagentPaneDisclosureSection;
      snapshot: SubagentSnapshot;
      group?: "active" | "earlier";
    }
  | { kind: "earlier-toggle"; key: string; section: SubagentPaneDisclosureSection; count: number; expanded: boolean; clearedCount: number }
  | { kind: "show-all"; key: string; section: SubagentPaneDisclosureSection; hiddenCount: number }
  | { kind: "restore-cleared"; key: string; section: SubagentPaneDisclosureSection; count: number };

export type SubagentPaneContent = {
  snapshots: SubagentSnapshot[];
};

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const SUBAGENT_MODEL_INHERITED_SUFFIX = "inherited";

export type SubagentModelAttribution = {
  label: string;
  inherited: boolean;
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
}): SubagentModelAttribution | null {
  const reported = formatSubagentModelLabel(args.snapshotModel);
  if (reported) return { label: reported, inherited: false };
  const session = formatSubagentModelLabel(args.sessionModelLabel);
  if (!session) return null;
  return { label: session, inherited: true };
}

export function formatSubagentModelChip(attribution: SubagentModelAttribution | null): string | null {
  if (!attribution) return null;
  return attribution.inherited
    ? `${attribution.label} · ${SUBAGENT_MODEL_INHERITED_SUFFIX}`
    : attribution.label;
}

export function chatInfoHeaderModelAttribution(args: {
  inspectedSnapshotModel?: string | null;
  sessionModelLabel: string;
  inspecting: boolean;
}): SubagentModelAttribution {
  const session = textField(args.sessionModelLabel) ?? args.sessionModelLabel;
  if (!args.inspecting) return { label: session, inherited: false };
  return subagentModelAttribution({
    snapshotModel: args.inspectedSnapshotModel,
    sessionModelLabel: session,
  }) ?? { label: session, inherited: true };
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
  const source = value?.replace(/\r\n?/g, "\n").trim();
  if (!source) return null;
  const parts: string[] = [];
  let pendingSeparator: string | null = null;
  for (const rawLine of source.split("\n")) {
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
    if (parts.length) parts.push(pendingSeparator ?? " ");
    parts.push(line);
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

export type AgentIdentityLabel = {
  /** Human role, sentence case — "Ship poller". */
  label: string;
  /** Trailing issue/PR number lifted out of the path, e.g. "#927". */
  ref: string | null;
  /** The raw value, kept for the `title` tooltip. */
  raw: string;
};

/**
 * Words an agent id spells in lower case that read wrong in sentence case:
 * `ios_shared_scan` is "iOS shared scan", not "Ios shared scan". Mirrored on
 * iOS in `WorkStatusAndFormattingHelpers.swift`.
 */
const AGENT_IDENTITY_ACRONYMS: ReadonlyMap<string, string> = new Map(
  ["iOS", "CLI", "TUI", "UI", "UX", "API", "IPC", "PR", "CI", "SDK", "MCP", "DB", "JSON", "URL", "HTTP", "SQL", "CSS", "HTML", "AI", "ID"]
    .map((word) => [word.toLowerCase(), word] as const),
);

/**
 * Turn a runtime's internal agent path into a role.
 *
 * Codex hands us `/ROOT/SHIP_POLL_927` — an id, not an identity. Identity
 * should read as role + intent, so the last segment becomes sentence case
 * ("Ship poll") and a trailing issue/PR number is lifted into `ref`.
 * Runtimes that never set an agent type (OpenCode, Droid) get `null`.
 */
export function humanizeAgentIdentity(value: string | null | undefined): AgentIdentityLabel | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  // `background` is a flag the spawn card renders as its own chip.
  if (raw.toLowerCase() === "background") return null;
  const segments = raw.split(/[/\\]+/).filter((segment) => segment.length > 0);
  let tail = segments.length ? segments[segments.length - 1]! : raw;
  // A bare "/root" (or an all-separator value) carries no role at all.
  if (segments.length === 1 && /^root$/i.test(tail)) return null;
  let ref: string | null = null;
  const numberMatch = tail.match(/[_\-\s](\d{2,})$/);
  if (numberMatch) {
    ref = `#${numberMatch[1]}`;
    tail = tail.slice(0, numberMatch.index);
  }
  const words = tail.split(/[_\-\s]+/).filter((word) => word.length > 0);
  if (!words.length) return ref ? { label: raw, ref, raw } : null;
  const label = words
    .map((word, index) => {
      const acronym = AGENT_IDENTITY_ACRONYMS.get(word.toLowerCase());
      if (acronym) return acronym;
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
  return { label, ref, raw };
}

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

function eventType(event: AgentChatEvent): string {
  return String((event as { type?: unknown }).type ?? "");
}

function eventSubagentIds(event: AgentChatEvent): string[] {
  const record = event as { taskId?: unknown; agentId?: unknown };
  const ids = [
    textField(record.taskId),
    textField(record.agentId),
  ].filter((value): value is string => value != null);
  return [...new Set(ids)];
}

function eventParentToolUseId(event: AgentChatEvent): string | null {
  return textField((event as { parentToolUseId?: unknown }).parentToolUseId)
    ?? textField((event as { parentAgentId?: unknown }).parentAgentId);
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

export function workEventItemId(event: AgentChatEvent): string | null {
  if (event.type !== "tool_call" && event.type !== "tool_result" && event.type !== "command" && event.type !== "file_change") {
    return null;
  }
  return textField((event as { itemId?: unknown }).itemId);
}

export function workEventParentItemId(event: AgentChatEvent): string | null {
  if (event.type !== "tool_call" && event.type !== "tool_result") {
    return null;
  }
  return textField((event as { parentItemId?: unknown }).parentItemId);
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

export function subagentActivitySummaryFromEvents(rawEvents: AgentChatEventEnvelope[]): { totalCount: number; runningCount: number } {
  const events = collapseLegacySubagentEndEvents(rawEvents, (envelope) => envelope.event);
  const snapshots = new Map<string, Pick<SubagentSnapshot, "status" | "kind" | "background" | "turnId">>();

  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    const turnId = typeof event.turnId === "string" ? event.turnId : null;

    if (type === "teammate.idle") {
      const teamName = typeof event.teamName === "string" ? event.teamName : "";
      const teammateName = typeof event.teammateName === "string" ? event.teammateName : "";
      if (!teammateName) continue;
      snapshots.set(`teammate:${teamName}:${teammateName}`, {
        kind: "teammate",
        status: "running",
        turnId,
      });
      continue;
    }

    if (type === "task.completed") {
      const teamName = typeof event.teamName === "string" ? event.teamName : "";
      const teammateName = typeof event.teammateName === "string" ? event.teammateName : "";
      if (!teammateName) continue;
      snapshots.set(`teammate:${teamName}:${teammateName}`, {
        kind: "teammate",
        status: "completed",
        turnId,
      });
      continue;
    }

    if (!type.startsWith("subagent")) continue;
    const taskId = typeof event.taskId === "string" && event.taskId.trim() ? event.taskId.trim() : null;
    const agentId = typeof event.agentId === "string" && event.agentId.trim() ? event.agentId.trim() : null;
    const id = agentId ?? taskId;
    if (!id) continue;
    const existing = snapshots.get(id) ?? (taskId ? snapshots.get(taskId) : undefined);
    if (taskId && id !== taskId) snapshots.delete(taskId);
    const isTerminalEvent = type === "subagent_result" || type === "subagent.completed";
    // Same rule as `subagentSnapshotsFromEvents`: a late progress tick never
    // reopens a settled agent; only a fresh start does.
    if (existing && existing.status !== "running" && !isTerminalEvent && !type.includes("started")) {
      snapshots.set(id, existing);
      continue;
    }
    const status = isTerminalEvent
      ? event.status === "failed" || event.status === "stopped" || event.status === "completed"
        ? event.status
        : "completed"
      : "running";
    snapshots.set(id, {
      kind: "subagent",
      status,
      background: event.background === true,
      turnId,
    });
  }

  let runningCount = 0;
  for (const snapshot of snapshots.values()) {
    if (snapshot.status === "running") runningCount += 1;
  }
  return { totalCount: snapshots.size, runningCount };
}

export function buildSubagentPaneRows(
  content: SubagentPaneContent,
  viewState?: SubagentPaneViewState,
): SubagentPaneRow[] {
  const foregroundSubagents = content.snapshots.filter((snap) => (
    snap.kind === "subagent"
    && snap.background !== true
  ));
  const teammates = content.snapshots.filter((snap) => snap.kind === "teammate");
  const background = content.snapshots.filter((snap) => snap.kind === "subagent" && snap.background === true);

  if (!viewState) {
    const runningWeight = (snap: SubagentSnapshot): number => (snap.status === "running" ? 0 : 1);
    const sortedForegroundSubagents = [...foregroundSubagents].sort(
      (left, right) => runningWeight(left) - runningWeight(right),
    );

    return [
      { kind: "main", key: "main", section: "main", label: "main" },
      ...sortedForegroundSubagents.map((snapshot) => ({ kind: "snapshot" as const, key: snapshot.id, section: "subagents" as const, snapshot })),
      ...teammates.map((snapshot) => ({ kind: "snapshot" as const, key: snapshot.id, section: "teammates" as const, snapshot })),
      ...background.map((snapshot) => ({ kind: "snapshot" as const, key: snapshot.id, section: "background" as const, snapshot })),
    ];
  }

  const rows: SubagentPaneRow[] = viewState.hideMain
    ? []
    : [{ kind: "main", key: "main", section: "main", label: "main" }];
  const pinnedIds = new Set(viewState.pinnedIds ?? []);
  const sections: Array<{
    section: SubagentPaneDisclosureSection;
    label: string;
    items: SubagentSnapshot[];
    cap: number;
    scalable: boolean;
  }> = [
    { section: "subagents", label: "SUBAGENTS", items: foregroundSubagents, cap: SUBAGENTS_ACTIVE_CAP, scalable: true },
    { section: "teammates", label: "TEAMMATES", items: teammates, cap: Number.POSITIVE_INFINITY, scalable: false },
    { section: "background", label: "BACKGROUND", items: background, cap: BACKGROUND_ACTIVE_CAP, scalable: true },
  ];

  for (const { section, label, items, cap, scalable } of sections) {
    if (!items.length) continue;
    const clearedIds = new Set(viewState.cleared?.[section] ?? []);
    const grouped = scalable
      ? groupPaneSectionItems(items, {
          isEarlier: isEarlierSubagentSnapshot,
          isCleared: (snapshot) => clearedIds.has(snapshot.id),
          isPinned: (snapshot) => pinnedIds.has(snapshot.id),
        })
      : { active: items, earlier: [], clearedCount: 0 };
    const collapsible = scalable && (grouped.earlier.length > 0 || grouped.active.length > cap);
    const collapsed = collapsible && viewState.collapsed?.[section] === true;
    rows.push({
      kind: "section-header",
      key: `section:${section}`,
      section,
      label,
      activeCount: grouped.active.length,
      earlierCount: grouped.earlier.length,
      clearedCount: grouped.clearedCount,
      collapsible,
      collapsed,
      hasClear: grouped.earlier.length > 0,
    });
    if (collapsed) continue;

    const capped = viewState.showAll?.[section]
      ? { visible: grouped.active, hiddenCount: 0 }
      : capPaneSectionItems(grouped.active, cap, (snapshot) => (
          snapshot.status === "failed" || pinnedIds.has(snapshot.id)
        ));
    rows.push(...capped.visible.map((snapshot) => ({
      kind: "snapshot" as const,
      key: snapshot.id,
      section,
      snapshot,
      group: "active" as const,
    })));
    if (capped.hiddenCount > 0) {
      rows.push({ kind: "show-all", key: `show-all:${section}`, section, hiddenCount: capped.hiddenCount });
    }

    const earlierExpanded = viewState.earlierExpanded?.[section] === true;
    if (grouped.earlier.length > 0 || grouped.clearedCount > 0) {
      rows.push({
        kind: "earlier-toggle",
        key: `earlier:${section}`,
        section,
        count: grouped.earlier.length,
        expanded: earlierExpanded,
        clearedCount: grouped.clearedCount,
      });
    }
    if (earlierExpanded) {
      rows.push(...grouped.earlier.map((snapshot) => ({
        kind: "snapshot" as const,
        key: snapshot.id,
        section,
        snapshot,
        group: "earlier" as const,
      })));
      if (grouped.clearedCount > 0) {
        rows.push({ kind: "restore-cleared", key: `restore:${section}`, section, count: grouped.clearedCount });
      }
    } else if (grouped.active.length === 0 && grouped.earlier.length === 0 && grouped.clearedCount > 0) {
      rows.push({ kind: "restore-cleared", key: `restore:${section}`, section, count: grouped.clearedCount });
    }
  }

  return rows;
}

export function selectedSubagentSnapshot(
  content: SubagentPaneContent,
  selectedIndex: number,
  viewState?: SubagentPaneViewState,
): SubagentSnapshot | null {
  const row = buildSubagentPaneRows(content, viewState)
    .filter((candidate) => candidate.kind === "main" || candidate.kind === "snapshot")[selectedIndex] ?? null;
  return row?.kind === "snapshot" ? row.snapshot : null;
}

// Calibrated preamble offset the ade-code TUI mouse mapper assumes. The caller
// passes `mouse.y - subagentPaneTop`, and app.tsx's subagentPaneTop formula was
// tuned against this baseline (the CHATS head + chat-info preamble rows that
// render above the "main" row). Changing one side without the other shifts
// every roster click by the same amount.
const SUBAGENT_PANE_TABLE_START_LINE = 4;

function subagentPaneRowLineSpan(row: SubagentPaneRow, selected: boolean): number {
  if (row.kind === "section-header") return 2;
  if (row.kind === "main") return 2;
  if (row.kind === "snapshot") {
    return selected && (row.snapshot.lastToolName || row.snapshot.summary) ? 2 : 1;
  }
  return 1;
}

export function windowSubagentPaneRows(
  rows: readonly SubagentPaneRow[],
  selectedIndex: number,
  capacity = SUBAGENT_PANE_ROSTER_CAPACITY,
): { visibleRows: Exclude<SubagentPaneRow, { kind: "main" }>[]; hiddenBefore: number; hiddenAfter: number } {
  const rosterRows = rows.filter((row): row is Exclude<SubagentPaneRow, { kind: "main" }> => row.kind !== "main");
  if (rosterRows.length <= capacity) {
    return { visibleRows: rosterRows, hiddenBefore: 0, hiddenAfter: 0 };
  }
  const snapshotRows = rows.filter((row): row is Extract<SubagentPaneRow, { kind: "snapshot" }> => (
    row.kind === "snapshot"
  ));
  const selectedKey = selectedIndex > 0 ? snapshotRows[selectedIndex - 1]?.key : null;
  const selectedRosterIndex = Math.max(0, rosterRows.findIndex((row) => row.key === selectedKey));
  const half = Math.floor(capacity / 2);
  let start = Math.max(0, selectedRosterIndex - half);
  let end = start + capacity;
  if (end > rosterRows.length) {
    end = rosterRows.length;
    start = end - capacity;
  }
  return {
    visibleRows: rosterRows.slice(start, end),
    hiddenBefore: start,
    hiddenAfter: rosterRows.length - end,
  };
}

export function subagentPaneSelectableLineOffsets(
  content: SubagentPaneContent,
  selectedIndex = 0,
  viewState?: SubagentPaneViewState,
): number[] {
  const rows = buildSubagentPaneRows(content, viewState);
  const offsets: number[] = [];
  let line = SUBAGENT_PANE_TABLE_START_LINE;
  let selectableIndex = 0;

  for (const row of rows) {
    const selectable = row.kind === "main" || row.kind === "snapshot";
    const selected = selectable && selectableIndex === selectedIndex;
    if (selectable) {
      offsets.push(line);
      selectableIndex += 1;
    }
    line += subagentPaneRowLineSpan(row, selected);
  }

  return offsets;
}

export type SubagentPaneTarget =
  | { type: "snapshot"; index: number }
  | { type: "toggle-section"; section: SubagentPaneDisclosureSection }
  | { type: "toggle-earlier"; section: SubagentPaneDisclosureSection }
  | { type: "show-all"; section: SubagentPaneDisclosureSection }
  | { type: "restore"; section: SubagentPaneDisclosureSection };

export function subagentIndexForPaneLine(
  content: SubagentPaneContent,
  line: number,
  selectedIndex = 0,
  viewState?: SubagentPaneViewState,
  windowCapacity?: number,
): SubagentPaneTarget | null {
  if (!Number.isFinite(line)) return null;
  const rows = buildSubagentPaneRows(content, viewState);
  const snapshotIndexByKey = new Map(
    rows
      .filter((row): row is Extract<SubagentPaneRow, { kind: "snapshot" }> => row.kind === "snapshot")
      .map((row, index) => [row.key, index + 1]),
  );
  const windowed = windowCapacity == null
    ? { visibleRows: rows.filter((row) => row.kind !== "main"), hiddenBefore: 0, hiddenAfter: 0 }
    : windowSubagentPaneRows(rows, selectedIndex, windowCapacity);
  const visibleRows: Array<SubagentPaneRow | null> = [
    ...(rows.find((row) => row.kind === "main") ? [rows.find((row) => row.kind === "main")!] : []),
    ...(windowed.hiddenBefore > 0 ? [null] : []),
    ...windowed.visibleRows,
    ...(windowed.hiddenAfter > 0 ? [null] : []),
  ];
  let rowLine = SUBAGENT_PANE_TABLE_START_LINE;
  const anchors: Array<{ line: number; target: SubagentPaneTarget }> = [];
  let exactHit: SubagentPaneTarget | null = null;
  let insideNonInteractive = false;
  for (const row of visibleRows) {
    const selectableIndex = row?.kind === "main"
      ? 0
      : row?.kind === "snapshot"
        ? snapshotIndexByKey.get(row.key) ?? -1
        : -1;
    const selected = selectableIndex === selectedIndex;
    const span = row ? subagentPaneRowLineSpan(row, selected) : 1;
    const target: SubagentPaneTarget | null = !row
      ? null
      : row.kind === "main" || row.kind === "snapshot"
        ? { type: "snapshot", index: selectableIndex }
        : row.kind === "section-header"
          ? (row.collapsible ? { type: "toggle-section", section: row.section } : null)
          : row.kind === "earlier-toggle"
            ? { type: "toggle-earlier", section: row.section }
            : row.kind === "show-all"
              ? { type: "show-all", section: row.section }
              : { type: "restore", section: row.section };
    if (target) anchors.push({ line: rowLine, target });
    if (line >= rowLine && line < rowLine + span) {
      if (target) exactHit = target;
      else insideNonInteractive = true;
    }
    rowLine += span;
  }
  if (exactHit) return exactHit;
  if (!anchors.length) return null;
  // Near-miss tolerance (the pre-grouping mapper snapped to the nearest row):
  // the constant paneTop the TUI passes drifts by a line or two when variable
  // blocks (plan, goal banner) sit above the roster, so a click inside a
  // non-interactive span or just past the roster bounds snaps to the nearest
  // interactive row instead of dead-dropping.
  const first = anchors[0]!.line;
  if (!insideNonInteractive && (line < first - 1 || line > rowLine)) return null;
  let best = anchors[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    const distance = Math.abs(line - anchor.line);
    if (distance < bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  return best.target;
}

export function isLifecycleEventForSnapshot(event: AgentChatEvent, snapshot: SubagentSnapshot): boolean {
  const type = eventType(event);
  if (snapshot.kind === "teammate") {
    if (type === "teammate.idle" || type === "task.completed") {
      const record = event as { teamName?: unknown; teammateName?: unknown };
      const teamName = textField(record.teamName) ?? "";
      const teammateName = textField(record.teammateName) ?? "";
      return snapshot.id === `teammate:${teamName}:${teammateName}`;
    }
    return false;
  }
  if (
    type !== "subagent_started"
    && type !== "subagent_progress"
    && type !== "subagent_result"
    && type !== "subagent.started"
    && type !== "subagent.progress"
    && type !== "subagent.completed"
  ) {
    return false;
  }
  const explicitIds = eventSubagentIds(event);
  if (explicitIds.length > 0) return explicitIds.includes(snapshot.id);
  const parentToolUseId = eventParentToolUseId(event);
  return Boolean(snapshot.parentToolUseId && parentToolUseId === snapshot.parentToolUseId);
}

function lifecycleText(event: AgentChatEvent, snapshot: SubagentSnapshot): string | null {
  const type = eventType(event);
  const record = event as {
    description?: unknown;
    summary?: unknown;
    finalSummary?: unknown;
    text?: unknown;
    subject?: unknown;
    status?: unknown;
  };
  if (type === "subagent_started" || type === "subagent.started") {
    return "Started.";
  }
  if (type === "subagent_progress" || type === "subagent.progress") {
    return textField(record.summary) ?? textField(record.text) ?? null;
  }
  if (type === "subagent_result" || type === "subagent.completed") {
    const status = textField(record.status) ?? snapshot.status;
    const summary = textField(record.finalSummary) ?? textField(record.summary) ?? snapshot.summary;
    return `${status}: ${summary || snapshot.name}`;
  }
  if (type === "teammate.idle") {
    return `Teammate idle: ${snapshot.name}`;
  }
  if (type === "task.completed") {
    return `completed: ${textField(record.subject) ?? snapshot.summary ?? snapshot.name}`;
  }
  return null;
}

function syntheticTextEvent(
  sessionId: string,
  timestamp: string,
  sequence: number,
  turnId: string | null | undefined,
  text: string,
  // Distinct per synthetic line. Without it, every synthetic transcript line
  // shares the snapshot turnId and no itemId, so the render-line coalescer fuses
  // them into one separator-less blob ("…Task: XStarted.", message runs jammed
  // together). A unique itemId keeps each line its own rendered paragraph.
  itemId?: string,
): AgentChatEventEnvelope {
  return {
    sessionId,
    timestamp,
    sequence,
    event: {
      type: "text",
      text,
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
    },
  };
}

export function buildSubagentTranscriptEvents(args: {
  events: AgentChatEventEnvelope[];
  activeSession: AgentChatSessionSummary | null;
  snapshot: SubagentSnapshot;
}): AgentChatEventEnvelope[] {
  const sessionId = args.activeSession?.sessionId ?? args.events[0]?.sessionId ?? "subagent";
  const parentToolUseId = textField(args.snapshot.parentToolUseId);
  const childItemIds = new Set<string>();

  if (parentToolUseId) {
    for (const envelope of args.events) {
      const event = envelope.event;
      const parentItemId = workEventParentItemId(event);
      const itemId = workEventItemId(event);
      if (parentItemId === parentToolUseId && itemId) {
        childItemIds.add(itemId);
      }
    }
  }

  let lineSeq = 0;
  const transcript: AgentChatEventEnvelope[] = [
    syntheticTextEvent(
      sessionId,
      args.snapshot.startedAt ?? args.events[0]?.timestamp ?? new Date(0).toISOString(),
      -2,
      args.snapshot.turnId,
      `Viewing ${args.snapshot.kind === "teammate" ? "teammate" : args.snapshot.background ? "background agent" : "agent"} transcript. Select Main chat in Chat Info to return.\nTask: ${args.snapshot.name}`,
      `subagent-line:${lineSeq++}`,
    ),
  ];

  for (const envelope of args.events) {
    const event = envelope.event;
    if (isLifecycleEventForSnapshot(event, args.snapshot)) {
      const text = lifecycleText(event, args.snapshot);
      if (text) {
        transcript.push(syntheticTextEvent(sessionId, envelope.timestamp, envelope.sequence ?? 0, args.snapshot.turnId, text, `subagent-line:${lineSeq++}`));
      }
      continue;
    }
    const parentItemId = workEventParentItemId(event);
    const itemId = workEventItemId(event);
    if (parentToolUseId && (parentItemId === parentToolUseId || (itemId != null && childItemIds.has(itemId)))) {
      transcript.push(envelope);
    }
  }

  if (transcript.length === 1) {
    transcript.push(syntheticTextEvent(
      sessionId,
      args.snapshot.endedAt ?? args.events.at(-1)?.timestamp ?? new Date(0).toISOString(),
      -1,
      args.snapshot.turnId,
      args.snapshot.summary || "No detailed transcript rows were recorded for this agent.",
      `subagent-line:${lineSeq++}`,
    ));
  }

  return transcript;
}

function transcriptRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function transcriptEventField(event: AgentChatEvent, key: "itemId" | "messageId" | "turnId"): string | null {
  return textField((event as Record<string, unknown>)[key]);
}

// Stable per-source-message identity so the streamed chunks of one assistant
// message (Codex persists each delta as its own transcript row) carry the SAME
// messageId and the transcript coalescers fuse them back into one paragraph,
// instead of rendering one block (≈ one word) per chunk.
function stableTranscriptMessageId(
  event: AgentChatEvent,
  message: AgentChatSubagentTranscriptMessage,
  index: number,
): string {
  const turnId = transcriptEventField(event, "turnId") ?? "no-turn";
  const itemId = transcriptEventField(event, "itemId")
    ?? transcriptEventField(event, "messageId")
    ?? message.uuid
    ?? String(index);
  return `subagent:${message.sessionId}:${turnId}:${itemId}:${event.type}`;
}

function normalizeTranscriptEvent(
  event: AgentChatEvent,
  message: AgentChatSubagentTranscriptMessage,
  index: number,
): AgentChatEvent {
  if (event.type === "text" || event.type === "user_message") {
    return { ...event, messageId: event.messageId ?? stableTranscriptMessageId(event, message, index) };
  }
  // A Codex fileChange thread item fans out into one event per file, all
  // sharing the item's id; the transcript group dedupes by itemId, so suffix
  // the path to keep each file its own row (stable across refetches).
  if (event.type === "file_change") {
    return { ...event, itemId: `${event.itemId}:${event.path}` };
  }
  return event;
}

function claudeToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const record = transcriptRecord(block);
        return record && typeof record.text === "string" ? record.text : "";
      })
      .filter((value) => value.length > 0)
      .join("\n");
  }
  return "";
}

/**
 * Expand an Anthropic/Claude message ({ role, content[, type:"message"] }) into
 * real transcript events — each content block (text / thinking / tool_use /
 * tool_result) becomes the matching chat event so tool calls render through the
 * same tool-line formatting as the main transcript (desktop parity:
 * expandClaudeTranscriptMessage in AgentChatPane).
 */
function expandClaudeTranscriptMessage(
  record: Record<string, unknown>,
  message: AgentChatSubagentTranscriptMessage,
): AgentChatEvent[] {
  const role = typeof record.role === "string" ? record.role : message.type;
  const content = record.content;
  const out: AgentChatEvent[] = [];
  const pushText = (value: string, id: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    out.push(role === "user"
      ? { type: "user_message", text: trimmed, messageId: id }
      : { type: "text", text: trimmed, messageId: id });
  };

  if (typeof content === "string") {
    pushText(content, message.uuid);
  } else if (Array.isArray(content)) {
    content.forEach((block, blockIndex) => {
      const b = transcriptRecord(block);
      if (!b) return;
      const blockType = typeof b.type === "string" ? b.type : "";
      const id = `${message.uuid}:${blockIndex}`;
      if (blockType === "text" && typeof b.text === "string") {
        pushText(b.text, id);
      } else if (blockType === "thinking" && typeof b.thinking === "string" && b.thinking.trim().length > 0) {
        out.push({ type: "reasoning", text: b.thinking, itemId: id });
      } else if (blockType === "tool_use") {
        out.push({
          type: "tool_call",
          tool: typeof b.name === "string" && b.name.length > 0 ? b.name : "tool",
          args: b.input ?? {},
          itemId: typeof b.id === "string" && b.id.length > 0 ? b.id : id,
        });
      } else if (blockType === "tool_result") {
        out.push({
          type: "tool_result",
          tool: "",
          result: claudeToolResultText(b.content),
          itemId: typeof b.tool_use_id === "string" && b.tool_use_id.length > 0 ? b.tool_use_id : id,
          status: b.is_error === true ? "failed" : "completed",
        });
      }
    });
  }

  // Nothing structured extracted but the SDK still gave us flat text.
  if (out.length === 0 && typeof message.text === "string" && message.text.trim().length > 0) {
    pushText(message.text, message.uuid);
  }
  return out;
}

// `/bin/zsh -lc "…"`, `bash -c '…'`, `sh -c …` — system rows that are really
// shell invocations become command events so they render as tool lines (the
// transcript renderer strips the launcher wrapper itself).
const SHELL_LAUNCHER_PATTERN = /^(?:\/[\w./-]+\/)?(?:zsh|bash|sh)\s+-[\w]*c\s+/;

function eventsFromTranscriptMessage(
  message: AgentChatSubagentTranscriptMessage,
  index: number,
): AgentChatEvent[] {
  const record = transcriptRecord(message.message);
  // Anthropic/Claude message shape — expand its content blocks. This MUST come
  // before the generic passthrough: Anthropic messages carry type:"message",
  // which would otherwise be mistaken for an already-formed chat event.
  if (record && (record.type === "message" || record.role === "assistant" || record.role === "user")) {
    const expanded = expandClaudeTranscriptMessage(record, message)
      .map((event, subIndex) => normalizeTranscriptEvent(event, message, index + subIndex));
    if (expanded.length > 0) return expanded;
  }
  // Runtime already handed us a formed chat event (Codex thread items / the
  // captured live-event path) — pass it through so commands, file changes, and
  // tool calls render through the normal typed pipeline.
  if (typeof record?.type === "string" && record.type.trim().length > 0 && record.type !== "message") {
    return [normalizeTranscriptEvent(record as unknown as AgentChatEvent, message, index)];
  }
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) return [];
  if (message.type === "user") {
    return [{ type: "user_message", text, messageId: message.uuid }];
  }
  if (message.type === "system") {
    if (SHELL_LAUNCHER_PATTERN.test(text)) {
      return [{
        type: "command",
        command: text,
        cwd: "",
        output: "",
        itemId: `subagent-cmd:${message.uuid}`,
        status: "completed",
      }];
    }
    return [{ type: "text", text: `system › ${text}`, messageId: message.uuid }];
  }
  return [{ type: "text", text, messageId: message.uuid }];
}

/**
 * Convert a REAL daemon-backed subagent transcript (Codex app-server threads /
 * OpenCode child-session messages / Claude SDK subagent messages) into display
 * envelopes for the takeover view. Used when a `canViewFullTranscript` subagent
 * is inspected; falls back to {@link buildSubagentTranscriptEvents} when the
 * daemon returns null. Formed chat events embedded in `message` pass through
 * (so tool calls / commands / file changes render as typed tool lines), Claude
 * message content blocks expand to their event equivalents, and flat text gets
 * a stable per-message messageId so streamed chunks merge back into paragraphs.
 */
export function subagentTranscriptMessagesToEvents(args: {
  messages: AgentChatSubagentTranscriptMessage[];
  snapshot: SubagentSnapshot;
  sessionId: string;
}): AgentChatEventEnvelope[] {
  const { messages, snapshot, sessionId } = args;
  const startTs = snapshot.startedAt ?? new Date(0).toISOString();
  let lineSeq = 0;
  const transcript: AgentChatEventEnvelope[] = [
    syntheticTextEvent(
      sessionId,
      startTs,
      lineSeq++,
      snapshot.turnId,
      `Viewing ${snapshot.kind === "teammate" ? "teammate" : snapshot.background ? "background agent" : "agent"} transcript. Select Main chat in Chat Info to return.\nTask: ${snapshot.name}`,
      `subagent-line:0`,
    ),
  ];
  messages.forEach((message, index) => {
    for (const event of eventsFromTranscriptMessage(message, index)) {
      transcript.push({ sessionId, timestamp: startTs, sequence: lineSeq++, event });
    }
  });
  if (transcript.length === 1) {
    transcript.push(syntheticTextEvent(
      sessionId,
      snapshot.endedAt ?? startTs,
      lineSeq,
      snapshot.turnId,
      snapshot.summary || "No transcript rows were returned for this agent.",
      `subagent-line:${lineSeq}`,
    ));
  }
  return transcript;
}
