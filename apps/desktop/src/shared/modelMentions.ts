// Grammar + send-time expansion for composer @-mentions of models.
//
// A model mention names a model, a thinking level, and a permission mode in one
// chip, so a user can write "start an agent in this lane with <chip>" and the
// agent receives the exact ids and CLI flags instead of guessing them.
//
// Token form (what the draft, the transcript, and every surface store):
//
//   @model:<model-id>?effort=<level>&perm=<mode>
//
// `effort` and `perm` are optional. The token is pure text, so copy, paste,
// prompt history and saved drafts keep it with no side table. Like chat
// mentions, the transcript keeps the raw token and only the provider-bound
// prompt text carries the expanded `<ade-mention kind="model">` block.

import { compareChatMentionRanks, scoreChatMentionCandidate } from "./chatMentions";

/** Permission modes a model chip can carry. Mirrors `--permissions` on `ade chat create`. */
export const MODEL_MENTION_PERMISSION_MODES = ["default", "auto", "plan", "edit", "full-auto"] as const;
export type ModelMentionPermissionMode = (typeof MODEL_MENTION_PERMISSION_MODES)[number];

/** The mode a new chip starts on. */
export const MODEL_MENTION_DEFAULT_PERMISSION: ModelMentionPermissionMode = "default";

const PERMISSION_LABELS: Record<ModelMentionPermissionMode, string> = {
  default: "Default",
  auto: "Auto",
  plan: "Plan",
  edit: "Edit",
  "full-auto": "Full access",
};

export function modelMentionPermissionLabel(mode: string | null | undefined): string {
  if (!mode) return PERMISSION_LABELS.default;
  return isModelMentionPermissionMode(mode) ? PERMISSION_LABELS[mode] : mode;
}

export function isModelMentionPermissionMode(value: string | null | undefined): value is ModelMentionPermissionMode {
  return typeof value === "string" && (MODEL_MENTION_PERMISSION_MODES as readonly string[]).includes(value);
}

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
};

export function modelMentionEffortLabel(effort: string | null | undefined): string {
  if (!effort) return "Default";
  return EFFORT_LABELS[effort] ?? effort;
}

export type ModelMention = {
  modelId: string;
  effort: string | null;
  permission: string | null;
};

export type ParsedModelMention = ModelMention & {
  /** The matched token text. */
  token: string;
  /** Offset of the `@` within the source text. */
  start: number;
  end: number;
};

// Model ids are registry ids such as `opencode/opencode-go/deepseek-v4.1-flash`
// or `anthropic/claude-opus-5`: letters, digits, `.`, `_`, `-`, `/` and `:`.
// The query only carries simple `key=value` pairs. The token must start at a
// word boundary so an email or a URL never matches.
const MODEL_ID_CHARS = "A-Za-z0-9._/:-";
const MODEL_TOKEN_SOURCE =
  `(?:^|[\\s(\\[{,])@model:([${MODEL_ID_CHARS}]+)(?:\\?([A-Za-z0-9=&._-]+))?`;

// A sentence can end right after a chip ("use @model:x."). The id never ends in
// punctuation, so trailing dots and dashes belong to the prose, not the id.
const TRAILING_PROSE_RE = /[.:-]+$/;

/** Serialize one model mention into its chip/draft token form. */
export function formatModelMentionToken(mention: ModelMention): string {
  const params: string[] = [];
  if (mention.effort) params.push(`effort=${mention.effort}`);
  if (mention.permission) params.push(`perm=${mention.permission}`);
  return `@model:${mention.modelId}${params.length ? `?${params.join("&")}` : ""}`;
}

function parseParams(query: string | undefined): { effort: string | null; permission: string | null } {
  let effort: string | null = null;
  let permission: string | null = null;
  for (const pair of (query ?? "").split("&")) {
    const [key, value] = pair.split("=");
    if (!value) continue;
    if (key === "effort") effort = value;
    else if (key === "perm") permission = value;
  }
  return { effort, permission };
}

