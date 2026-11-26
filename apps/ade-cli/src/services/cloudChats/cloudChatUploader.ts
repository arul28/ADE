/**
 * Saves this cloud computer's chats to the account server, so they stay
 * readable while it's asleep, stopped, out of hours, or deleted (spec, "Saved
 * chats"). Only on a cloud computer (`ADE_CLOUD_INSTANCE_ID`); the transcript
 * on this disk stays the source of truth and this is a copy of it.
 *
 * After each chat turn ends, the new bytes of that chat's transcript go up as
 * one part, redacted line by line. At most one upload per turn: anything left
 * over, and any failed upload, waits for the next turn or `uploadPending`. A
 * failure here never touches the chat. No chat text reaches the logs.
 */

import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  cloudSavedChatLaneUrl,
  cloudSavedChatPartUrl,
  cloudSavedChatUrl,
  type CloudSavedChatRowInput,
} from "../../../../desktop/src/shared/cloudSavedChats";

/** Under the server's 8 MiB limit, with room for redaction to grow a part. */
const PART_BUDGET_BYTES = 6 * 1024 * 1024;
const PART_HARD_LIMIT_BYTES = 7 * 1024 * 1024;
/** A single string past this is cut; a transcript's real lines stay far under it. */
const MAX_STRING_CHARS = 256 * 1024;
const MAX_LINE_DEPTH = 40;
const REQUEST_TIMEOUT_MS = 30_000;
const STATE_FILE = "saved-chats.json";
const REDACTED = "[REDACTED]";
/** Field names that hold a credential, the same list `redactSecrets` treats as a JSON key. */
const SENSITIVE_KEY = /^(?:api[_-]?key|secret|token|password|authorization)$/i;

/**
 * `rowStale`: the chat's title, status or lane name changed after its last part; the next upload sends the row even with no new text.
 * `settings`: the composer settings the saved row last carried (`settingsKey`), so a setting changed with no turn after it still reaches the copy before a rest.
 * `laneColor`: the lane color the saved row last carried, so a lane recolored (or a copy saved before rows carried it) gets its row again before a rest.
 */
type Entry = { offset: number; seq: number; dirty: boolean; laneId: string | null; rowStale?: boolean; settings?: string; laneColor?: string | null };

/** The settings of a row as one comparable string; "" when it has none. */
function settingsKey(row: CloudSavedChatRowInput): string {
  return row.settings ? JSON.stringify(row.settings) : "";
}
type StateFile = {
  v: 1;
  machineKey: string | null;
  chats: Record<string, Entry>;
  /** Deletes the server hasn't confirmed; sent again before the next upload. */
  deletes: Array<{ chatId?: string; laneId?: string }>;
  /** Parent chat id → the saved copies of its native subagents (`uploadSubagentCopy`), so they go with it. */
  subagentCopies?: Record<string, string[]>;
};
const emptyState = (): StateFile => ({ v: 1, machineKey: null, chats: {}, deletes: [], subagentCopies: {} });

export type CloudChatUploaderDeps = {
  env?: NodeJS.ProcessEnv;
  /** This project's `.ade` directory. */
  adeDir: string;
  /** Where this project's chat transcripts live (`<sessionId>.jsonl`, or `.jsonl.gz`). */
  chatTranscriptsDir: string;
  directoryBaseUrl: () => string | null;
  /** The account token; null when this computer isn't signed in. */
  getAccessToken: () => Promise<string | null>;
  getMachineKey: () => string | null;
  /** The chat's row in the list, or null when the chat is gone. */
  readChatRow: (sessionId: string) => Promise<CloudSavedChatRowInput | null>;
  /** Waits until everything queued for this chat's transcript is on disk. */
  flushTranscript: (sessionId: string) => Promise<void>;
  redactSecrets: (text: string) => string;
  fetch?: typeof fetch;
  logger?: { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };
};

export type CloudChatUploadPendingResult = { uploaded: number; remaining: number; timedOut: boolean };

