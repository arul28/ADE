/**
 * What an ADE error report carries beyond the error, so that one report is
 * enough to find the cause:
 *   - the last lines this process logged, from info up, as the attachment
 *     `ade-log-tail.jsonl.gz`;
 *   - contexts other modules register (the brain connection, memory), read
 *     when the event is sent, so they describe the moment of the failure;
 *   - files other modules register (the project list journal, the brain's
 *     log), attached the same way.
 *
 * Only main and the brain apply this (`createSentryEventHooks({ diagnostics:
 * true })`). Renderer events pass through main's `beforeSend`, so they get
 * main's diagnostics too.
 *
 * Contexts cost nothing against the quota: the error quota counts events, not
 * bytes. Attachments have a quota of their own (1 GB a month for the whole
 * organization), so a process attaches files only to the first event of an
 * issue each day, and to a fixed number of events each day in total.
 */
import { scrubSecretsValue, scrubString } from "./scrub";

/** Lines kept per process: the last several minutes of a busy brain. */
const LOG_TAIL_LINES = 1_000;
/** One line longer than this is cut: a giant meta object says little more. */
const LOG_TAIL_LINE_CHARS = 1_500;
/** The log tail file is the newest lines that fit in this many characters. */
const LOG_TAIL_ATTACHMENT_CHARS = 256_000;
/** A registered file is cut to its newest characters past this size. */
export const DIAGNOSTIC_FILE_MAX_CHARS = 256_000;

export type DiagnosticAttachmentBudget = {
  /** Events of one issue that get files, per process per day. */
  perIssuePerDay: number;
  /** Events that get files, per process per day. */
  totalPerDay: number;
  /** Attachment bytes as sent (compressed when the process compresses), per process per day. */
  bytesPerDay: number;
};

/**
 * Sized against the organization's 1 GB a month of attachments, about 100 MB
 * of which minidumps use. About 45 machines report, and the first event of an
 * issue is the one a reader opens. A compressed pair of files is about 60 KB,
 * so one process spends at most 1 MB a day, and the organization about 200 MB
 * a month at today's error rate.
 */
export const DEFAULT_DIAGNOSTIC_ATTACHMENT_BUDGET: DiagnosticAttachmentBudget = {
  perIssuePerDay: 1,
  totalPerDay: 15,
  bytesPerDay: 1_000_000,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_ISSUES = 500;

let enabled = false;
let compress: ((text: string) => Uint8Array) | null = null;
const tail: string[] = new Array(LOG_TAIL_LINES);
let tailNext = 0;
let tailCount = 0;

/** The parts of an event the providers may read. */
export type DiagnosticEvent = {
  message?: string;
  tags?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  exception?: { values?: Array<{ type?: string; value?: string }> };
};

/** The tag a capture sets to ask for one named file (`registerSentryDiagnosticAttachment`). */
export const DIAGNOSTIC_ATTACH_TAG = "diagnostic.attach";

/** The event's own text: its message and every exception value. */
export function diagnosticEventText(event: DiagnosticEvent): string {
  return [event.message ?? "", ...(event.exception?.values ?? []).map((value) => value.value ?? "")].join("\n");
}

/** `data` is plain text; the process compresses it on the way out when it can. */
export type DiagnosticAttachment = { filename: string; data: string };

type ContextProvider = () => Record<string, unknown> | null | undefined;
type AttachmentProvider = (event: DiagnosticEvent) => DiagnosticAttachment | null | undefined;

const contextProviders = new Map<string, ContextProvider>();
const attachmentProviders = new Map<string, AttachmentProvider>();

/**
 * Called once by a process that sends reports with diagnostics (main, brain).
 * `gzip` comes from the caller because this module also loads in the
 * renderer, which has no `node:zlib`. With it, each file goes out as
 * `<name>.gz`, about an eighth of its size.
 */
export function enableSentryDiagnostics(options: { gzip?: (text: string) => Uint8Array } = {}): void {
  enabled = true;
  if (options.gzip) compress = options.gzip;
}

/**
 * Record one log line, already serialized by the file logger. Cheap: one
 * array slot, no copy unless the line is long. A no-op until diagnostics are
 * on, so dev builds and tests pay nothing.
 */
export function recordLogTailLine(line: string): void {
  if (!enabled) return;
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  tail[tailNext] = trimmed.length > LOG_TAIL_LINE_CHARS
    ? `${trimmed.slice(0, LOG_TAIL_LINE_CHARS)}... [cut ${trimmed.length - LOG_TAIL_LINE_CHARS} chars]`
    : trimmed;
  tailNext = (tailNext + 1) % LOG_TAIL_LINES;
  if (tailCount < LOG_TAIL_LINES) tailCount += 1;
}

/** The newest lines, oldest first, that fit in `maxChars`. Secrets removed. */
export function readLogTail(maxChars = LOG_TAIL_ATTACHMENT_CHARS): string {
  const lines: string[] = [];
  let size = 0;
  for (let index = 0; index < tailCount; index += 1) {
    const slot = (tailNext - 1 - index + LOG_TAIL_LINES) % LOG_TAIL_LINES;
    const line = tail[slot] ?? "";
    if (size + line.length + 1 > maxChars) break;
    lines.push(line);
    size += line.length + 1;
  }
  return scrubDiagnosticText(lines.reverse().join("\n"));
}

/**
 * Remove secrets from a diagnostic file line by line. A JSON line is scrubbed
 * by key (`accessToken`, `secret`) as well as by shape; any other line by
 * shape only.
 */
export function scrubDiagnosticText(text: string): string {
  if (!text) return text;
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        return JSON.stringify(scrubSecretsValue(JSON.parse(trimmed)));
      } catch {
        // Not JSON after all (or a cut line); scrub it as text.
      }
    }
    return scrubString(line, { maxLength: LOG_TAIL_LINE_CHARS * 2 });
  }).join("\n");
}

