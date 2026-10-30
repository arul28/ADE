/**
 * What an ADE error report carries beyond the error, so that one report is
 * enough to find the cause:
 *   - the last lines this process logged, as the attachment
 *     `ade-log-tail.jsonl.gz`;
 *   - contexts other modules register (the brain connection, memory), read
 *     when the event is sent, so they describe the moment of the failure;
 *   - files other modules register (the project list journal, the brain's
 *     log), attached the same way.
 *
 * Every process's `beforeSend` calls `applySentryDiagnostics`, but it does
 * nothing until `enableSentryDiagnostics` runs, which only main and the brain
 * do. Renderer events pass through main's `beforeSend`, so they get main's
 * diagnostics too.
 *
 * Contexts cost nothing against the quota: the error quota counts events, not
 * bytes. Attachments have a quota of their own (1 GB a month for the whole
 * organization), so a process attaches files only to the first event of an
 * issue each day, and to a fixed number of events each day in total.
 */
import { countInLimiterWindow, createLimiterWindow, DAY_MS, limiterWindowHasRoom, rollLimiterWindow } from "./guardrails";
import { scrubDiagnosticText } from "./scrub";

/** Lines kept per process: the last several minutes of a busy brain. */
const LOG_TAIL_LINES = 1_000;
/** One line longer than this is cut: a giant meta object says little more. */
const LOG_TAIL_LINE_CHARS = 1_500;
/** Past this a line is not parsed to scrub it; only its time, level and event name are kept. */
const LOG_TAIL_PARSE_CHARS = 64_000;
/** The start the file logger gives every line, up to the end of its event name. */
const LOG_LINE_HEAD = /^\{"ts":"[^"]*","level":"[^"]*","event":"[^"]*"/;
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
 * One process spends at most `bytesPerDay` (1 MB) a day on files, and a
 * machine runs two reporting processes (main and the brain). A month for the
 * organization is then at most 60 MB times the number of machines that
 * report; in practice far less, since most machines send a few issues a day
 * and a gzip pair of files is about 60 KB. Check the attachment use in
 * Sentry's Stats page against the 1 GB before raising any of these.
 */
export const DEFAULT_DIAGNOSTIC_ATTACHMENT_BUDGET: DiagnosticAttachmentBudget = {
  perIssuePerDay: 1,
  totalPerDay: 15,
  bytesPerDay: 1_000_000,
};

const BYTES_PER_MB = 1024 * 1024;

/** Bytes as whole megabytes, the unit every diagnostic context uses. */
export function toMegabytes(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB);
}

let enabled = false;
let compress: ((text: string) => Uint8Array) | null = null;
const tail: string[] = new Array(LOG_TAIL_LINES);
let tailNext = 0;
let tailCount = 0;

/** The parts of an event the providers may read and this module writes. */
export type DiagnosticEvent = {
  message?: string;
  tags?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  exception?: { values?: Array<{ type?: string; value?: string }> };
};

/** An attachment as the SDK takes it from an event hint. */
export type DiagnosticHintAttachment = { filename: string; data: string | Uint8Array; contentType?: string };
export type DiagnosticHint = { attachments?: DiagnosticHintAttachment[] };

/** `data` is plain text; the process compresses it on the way out when it can. */
export type DiagnosticAttachment = { filename: string; data: string };

/** The tag a capture sets to ask for one named file (`registerSentryDiagnosticAttachment`). */
export const DIAGNOSTIC_ATTACH_TAG = "diagnostic.attach";

/** The event's own text: its message and every exception value. */
export function diagnosticEventText(event: DiagnosticEvent): string {
  return [event.message ?? "", ...(event.exception?.values ?? []).map((value) => value.value ?? "")].join("\n");
}

type ContextProvider = (event: DiagnosticEvent) => Record<string, unknown> | null | undefined;
type AttachmentProvider = (event: DiagnosticEvent) => DiagnosticAttachment | null | undefined;

const contextProviders = new Map<string, ContextProvider>();
const attachmentProviders = new Map<string, AttachmentProvider>();

/**
 * Turn diagnostics on for this process (main, brain). `gzip` comes from the
 * caller because this module also loads in the renderer, which has no
 * `node:zlib`. With it, each file goes out as `<name>.gz`, about an eighth of
 * its size.
 */
export function enableSentryDiagnostics(options: { gzip?: (text: string) => Uint8Array } = {}): void {
  enabled = true;
  if (options.gzip) compress = options.gzip;
}