export type CloudChatUploader = {
  /**
   * A chat turn ended. Marks the chat and uploads its new part in the
   * background. `turnStatus` is the end of the turn (`done.status`): an end
   * that is not `interrupted` removes the "stopped for rest" mark.
   */
  noteTurnEnded(sessionId: string, turnStatus?: string): void;
  /** The chat's name changed (a title set after its turn ended): its saved copy gets the new row. */
  noteRowChanged(sessionId: string): void;
  /** A chat was deleted: its copy goes too. */
  noteChatDeleted(sessionId: string): void;
  /** A lane was deleted: every copy of its chats goes too. */
  noteLaneDeleted(laneId: string): void;
  /** Uploads everything pending now; resolves when done or after `timeoutMs`. */
  uploadPending(timeoutMs?: number): Promise<CloudChatUploadPendingResult>;
  /**
   * A chat restored here from its saved copy (fork-continue): the server
   * already holds its history up to `seq`, so the upload goes on from the
   * transcript's end as it is now. False when this project has no such chat.
   */
  adoptRestored(sessionId: string, seq: number, laneId: string | null): Promise<boolean>;
  /**
   * One native subagent's saved copy, as a chat row of its own under its
   * parent (`parentChatId`, `spawnKind: "native_subagent"`). The copy is one
   * part, replaced each time (the server takes a newer newest part). Null
   * when this project has no such parent chat.
   */
  uploadSubagentCopy(parentSessionId: string, copy: { chatId: string; text: string; title: string | null; lastActivityAt: string | null }): Promise<boolean | null>;
  dispose(): void;
};

const uploaders = new Set<CloudChatUploader>();
/**
 * Chats a fork-continue restores now. Their copy already moved here
 * (`moveSavedChat`), so an upload before `adoptRestored` would start at seq 1
 * and conflict with the moved copy. No upload starts for them until then.
 */
const restoringChats = new Set<string>();

/**
 * Chats whose running turn ADE stopped because this computer goes to sleep,
 * stops or is deleted (`prepare-stop`). Their saved row reads
 * `SAVED_CHAT_STOPPED_STATUS`, so a client shows the turn as Stopped, not
 * Done, while the computer rests. The next turn end that is not an interrupt
 * removes the mark. Kept in memory: the prepare uploads the chat at once.
 */
const stoppedForRest = new Set<string>();

/** ADE stops the turn of this chat for a sleep, a stop or a delete (`prepare-stop`). */
export function noteCloudChatStoppedForRest(sessionId: string): void {
  if (sessionId) stoppedForRest.add(sessionId);
}

/** Whether ADE stopped the last turn of this chat for a sleep, a stop or a delete. */
export function cloudChatStoppedForRest(sessionId: string): boolean {
  return stoppedForRest.has(sessionId);
}

/** Holds back every upload of `sessionId` until `adoptRestoredCloudChat` or `releaseRestoringCloudChat`. */
export function holdRestoringCloudChat(sessionId: string): void {
  restoringChats.add(sessionId);
}

/** Ends the hold after a restore that failed: the chat uploads as usual again. */
export function releaseRestoringCloudChat(sessionId: string): void {
  restoringChats.delete(sessionId);
}

/** Uploads one native subagent's copy through the uploader of the project that holds its parent. */
export async function uploadSubagentCloudCopy(
  parentSessionId: string,
  copy: { chatId: string; text: string; title: string | null; lastActivityAt: string | null },
): Promise<boolean> {
  for (const uploader of uploaders) {
    const result = await uploader.uploadSubagentCopy(parentSessionId, copy);
    if (result !== null) return result;
  }
  return false;
}

/** The restored chat's upload goes on from `seq` in the project that holds it (`CloudChatUploader.adoptRestored`). */
export async function adoptRestoredCloudChat(sessionId: string, seq: number, laneId: string | null): Promise<boolean> {
  try {
    for (const uploader of uploaders) {
      if (await uploader.adoptRestored(sessionId, seq, laneId)) return true;
    }
    return false;
  } finally {
    restoringChats.delete(sessionId);
  }
}

/**
 * Every project's pending uploads on this computer, for the out-of-hours path:
 * resolves when done or after `timeoutMs`, whichever comes first.
 */
export async function uploadPendingCloudChats(timeoutMs = 45_000): Promise<CloudChatUploadPendingResult> {
  const results = await Promise.all([...uploaders].map((uploader) => uploader.uploadPending(timeoutMs)));
  return results.reduce(
    (total, result) => ({
      uploaded: total.uploaded + result.uploaded,
      remaining: total.remaining + result.remaining,
      timedOut: total.timedOut || result.timedOut,
    }),
    { uploaded: 0, remaining: 0, timedOut: false },
  );
}

/**
 * A value a provider reads back byte for byte: a Claude thinking signature or
 * image `data`, a Codex `encrypted_content` or `image_url`, an OpenCode file
 * `url`. Kept only under these names and only when it has a blob's shape, so
 * a change can't break the resume and a key elsewhere still goes.
 */
