/** Shared session/terminal utilities for the renderer. */

import type { AgentChatProvider, AgentChatSession, TerminalSessionSummary, TerminalToolType } from "../../shared/types";
import { chatSessionAgentLabel, PLUGIN_CHAT_PROVIDER } from "../../shared/types/chat";
import { isProviderSlashCommandInput } from "../../shared/chatSlashCommands";
import { stripElectronErrorWrapper } from "../../shared/codedError";
import {
  sessionNameIsLocked,
  sessionRenameBlockedMessage as sharedSessionRenameBlockedMessage,
} from "../../shared/cursorCloudNaming";

export {
  CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE,
  PLUGIN_RUNTIME_RENAME_BLOCKED_MESSAGE,
} from "../../shared/cursorCloudNaming";

/** Returns true if the tool type represents an AI chat session. */
export function isChatToolType(toolType: string | null | undefined): boolean {
  if (!toolType) return false;
  const t = toolType.trim().toLowerCase();
  return (
    t === "codex-chat"
    || t === "claude-chat"
    || t === "opencode-chat"
    || t === "cursor"
    || t.endsWith("-chat")
  );
}

/**
 * True when ADE must not rename this chat: Cursor owns the name, or the
 * plugin runtime declared `ownsName`.
 *
 * Wrapper over the shared predicate so renderer menus keep passing a
 * session object. A whitespace-only id is not a cloud agent.
 */
export function cursorOwnsSessionName(
  session: Pick<TerminalSessionSummary, "cursorCloudAgentId" | "runtimeRef">,
): boolean {
  return sessionNameIsLocked(session);
}

export function sessionRenameBlockedMessage(
  session: Pick<TerminalSessionSummary, "cursorCloudAgentId" | "runtimeRef">,
): string {
  return sharedSessionRenameBlockedMessage(session);
}

/**
 * Agent CLI sessions whose PTY accepts pasted tool context (and, with it, an
 * attached terminal). Shells are excluded: they host terminals but are not a
 * context insertion target.
 */
export function isPtyContextInsertableToolType(toolType: TerminalSessionSummary["toolType"]): boolean {
  return toolType === "claude"
    || toolType === "codex"
    || toolType === "cursor-cli"
    || toolType === "droid"
    || toolType === "opencode"
    || toolType === "qwen"
    || toolType === "kimi"
    || toolType === "grok"
    || toolType === "copilot";
}

/**
 * Turns a runtime rejection into copy a person can act on.
 *
 * Every runtime call the Work rows make crosses `ipcRenderer.invoke`, which
 * wraps the real message in `Error invoking remote method '<channel>': Error:
 * …`. That prefix names an IPC channel the user has no relationship with, and
 * it is the first thing they read in a red banner. Strip it, then translate the
 * two failures a person can actually do something about — an ownership mismatch
 * and an offline machine — into what is blocked and what to do next.
 */
export function formatSessionActionError(error: unknown, action: string): string {
  const raw = (error instanceof Error ? error.message : String(error ?? "")).trim();
  const message = stripElectronErrorWrapper(raw);
  if (!message) return `${action} failed. Try again.`;
  if (/(?:session|chat) '[^']*' was not found\.?$/i.test(message)) {
    // The session belongs to a different machine than the one the call reached,
    // or it is already gone. Both are fixed the same way, and neither is worth
    // showing the raw id for.
    return `${action} failed: that session is no longer on the machine this tab is connected to. Refresh the list, or switch to the machine that owns it and try again.`;
  }
  if (/is still owned by another ADE runtime/i.test(message)) {
    return `${action} failed: another ADE runtime still owns this session. Stop it from that machine first.`;
  }
  return `${action} failed: ${message}`;
}

export function canBulkStopSession(session: Pick<TerminalSessionSummary, "status" | "toolType">): boolean {
  return session.status === "running" && !isChatToolType(session.toolType);
}

export function canBulkDeleteSession(session: Pick<TerminalSessionSummary, "status" | "toolType">): boolean {
  return session.status !== "running" || isChatToolType(session.toolType);
}