/** A named context set on every event at send time. A provider that throws is skipped. */
export function registerSentryDiagnosticContext(name: string, provider: ContextProvider): () => void {
  contextProviders.set(name, provider);
  return () => {
    if (contextProviders.get(name) === provider) contextProviders.delete(name);
  };
}

/** A file attached to events that get attachments. Return null to attach nothing. */
export function registerSentryDiagnosticAttachment(name: string, provider: AttachmentProvider): () => void {
  attachmentProviders.set(name, provider);
  return () => {
    if (attachmentProviders.get(name) === provider) attachmentProviders.delete(name);
  };
}

export type AttachmentLimiter = {
  /** Whether an event of this issue could still get files today; records nothing. */
  hasRoom(issueKey: string, nowMs?: number): boolean;
  /** True when the files may go; records them against the budget. */
  admit(issueKey: string, bytes: number, nowMs?: number): boolean;
};

export function createAttachmentLimiter(
  budget: DiagnosticAttachmentBudget = DEFAULT_DIAGNOSTIC_ATTACHMENT_BUDGET,
): AttachmentLimiter {
  let windowStart = 0;
  let total = 0;
  let bytes = 0;
  const perIssue = new Map<string, number>();
  const roll = (nowMs: number) => {
    if (nowMs - windowStart < DAY_MS) return;
    windowStart = nowMs;
    total = 0;
    bytes = 0;
    perIssue.clear();
  };
  const hasRoom = (issueKey: string, nowMs: number): boolean => {
    roll(nowMs);
    if (total >= budget.totalPerDay || bytes >= budget.bytesPerDay) return false;
    const seen = perIssue.get(issueKey) ?? 0;
    if (seen >= budget.perIssuePerDay) return false;
    return perIssue.has(issueKey) || perIssue.size < MAX_TRACKED_ISSUES;
  };
  return {
    hasRoom: (issueKey, nowMs = Date.now()) => hasRoom(issueKey, nowMs),
    admit(issueKey, size, nowMs = Date.now()) {
      if (!hasRoom(issueKey, nowMs) || bytes + size > budget.bytesPerDay) return false;
      const seen = perIssue.get(issueKey) ?? 0;
      perIssue.set(issueKey, seen + 1);
      total += 1;
      bytes += size;
      return true;
    },
  };
}

type Attachment = { filename: string; data: string | Uint8Array; contentType?: string };
type MutableHint = { attachments?: Attachment[] };
type MutableEvent = DiagnosticEvent & { contexts?: Record<string, unknown> };

/** Cut a file to its newest characters, on a line boundary when there is one. */
export function newestChars(text: string, maxChars = DIAGNOSTIC_FILE_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(text.length - maxChars);
  const newline = cut.indexOf("\n");
  return newline >= 0 && newline < 2_000 ? cut.slice(newline + 1) : cut;
}

function packAttachment(filename: string, text: string): Attachment {
  if (compress) {
    try {
      return { filename: `${filename}.gz`, data: compress(text), contentType: "application/gzip" };
    } catch {
      // Send it plain.
    }
  }
  return { filename, data: text, contentType: "text/plain" };
}

function attachmentBytes(file: Attachment): number {
  return typeof file.data === "string" ? file.data.length : file.data.byteLength;
}

/**
 * Add contexts and, when the budget allows, files to an event that passed
 * every filter and the event budget. Never throws: a report with less detail
 * beats no report.
 */
export function applySentryDiagnostics(
  event: MutableEvent,
  hint: MutableHint | undefined,
  issueKey: string,
  limiter: AttachmentLimiter,
): void {
  if (!enabled) return;
  for (const [name, provider] of contextProviders) {
    try {
      const value = provider();
      if (value) event.contexts = { ...(event.contexts ?? {}), [name]: value };
    } catch {
      // A broken provider must not cost the report.
    }
  }
  // Reading and compressing the files is the expensive part: skip it when
  // the budget would refuse them anyway.
  if (!hint || !limiter.hasRoom(issueKey)) return;
  try {
    const files: Attachment[] = [];
    const logTail = readLogTail();
    if (logTail) files.push(packAttachment("ade-log-tail.jsonl", logTail));
    for (const provider of attachmentProviders.values()) {
      try {
        const file = provider(event);
        if (!file?.data) continue;
        files.push(packAttachment(file.filename, scrubDiagnosticText(newestChars(file.data))));
      } catch {
        // Skip the one file.
      }
    }
    if (files.length === 0) return;
    const size = files.reduce((sum, file) => sum + attachmentBytes(file), 0);
    if (!limiter.admit(issueKey, size)) return;
    hint.attachments = [...(hint.attachments ?? []), ...files];
  } catch {
    // Diagnostics are best effort.
  }
}
