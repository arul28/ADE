import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExternalSessionMessage,
  ExternalSessionProvider,
  ExternalSessionSummary,
} from "../../../shared/types/externalSessions";
import type { TerminalResumeLaunchConfig } from "../../../shared/types/sessions";
import { commandArrayToLine as sharedCommandArrayToLine } from "../../../shared/shell";

export type ExternalSessionDiscoveryRecord = Omit<
  ExternalSessionSummary,
  "alreadyImported" | "possiblyActive" | "cwdMatchesRequestedLane" | "capabilities"
> & {
  sourcePath?: string | null;
  sourceMtimeMs?: number | null;
};

export type ExternalSessionDiscoveryArgs = {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string | null;
  projectRoot?: string | null;
  /** Exact provider session id to resolve without building a broad recent-session list. */
  sessionId?: string | null;
  limit?: number | null;
  scopeRoots?: string[] | null;
  logger?: {
    warn?: (message: string, fields?: Record<string, unknown>) => void;
    info?: (message: string, fields?: Record<string, unknown>) => void;
  } | null;
};

export type ExternalSessionFileCandidate<T extends Record<string, unknown> = Record<string, unknown>> = T & {
  filePath: string;
  mtimeMs: number;
  size: number;
};

export const DEFAULT_EXTERNAL_SESSION_LIMIT = 50;
export const MAX_EXTERNAL_SESSION_LIMIT = 5000;
export const JSONL_SCAN_LINE_LIMIT = 80;
export const JSONL_SCAN_BYTE_LIMIT = 512 * 1024;
export const MESSAGE_COUNT_MAX_BYTES = 768 * 1024;
export const EXTERNAL_SESSION_PREVIEW_MAX_LENGTH = 240;
export const EXTERNAL_SESSION_TITLE_MAX_LENGTH = 160;
export const EXTERNAL_SESSION_MESSAGES_MAX_COUNT = 8;
export const EXTERNAL_SESSION_MESSAGE_MAX_LENGTH = 320;
// Markup-dominant transport receipts are not useful session previews, while
// ordinary prose containing a short JSX/XML fragment remains recoverable.
export const EXTERNAL_SESSION_MARKUP_TEXT_MIN_RATIO = 0.35;
const EXTERNAL_SESSION_CLIP_BOUNDARY_WINDOW_RATIO = 0.25;

const PLACEHOLDER_SESSION_TITLES = new Set([
  "new session",
  "new agent",
  "untitled",
  "new chat",
]);

export function normalizeExternalSessionLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_EXTERNAL_SESSION_LIMIT;
  }
  return Math.max(1, Math.min(MAX_EXTERNAL_SESSION_LIMIT, Math.floor(limit)));
}

export function resolveHomeDir(args?: Pick<ExternalSessionDiscoveryArgs, "homeDir" | "env">): string {
  const explicit = typeof args?.homeDir === "string" ? args.homeDir.trim() : "";
  if (explicit) return explicit;
  const env = args?.env ?? process.env;
  const envHome = typeof env.HOME === "string" ? env.HOME.trim() : "";
  if (process.platform === "win32") {
    // `HOME` is not a Windows concept. When it is set at all it comes from a
    // POSIX emulation layer — Git Bash exports `HOME=/c/Users/<name>`, which no
    // `fs` call can resolve — so every session directory built from it silently
    // came back empty. `%USERPROFILE%` is the real home, and it is what the
    // provider CLIs themselves write under (`%USERPROFILE%\.claude`,
    // `%USERPROFILE%\.codex`). Matches getHomeDir() in cliExecutableResolver.
    const profile = typeof env.USERPROFILE === "string" ? env.USERPROFILE.trim() : "";
    if (profile) return profile;
    return path.win32.isAbsolute(envHome) ? envHome : os.homedir();
  }
  return envHome || os.homedir();
}

export function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

