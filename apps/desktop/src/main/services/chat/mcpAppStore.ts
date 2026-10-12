import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MCP_APP_LIMITS, type McpAppDocument } from "../../../shared/mcpApp";

/**
 * Where a chat's MCP Apps live on disk, so a reopened chat still shows them.
 *
 * One folder per chat, next to the chat's transcript:
 *
 *   <transcripts>/chat-apps/<chat>/app-<hash of the tool call id>.json
 *   <transcripts>/chat-apps/<chat>/doc-<hash of the HTML>.html
 *
 * The HTML is filed by its own hash, because every call of one tool returns
 * the same page: twenty calls keep one copy. The record holds the rest (which
 * server, the declared network origins, the tool input and result to replay).
 *
 * Bounded three ways: one page is at most `maxDocumentBytes`, a chat keeps at
 * most `maxAppsPerChat` apps (the oldest goes first), and a page no record
 * names any more is removed. The folder goes when the chat is deleted.
 *
 * No name in a path comes from outside: the chat folder and both file names
 * are hashes or checked ids, so there is nothing to traverse with.
 */

type StoredRecord = Omit<McpAppDocument, "html"> & { docHash: string };

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

function sessionFolderName(sessionId: string): string {
  const trimmed = sessionId.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(trimmed) ? trimmed : `h-${sha(trimmed).slice(0, 40)}`;
}

export type McpAppStore = {
  /** False when the app is too large to keep; nothing is written then. */
  write(app: McpAppDocument): boolean;
  read(sessionId: string, itemId: string): McpAppDocument | null;
  /** The record without its page: what request routing needs. */
  readRecord(sessionId: string, itemId: string): Omit<McpAppDocument, "html"> | null;
  deleteSession(sessionId: string): void;
};

export function createMcpAppStore(args: {
  rootDir: string;
  onError?: (event: string, detail: Record<string, unknown>) => void;
}): McpAppStore {
  const { rootDir } = args;
  const report = (event: string, error: unknown, detail: Record<string, unknown> = {}) =>
    args.onError?.(event, { ...detail, error: error instanceof Error ? error.message : String(error) });
  const dirFor = (sessionId: string) => path.join(rootDir, sessionFolderName(sessionId));
  const recordPath = (sessionId: string, itemId: string) => path.join(dirFor(sessionId), `app-${sha(itemId)}.json`);
  const docPath = (sessionId: string, docHash: string) => path.join(dirFor(sessionId), `doc-${docHash}.html`);

  const readStored = (sessionId: string, itemId: string): StoredRecord | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(recordPath(sessionId, itemId), "utf8")) as StoredRecord;
      if (!parsed || typeof parsed !== "object" || typeof parsed.docHash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.docHash)) return null;
      // A record is only ever read back for the chat and call it was filed under.
      if (parsed.sessionId !== sessionId || parsed.itemId !== itemId) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  /** Drop the oldest records past the per-chat cap, then every page nothing names. */
  const prune = (sessionId: string): void => {
    const dir = dirFor(sessionId);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    const records = names
      .filter((name) => name.startsWith("app-") && name.endsWith(".json"))
      .map((name) => {
        const filePath = path.join(dir, name);
        try {
          return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of records.slice(MCP_APP_LIMITS.maxAppsPerChat)) fs.rmSync(stale.filePath, { force: true });
    const named = new Set<string>();
    for (const kept of records.slice(0, MCP_APP_LIMITS.maxAppsPerChat)) {
      try {
        const docHash = (JSON.parse(fs.readFileSync(kept.filePath, "utf8")) as StoredRecord).docHash;
        if (typeof docHash === "string") named.add(`doc-${docHash}.html`);
      } catch {
        // An unreadable record names nothing.
      }
    }
    for (const name of names) {
      if (name.startsWith("doc-") && name.endsWith(".html") && !named.has(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
  };

  return {
    write(app) {
      if (Buffer.byteLength(app.html, "utf8") > MCP_APP_LIMITS.maxDocumentBytes) return false;
      try {
        const dir = dirFor(app.sessionId);
        fs.mkdirSync(dir, { recursive: true });
        const docHash = sha(app.html);
        const pagePath = docPath(app.sessionId, docHash);
        if (!fs.existsSync(pagePath)) fs.writeFileSync(pagePath, app.html, "utf8");
        const { html: _page, ...rest } = app;
        const record: StoredRecord = { ...rest, docHash };
        fs.writeFileSync(recordPath(app.sessionId, app.itemId), JSON.stringify(record), "utf8");
        prune(app.sessionId);
        return true;
      } catch (error) {
        report("agent_chat.mcp_app_store_write_failed", error, { sessionId: app.sessionId });
        return false;
      }
    },
    read(sessionId, itemId) {
      const stored = readStored(sessionId, itemId);
      if (!stored) return null;
      try {
        const html = fs.readFileSync(docPath(sessionId, stored.docHash), "utf8");
        const { docHash: _hash, ...rest } = stored;
        return { ...rest, html };
      } catch {
        return null;
      }
    },
    readRecord(sessionId, itemId) {
      const stored = readStored(sessionId, itemId);
      if (!stored) return null;
      const { docHash: _hash, ...rest } = stored;
      return rest;
    },
    deleteSession(sessionId) {
      try {
        fs.rmSync(dirFor(sessionId), { recursive: true, force: true });
      } catch (error) {
        report("agent_chat.mcp_app_store_delete_failed", error, { sessionId });
      }
    },
  };
}