const OPAQUE_KEYS: ReadonlySet<string> = new Set(["signature", "data", "encrypted_content", "image_url", "url"]);
const OPAQUE_BLOB = /^(?:[A-Za-z0-9+/_-]{256,}={0,2}|data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/]+={0,2})$/;

/** Node 22's lossless JSON numbers (`JSON.rawJSON`, the reviver's source text); absent on an older runtime. */
const jsonWithRaw = JSON as unknown as { rawJSON?: (text: string) => object; isRawJSON?: (value: unknown) => boolean };
const isRawJson = (value: unknown): boolean => jsonWithRaw.isRawJSON?.(value) === true;

/** `raw` parsed with each number kept as its own text (`9007199254740993`, `1.0`); null when the runtime can't, or it isn't JSON. */
function parseJsonExact(raw: string): unknown {
  const rawJSON = jsonWithRaw.rawJSON;
  if (!rawJSON) return null;
  try {
    return JSON.parse(raw, ((_key: string, value: unknown, context?: { source?: string }) =>
      typeof value === "number" && context?.source !== undefined && context.source !== String(value) ? rawJSON(context.source) : value) as (key: string, value: unknown) => unknown);
  } catch {
    return null;
  }
}

type RedactShape = { maxStringChars: number | null; maxDepth: number; keepOpaque: boolean };
const TRANSCRIPT_SHAPE: RedactShape = { maxStringChars: MAX_STRING_CHARS, maxDepth: MAX_LINE_DEPTH, keepOpaque: false };
/** A provider's own history: nothing is cut, since its resume reads every string back. */
const HISTORY_SHAPE: RedactShape = { maxStringChars: null, maxDepth: 200, keepOpaque: true };

/** `value` redacted; `redact` sees every string, and `mark` hears each field replaced by its name alone. */
function redactValue(value: unknown, redact: (text: string) => string, depth: number, shape: RedactShape, mark?: () => void): unknown {
  if (typeof value === "string") {
    const cut = shape.maxStringChars !== null && value.length > shape.maxStringChars ? `${value.slice(0, shape.maxStringChars)}\n[truncated]` : value;
    return redact(cut);
  }
  if (!value || typeof value !== "object" || isRawJson(value)) return value;
  if (depth >= shape.maxDepth) {
    mark?.();
    return "[truncated]";
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, redact, depth + 1, shape, mark));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && shape.keepOpaque && OPAQUE_KEYS.has(key) && OPAQUE_BLOB.test(entry)) {
      out[key] = entry;
    } else if (typeof entry === "string" && SENSITIVE_KEY.test(key) && entry.length >= 4) {
      // A JSON field that holds a credential: the value alone looks like nothing.
      mark?.();
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(entry, redact, depth + 1, shape, mark);
    }
  }
  return out;
}

/** One transcript line, redacted field by field so the JSON stays valid. Null for a line that isn't JSON. */
export function redactChatTranscriptLine(line: string, redact: (text: string) => string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return JSON.stringify(redactValue(parsed, redact, 0, TRANSCRIPT_SHAPE));
}

/**
 * One file of a provider's own history (a Claude session or subagent file, a
 * tool result, a Codex rollout, an OpenCode export), redacted before it
 * leaves the computer in a fork capsule. JSON stays JSON field by field (one
 * document, or one line at a time), so the provider still resumes from it;
 * anything else is redacted as text.
 */