/**
 * Record one log line, already serialized by the file logger. Cheap for an
 * ordinary line: one array slot, no copy. A no-op until diagnostics are on,
 * so dev builds and tests pay nothing.
 */
export function recordLogTailLine(line: string): void {
  if (!enabled) return;
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (trimmed.length <= LOG_TAIL_LINE_CHARS) {
    tail[tailNext] = trimmed;
  } else if (trimmed.length > LOG_TAIL_PARSE_CHARS) {
    // Too long to parse on every write. The head is the logger's own fields,
    // never a secret.
    const head = LOG_LINE_HEAD.exec(trimmed)?.[0] ?? "{}";
    tail[tailNext] = `${head}... [meta of ${trimmed.length} chars left out]`;
  } else {
    // Scrubbed whole, before the cut: a cut line is no longer JSON, and only
    // a JSON line is scrubbed by key (`pushToken`, `machineKey`).
    const scrubbed = scrubDiagnosticText(trimmed, trimmed.length);
    tail[tailNext] = scrubbed.length > LOG_TAIL_LINE_CHARS
      ? `${scrubbed.slice(0, LOG_TAIL_LINE_CHARS)}... [cut ${scrubbed.length - LOG_TAIL_LINE_CHARS} chars]`
      : scrubbed;
  }
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
  return scrubDiagnosticText(lines.reverse().join("\n"), LOG_TAIL_LINE_CHARS * 2);
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
  const day = createLimiterWindow();
  const hasRoom = (issueKey: string, nowMs: number): boolean => {
    rollLimiterWindow(day, DAY_MS, nowMs);
    return day.bytes < budget.bytesPerDay
      && limiterWindowHasRoom(day, issueKey, budget.totalPerDay, budget.perIssuePerDay);
  };
  return {
    hasRoom: (issueKey, nowMs = Date.now()) => hasRoom(issueKey, nowMs),
    admit(issueKey, bytes, nowMs = Date.now()) {
      if (!hasRoom(issueKey, nowMs) || day.bytes + bytes > budget.bytesPerDay) return false;
      countInLimiterWindow(day, issueKey, bytes);
      return true;
    },
  };
}

const processAttachmentLimiter = createAttachmentLimiter();

/** Cut a file to its newest characters, on a line boundary when there is one. */
export function newestChars(text: string, maxChars = DIAGNOSTIC_FILE_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(text.length - maxChars);
  const newline = cut.indexOf("\n");
  return newline >= 0 && newline < 2_000 ? cut.slice(newline + 1) : cut;
}

function packAttachment(filename: string, text: string): DiagnosticHintAttachment {
  if (compress) {
    try {
      return { filename: `${filename}.gz`, data: compress(text), contentType: "application/gzip" };
    } catch {
      // Send it plain.
    }
  }
  return { filename, data: text, contentType: "text/plain" };
}

const utf8 = new TextEncoder();

/** Bytes as sent: UTF-8 for plain text (this module also loads in the renderer, so no `Buffer`). */
function attachmentBytes(file: DiagnosticHintAttachment): number {
  return typeof file.data === "string" ? utf8.encode(file.data).byteLength : file.data.byteLength;
}

/**
 * Add contexts and, when the budget allows, files to an event that passed
 * every filter and the event budget. Never throws: a report with less detail
 * beats no report.
 */
export function applySentryDiagnostics(
  event: DiagnosticEvent,
  hint: DiagnosticHint | undefined,
  issueKey: string,
  limiter: AttachmentLimiter = processAttachmentLimiter,
): void {
  if (!enabled) return;
  for (const [name, provider] of contextProviders) {
    try {
      const value = provider(event);
      if (value) event.contexts = { ...(event.contexts ?? {}), [name]: value };
    } catch {
      // A broken provider must not cost the report.
    }
  }
  // Reading and compressing the files is the expensive part: skip it when
  // the budget would refuse them anyway.
  if (!hint || !limiter.hasRoom(issueKey)) return;
  try {
    const files: DiagnosticHintAttachment[] = [];
    const logTail = readLogTail();
    if (logTail) files.push(packAttachment("ade-log-tail.jsonl", logTail));
    for (const provider of attachmentProviders.values()) {
      try {
        const file = provider(event);
        if (!file?.data) continue;
        files.push(packAttachment(file.filename, scrubDiagnosticText(newestChars(file.data), LOG_TAIL_LINE_CHARS * 2)));
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