/** Find every model token in `text`, in document order. */
export function parseModelMentions(text: string): ParsedModelMention[] {
  if (!text || !text.includes("@model:")) return [];
  const re = new RegExp(MODEL_TOKEN_SOURCE, "g");
  const out: ParsedModelMention[] = [];
  for (const match of text.matchAll(re)) {
    let modelId = match[1]!;
    let query = match[2];
    if (!query) {
      const trimmed = modelId.replace(TRAILING_PROSE_RE, "");
      if (!trimmed) continue;
      modelId = trimmed;
    } else {
      query = query.replace(TRAILING_PROSE_RE, "");
    }
    const { effort, permission } = parseParams(query);
    const token = formatRawToken(modelId, query);
    const tokenStart = (match.index ?? 0) + match[0]!.indexOf("@model:");
    out.push({ modelId, effort, permission, token, start: tokenStart, end: tokenStart + token.length });
  }
  return out;
}

function formatRawToken(modelId: string, query: string | undefined): string {
  return `@model:${modelId}${query ? `?${query}` : ""}`;
}

/** Parse one token such as `@model:x?effort=high`. Null when it is not a model token. */
export function parseModelMentionToken(token: string): ModelMention | null {
  const [first] = parseModelMentions(token.trim());
  return first && first.start === 0 && first.end === token.trim().length
    ? { modelId: first.modelId, effort: first.effort, permission: first.permission }
    : null;
}

/** True when a bare `@`-token body (the text after `@`) is a model token. */
export function isModelMentionTokenBody(body: string): boolean {
  return parseModelMentionToken(`@${body}`) !== null;
}

/** What the expansion needs to know about the model, from the caller's catalog. */
export type ModelMentionModelInfo = {
  displayName: string;
  /** Chat provider that runs it: claude, codex, opencode, cursor, ... */
  provider: string;
  /** Reasoning levels this model accepts. Empty when it has none. */
  reasoningTiers: readonly string[];
};

