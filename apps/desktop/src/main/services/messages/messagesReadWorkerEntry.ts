/**
 * Child-process entry for the Messages reader.
 *
 * One JSON request in on stdin, one JSON response out on stdout, then exit.
 * Nothing else runs in this process, which is the point: the synchronous
 * `node:sqlite` reads happen off the Electron main thread, and macOS attributes
 * the Full Disk Access check to this child of ADE.app.
 *
 * Message text, senders and codes travel back over the pipe and are never
 * written to a file or a log here.
 *
 * @module messages/messagesReadWorkerEntry
 */
import {
  checkMessagesDatabaseAccess,
  defaultMessagesDatabasePath,
  isFullDiskAccessDenial,
  listChats,
  openMessagesDatabase,
  readRecentMessages,
  type MessagesAccessFailure,
} from "./messagesDatabase";
import type { MessagesReadRequest, MessagesReadResponse } from "./messagesReadWorkerClient";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function failureFor(error: unknown): MessagesAccessFailure {
  if (isFullDiskAccessDenial(error)) {
    return { ok: false, code: "needs_full_disk_access", message: "ADE needs Full Disk Access to read Messages." };
  }
  if ((error as { code?: unknown } | null)?.code === "ENOENT") {
    return { ok: false, code: "no_database", message: "Messages has no database on this Mac yet." };
  }
  return { ok: false, code: "error", message: "Messages could not be read." };
}

/**
 * Validates and runs one request. Kept separate from the stdin/stdout shell so
 * the dispatch is readable and the only values that leave are typed answers.
 */
export function runMessagesReadRequest(request: MessagesReadRequest): MessagesReadResponse {
  if (process.platform !== "darwin") {
    return { ok: false, code: "unsupported_platform", message: "Messages is available on Macs only." };
  }

  const databasePath = defaultMessagesDatabasePath();
  const access = checkMessagesDatabaseAccess(databasePath);
  if (!access.ok) {
    return { ok: false, code: access.code, message: access.message };
  }
  if (request.op === "access") {
    return { ok: true, op: "access", path: access.path };
  }

  let db: ReturnType<typeof openMessagesDatabase> | null = null;
  try {
    db = openMessagesDatabase(databasePath);
    if (request.op === "chats") {
      return { ok: true, op: "chats", chats: listChats(db, { limit: request.limit }) };
    }
    return { ok: true, op: "recent", messages: readRecentMessages(db, request) };
  } catch (error) {
    return failureFor(error);
  } finally {
    try {
      db?.close();
    } catch {
      // A read-only handle closing late cannot lose anything.
    }
  }
}

function parseRequest(raw: string): MessagesReadRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const request = parsed as Record<string, unknown>;
  if (request.op !== "recent" && request.op !== "chats" && request.op !== "access") return null;
  return request as MessagesReadRequest;
}

void (async () => {
  try {
    const request = parseRequest(await readStdin());
    if (request === null) {
      process.stdout.write(JSON.stringify({
        ok: false,
        code: "error",
        message: "The Messages helper received an invalid request.",
      } satisfies MessagesReadResponse));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify(runMessagesReadRequest(request)));
    process.exitCode = 0;
  } catch {
    // The thrown value can carry a database path or a row; only the type is
    // reported.
    process.stdout.write(JSON.stringify({
      ok: false,
      code: "error",
      message: "Messages could not be read.",
    } satisfies MessagesReadResponse));
    process.exitCode = 1;
  }
})();