export function safeReadDir(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function sessionFileCandidate<T extends Record<string, unknown>>(
  filePath: string,
  extra: T,
): ExternalSessionFileCandidate<T> | null {
  const stat = safeStat(filePath);
  if (!stat?.isFile()) return null;
  return {
    ...extra,
    filePath,
    mtimeMs: Math.floor(stat.mtimeMs),
    size: stat.size,
  };
}

export function sortFileCandidatesByMtime<T extends ExternalSessionFileCandidate>(
  candidates: T[],
  limit: number,
): T[] {
  return candidates
    .slice()
    .sort((left, right) => {
      if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, limit);
}

export function safeParseJson(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function readFilePrefix(filePath: string, maxBytes = JSONL_SCAN_BYTE_LIMIT): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    if (bytesRead <= 0) return null;
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort close
      }
    }
  }
}

export function readFileSuffix(filePath: string, maxBytes = JSONL_SCAN_BYTE_LIMIT): string | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    const bytesToRead = Math.min(maxBytes, Math.max(0, stat.size));
    if (bytesToRead <= 0) return null;
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
    if (bytesRead <= 0) return null;
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort close
      }
    }
  }
}

export function readJsonlRecords(filePath: string, maxLines = JSONL_SCAN_LINE_LIMIT): unknown[] {
  const text = readFilePrefix(filePath);
  if (!text) return [];
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0).slice(0, maxLines);
  return lines
    .map((line) => safeParseJson(line))
    .filter((record): record is Record<string, unknown> => record != null);
}

function jsonlRecordsForSemanticCount(filePath: string): unknown[] | null {
  const stat = safeStat(filePath);
  if (!stat || stat.size > MESSAGE_COUNT_MAX_BYTES) return null;
  const text = readFilePrefix(filePath, MESSAGE_COUNT_MAX_BYTES + 1);
  if (text == null) return [];
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => safeParseJson(line))
    .filter((record): record is Record<string, unknown> => record != null);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

export function cleanSessionTitle(raw: string | null | undefined): string | null {
  const title = stripTerminalControlSequences(raw ?? "").replace(/\s+/gu, " ").trim();
  if (!title) return null;
  const normalized = title.toLowerCase();
  if (PLACEHOLDER_SESSION_TITLES.has(normalized)) return null;
  if (/^new (?:session|chat)\s*[-:]\s*\d{4}-\d{2}-\d{2}/u.test(normalized)) return null;
  return clipNormalizedExternalSessionText(title, EXTERNAL_SESSION_TITLE_MAX_LENGTH, "…");
}

export function asEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractText(value: unknown, depth = 0): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractText(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry?.trim()));
    return parts.length ? parts.join("\n") : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["text", "content", "message", "body", "summary", "title", "sessionTitle"]) {
    const direct = extractText(record[key], depth + 1);
    if (direct?.trim()) return direct;
  }
  return null;
}

function stripTerminalControlSequences(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1b[@-Z\\-_]/gu, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "");
}

/**
 * Transport wrappers stripped wholesale. Every name here must be distinctive
 * enough that it cannot plausibly occur in prose or pasted code — the unclosed
 * form below deletes everything after the tag, so a generic word like `status`
 * would truncate a real message. (`<status>` needs no entry of its own: it only
 * appears inside `<task-notification>`, which is stripped as a block.)
 */
const EXTERNAL_SESSION_NOISE_TAGS = [
  "system-reminder",
  "task-notification",
  "task-id",
  "tool-use-id",
  "output-file",
  "local-command-args",
  "local-command-caveat",
  "local-command-stdout",
  "command-name",
  "command-message",
  "command-args",
  "ide_opened_file",
  "ide_selection",
] as const;

function stripKnownNoiseTags(raw: string): string {
  let text = raw;
  for (const tag of EXTERNAL_SESSION_NOISE_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "giu"), " ");
    text = text.replace(new RegExp(`^(?:\\s*<\\/${tag}\\s*>)+`, "iu"), " ");
    // Suffix reads can begin or end inside a provider wrapper. Once a known
    // opening tag has no close, everything after it is untrusted transport.
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "giu"), " ");
  }
  return text;
}