/** Short chip label: `DeepSeek V4.1 Flash · High · Full access`. */
export function modelMentionChipLabel(mention: ModelMention, displayName: string): string {
  return [
    displayName,
    mention.effort ? modelMentionEffortLabel(mention.effort) : null,
    modelMentionPermissionLabel(mention.permission),
  ].filter(Boolean).join(" · ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9._/:=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Detail for one `<ade-mention kind="model">` block. The block states the exact
 * ids and the flags for the three commands an agent uses to start work on
 * another model, so the agent copies them instead of guessing.
 */
export function buildModelMentionDetail(
  mention: ModelMention,
  info: ModelMentionModelInfo | null,
): {
  kind: "model";
  id: string;
  title: string;
  attributes: Array<[string, string]>;
  hint: string;
} {
  if (!info) {
    return {
      kind: "model",
      id: mention.modelId,
      title: "(unavailable)",
      attributes: [["resolved", "false"]],
      hint:
        `No model with id ${mention.modelId} is available on this machine. `
        + "Do not guess a replacement. Ask the user which model to use.",
    };
  }
  const effort = mention.effort && info.reasoningTiers.includes(mention.effort) ? mention.effort : null;
  const permission = isModelMentionPermissionMode(mention.permission) ? mention.permission : null;
  const flags = [
    `--provider ${shellQuote(info.provider)}`,
    `--model ${shellQuote(mention.modelId)}`,
    effort ? `--reasoning-effort ${shellQuote(effort)}` : null,
    permission ? `--permissions ${shellQuote(permission)}` : null,
  ].filter(Boolean).join(" ");
  const handoffFlags = [
    `--model ${shellQuote(mention.modelId)}`,
    effort ? `--effort ${shellQuote(effort)}` : null,
    permission ? `--permissions ${shellQuote(permission)}` : null,
  ].filter(Boolean).join(" ");
  const ignored: string[] = [];
  if (mention.effort && !effort) ignored.push(`thinking level "${mention.effort}" (this model does not accept it)`);
  if (mention.permission && !permission) ignored.push(`permission mode "${mention.permission}" (unknown mode)`);
  return {
    kind: "model",
    id: mention.modelId,
    title: info.displayName,
    attributes: [
      ["provider", info.provider],
      ["effort", effort ?? ""],
      ["permissions", permission ?? ""],
    ],
    hint: [
      "The user picked this model, thinking level, and permission mode. Use these exact values when you start or hand off work to it:",
      `- New chat in a lane: \`ade chat create --lane <lane> ${flags} --prompt "<task>"\``,
      `- Brief handoff of a chat: \`ade chat handoff <session> ${handoffFlags} --note "<instructions>"\``,
      ignored.length ? `Ignored from the chip: ${ignored.join("; ")}.` : null,
    ].filter(Boolean).join("\n"),
  };
}

/**
 * A model row in an `@` menu. Every surface (desktop, TUI, iOS) lists models
 * with the same shape and the same match rule.
 */
export type ComposerModelSuggestion = {
  modelId: string;
  title: string;
  /** Harness and route, e.g. "OpenCode · OpenCode Go". */
  subtitle: string;
  reasoningTiers: string[];
  defaultEffort: string | null;
};

const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Droid",
  pi: "Pi",
  qwen: "Qwen Code",
  kimi: "Kimi",
  grok: "Grok",
  copilot: "Copilot",
  devin: "Devin",
};

/** The harness that runs a provider group, e.g. "opencode" → "OpenCode". */
export function modelMentionHarnessLabel(group: string): string {
  return HARNESS_LABELS[group] ?? group;
}

/** "Harness · route" subtitle; the route is dropped when it repeats the harness. */
export function modelMentionSubtitle(harness: string, route: string | null | undefined): string {
  const trimmed = route?.trim();
  return trimmed && trimmed !== harness ? `${harness} · ${trimmed}` : harness;
}

const MAX_MODEL_RESULTS = 6;
/** Below this many characters a query is too short to mean a model. */
const MIN_MODEL_QUERY_LENGTH = 2;
/** Exact, prefix, and substring hits only; a subsequence hit is noise here. */
const MAX_MODEL_MATCH_SCORE = 2;

/**
 * Rank model rows for an @ query. A model shows only when the query names it
 * (word-prefix, prefix, or substring of the name, 2+ characters). `@model`
 * alone lists every model, and `@model deep` filters by the rest of the query.
 */
export function rankComposerModelSuggestions<T extends ComposerModelSuggestion>(
  models: T[],
  rawQuery: string,
): { rows: T[]; bestScore: number | null } {
  const query = rawQuery.trim();
  const keyword = /^models?(?:[:\s]+|$)/i.exec(query);
  const effectiveQuery = keyword ? query.slice(keyword[0].length).trim() : query;
  if (!keyword && effectiveQuery.length < MIN_MODEL_QUERY_LENGTH) return { rows: [], bestScore: null };
  const lowered = effectiveQuery.toLowerCase();
  const scored: Array<{ item: { id: string; model: T }; score: number; titlePrefixLength: number }> = [];
  for (const model of models) {
    // "opus" names "Claude Opus 5" as surely as "claude" does: a hit at the
    // start of any word in the name counts as a prefix hit.
    const wordPrefix = lowered.length > 0
      && model.title.toLowerCase().split(/[\s/._-]+/).some((word) => word.startsWith(lowered));
    const match = (wordPrefix ? { score: 1, titlePrefixLength: 0 } : null)
      ?? scoreChatMentionCandidate({ title: model.title, subtitle: model.subtitle }, effectiveQuery)
      ?? scoreChatMentionCandidate({ title: model.modelId }, effectiveQuery);
    if (!match) continue;
    if (!keyword && match.score > MAX_MODEL_MATCH_SCORE) continue;
    scored.push({ item: { id: model.modelId, model }, score: match.score, titlePrefixLength: match.titlePrefixLength });
  }
  scored.sort(compareChatMentionRanks);
  return {
    rows: scored.slice(0, MAX_MODEL_RESULTS).map((entry) => entry.item.model),
    bestScore: scored[0]?.score ?? null,
  };
}