/**
 * The chat provider ↔ tool type mapping, spelled out in both directions.
 *
 * Keyed on a literal union rather than `AgentChatProvider`: that type widens
 * with `string & {}` to stay open to runtimes ADE has not shipped yet, and a
 * `Record` over it checks nothing — a missing provider would compile. Naming
 * the six here is what makes adding a seventh a type error in this file.
 *
 * The reverse map is written out rather than derived, because `Object.entries`
 * loses the key types and the result needs a cast that hides exactly the same
 * mistake. So these are two hand-written literal tables that must agree; the
 * only thing keeping them in sync is the round-trip test in `sessions.test.ts`.
 *
 * The type-error guarantee is forward-only: the reverse map is keyed on `string`
 * (a lookup here takes an arbitrary runtime tool type), so a typo or an omission
 * on that side compiles fine and is caught by the test, not the compiler.
 */
export type KnownChatProvider =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "pi"
  | "opencode"
  | "qwen"
  | "kimi"
  | "grok"
  | "copilot";

export const CHAT_TOOL_TYPE_BY_PROVIDER: Record<KnownChatProvider, TerminalToolType> = {
  claude: "claude-chat",
  codex: "codex-chat",
  cursor: "cursor",
  droid: "droid-chat",
  pi: "pi-chat",
  opencode: "opencode-chat",
  qwen: "qwen-chat",
  kimi: "kimi-chat",
  grok: "grok-chat",
  copilot: "copilot-chat",
};

const CHAT_PROVIDER_BY_TOOL_TYPE: Record<string, KnownChatProvider> = {
  "claude-chat": "claude",
  "codex-chat": "codex",
  cursor: "cursor",
  "droid-chat": "droid",
  "pi-chat": "pi",
  "opencode-chat": "opencode",
  "qwen-chat": "qwen",
  "kimi-chat": "kimi",
  "grok-chat": "grok",
  "copilot-chat": "copilot",
};

/**
 * Tool type for a chat provider. An unrecognised provider falls back to
 * `opencode-chat`, which is what every caller has always got for one.
 */
export function chatToolTypeForProvider(provider: AgentChatProvider | string | null | undefined): TerminalToolType {
  // `Object.hasOwn`, not a plain lookup: the key is arbitrary runtime input, so
  // a provider named "constructor" or "toString" would otherwise resolve to an
  // inherited Object.prototype member instead of falling back.
  if (typeof provider === "string" && Object.hasOwn(CHAT_TOOL_TYPE_BY_PROVIDER, provider)) {
    return CHAT_TOOL_TYPE_BY_PROVIDER[provider as KnownChatProvider];
  }
  // A plugin-owned chat has no ADE tool behind it, so it gets the neutral tool
  // type rather than somebody else's. `"other"` is absent from `LOGO_MAP`, so
  // `ToolLogo` draws its generic mark, and `CHAT_PROVIDER_BY_TOOL_TYPE` has no
  // entry for it, so nothing tries to lock the pane to a built-in provider.
  // Without this the fallback below dressed a Cursor Cloud conversation in the
  // OpenCode logo.
  if (provider === PLUGIN_CHAT_PROVIDER) return "other";
  return "opencode-chat";
}

/**
 * Inverse of `chatToolTypeForProvider`: the chat provider a Work-row tool type
 * belongs to, or null when the tool type is not an ADE chat.
 *
 * Used to feed `AgentChatPane`'s `lockSessionProvider` prop — see its doc for
 * why the host supplies the provider.
 */
export function providerFromChatToolType(toolType: string | null | undefined): AgentChatProvider | null {
  if (!toolType) return null;
  const key = toolType.trim().toLowerCase();
  // Same prototype-chain guard as the forward direction: "constructor" and
  // "toString" are valid runtime strings and must resolve to null, not to an
  // inherited member of Object.prototype.
  if (!Object.hasOwn(CHAT_PROVIDER_BY_TOOL_TYPE, key)) return null;
  return CHAT_PROVIDER_BY_TOOL_TYPE[key] ?? null;
}

export const STALE_RUNNING_CLI_SESSION_MS = 24 * 60 * 60 * 1_000;
const STALE_RUNNING_CLI_SESSION_HOURS = STALE_RUNNING_CLI_SESSION_MS / (60 * 60 * 1_000);

