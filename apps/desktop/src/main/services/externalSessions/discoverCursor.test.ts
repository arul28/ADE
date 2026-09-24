import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { discoverCursorSessions, readCursorStorePrompts } from "./discoverCursor";

import { cursorProjectSlug } from "../../../shared/cursorProjectSlug";

// Loaded at run time: Vite cannot resolve a static `node:sqlite` import.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (dbPath: string) => DatabaseSyncType;
};

function writeTranscript(home: string, slug: string, agentId: string, cwd: string): void {
  const dir = path.join(home, ".cursor", "projects", slug, "agent-transcripts", agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${agentId}.jsonl`),
    `${JSON.stringify({
      type: "user",
      timestamp: 1_700_000_000_000,
      cwd,
      message: { role: "user", content: "hello" },
    })}\n`,
  );
}

describe("discoverCursorSessions", () => {
  it("imports a transcript for an existing scoped workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-import-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "repo");
    fs.mkdirSync(workspace, { recursive: true });
    writeTranscript(home, cursorProjectSlug(workspace), "chat-existing", workspace);

    try {
      const records = await discoverCursorSessions({ homeDir: home, scopeRoots: [workspace], limit: 10 });
      expect(records.map((record) => record.id)).toContain("chat-existing");
      expect(records[0]?.cwd).toBe(workspace);
      expect(records[0]?.preview).toBe("hello");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches Cursor's own project slug rule", () => {
    // Byte-for-byte from @cursor/sdk's shipped slug function.
    expect(cursorProjectSlug("C:\\Users\\me\\repo")).toBe("C-Users-me-repo");
    expect(cursorProjectSlug("/Users/me/repo")).toBe("Users-me-repo");
    expect(cursorProjectSlug("/Users/me/my.app/node_modules")).toBe("Users-me-my-app-node-modules");
    expect(cursorProjectSlug("C:\\repo\\.ade\\worktrees\\lane-1")).toBe("C-repo-ade-worktrees-lane-1");
  });

  it("keeps a transcript in scope when its workspace directory no longer exists", async () => {
    // The slug-to-cwd resolver cannot help once the directory is gone, so the
    // structural slug comparison is the only thing left.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-import-gone-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "deleted-repo");
    writeTranscript(home, cursorProjectSlug(workspace), "chat-deleted", workspace);

    try {
      const records = await discoverCursorSessions({ homeDir: home, scopeRoots: [workspace], limit: 10 });
      expect(records.map((record) => record.id)).toContain("chat-deleted");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readCursorStorePrompts", () => {
  /**
   * A store laid out as Cursor writes it: content-addressed blobs inserted
   * newest first, so row order is not conversation order, and a protobuf root
   * (named by `meta['0']`) listing the message ids oldest first.
   */
  function writeStore(filePath: string, messages: unknown[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const db = new DatabaseSync(filePath);
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
    const insert = db.prepare("INSERT OR IGNORE INTO blobs (id, data) VALUES (?, ?)");
    const put = (data: Buffer): string => {
      const id = createHash("sha256").update(data).digest("hex");
      insert.run(id, data);
      return id;
    };
    const ids = [...messages].reverse().map((message) => put(Buffer.from(JSON.stringify(message)))).reverse();
    const rootId = put(Buffer.concat(ids.map((id) => Buffer.concat([Buffer.from([0x0a, 32]), Buffer.from(id, "hex")]))));
    const meta = { agentId: "sess-1", latestRootBlobId: rootId };
    db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta)).toString("hex"));
    db.close();
  }

  it("reads the first real prompt and skips the environment block", () => {
    // 2026-09-23: store-only Cursor chats listed as "Untitled Cursor chat".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-store-"));
    try {
      const store = path.join(root, "store.db");
      writeStore(store, [
        { role: "user", content: "<user_info>\nOS Version: darwin\n</user_info>" },
        { role: "user", content: [{ type: "text", text: "<user_query>\nkeep this branch up to date with main\n</user_query>" }] },
        { role: "assistant", content: "Done." },
      ]);
      expect(readCursorStorePrompts(store, null)).toEqual({
        firstUserText: "keep this branch up to date with main",
        userCount: 1,
        adeOrigin: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts prompts in conversation order, a repeated prompt each time", () => {
    // The blob table holds one row per distinct message, newest first; the
    // old row scan counted "continue" once and could miss the first prompt.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-store-"));
    try {
      const store = path.join(root, "store.db");
      const again = { role: "user", content: [{ type: "text", text: "<user_query>\ncontinue\n</user_query>" }] };
      writeStore(store, [
        { role: "user", content: [{ type: "text", text: "<user_query>\nfix the banner\n</user_query>" }] },
        { role: "assistant", content: "Fixed." },
        again,
        { role: "assistant", content: "Done." },
        again,
      ]);
      expect(readCursorStorePrompts(store, null)).toEqual({
        firstUserText: "fix the banner",
        userCount: 3,
        adeOrigin: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks chats ADE's CTO agent drove", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-store-"));
    try {
      const store = path.join(root, "store.db");
      writeStore(store, [
        { role: "user", content: "<user_query>\nSystem context (CTO reconstruction, do not echo verbatim):\n…\n</user_query>" },
      ]);
      expect(readCursorStorePrompts(store, null)?.adeOrigin).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