export function redactProviderHistoryFile(text: string, redact: (text: string) => string): string {
  let changed = false;
  const mark = () => {
    changed = true;
  };
  const tracked = (entry: string) => {
    const next = redact(entry);
    if (next !== entry) changed = true;
    return next;
  };
  /** One JSON value redacted, or null when nothing in it changed (its text stays byte for byte). */
  const redactJson = (raw: string, value: object): string | null => {
    changed = false;
    const out = redactValue(value, tracked, 0, HISTORY_SHAPE, mark);
    if (!changed) return null;
    // Parsed again with each number's own text, so a large id or a `1.0` is written back as it was.
    const exact = parseJsonExact(raw);
    return JSON.stringify(exact && typeof exact === "object" ? redactValue(exact, redact, 0, HISTORY_SHAPE) : out);
  };
  const parseObject = (raw: string): object | null => {
    try {
      const value: unknown = JSON.parse(raw);
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  };
  const whole = text.trim() ? parseObject(text) : null;
  if (whole) {
    const out = redactJson(text, whole);
    return out === null ? text : `${out}${text.endsWith("\n") ? "\n" : ""}`;
  }
  // One JSON record per line. The lines between records are text, redacted
  // together, so a key across lines (a private key) goes too; with no record
  // at all that is the whole file (a plain tool result).
  const out: string[] = [];
  let block: string[] = [];
  const endBlock = () => {
    if (block.length) out.push(redact(block.join("\n")));
    block = [];
  };
  for (const line of text.split("\n")) {
    const value = line.trim() ? parseObject(line) : null;
    if (!value) {
      block.push(line);
      continue;
    }
    endBlock();
    out.push(redactJson(line, value) ?? line);
  }
  endBlock();
  return out.join("\n");
}

type Reader = { size: number; read: (position: number, length: number) => Buffer };

function openTranscript(dir: string, sessionId: string): Reader | null {
  const plain = path.join(dir, `${sessionId}.jsonl`);
  try {
    const stat = fs.statSync(plain);
    return {
      size: stat.size,
      read: (position, length) => {
        const fd = fs.openSync(plain, "r");
        try {
          const buffer = Buffer.alloc(length);
          const read = fs.readSync(fd, buffer, 0, length, position);
          return buffer.subarray(0, read);
        } finally {
          fs.closeSync(fd);
        }
      },
    };
  } catch {
    try {
      const raw = gunzipSync(fs.readFileSync(`${plain}.gz`));
      return { size: raw.length, read: (position, length) => raw.subarray(position, position + length) };
    } catch {
      return null;
    }
  }
}

type DeltaResult =
  | { kind: "none" }
  | { kind: "rewritten" }
  | { kind: "part"; text: string; nextOffset: number; more: boolean };

/** The next complete lines of a transcript, redacted, up to one part. */
function readDelta(reader: Reader, offset: number, redact: (text: string) => string): DeltaResult {
  if (reader.size < offset) return { kind: "rewritten" };
  let position = offset;
  const lines: string[] = [];
  let total = 0;
  while (position < reader.size && total < PART_BUDGET_BYTES) {
    const window = reader.read(position, Math.min(PART_BUDGET_BYTES, reader.size - position));
    const newline = window.lastIndexOf(0x0a);
    if (newline < 0) {
      // No newline in a whole budget of bytes: an oversized line. Skip past it.
      const skip = findLineEnd(reader, position + window.length);
      if (skip == null) break;
      position = skip;
      continue;
    }
    let start = 0;
    const complete = window.subarray(0, newline + 1);
    for (let end = 0; end < complete.length; end += 1) {
      if (complete[end] !== 0x0a) continue;
      const raw = complete.subarray(start, end).toString("utf8");
      const lineLength = end - start + 1;
      start = end + 1;
      const safe = raw.trim() ? redactChatTranscriptLine(raw, redact) : null;
      position += lineLength;
      if (safe == null) continue;
      if (total + safe.length + 1 > PART_HARD_LIMIT_BYTES && lines.length > 0) {
        position -= lineLength;
        return { kind: "part", text: `${lines.join("\n")}\n`, nextOffset: position, more: true };
      }
      lines.push(safe);
      total += Buffer.byteLength(safe, "utf8") + 1;
    }
  }
  if (lines.length === 0) {
    // Only unparseable or skipped lines: nothing to send, but they're behind us.
    return position === offset ? { kind: "none" } : { kind: "part", text: "", nextOffset: position, more: position < reader.size };
  }
  return { kind: "part", text: `${lines.join("\n")}\n`, nextOffset: position, more: position < reader.size };
}

/** The offset just past the newline at or after `from`, or null when there is none yet. */
function findLineEnd(reader: Reader, from: number): number | null {
  let position = from;
  while (position < reader.size) {
    const chunk = reader.read(position, Math.min(1024 * 1024, reader.size - position));
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) return position + newline + 1;
    position += chunk.length;
  }
  return null;
}