function hasEnoughTextOutsideMarkup(text: string): boolean {
  const originalLength = text.replace(/\s+/gu, "").length;
  if (!originalLength) return false;
  const outsideMarkup = text
    .replace(/<[^>]*>/gu, " ")
    .replace(/<\/?[A-Za-z][A-Za-z0-9:_-]*\b[^<>\n]*$/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const outsideLength = outsideMarkup.replace(/\s+/gu, "").length;
  return outsideLength > 0
    && outsideLength / originalLength >= EXTERNAL_SESSION_MARKUP_TEXT_MIN_RATIO
    && /[\p{L}\p{N}_]{3}/u.test(outsideMarkup);
}

/**
 * Strip transport noise and return whatever real text is left.
 *
 * Deliberately does NOT apply the markup-density gate: this cleaner also feeds
 * `externalChatHistoryImport`, which builds the *imported chat transcript*.
 * Rejecting markup-heavy or very short turns there silently deletes real user
 * messages from someone's history — a pasted JSX snippet, or a reply as ordinary
 * as "ok". Preview selection wants that gate; history does not.
 */
function cleanExternalSessionText(raw: string): string | null {
  const cleaned = stripKnownNoiseTags(stripTerminalControlSequences(raw)).trim();
  return cleaned || null;
}

/**
 * Preview-only: text that is mostly markup makes a useless row heading, which is
 * how a raw `<task-notification>` blob once became a session's entire preview.
 * Import and message-count paths must not use this.
 */
function previewWorthyText(raw: string | null | undefined): string | null {
  const cleaned = raw?.trim();
  if (!cleaned) return null;
  return hasEnoughTextOutsideMarkup(cleaned) ? cleaned : null;
}

function isProviderGeneratedNotice(text: string): boolean {
  return /^token limit reached\.\s+use \/limits\b/iu.test(text)
    || /^caveat:\s+the messages below were generated by the user while running local commands\b/iu.test(text);
}

/**
 * Remove provider/ADE transport markup while preserving the user's actual
 * request. Known local-command wrappers are removed with their contents; a
 * generic tag strip alone would surface `/model` plumbing and caveat text.
 */
export function cleanExternalSessionUserText(raw: string): string | null {
  let text = stripKnownNoiseTags(stripTerminalControlSequences(raw));
  const hasKnownAdePreamble = /\[ADE launch directive\]|## ADE CLI primer|## Project agent rules|ADE session guidance|# AGENTS\.md instructions/iu.test(text);

  const queryMatches = Array.from(text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/giu));
  const lastQueryMatch = queryMatches.at(-1);
  if (lastQueryMatch) {
    const outsideQuery = text.replace(lastQueryMatch[0], "").trim();
    if (!outsideQuery || hasKnownAdePreamble) text = lastQueryMatch[1] ?? "";
  }

  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, " ")
    .replace(/\[ADE launch directive\][\s\S]*?(?=\n\n|$)/giu, " ")
    .replace(/## ADE CLI primer[\s\S]*?(?=User request:|<\/user_query>|$)/giu, " ")
    .replace(/## Project agent rules[\s\S]*?(?=User request:|<\/user_query>|$)/giu, " ")
    .replace(/ADE session guidance[\s\S]*?(?=\n\n|$)/giu, " ")
    .replace(/# AGENTS\.md instructions[\s\S]*?(?=User request:|<\/user_query>|$)/giu, " ");

  if (hasKnownAdePreamble) {
    const markers = ["User request:", "User prompt:"];
    let markerIndex = -1;
    let markerLength = 0;
    for (const marker of markers) {
      const index = text.lastIndexOf(marker);
      if (index > markerIndex) {
        markerIndex = index;
        markerLength = marker.length;
      }
    }
    if (markerIndex >= 0) text = text.slice(markerIndex + markerLength);
  }

  const cleaned = cleanExternalSessionText(text);
  if (!cleaned) return null;
  const normalizedForNotice = cleaned.replace(/\s+/gu, " ");
  return !isProviderGeneratedNotice(normalizedForNotice) ? cleaned : null;
}

export function stripAdeGuidance(raw: string): string {
  return cleanExternalSessionUserText(raw) ?? "";
}

export function clipExternalSessionText(
  raw: string | null | undefined,
  max = EXTERNAL_SESSION_PREVIEW_MAX_LENGTH,
): string | null {
  const stripped = stripAdeGuidance(raw ?? "");
  if (!stripped) return null;
  const normalized = stripped.replace(/\s+/gu, " ").trim();
  return clipNormalizedExternalSessionText(normalized, max, "...");
}

function clipNormalizedExternalSessionText(
  normalized: string,
  max: number,
  suffix: string,
): string | null {
  if (!normalized) return null;
  if (normalized.length <= max) return normalized;
  const contentBudget = Math.max(0, max - suffix.length);
  if (contentBudget <= 0) return suffix.slice(0, Math.max(0, max)) || null;
  let end = contentBudget;
  const lastWhitespace = normalized.lastIndexOf(" ", contentBudget);
  const boundaryFloor = Math.floor(contentBudget * (1 - EXTERNAL_SESSION_CLIP_BOUNDARY_WINDOW_RATIO));
  if (lastWhitespace >= boundaryFloor) end = lastWhitespace;
  let clipped = normalized.slice(0, end).trimEnd();
  const lastOpen = clipped.lastIndexOf("<");
  if (lastOpen > clipped.lastIndexOf(">")) clipped = clipped.slice(0, lastOpen).trimEnd();
  return clipped ? `${clipped}${suffix}` : null;
}

function extractUserFacingText(value: unknown, depth = 0): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractUserFacingText(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry?.trim()));
    return parts.length ? parts.join("\n") : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const type = asString(record.type)?.toLowerCase();
  if (type === "tool_result" || type === "tool_use" || type === "server_tool_use") return null;
  return extractText(record, depth);
}

