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

type Entry = { offset: number; seq: number; dirty: boolean; laneId: string | null };
type StateFile = {
  v: 1;
  machineKey: string | null;
  chats: Record<string, Entry>;
  /** Deletes the server hasn't confirmed; sent again before the next upload. */
  deletes: Array<{ chatId?: string; laneId?: string }>;
};
const emptyState = (): StateFile => ({ v: 1, machineKey: null, chats: {}, deletes: [] });

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
  /** A chat turn ended. Marks the chat and uploads its new part in the background. */
  noteTurnEnded(sessionId: string): void;
  /** A chat was deleted: its copy goes too. */
  noteChatDeleted(sessionId: string): void;
  /** A lane was deleted: every copy of its chats goes too. */
  noteLaneDeleted(laneId: string): void;
  /** Uploads everything pending now; resolves when done or after `timeoutMs`. */
  uploadPending(timeoutMs?: number): Promise<CloudChatUploadPendingResult>;
  dispose(): void;
};

const uploaders = new Set<CloudChatUploader>();

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

function redactValue(value: unknown, redact: (text: string) => string, depth: number): unknown {
  if (typeof value === "string") {
    const cut = value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}\n[truncated]` : value;
    return redact(cut);
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_LINE_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, redact, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // A JSON field that holds a credential: the value alone looks like nothing.
    out[key] = typeof entry === "string" && SENSITIVE_KEY.test(key) && entry.length >= 4 ? REDACTED : redactValue(entry, redact, depth + 1);
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
  return JSON.stringify(redactValue(parsed, redact, 0));
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
    const token = await deps.getAccessToken().catch(() => null);
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
      await deps.flushTranscript(sessionId).catch(() => {});
      const reader = openTranscript(deps.chatTranscriptsDir, sessionId);
      if (!reader) return sent;
      const entry = state.chats[sessionId] ?? { offset: 0, seq: 0, dirty: true, laneId: null };
      state.chats[sessionId] = entry;
      if (reader.size === entry.offset) {
        entry.dirty = false;
        persist();
        return sent;
      }
      const delta = readDelta(reader, entry.offset, deps.redactSecrets);
      if (delta.kind === "none") {
        entry.dirty = false;
        persist();
        return sent;
      }
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
        return sent;
      }
      const row = await deps.readChatRow(sessionId).catch(() => null);
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
      persist();
      sent = true;
      if (mode === "turn" || !delta.more) return sent;
    }
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
    noteTurnEnded(sessionId) {
      if (disposed || !sessionId) return;
      const entry = state.chats[sessionId] ?? { offset: 0, seq: 0, dirty: true, laneId: null };
      entry.dirty = true;
      state.chats[sessionId] = entry;
      persist();
      void schedule(sessionId);
    },
    noteChatDeleted(sessionId) {
      if (!sessionId) return;
      delete state.chats[sessionId];
      state.deletes.push({ chatId: sessionId });
      persist();
      void runDeletes();
    },
    noteLaneDeleted(laneId) {
      if (!laneId) return;
      for (const [id, entry] of Object.entries(state.chats)) if (entry.laneId === laneId) delete state.chats[id];
      state.deletes.push({ laneId });
      persist();
      void runDeletes();
    },
    async uploadPending(timeoutMs = 45_000) {
      const started = Date.now();
      const deadline = started + timeoutMs;
      // Dirty chats plus any upload already running, so a turn that just ended is waited for.
      const pending = [...new Set([...Object.entries(state.chats).filter(([, entry]) => entry.dirty).map(([id]) => id), ...running.keys()])];
      let uploaded = 0;
      const drain = (async () => {
        await runDeletes().catch(() => {});
        let index = 0;
        const worker = async () => {
          while (index < pending.length) {
            const sessionId = pending[index++]!;
            await schedule(sessionId, "flush");
            await (running.get(sessionId) ?? Promise.resolve());
            if (!state.chats[sessionId]?.dirty) uploaded += 1;
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, pending.length || 1) }, worker));
      })();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timedOut = await Promise.race([
        drain.then(() => false, () => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (timer) clearTimeout(timer);
      const remaining = pending.filter((id) => state.chats[id]?.dirty).length;
      return { uploaded, remaining, timedOut };
    },
    dispose() {
      disposed = true;
      uploaders.delete(uploader);
    },
  };
  uploaders.add(uploader);
  return uploader;
}