export function createCloudChatUploader(deps: CloudChatUploaderDeps): CloudChatUploader {
  const env = deps.env ?? process.env;
  const instanceId = env.ADE_CLOUD_INSTANCE_ID?.trim() ?? "";
  const statePath = path.join(deps.adeDir, "cloud", STATE_FILE);
  const fetcher = deps.fetch ?? fetch;
  const log = deps.logger;
  let state = readState();
  const running = new Map<string, Promise<void>>();
  const rerun = new Set<string>();
  let disposed = false;
  let deletesRunning: Promise<void> | null = null;

  function readState(): StateFile {
    try {
      const value = JSON.parse(fs.readFileSync(statePath, "utf8")) as StateFile;
      if (value?.v === 1 && value.chats && typeof value.chats === "object") {
        return { ...emptyState(), ...value, deletes: Array.isArray(value.deletes) ? value.deletes : [] };
      }
    } catch {
      // Missing or unreadable: start fresh. The server answers 409 and the chat restarts.
    }
    return emptyState();
  }

  function persist(): void {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch (error) {
      log?.warn("cloud.chat_upload_state_write_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  }

  const authHeaders = async (): Promise<Record<string, string> | null> => {
    const token = await deps.getAccessToken().catch((error: unknown) => {
      log?.warn("cloud.chat_upload_token_failed", { error: error instanceof Error ? error.name : "unknown" });
      return null;
    });
    return token ? { authorization: `Bearer ${token}` } : null;
  };

  /** This computer's machine key; a copy of the disk under a new key starts its uploads over. */
  function currentMachineKey(): string | null {
    const key = deps.getMachineKey();
    if (key && state.machineKey && state.machineKey !== key) {
      state = { ...emptyState(), machineKey: key };
      persist();
    } else if (key && !state.machineKey) {
      state.machineKey = key;
      persist();
    }
    return key;
  }

  async function runDeletes(): Promise<void> {
    if (deletesRunning) return deletesRunning;
    if (!state.deletes.length) return;
    deletesRunning = (async () => {
      const base = deps.directoryBaseUrl();
      const machineKey = currentMachineKey();
      const headers = await authHeaders();
      if (!base || !machineKey || !headers) return;
      for (const item of [...state.deletes]) {
        const url = item.chatId ? cloudSavedChatUrl(base, machineKey, item.chatId) : cloudSavedChatLaneUrl(base, machineKey, item.laneId ?? "");
        try {
          const response = await fetcher(url, { method: "DELETE", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
          if (!response.ok) throw new Error(`status_${response.status}`);
          state.deletes = state.deletes.filter((entry) => entry !== item);
          persist();
        } catch (error) {
          log?.warn("cloud.chat_delete_failed", { chatId: item.chatId ?? null, laneId: item.laneId ?? null, error: error instanceof Error ? error.message : "unknown" });
          return;
        }
      }
    })().finally(() => { deletesRunning = null; });
    return deletesRunning;
  }

  /** An upload already on the wire can land after the delete and bring the copy back, so delete once more when it's done. */
  function deleteAgainAfterUploads(item: { chatId?: string; laneId?: string }, uploads: Array<Promise<void>>): void {
    if (!uploads.length) return;
    void Promise.allSettled(uploads).then(async () => {
      state.deletes.push({ ...item });
      persist();
      // A delete pass in progress wouldn't see the new entry.
      await Promise.allSettled([deletesRunning]);
      await runDeletes();
    });
  }

  /** Sends what's new for one chat: one part on a turn, everything on a flush. True when anything was sent. */
  async function uploadChat(sessionId: string, mode: "turn" | "flush"): Promise<boolean> {
    const base = deps.directoryBaseUrl();
    const machineKey = currentMachineKey();
    const headers = await authHeaders();
    if (!base || !machineKey || !headers || !instanceId) {
      log?.warn("cloud.chat_upload_not_ready", { sessionId, base: Boolean(base), machineKey: Boolean(machineKey), signedIn: Boolean(headers) });
      return false;
    }
    await runDeletes();
    let sent = false;
    for (;;) {
      // A failed flush only means this part is shorter; the next turn sends the rest.
      await deps.flushTranscript(sessionId).catch((error: unknown) => {
        log?.warn("cloud.chat_upload_flush_failed", { sessionId, error: error instanceof Error ? error.name : "unknown" });
      });
      const reader = openTranscript(deps.chatTranscriptsDir, sessionId);
      if (!reader) return sent;
      const entry = state.chats[sessionId] ?? { offset: 0, seq: 0, dirty: true, laneId: null };
      state.chats[sessionId] = entry;
      if (reader.size === entry.offset) return await sendStaleRow(sessionId, entry, base, machineKey, headers) || sent;
      const delta = readDelta(reader, entry.offset, deps.redactSecrets);
      if (delta.kind === "none") return await sendStaleRow(sessionId, entry, base, machineKey, headers) || sent;
      if (delta.kind === "rewritten") {
        // The file got shorter than what was sent (a rewrite): the copy starts over.
        await deleteAndRestart(sessionId, base, machineKey, headers, entry);
        continue;
      }
      if (!delta.text) {
        entry.offset = delta.nextOffset;
        entry.dirty = delta.more;
        persist();
        if (delta.more) continue;
        return await sendStaleRow(sessionId, entry, base, machineKey, headers) || sent;
      }
      const row = await deps.readChatRow(sessionId).catch((error: unknown) => {
        log?.warn("cloud.chat_upload_row_failed", { sessionId, error: error instanceof Error ? error.name : "unknown" });
        return null;
      });
      if (!row) return sent;
      const seq = entry.seq + 1;
      let response: Response;
      try {
        response = await fetcher(cloudSavedChatPartUrl(base, machineKey, sessionId, seq), {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ instanceId, text: delta.text, row }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        log?.warn("cloud.chat_upload_failed", { sessionId, seq, error: error instanceof Error ? error.name : "unknown" });
        entry.dirty = true;
        persist();
        return sent;
      }
      if (response.status === 409) {
        // The copy and this computer disagree on the sequence: start the copy over.
        log?.warn("cloud.chat_upload_conflict", { sessionId, seq });
        await deleteAndRestart(sessionId, base, machineKey, headers, entry);
        return sent;
      }
      if (!response.ok) {
        const code = await response.json().then((body: { error?: { code?: string } }) => body?.error?.code ?? null).catch(() => null);
        // The account cap gets its own line so it's easy to spot. Either way the next turn tries again.
        log?.warn(code === "account_full" ? "cloud.chat_upload_account_full" : "cloud.chat_upload_failed", { sessionId, seq, status: response.status, code });
        entry.dirty = true;
        persist();
        return sent;
      }
      entry.seq = seq;
      entry.offset = delta.nextOffset;
      entry.dirty = delta.more;
      entry.laneId = row.laneId;
      // The row went with this part.
      entry.rowStale = false;
      entry.settings = settingsKey(row);
      entry.laneColor = row.laneColor ?? null;
      persist();
      sent = true;
      if (mode === "turn" || !delta.more) return sent;
    }
  }

  /**
   * No new text, but the row changed (a title set after the turn ended): an
   * empty part carries the row, so the saved copy shows the chat's name while
   * its computer sleeps. Only for a copy that exists (`seq > 0`); a first part
   * carries its row anyway. True when it was sent.
   */
  async function sendStaleRow(sessionId: string, entry: Entry, base: string, machineKey: string, headers: Record<string, string>): Promise<boolean> {
    if (!entry.rowStale || entry.seq < 1) {
      entry.dirty = false;
      persist();
      return false;
    }
    const row = await deps.readChatRow(sessionId).catch(() => null);
    if (!row) {
      entry.dirty = false;
      persist();
      return false;
    }
    const seq = entry.seq + 1;
    try {
      const response = await fetcher(cloudSavedChatPartUrl(base, machineKey, sessionId, seq), {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ instanceId, text: "", row }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`status_${response.status}`);
    } catch (error) {
      // Stays stale and dirty: the next turn or the flush before a sleep tries again.
      log?.warn("cloud.chat_row_upload_failed", { sessionId, seq, error: error instanceof Error ? error.message : "unknown" });
      entry.dirty = true;
      persist();
      return false;
    }
    entry.seq = seq;
    entry.rowStale = false;
    entry.dirty = false;
    entry.laneId = row.laneId;
    entry.settings = settingsKey(row);
    entry.laneColor = row.laneColor ?? null;
    persist();
    return true;
  }

  /**
   * Before a rest: a saved copy whose chat's settings changed with no turn
   * after the change (a thinking level picked, nothing sent) gets its row
   * again, so a client shows the chat's own settings while this computer
   * rests. A copy saved before rows carried settings gets them once here.
   */
  async function markChangedSettings(): Promise<void> {
    for (const [sessionId, entry] of Object.entries(state.chats)) {
      if (disposed) return;
      if (entry.dirty || entry.seq < 1 || running.has(sessionId) || restoringChats.has(sessionId)) continue;
      const row = await deps.readChatRow(sessionId).catch((error: unknown) => {
        log?.warn("cloud.chat_settings_row_read_failed", { sessionId, error: error instanceof Error ? error.name : "unknown" });
        return null;
      });
      if (!row) continue;
      const key = settingsKey(row);
      // A lane color the copy doesn't have yet (recolored, or saved before rows carried it).
      // A color that went away is a lane list that could not be read, not a change.
      const colorChanged = Boolean(row.laneColor) && row.laneColor !== entry.laneColor;
      // No key recorded yet (a copy older than settings): sent once. Settings
      // that went away are a summary that could not be read, not a change:
      // sending that row would clear the saved model too.
      if (!key && entry.settings) continue;
      if (!colorChanged && entry.settings !== undefined && key === entry.settings) continue;
      entry.rowStale = true;
      entry.dirty = true;
    }
    persist();
  }

  /**
   * Before a rest: a chat whose transcript grew after its last part gets
   * marked. Only `done` marks a chat during work, and some lines come after
   * it: the turn's diff summary (it waits on git), a notice or card written
   * while the chat is idle. One stat per saved chat, once per rest save, so
   * a streaming turn still uploads once.
   */
  async function markGrownTranscripts(): Promise<string[]> {
    const marked: string[] = [];
    for (const sessionId of Object.keys(state.chats)) {
      if (disposed) break;
      if (restoringChats.has(sessionId)) continue;
      // An upload still running sets `dirty` from the text it read, not from the file now.
      await running.get(sessionId)?.catch(() => {});
      const entry = state.chats[sessionId];
      if (!entry || entry.dirty) continue;
      // A line still queued in memory counts too.
      await deps.flushTranscript(sessionId).catch((error: unknown) => {
        log?.warn("cloud.chat_upload_flush_failed", { sessionId, error: error instanceof Error ? error.name : "unknown" });
      });
      let size: number;
      try {
        // Only the live file: a `.jsonl.gz` is not written to.
        size = fs.statSync(path.join(deps.chatTranscriptsDir, `${sessionId}.jsonl`)).size;
      } catch {
        continue;
      }
      if (size === entry.offset) continue;
      entry.dirty = true;
      marked.push(sessionId);
    }
    if (marked.length) persist();
    return marked;
  }

  async function deleteAndRestart(sessionId: string, base: string, machineKey: string, headers: Record<string, string>, entry: Entry): Promise<void> {
    try {
      const response = await fetcher(cloudSavedChatUrl(base, machineKey, sessionId), { method: "DELETE", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        entry.offset = 0;
        entry.seq = 0;
      }
    } catch (error) {
      log?.warn("cloud.chat_upload_restart_failed", { sessionId, error: error instanceof Error ? error.name : "unknown" });
    }
    entry.dirty = true;
    persist();
  }

  function schedule(sessionId: string, mode: "turn" | "flush" = "turn"): Promise<void> {
    // A chat being restored waits for `adoptRestored`; its dirty mark stays.
    if (restoringChats.has(sessionId)) return Promise.resolve();
    const existing = running.get(sessionId);
    if (existing) {
      rerun.add(sessionId);
      return existing;
    }
    const run = (async () => {
      try {
        await uploadChat(sessionId, mode);
      } catch (error) {
        log?.warn("cloud.chat_upload_error", { sessionId, error: error instanceof Error ? error.name : "unknown" });
      } finally {
        running.delete(sessionId);
        if (rerun.delete(sessionId) && !disposed) void schedule(sessionId, mode);
      }
    })();
    running.set(sessionId, run);
    return run;
  }

  const uploader: CloudChatUploader = {
    noteTurnEnded(sessionId, turnStatus) {
      if (turnStatus !== undefined && turnStatus !== "interrupted") stoppedForRest.delete(sessionId);
      if (disposed || !sessionId) return;
      const entry = state.chats[sessionId] ?? { offset: 0, seq: 0, dirty: true, laneId: null };
      entry.dirty = true;
      state.chats[sessionId] = entry;
      persist();
      void schedule(sessionId);
    },
    noteRowChanged(sessionId) {
      // Only a chat with a saved copy: a first upload carries its row anyway.
      const entry = state.chats[sessionId];
      if (disposed || !sessionId || !entry || entry.seq < 1) return;
      entry.rowStale = true;
      entry.dirty = true;
      persist();
      void schedule(sessionId);
    },
    noteChatDeleted(sessionId) {
      if (!sessionId) return;
      delete state.chats[sessionId];
      rerun.delete(sessionId);
      state.deletes.push({ chatId: sessionId });
      // Its subagents' saved copies go with it.
      for (const subId of state.subagentCopies?.[sessionId] ?? []) state.deletes.push({ chatId: subId });
      if (state.subagentCopies) delete state.subagentCopies[sessionId];
      persist();
      void runDeletes();
      const upload = running.get(sessionId);
      deleteAgainAfterUploads({ chatId: sessionId }, upload ? [upload] : []);
    },
    noteLaneDeleted(laneId) {
      if (!laneId) return;
      for (const [id, entry] of Object.entries(state.chats)) {
        if (entry.laneId !== laneId) continue;
        delete state.chats[id];
        rerun.delete(id);
      }
      state.deletes.push({ laneId });
      persist();
      void runDeletes();
      // Every upload: a chat's first one doesn't know its lane yet.
      deleteAgainAfterUploads({ laneId }, [...running.values()]);
    },
    async uploadPending(timeoutMs = 45_000) {
      const started = Date.now();
      const deadline = started + timeoutMs;
      let pending: string[] = [];
      let uploaded = 0;
      const flush = async (ids: string[]) => {
        let index = 0;
        const worker = async () => {
          while (index < ids.length) {
            const sessionId = ids[index++]!;
            await schedule(sessionId, "flush");
            await (running.get(sessionId) ?? Promise.resolve());
            if (!state.chats[sessionId]?.dirty) uploaded += 1;
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, ids.length || 1) }, worker));
      };
      const drain = (async () => {
        await runDeletes().catch(() => {});
        // Dirty chats plus any upload already running, so a turn that just ended is waited for.
        pending = [...new Set([...Object.entries(state.chats).filter(([, entry]) => entry.dirty).map(([id]) => id), ...running.keys()])];
        await flush(pending);
        // Then lines written after a turn's end, and rows whose settings changed with no new text.
        const grown = await markGrownTranscripts();
        await markChangedSettings().catch((error: unknown) => {
          log?.warn("cloud.chat_settings_check_failed", { error: error instanceof Error ? error.name : "unknown" });
        });
        const changed = [...new Set([...grown, ...Object.entries(state.chats).filter(([id, entry]) => entry.dirty && !pending.includes(id)).map(([id]) => id)])];
        pending = [...new Set([...pending, ...changed])];
        await flush(changed);
      })();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timedOut = await Promise.race([
        drain.then(() => false, () => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (timer) clearTimeout(timer);
      // A time-out before the list was made still counts what waits.
      const remaining = (pending.length ? pending : Object.keys(state.chats)).filter((id) => state.chats[id]?.dirty).length;
      return { uploaded, remaining, timedOut };
    },
    async adoptRestored(sessionId, seq, laneId) {
      if (disposed || !sessionId || !Number.isSafeInteger(seq) || seq < 0) return false;
      await deps.flushTranscript(sessionId).catch(() => {});
      const reader = openTranscript(deps.chatTranscriptsDir, sessionId);
      if (!reader) return false;
      currentMachineKey();
      state.chats[sessionId] = { offset: reader.size, seq, dirty: false, laneId };
      persist();
      return true;
    },
    async uploadSubagentCopy(parentSessionId, copy) {
      if (disposed || !parentSessionId) return null;
      if (!openTranscript(deps.chatTranscriptsDir, parentSessionId)) return null;
      const base = deps.directoryBaseUrl();
      const machineKey = currentMachineKey();
      const headers = await authHeaders();
      if (!base || !machineKey || !headers || !instanceId) return false;
      const parentRow = await deps.readChatRow(parentSessionId).catch(() => null);
      if (!parentRow) return false;
      const row: CloudSavedChatRowInput = {
        ...parentRow,
        title: copy.title ?? parentRow.title,
        status: "idle",
        lastActivityAt: copy.lastActivityAt ?? parentRow.lastActivityAt,
        parentChatId: parentSessionId,
        spawnKind: "native_subagent",
      };
      try {
        const response = await fetcher(cloudSavedChatPartUrl(base, machineKey, copy.chatId, 1), {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ instanceId, text: deps.redactSecrets(copy.text), row }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          log?.warn("cloud.subagent_copy_failed", { status: response.status });
          return false;
        }
      } catch (error) {
        log?.warn("cloud.subagent_copy_failed", { error: error instanceof Error ? error.name : "unknown" });
        return false;
      }
      const known = new Set(state.subagentCopies?.[parentSessionId] ?? []);
      if (!known.has(copy.chatId)) {
        state.subagentCopies = { ...(state.subagentCopies ?? {}), [parentSessionId]: [...known, copy.chatId] };
        persist();
      }
      return true;
    },
    dispose() {
      disposed = true;
      uploaders.delete(uploader);
    },
  };
  uploaders.add(uploader);
  return uploader;
}