/**
 * The shape both record readers need, parsed once.
 *
 * These two used to derive role, type, text, and timestamp with near-identical
 * inline chains — and they had already drifted: a record with `type: "message"`
 * and no explicit role counted toward `messageCount` and could become the
 * preview, but was dropped from `messages`. One classifier means they cannot
 * disagree about what a record is.
 */
type ExternalSessionRecordShape = {
  explicitRole: string | null;
  topType: string | null;
  payloadType: string | null;
  rawText: string | null;
  at: number | null;
  isMeta: boolean;
};

function externalSessionRecordShape(record: unknown): ExternalSessionRecordShape | null {
  const obj = asRecord(record);
  if (!obj) return null;
  const payload = asRecord(obj.payload);
  const message = asRecord(obj.message);
  const payloadMessage = asRecord(payload?.message);
  return {
    explicitRole: (
      asString(message?.role)
      ?? asString(payloadMessage?.role)
      ?? asString(payload?.role)
      ?? asString(obj.role)
    )?.toLowerCase() ?? null,
    topType: asString(obj.type)?.toLowerCase() ?? null,
    payloadType: asString(payload?.type)?.toLowerCase() ?? null,
    rawText: extractUserFacingText(payloadMessage?.content)
      ?? extractUserFacingText(message?.content)
      ?? extractUserFacingText(payload?.message)
      ?? extractUserFacingText(payload?.content)
      ?? extractUserFacingText(payload?.text)
      ?? extractUserFacingText(obj.content)
      ?? extractUserFacingText(obj.text),
    at: asEpochMs(obj.timestamp)
      ?? asEpochMs(message?.timestamp)
      ?? asEpochMs(payload?.timestamp)
      ?? asEpochMs(payloadMessage?.timestamp),
    isMeta: obj.isMeta === true,
  };
}

/** Single definition of "this record is a user turn", shared by both readers. */
function isUserShape(shape: ExternalSessionRecordShape): boolean {
  const { explicitRole, topType, payloadType } = shape;
  if (explicitRole === "user") return true;
  if (explicitRole === "assistant" || explicitRole === "system"
    || explicitRole === "tool" || explicitRole === "developer") return false;
  return topType === "user"
    || topType === "user_message"
    || payloadType === "user"
    || payloadType === "user_message"
    || topType === "message"
    || payloadType === "message";
}

function isAssistantShape(shape: ExternalSessionRecordShape): boolean {
  const { explicitRole, topType, payloadType } = shape;
  if (explicitRole === "assistant") return true;
  if (explicitRole) return false;
  return topType === "assistant"
    || topType === "assistant_message"
    || payloadType === "assistant"
    || payloadType === "assistant_message"
    || payloadType === "agent_message";
}