/**
 * Returns how many hours a running CLI/shell session has been *idle* (no output),
 * or null if it is not stale. Staleness keys off the last activity timestamp —
 * not when the session started — so an old session that is still actively
 * producing output is never flagged; only genuinely untouched ones are. Falls
 * back to startedAt when no activity timestamp has been recorded yet.
 */
export function getStaleRunningCliSessionAgeHours(
  session: Pick<TerminalSessionSummary, "status" | "startedAt" | "toolType" | "lastActivityAt">,
  nowMs: number = Date.now(),
): number | null {
  if (session.status !== "running") return null;
  if (isChatToolType(session.toolType)) return null;
  const lastActivityMs = session.lastActivityAt ? Date.parse(session.lastActivityAt) : Number.NaN;
  const startedMs = Date.parse(session.startedAt);
  const referenceMs = Number.isFinite(lastActivityMs) ? lastActivityMs : startedMs;
  if (!Number.isFinite(referenceMs)) return null;
  const idleMs = nowMs - referenceMs;
  if (idleMs < STALE_RUNNING_CLI_SESSION_MS) return null;
  return Math.max(STALE_RUNNING_CLI_SESSION_HOURS, Math.floor(idleMs / (60 * 60 * 1_000)));
}

export function defaultSessionLabel(toolType: string | null | undefined): string {
  if (toolType === "shell" || toolType == null) return "Workspace";
  if (toolType === "claude-orchestrated") return "Claude worker";
  if (toolType === "codex-orchestrated") return "Codex worker";
  if (toolType === "opencode-orchestrated") return "OpenCode worker";
  if (toolType === "claude-chat") return "Claude chat";
  if (toolType === "codex-chat") return "Codex chat";
  if (toolType === "opencode-chat") return "OpenCode chat";
  if (toolType === "pi-chat") return "Pi chat";
  if (toolType === "cursor") return "Cursor chat";
  if (toolType === "cursor-cli") return "Cursor CLI session";
  if (toolType === "droid") return "Droid CLI session";
  if (toolType === "opencode") return "OpenCode CLI session";
  if (toolType === "droid-chat") return "Droid chat";
  if (toolType === "qwen-chat") return "Qwen chat";
  if (toolType === "kimi-chat") return "Kimi chat";
  if (toolType === "grok-chat") return "Grok chat";
  if (toolType === "copilot-chat") return "Copilot chat";
  if (toolType === "qwen") return "Qwen CLI session";
  if (toolType === "kimi") return "Kimi CLI session";
  if (toolType === "grok") return "Grok CLI session";
  if (toolType === "copilot") return "Copilot CLI session";
  if (toolType === "claude") return "Claude session";
  if (toolType === "codex") return "Codex session";
  return "Session";
}

export function buildOptimisticChatSessionSummary(args: {
  session: Pick<
    AgentChatSession,
    | "id"
    | "laneId"
    | "provider"
    | "status"
    | "currentTurnStartedAt"
    | "createdAt"
    | "lastActivityAt"
    | "idleSinceAt"
    | "orchestrationRunId"
    | "orchestrationRole"
    | "orchestrationTag"
    | "runtimeRef"
    | "runtimeLabel"
  >;
  laneName?: string | null;
}): TerminalSessionSummary {
  const toolType = chatToolTypeForProvider(args.session.provider);
  const isEnded = args.session.status === "ended";
  // A plugin-owned row says the runtime's own name — "Cursor Cloud", not
  // "Session" — because `toolType` cannot carry which plugin it is.
  const optimisticTitle = chatSessionAgentLabel(args.session, defaultSessionLabel(toolType));

  return {
    id: args.session.id,
    laneId: args.session.laneId,
    laneName: args.laneName?.trim() || args.session.laneId,
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType,
    title: optimisticTitle,
    status: isEnded ? "completed" : "running",
    startedAt: args.session.createdAt,
    endedAt: isEnded ? args.session.lastActivityAt : null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    lastActivityAt: args.session.lastActivityAt ?? null,
    currentTurnStartedAt: args.session.currentTurnStartedAt ?? null,
    summary: null,
    runtimeState: isEnded ? "exited" : args.session.status === "active" ? "running" : "idle",
    resumeCommand: null,
    chatIdleSinceAt: args.session.status === "idle" ? args.session.idleSinceAt ?? null : null,
    ...(args.session.orchestrationRunId
      ? {
          orchestrationRunId: args.session.orchestrationRunId,
          orchestrationRole: args.session.orchestrationRole,
          orchestrationTag: args.session.orchestrationTag,
        }
      : {}),
  };
}

