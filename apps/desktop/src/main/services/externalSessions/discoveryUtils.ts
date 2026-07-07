import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExternalSessionProvider,
  ExternalSessionSummary,
} from "../../../shared/types/externalSessions";

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
  limit?: number | null;
};

export const DEFAULT_EXTERNAL_SESSION_LIMIT = 50;
export const MAX_EXTERNAL_SESSION_LIMIT = 500;
export const JSONL_SCAN_LINE_LIMIT = 80;
export const JSONL_SCAN_BYTE_LIMIT = 512 * 1024;
export const MESSAGE_COUNT_MAX_BYTES = 768 * 1024;
export const EXTERNAL_SESSION_PREVIEW_MAX_LENGTH = 240;

const PLACEHOLDER_SESSION_TITLES = new Set([
  "new session",
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
  const envHome = typeof args?.env?.HOME === "string" ? args.env.HOME.trim() : "";
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

export function countJsonlLinesCheap(filePath: string): number | null {
  const stat = safeStat(filePath);
  if (!stat || stat.size > MESSAGE_COUNT_MAX_BYTES) return null;
  const text = readFilePrefix(filePath, MESSAGE_COUNT_MAX_BYTES + 1);
  if (!text) return 0;
  return text.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
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
  const title = raw?.replace(/\s+/gu, " ").trim() ?? "";
  if (!title) return null;
  const normalized = title.toLowerCase();
  if (PLACEHOLDER_SESSION_TITLES.has(normalized)) return null;
  if (/^new (?:session|chat)\s*[-:]\s*\d{4}-\d{2}-\d{2}/u.test(normalized)) return null;
  return title;
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

export function stripAdeGuidance(raw: string): string {
  let text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, " ")
    .replace(/\[ADE launch directive\][\s\S]*?(?=\n\n|$)/giu, " ")
    .replace(/## ADE CLI primer[\s\S]*?(?=User request:|<\/user_query>|$)/giu, " ")
    .replace(/## Project agent rules[\s\S]*?(?=User request:|<\/user_query>|$)/giu, " ")
    .replace(/ADE session guidance[\s\S]*?(?=\n\n|$)/giu, " ")
    .replace(/# AGENTS\.md instructions[\s\S]*?(?=User request:|<\/user_query>|$)/giu, " ");

  const userRequestIdx = text.lastIndexOf("User request:");
  if (userRequestIdx >= 0) {
    text = text.slice(userRequestIdx + "User request:".length);
  }
  const queryMatch = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/iu);
  if (queryMatch?.[1]) text = queryMatch[1];

  return text
    .replace(/<\/?[a-z][^>]*>/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function clipExternalSessionText(
  raw: string | null | undefined,
  max = EXTERNAL_SESSION_PREVIEW_MAX_LENGTH,
): string | null {
  const stripped = stripAdeGuidance(raw ?? "");
  if (!stripped) return null;
  if (stripped.length <= max) return stripped;
  return `${stripped.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

export function firstUserTextFromRecords(
  records: unknown[],
  max = EXTERNAL_SESSION_PREVIEW_MAX_LENGTH,
): string | null {
  for (const record of records) {
    const obj = asRecord(record);
    if (!obj) continue;
    const role = (asString(obj.role)
      ?? asString(asRecord(obj.message)?.role)
      ?? asString(asRecord(obj.payload)?.role)
      ?? asString(asRecord(asRecord(obj.payload)?.message)?.role))?.toLowerCase();
    const type = (asString(obj.type) ?? asString(asRecord(obj.payload)?.type))?.toLowerCase();
    const explicitNonUserRole = role === "assistant" || role === "system" || role === "tool";
    const isUser =
      role === "user"
      || (!explicitNonUserRole && (
        type === "user"
        || type === "user_message"
        || (!role && type === "message")
      ));
    if (!isUser) continue;
    const payload = asRecord(obj.payload) ?? obj;
    const text =
      extractText(asRecord(payload.message)?.content)
      ?? extractText(payload.message)
      ?? extractText(payload.content)
      ?? extractText(payload.text)
      ?? extractText(payload);
    const clipped = clipExternalSessionText(text, max);
    if (clipped) return clipped;
  }
  return null;
}

export function previewFromRecords(
  records: unknown[],
  max = EXTERNAL_SESSION_PREVIEW_MAX_LENGTH,
): string | null {
  for (const record of records) {
    const text = clipExternalSessionText(extractText(record), max);
    if (text) return text;
  }
  return null;
}

export function claudeProjectSlugForCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/gu, "-");
}

export function slashEscapedCwd(cwd: string): string {
  return cwd.replace(/\//gu, "-");
}

export function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

export function commandArrayToLine(parts: string[]): string {
  return parts.map((part) => {
    if (!part.length) return "''";
    if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(part)) return part;
    return `'${part.replace(/'/gu, "'\\''")}'`;
  }).join(" ");
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
  createdAt?: number | null;
  updatedAt?: number | null;
  messageCount?: number | null;
  filePath?: string | null;
}): ExternalSessionDiscoveryRecord {
  const stat = args.filePath ? safeStat(args.filePath) : null;
  return {
    provider: args.provider,
    id: args.id,
    cwd: args.cwd,
    title: args.title ?? null,
    preview: args.preview ?? null,
    createdAt: args.createdAt ?? null,
    updatedAt: args.updatedAt ?? (stat?.mtimeMs ? Math.floor(stat.mtimeMs) : null),
    messageCount: args.messageCount ?? null,
    sourcePath: args.filePath ?? null,
    sourceMtimeMs: stat?.mtimeMs ? Math.floor(stat.mtimeMs) : null,
  };
}

export function resolveExistingPath(candidate: string): string | null {
  try {
    return fs.existsSync(candidate) ? fs.realpathSync(candidate) : null;
  } catch {
    return null;
  }
}

export function cursorSlugCwdCandidates(slug: string): string[] {
  const candidates: string[] = [];
  const add = (candidate: string) => {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };

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