function externalSessionUserTextFromRecord(record: unknown): string | null {
  const shape = externalSessionRecordShape(record);
  if (!shape || shape.isMeta || !isUserShape(shape)) return null;
  return shape.rawText ? cleanExternalSessionUserText(shape.rawText) : null;
}

function recoverExternalSessionCommandName(raw: string | null): string | null {
  if (!raw) return null;
  const matches = Array.from(raw.matchAll(/<command-name\b[^>]*>\s*([\s\S]*?)\s*<\/command-name>/giu));
  const command = matches.at(-1)?.[1]?.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim() ?? "";
  return command ? cleanExternalSessionText(command) : null;
}

function externalSessionMessageFromRecord(record: unknown): ExternalSessionMessage | null {
  const shape = externalSessionRecordShape(record);
  if (!shape) return null;
  const role = isUserShape(shape) ? "user" : isAssistantShape(shape) ? "assistant" : null;
  if (!role) return null;
  // A meta row is plumbing, but a slash command inside one is a real thing the
  // user typed, so recover just that.
  if (shape.isMeta) {
    const command = recoverExternalSessionCommandName(shape.rawText);
    const text = clipExternalSessionText(command, EXTERNAL_SESSION_MESSAGE_MAX_LENGTH);
    return text ? { role: "user", text, at: shape.at } : null;
  }
  const cleaned = role === "user"
    ? shape.rawText
      ? cleanExternalSessionUserText(shape.rawText) ?? recoverExternalSessionCommandName(shape.rawText)
      : null
    : shape.rawText ? cleanExternalSessionText(shape.rawText) : null;
  const text = clipExternalSessionText(cleaned, EXTERNAL_SESSION_MESSAGE_MAX_LENGTH);
  return text ? { role, text, at: shape.at } : null;
}

export function firstUserTextFromRecords(
  records: unknown[],
  max = EXTERNAL_SESSION_PREVIEW_MAX_LENGTH,
): string | null {
  for (const record of records) {
    // The markup gate belongs here, not in the shared cleaner: a preview must be
    // readable, while imported history must stay verbatim.
    const worthy = previewWorthyText(externalSessionUserTextFromRecord(record));
    const clipped = clipExternalSessionText(worthy, max);
    if (clipped) return clipped;
  }
  return null;
}

export function recentExternalSessionMessagesFromRecords(
  records: unknown[],
  maxMessages = EXTERNAL_SESSION_MESSAGES_MAX_COUNT,
): ExternalSessionMessage[] {
  const limit = Math.max(0, Math.min(EXTERNAL_SESSION_MESSAGES_MAX_COUNT, Math.floor(maxMessages)));
  if (!limit) return [];
  return records
    .map((record) => externalSessionMessageFromRecord(record))
    .filter((message): message is ExternalSessionMessage => message != null)
    .filter((message) => previewWorthyText(message.text) != null)
    .slice(-limit);
}

/**
 * Codex persists a single conversational turn twice: a canonical `event_msg`
 * and a mirrored `response_item`. Sampling the raw rows would show every turn
 * twice and evict genuinely older exchanges from the capped window, so drop the
 * mirror whenever the canonical form is present in the same file.
 */
export function canonicalCodexRecords(records: unknown[]): unknown[] {
  const hasCanonical = records.some((record) => (
    asString(asRecord(record)?.type)?.toLowerCase() === "event_msg"
  ));
  if (!hasCanonical) return records;
  return records.filter((record) => (
    asString(asRecord(record)?.type)?.toLowerCase() !== "response_item"
  ));
}

function isCanonicalCodexUserRecord(record: unknown): boolean {
  const obj = asRecord(record);
  const payload = asRecord(obj?.payload);
  if (!obj || !payload || asString(obj.type)?.toLowerCase() !== "event_msg") return false;
  const payloadType = asString(payload.type)?.toLowerCase();
  const payloadRole = asString(payload.role)?.toLowerCase();
  return payloadType === "user_message" || (payloadType === "message" && payloadRole === "user");
}