/** Exact tool-type -> short label map for compact card display. */
const SHORT_TOOL_TYPE_LABELS: Record<string, string> = {
  shell: "Shell",
  cursor: "Cursor",
  "cursor-cli": "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
  qwen: "Qwen",
  kimi: "Kimi",
  grok: "Grok",
  copilot: "Copilot",
  aider: "Aider",
  continue: "Continue",
};

/** Prefix -> short label entries, checked in order for tool types like "claude-chat". */
const SHORT_TOOL_TYPE_PREFIXES: readonly [string, string][] = [
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
  ["pi", "Pi"],
  ["qwen", "Qwen"],
  ["kimi", "Kimi"],
  ["grok", "Grok"],
  ["copilot", "Copilot"],
];

/** Resolve a short label via exact match, prefix match, or hyphen-to-space fallback. */
function getShortToolTypeLabel(toolType: string): string {
  const exact = SHORT_TOOL_TYPE_LABELS[toolType];
  if (exact) return exact;
  for (const [prefix, label] of SHORT_TOOL_TYPE_PREFIXES) {
    if (toolType.startsWith(prefix)) return label;
  }
  return toolType.replace(/-/g, " ");
}

/** Short tool type label for compact card display (e.g. "Claude", "Shell", "Codex"). */
export function shortToolTypeLabel(toolType: string | null | undefined): string {
  if (!toolType) return "Shell";
  return getShortToolTypeLabel(toolType);
}

export function formatToolTypeLabel(toolType: string | null | undefined): string {
  if (toolType === "claude-orchestrated") return "Claude worker runtime";
  if (toolType === "codex-orchestrated") return "Codex worker runtime";
  if (toolType === "opencode-orchestrated") return "OpenCode worker runtime";
  if (toolType === "claude-chat") return "Claude chat";
  if (toolType === "codex-chat") return "Codex chat";
  if (toolType === "opencode-chat") return "OpenCode chat";
  if (toolType === "cursor") return "Cursor chat";
  if (toolType === "cursor-cli") return "Cursor CLI session";
  if (toolType === "droid") return "Droid CLI session";
  if (toolType === "opencode") return "OpenCode CLI session";
  if (toolType === "droid-chat") return "Droid chat";
  if (toolType === "qwen-chat") return "Qwen chat";
  if (toolType === "kimi-chat") return "Kimi chat";
  if (toolType === "grok-chat") return "Grok chat";
  if (toolType === "copilot-chat") return "Copilot chat";
  if (toolType === "qwen") return "Qwen CLI session";
  if (toolType === "kimi") return "Kimi CLI session";
  if (toolType === "grok") return "Grok CLI session";
  if (toolType === "copilot") return "Copilot CLI session";
  if (toolType === "claude") return "Claude session";
  if (toolType === "codex") return "Codex session";
  if (toolType === "shell") return "Terminal session";
  return toolType ? toolType.replace(/-/g, " ") : "Unknown";
}

/* ── Session label helpers ──
 * Shared logic for deriving human-readable labels from session metadata.
 * Used by SessionCard and WorkViewArea.
 */

const LABEL_OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const LABEL_CSI_REGEX = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const LABEL_CHARSET_REGEX = /\u001b[\(\)][0-9A-Za-z]/g;
const LABEL_TWO_CHAR_ESC_REGEX = /\u001b(?:[@-Z\\-_]|[0-9=>])/g;

