import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createArchiveService, type ArchiveServiceDeps } from "./archiveService";

/**
 * The archive service's contract: which archived items it lists, that it
 * refuses anything not archived or of the wrong kind, and that a lane delete
 * keeps the branch and only forwards `force` when the caller asked for it.
 * Runs over a real temp database for the session rows; the lane/session/pty
 * services are the collaborators it calls.
 */

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as const;
}

const NOW = "2026-03-17T00:00:00.000Z";
const ARCHIVED_AT = "2026-03-01T00:00:00.000Z";

const activeDisposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (activeDisposers.length > 0) {
    const dispose = activeDisposers.pop();
    if (dispose) await dispose();
  }
});

type Db = Awaited<ReturnType<typeof openKvDb>>;

function insertSession(db: Db, id: string, toolType: string, archivedAt: string | null, chatSessionId: string | null = null): void {
  db.run(
    `insert into terminal_sessions(id, lane_id, title, started_at, transcript_path, status, tool_type, chat_session_id, archived_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "lane-archived", id, NOW, `/tmp/${id}.log`, "completed", toolType, chatSessionId, archivedAt],
  );
}

function laneRow(id: string, name: string, archivedAt: string | null, branchRef: string) {
  return {
    id,
    name,
    laneType: "worktree",
    baseRef: "main",
    branchRef,
    worktreePath: `/repo/ade/.ade/worktrees/${id}`,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: NOW,
    archivedAt,
  };
}

async function createHarness(overrides: {
  laneDelete?: (args: { laneId: string; deleteBranch: boolean; deleteRemoteBranch: boolean; force?: boolean }) => Promise<unknown>;
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-archive-service-"));
  const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as never);
  activeDisposers.push(async () => db.close());

  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["project-1", "/repo/ade", "ADE", "main", NOW, NOW],
  );
  db.run(
    `insert into lanes(id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, status, created_at, archived_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["lane-archived", "project-1", "Old lane", "worktree", "main", "feat/old", "/repo/ade/.ade/worktrees/lane-archived", "active", NOW, ARCHIVED_AT],
  );

  insertSession(db, "chat-archived", "codex-chat", ARCHIVED_AT);
  insertSession(db, "shell-archived", "shell", ARCHIVED_AT, "chat-archived");
  insertSession(db, "chat-live", "codex-chat", null);

  const laneService = {
    list: vi.fn(async () => [
      laneRow("lane-archived", "Old lane", ARCHIVED_AT, "feat/old"),
      laneRow("lane-active", "Live lane", null, "feat/live"),
    ]),
    unarchive: vi.fn(async () => ({ worktreeRecreated: false })),
    delete: vi.fn(overrides.laneDelete ?? (async () => ({}))),
  };
  const sessionService = {
    get: vi.fn((sessionId: string) => (["chat-archived", "shell-archived", "chat-live"].includes(sessionId) ? { id: sessionId } : null)),
    unarchiveSession: vi.fn(() => true),
  };
  const agentChatService = {
    unarchiveSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
  };
  const deps = {
    db,
    laneService,
    sessionService,
    ptyService: {},
    agentChatService,
    logger: createLogger(),
  } as unknown as ArchiveServiceDeps;

  return { service: createArchiveService(deps), laneService, sessionService, agentChatService };
}

describe("archiveService.list", () => {
  it("lists archived lanes, chats and shells, splitting sessions by kind and hiding live ones", async () => {
    const { service } = await createHarness();

    const { items } = await service.list();
    const byKey = new Map(items.map((item) => [`${item.kind}:${item.id}`, item]));

    expect(byKey.get("lane:lane-archived")?.branchRef).toBe("feat/old");
    expect(byKey.get("chat:chat-archived")?.toolType).toBe("codex-chat");
    // A shell is a non-chat terminal, and it carries its parent chat.
    expect(byKey.get("shell:shell-archived")?.kind).toBe("shell");
    expect(byKey.get("shell:shell-archived")?.parentChatId).toBe("chat-archived");
    // Never-archived sessions stay out of the archive.
    expect(byKey.has("chat:chat-live")).toBe(false);
    expect(byKey.has("lane:lane-active")).toBe(false);
  });
});

describe("archiveService.restore", () => {
  it("refuses a live item, a kind mismatch, and an unknown kind, reporting each by item", async () => {
    const { service, agentChatService } = await createHarness();

    const result = await service.restore({
      items: [
        { kind: "lane", id: "lane-active" },
        { kind: "chat", id: "shell-archived" },
        { kind: "bogus" as never, id: "whatever" },
        { kind: "chat", id: "chat-archived" },
      ],
    });

    expect(result.done).toEqual([{ kind: "chat", id: "chat-archived" }]);
    expect(agentChatService.unarchiveSession).toHaveBeenCalledWith({ sessionId: "chat-archived" });
    const errors = Object.fromEntries(result.failed.map((item) => [item.id, item.error]));
    expect(errors["lane-active"]).toMatch(/is not archived/i);
    expect(errors["shell-archived"]).toMatch(/is a shell, not a chat/i);
    expect(errors["whatever"]).toMatch(/unknown archive kind/i);
  });
});

describe("archiveService.delete", () => {
  it("deletes an archived lane without its branch", async () => {
    const { service, laneService } = await createHarness();

    const result = await service.delete({ items: [{ kind: "lane", id: "lane-archived" }] });

    expect(result.failed).toEqual([]);
    expect(laneService.delete).toHaveBeenCalledWith(
      { laneId: "lane-archived", deleteBranch: false, deleteRemoteBranch: false },
      { teardownEnv: undefined },
    );
  });

  it("forwards force only when the caller asked, so a dirty lane fails then succeeds", async () => {
    const laneDelete = vi.fn(async (args: { force?: boolean }) => {
      if (!args.force) throw new Error("Lane 'lane-archived' has uncommitted changes.");
      return {};
    });
    const { service, laneService } = await createHarness({ laneDelete });

    const refused = await service.delete({ items: [{ kind: "lane", id: "lane-archived" }] });
    expect(refused.done).toEqual([]);
    expect(refused.failed[0]?.error).toMatch(/has uncommitted changes/i);
    expect(laneService.delete).toHaveBeenLastCalledWith(
      { laneId: "lane-archived", deleteBranch: false, deleteRemoteBranch: false },
      { teardownEnv: undefined },
    );

    const forced = await service.delete({ items: [{ kind: "lane", id: "lane-archived" }], force: true });
    expect(forced.failed).toEqual([]);
    expect(forced.done).toEqual([{ kind: "lane", id: "lane-archived" }]);
    expect(laneService.delete).toHaveBeenLastCalledWith(
      { laneId: "lane-archived", deleteBranch: false, deleteRemoteBranch: false, force: true },
      { teardownEnv: undefined },
    );
  });

  it("reports an unknown kind per item while still deleting the valid ones", async () => {
    const { service, agentChatService } = await createHarness();

    const result = await service.delete({
      items: [
        { kind: "chat", id: "chat-archived" },
        { kind: "nope" as never, id: "x" },
      ],
    });

    expect(result.done).toEqual([{ kind: "chat", id: "chat-archived" }]);
    expect(agentChatService.deleteSession).toHaveBeenCalledWith({ sessionId: "chat-archived" });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toMatch(/unknown archive kind/i);
  });
});
