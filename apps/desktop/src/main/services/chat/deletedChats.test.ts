import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdeDb } from "../state/kvDb";
import { openFreshKvDb } from "../../../test/freshKvDb";
import { createDeletedChatsService, recordChatsDeletedWithLane } from "./deletedChats";

const CODEX_THREAD_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_CODEX_THREAD_ID = "99999999-8888-4777-8666-555555555555";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let root: string;
let db: AdeDb;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-deleted-chats-"));
  db = await openFreshKvDb(path.join(root, "ade.db"), logger);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A Codex home whose sessions folder holds a rollout for each thread id. */
function codexHomeWith(...threadIds: string[]): string {
  const home = path.join(root, "codex-home");
  const dayDir = path.join(home, "sessions", "2026", "11", "05");
  fs.mkdirSync(dayDir, { recursive: true });
  for (const threadId of threadIds) {
    fs.writeFileSync(path.join(dayDir, `rollout-2026-11-05T00-00-00-${threadId}.jsonl`), "{}\n", "utf8");
  }
  return home;
}

function insertLane(laneId: string): void {
  const now = "2026-11-05T00:00:00.000Z";
  db.run(
    "insert or ignore into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    ["project-1", root, "Project", "main", now, now],
  );
  db.run(
    `insert into lanes(id, project_id, name, base_ref, branch_ref, worktree_path, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [laneId, "project-1", "Lane one", "main", "ade/lane-1", "/tmp/lane-one", "idle", now],
  );
}

function insertTerminalSession(id: string, laneId: string): void {
  db.run(
    `insert into terminal_sessions(id, lane_id, tool_type, title, started_at, transcript_path, status)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, laneId, "codex-chat", "Chat", "2026-11-05T00:00:00.000Z", `/tmp/${id}.jsonl`, "running"],
  );
}

function insertDeletedChat(args: {
  id: string;
  externalId: string;
  configHome: string;
  laneId: string | null;
  title: string;
}): void {
  db.run(
    `insert into deleted_chats(
       id, lane_id, lane_name, title, provider, external_provider, external_id,
       config_home, cwd, created_at, last_active_at, deleted_at, origin
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      args.laneId,
      "Lane from the row",
      args.title,
      "codex",
      "codex",
      args.externalId,
      args.configHome,
      "/tmp/lane-one",
      "2026-11-05T00:00:00.000Z",
      "2026-11-05T00:10:00.000Z",
      "2026-11-05T00:20:00.000Z",
      "delete",
    ],
  );
}

function deletedChatsService(overrides: Partial<Parameters<typeof createDeletedChatsService>[0]> = {}) {
  return createDeletedChatsService({
    db: () => db,
    logger,
    getLane: async () => null,
    listLiveProviderRefs: async () => [],
    instanceIdForHome: () => null,
    importSession: async () => {
      throw new Error("importSession should not run");
    },
    loadDetail: async () => {
      throw new Error("loadDetail should not run");
    },
    ...overrides,
  });
}

describe("Recently deleted chats", () => {
  it("lists a deleted chat only once its chat row is gone", async () => {
    insertLane("lane-1");
    const home = codexHomeWith(CODEX_THREAD_ID, OTHER_CODEX_THREAD_ID);
    insertDeletedChat({ id: "chat-still-here", externalId: OTHER_CODEX_THREAD_ID, configHome: home, laneId: "lane-1", title: "Still here" });
    insertDeletedChat({ id: "chat-deleted", externalId: CODEX_THREAD_ID, configHome: home, laneId: "lane-1", title: "Deleted chat" });
    // The chat's own row survived (its delete failed), so reopening it would
    // open a second chat for one conversation.
    insertTerminalSession("chat-still-here", "lane-1");

    const result = await deletedChatsService().list();

    expect(result.chats.map((chat) => chat.id)).toEqual(["chat-deleted"]);
    expect(result.chats[0]).toMatchObject({
      title: "Deleted chat",
      laneId: "lane-1",
      laneName: "Lane one",
      laneExists: true,
      sourceProvider: "codex",
    });
  });

  it("refuses a conversation a live or archived chat already holds", async () => {
    const home = codexHomeWith(CODEX_THREAD_ID);
    insertDeletedChat({ id: "chat-1", externalId: CODEX_THREAD_ID, configHome: home, laneId: "lane-1", title: "Deleted chat" });
    const importSession = vi.fn();

    const service = deletedChatsService({
      // The service is given every live chat, archived ones included.
      listLiveProviderRefs: async () => [{ provider: "codex", externalId: CODEX_THREAD_ID }],
      importSession,
    });

    await expect(service.reopen({ id: "chat-1" })).rejects.toThrow("already open in another chat");

    expect(importSession).not.toHaveBeenCalled();
    // It leaves the list: the conversation is open somewhere already.
    expect(db.get<{ hiddenReason: string | null }>(
      "select hidden_reason as hiddenReason from deleted_chats where id = ?",
      ["chat-1"],
    )?.hiddenReason).toBe("reopened");
    await expect(service.list()).resolves.toEqual({ chats: [] });
  });

  it("keeps a deleted lane's chats, but not its subagents, side chats, or chats that never launched", () => {
    insertLane("lane-1");
    const chatSessionsDir = path.join(root, "chat-sessions");
    fs.mkdirSync(chatSessionsDir, { recursive: true });
    const writeRecord = (id: string, record: Record<string, unknown>) =>
      fs.writeFileSync(path.join(chatSessionsDir, `${id}.json`), JSON.stringify(record), "utf8");
    writeRecord("chat-real", { provider: "codex", threadId: CODEX_THREAD_ID });
    writeRecord("chat-subagent", { provider: "codex", threadId: OTHER_CODEX_THREAD_ID, spawnKind: "subagent" });
    writeRecord("chat-side", { provider: "codex", threadId: OTHER_CODEX_THREAD_ID, sideChatParentSessionId: "chat-real" });
    writeRecord("chat-never-launched", { provider: "codex" });
    for (const id of ["chat-real", "chat-subagent", "chat-side", "chat-never-launched"]) {
      insertTerminalSession(id, "lane-1");
    }

    const recorded = recordChatsDeletedWithLane(db, {
      laneId: "lane-1",
      laneName: "Lane one",
      worktreePath: "/tmp/lane-one",
      chatSessionsDir,
    });

    expect(recorded).toBe(1);
    expect(db.all<{ id: string }>("select id from deleted_chats order by id")).toEqual([{ id: "chat-real" }]);
    expect(db.get<Record<string, unknown>>(
      "select origin, external_provider as externalProvider, external_id as externalId, lane_id as laneId, lane_name as laneName, cwd from deleted_chats where id = ?",
      ["chat-real"],
    )).toMatchObject({
      origin: "lane_delete",
      externalProvider: "codex",
      externalId: CODEX_THREAD_ID,
      laneId: "lane-1",
      laneName: "Lane one",
      cwd: "/tmp/lane-one",
    });
  });
});