export function stripTerminalLabelControls(raw: string): string {
  return raw
    .replace(LABEL_OSC_REGEX, "")
    .replace(LABEL_CSI_REGEX, "")
    .replace(LABEL_CHARSET_REGEX, "")
    .replace(LABEL_TWO_CHAR_ESC_REGEX, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function stripTerminalChromeFromLabel(raw: string): string {
  return raw
    .replace(/\(FAIL,\s*exit code (130|143)(?:,[^)]*)?\)/giu, "(STOPPED, exit code $1)")
    .replace(/\((FAIL,\s*exit code \d+),\s*(?:[╭╮╯╰─│┌┐└┘├┤┬┴┼▌▐▛▜▘▝▄▀█▒░].*|Claude Code.*|\? for shortcuts.*)\)/giu, "($1)")
    .replace(/\s*(?:[╭╮╯╰─│┌┐└┘├┤┬┴┼▌▐▛▜▘▝▄▀█▒░].*|Claude Codev?\d.*|\? for shortcuts.*)$/giu, "");
}

export function normalizeSessionLabel(raw: string | null | undefined): string | null {
  const normalized = stripTerminalChromeFromLabel(stripTerminalLabelControls(String(raw ?? ""))).replace(/\s+/g, " ").trim();
  return normalized.length ? normalized : null;
}

function stripOutcomePrefix(raw: string): string {
  const stripped = raw.replace(/^(completed?|done|finished|resolved|success|interrupted|failed|error)\b[\s:.-]*/iu, "").trim();
  return stripped.length ? stripped : raw;
}

export function isLowSignalSessionLabel(raw: string | null | undefined): boolean {
  const normalized = normalizeSessionLabel(raw);
  if (!normalized) return false;

  const collapsed = normalized
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();

  if (!collapsed.length) return true;
  if (isProviderSlashCommandInput(normalized)) return true;
  if (/\b(error|exception|apicall|traceback|stack\s*trace)\b/i.test(collapsed)) return true;
  if (/^(session closed|chat completed)\b/u.test(collapsed)) return true;

  if (/^(completed?|done|finished|resolved|success)\b/u.test(collapsed)) {
    const remainder = collapsed.replace(/^(completed?|done|finished|resolved|success)\b/u, "").trim();
    const remainderTokens = remainder.length ? remainder.split(/\s+/).filter(Boolean) : [];
    const genericRemainder = remainderTokens.every((token) =>
      /^(ok|okay|ready|hello|hi|test|yes|no|true|false|response|reply|result|output|pass|passed)$/u.test(token)
    );
    return !remainderTokens.length || remainderTokens.length <= 2 || genericRemainder;
  }

  return false;
}

export function preferredSessionLabel(raw: string | null | undefined): string | null {
  const normalized = normalizeSessionLabel(raw);
  if (!normalized || isLowSignalSessionLabel(normalized)) return null;
  return stripOutcomePrefix(normalized);
}

export function isGenericSessionTitle(session: TerminalSessionSummary, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return true;
  if (
    normalized === "opencode chat" ||
    normalized === "claude chat" ||
    normalized === "codex chat" ||
    normalized === "cursor chat" ||
    normalized === "claude code" ||
    normalized === "claude cli" ||
    normalized === "claude session" ||
    normalized === "codex" ||
    normalized === "codex cli" ||
    normalized === "codex session" ||
    normalized === "opencode worker" ||
    normalized === "claude worker" ||
    normalized === "codex worker"
  ) {
    return true;
  }
  if (
    (session.toolType === "shell" || session.toolType == null)
    && (normalized === "shell" || normalized === "terminal")
  ) {
    return true;
  }
  return false;
}

export function primarySessionLabel(session: TerminalSessionSummary): string {
  const title = preferredSessionLabel(session.title);
  if (title && !isGenericSessionTitle(session, title)) return title;
  // A plugin-owned chat with no title of its own says the runtime's name —
  // "Cursor Cloud" — ahead of the goal and the summary, because that is the
  // identity of the thing the user is talking to. `toolType` cannot say it:
  // there is one tool type for every plugin.
  const runtimeName = session.runtimeLabel?.displayName?.trim();
  if (runtimeName) return runtimeName;

  const goal = preferredSessionLabel(session.goal);
  if (goal) return goal;

  const summary = preferredSessionLabel(session.summary);
  if (summary) return summary;

  return defaultSessionLabel(session.toolType);
}

export function secondarySessionLabel(session: TerminalSessionSummary): string {
  const primary = primarySessionLabel(session);
  const summary = preferredSessionLabel(session.summary);
  if (summary && summary !== primary) return summary;

  const goal = preferredSessionLabel(session.goal);
  if (goal && goal !== primary) return goal;

  return "";
}

export function truncateSessionLabel(text: string, max = 24): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}