/** `messageCount` is the number of meaningful user prompts, not JSONL rows. */
export function countExternalSessionUserMessages(
  records: unknown[],
  provider: ExternalSessionProvider,
): number {
  if (provider === "codex") {
    const canonical = records.filter(isCanonicalCodexUserRecord);
    if (canonical.length) {
      return canonical.reduce<number>((count, record) => count + (externalSessionUserTextFromRecord(record) ? 1 : 0), 0);
    }
  }
  return records.reduce<number>(
    (count, record) => count + (externalSessionUserTextFromRecord(record) ? 1 : 0),
    0,
  );
}

export function countJsonlUserMessagesCheap(
  filePath: string,
  provider: ExternalSessionProvider,
): number | null {
  const records = jsonlRecordsForSemanticCount(filePath);
  return records == null ? null : countExternalSessionUserMessages(records, provider);
}

export function claudeProjectSlugForCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/gu, "-");
}

export function slashEscapedCwd(cwd: string): string {
  return cwd.replace(/[\\/]/gu, "-");
}

export function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

/**
 * POSIX single-quoting produces a command line cmd.exe and PowerShell both
 * misread, so defer to the shared platform-aware quoter rather than keeping a
 * second, Unix-only copy here.
 */
export function commandArrayToLine(parts: string[]): string {
  return sharedCommandArrayToLine(parts);
}

export function directShellLaunchForCommandLine(commandLine: string): { command?: string; args?: string[] } {
  const trimmed = commandLine.trim();
  if (!trimmed || process.platform === "win32") return {};
  return { command: "/bin/bash", args: ["--noprofile", "--norc", "-lc", trimmed] };
}

export function sortDiscoveryRecords(records: ExternalSessionDiscoveryRecord[], limit: number): ExternalSessionDiscoveryRecord[] {
  return records
    .slice()
    .sort((left, right) => {
      const leftUpdated = left.updatedAt ?? left.createdAt ?? 0;
      const rightUpdated = right.updatedAt ?? right.createdAt ?? 0;
      if (rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;
      return `${left.provider}:${left.id}`.localeCompare(`${right.provider}:${right.id}`);
    })
    .slice(0, limit);
}

export function recordWithFile(args: {
  provider: ExternalSessionProvider;
  id: string;
  cwd: string | null;
  title?: string | null;
  preview?: string | null;
  messages?: ExternalSessionMessage[] | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  messageCount?: number | null;
  launch?: TerminalResumeLaunchConfig | null;
  filePath?: string | null;
  sourceMtimeMs?: number | null;
}): ExternalSessionDiscoveryRecord {
  const stat = args.filePath ? safeStat(args.filePath) : null;
  const sourceMtimeMs = typeof args.sourceMtimeMs === "number" && Number.isFinite(args.sourceMtimeMs)
    ? Math.floor(args.sourceMtimeMs)
    : stat ? Math.floor(stat.mtimeMs) : null;
  return {
    provider: args.provider,
    id: args.id,
    cwd: args.cwd,
    title: args.title ?? null,
    preview: args.preview ?? null,
    ...(args.messages !== undefined ? { messages: args.messages } : {}),
    createdAt: args.createdAt ?? null,
    updatedAt: args.updatedAt ?? sourceMtimeMs,
    messageCount: args.messageCount ?? null,
    launch: args.launch ?? null,
    sourcePath: args.filePath ?? null,
    sourceMtimeMs,
  };
}

export function resolveExistingPath(candidate: string): string | null {
  try {
    return fs.existsSync(candidate) ? fs.realpathSync(candidate) : null;
  } catch {
    return null;
  }
}

function uniqueNames(names: string[]): string[] {
  return names.filter((name, index) => name.length > 0 && names.indexOf(name) === index);
}

function cursorSlugMixedNames(parts: string[]): string[] {
  if (parts.length <= 1 || parts.length > 8) return [];
  const separatorSlots = parts.length - 1;
  const names: string[] = [];
  for (let mask = 0; mask < (1 << separatorSlots); mask += 1) {
    let name = parts[0] ?? "";
    for (let index = 1; index < parts.length; index += 1) {
      name += ((mask & (1 << (index - 1))) ? "." : "-") + parts[index];
    }
    names.push(name);
  }
  return names;
}

function cursorSlugSegmentNames(parts: string[]): string[] {
  const hyphen = parts.join("-");
  const dotted = parts.join(".");
  const mixed = cursorSlugMixedNames(parts);
  return uniqueNames([
    hyphen,
    dotted,
    ...mixed,
    `.${hyphen}`,
    `.${dotted}`,
    ...mixed.map((name) => `.${name}`),
  ]);
}

function greedyCursorSlugCwdCandidate(slug: string): string | null {
  const parts = slug.split("-").filter((part) => part.length > 0);
  if (!parts.length) return null;
  let current = path.parse(path.resolve("/")).root;
  let index = 0;

  while (index < parts.length) {
    let matched: { dir: string; nextIndex: number } | null = null;
    for (let nextIndex = parts.length; nextIndex > index; nextIndex -= 1) {
      const segmentParts = parts.slice(index, nextIndex);
      for (const name of cursorSlugSegmentNames(segmentParts)) {
        const candidate = path.join(current, name);
        const stat = safeStat(candidate);
        if (stat?.isDirectory()) {
          matched = { dir: candidate, nextIndex };
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) return null;
    current = matched.dir;
    index = matched.nextIndex;
  }

  return current;
}

export function cursorSlugCwdCandidates(slug: string): string[] {
  const candidates: string[] = [];
  const add = (candidate: string) => {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };

  const greedy = greedyCursorSlugCwdCandidate(slug);
  if (greedy) add(greedy);

  if (slug.startsWith("Users-")) {
    const parts = slug.split("-");
    if (parts.length >= 2) {
      const username = parts[1];
      const rest = parts.slice(2).join("-");
      if (username && rest) {
        const worktreeMarker = "-ade-worktrees-";
        const markerIdx = rest.indexOf(worktreeMarker);
        if (markerIdx >= 0) {
          const projectPart = rest.slice(0, markerIdx);
          const lanePart = rest.slice(markerIdx + worktreeMarker.length);
          add(path.join("/Users", username, ...projectPart.split("-"), ".ade", "worktrees", lanePart));
        }
        add(path.join("/Users", username, ...rest.split("-")));
      }
    }
  }

  add(`/${slug.replace(/-/gu, "/")}`);
  return candidates;
}

export function resolveCursorCwdFromSlug(slug: string): string | null {
  for (const candidate of cursorSlugCwdCandidates(slug)) {
    const resolved = resolveExistingPath(candidate);
    if (resolved) return resolved;
  }
  return null;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function realishPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function normalizeScopeRoots(scopeRoots: readonly string[] | null | undefined): string[] {
  const roots = new Set<string>();
  for (const root of scopeRoots ?? []) {
    const clean = root.trim();
    if (clean) roots.add(realishPath(clean));
  }
  return Array.from(roots);
}

function scopeRootPathVariants(scopeRoots: readonly string[] | null | undefined): string[] {
  const roots = new Set<string>();
  for (const root of scopeRoots ?? []) {
    const clean = root.trim();
    if (!clean) continue;
    roots.add(path.resolve(clean));
    roots.add(realishPath(clean));
  }
  return Array.from(roots);
}

export function cwdIsInScope(cwd: string | null | undefined, scopeRoots: readonly string[] | null | undefined): boolean {
  const roots = normalizeScopeRoots(scopeRoots);
  if (!roots.length) return true;
  const clean = cwd?.trim();
  if (!clean) return false;
  const resolved = realishPath(clean);
  return roots.some((root) => isPathInside(root, resolved));
}

export function cwdCandidatesIncludeScope(
  candidates: string[],
  scopeRoots: readonly string[] | null | undefined,
): boolean {
  const roots = normalizeScopeRoots(scopeRoots);
  if (!roots.length) return true;
  return candidates.some((candidate) => cwdIsInScope(candidate, roots));
}

export function slugMatchesScopeRoots(
  slug: string,
  scopeRoots: readonly string[] | null | undefined,
  slugForCwd: (cwd: string) => string,
): boolean {
  const roots = scopeRootPathVariants(scopeRoots);
  if (!roots.length) return true;
  return roots.some((root) => {
    const rootSlug = slugForCwd(root);
    return slug === rootSlug || slug.startsWith(`${rootSlug}-`);
  });
}
