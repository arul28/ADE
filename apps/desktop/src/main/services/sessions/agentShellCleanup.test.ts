import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createSessionService } from "./sessionService";
import { writeCarriesTypedInput } from "./agentShellCleanup";

/**
 * `agentShellCleanup` deletes a dead shell App Control started, and only then.
 * The rules are the whole contract: a replaced shell goes at once, a clean exit
 * or an ADE stop waits out the grace period, a crash waits for the chat to
 * settle, anything the person typed into is theirs and is never deleted, and a
 * running shell is never touched. Exercised through the real service over a
 * real temp database, so the sweep's join and the ledger trim are real too.
 */

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as const;
}

const NOW = "2026-03-17T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const MINUTE = 60_000;
const GRACE = 10 * MINUTE;

const activeDisposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (activeDisposers.length > 0) {
    const dispose = activeDisposers.pop();
    if (dispose) await dispose();
  }
});

type Db = Awaited<ReturnType<typeof openKvDb>>;

function insertProjectGraph(db: Db): void {
  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["project-1", "/repo/ade", "ADE", "main", NOW, NOW],
  );
  db.run(
    `insert into lanes(id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["lane-1", "project-1", "Lane 1", "worktree", "main", "feature/lane-1", "/repo/ade/.ade/worktrees/lane-1", "active", NOW],
  );
}

function insertSession(db: Db, overrides: Partial<{
  id: string;
  status: string;
  toolType: string;
  exitCode: number | null;
  endedAt: string | null;
  chatSessionId: string | null;
  settledAt: string | null;
  archivedAt: string | null;
}> = {}): string {
  const id = overrides.id ?? "shell-1";
  db.run(
    `insert into terminal_sessions(
       id, lane_id, title, started_at, ended_at, exit_code, transcript_path, status,
       tool_type, chat_session_id, settled_at, archived_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "lane-1",
      id,
      NOW,
      overrides.endedAt === undefined ? NOW : overrides.endedAt,
      overrides.exitCode === undefined ? 0 : overrides.exitCode,
      `/tmp/${id}.log`,
      overrides.status ?? "completed",
      overrides.toolType ?? "shell",
      overrides.chatSessionId ?? null,
      overrides.settledAt ?? null,
      overrides.archivedAt ?? null,
    ],
  );
  return id;
}

async function createHarness(): Promise<{ db: Db; agentShells: ReturnType<typeof createSessionService>["agentShells"] }> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-agent-shell-cleanup-"));
  const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as never);
  activeDisposers.push(async () => db.close());
  insertProjectGraph(db);
  const service = createSessionService({ db });
  return { db, agentShells: service.agentShells };
}

function rowExists(db: Db, id: string): boolean {
  return Boolean(db.get<{ present: number }>("select 1 as present from terminal_sessions where id = ?", [id]));
}

function ledgerCount(db: Db, id: string): number {
  return Number(db.get<{ count: number }>("select count(*) as count from agent_shell_cleanup where session_id = ?", [id])?.count ?? 0);
}

/** An agent-launched shell under a chat, tracked in the ledger. */
function seedAgentShell(
  db: Db,
  agentShells: ReturnType<typeof createSessionService>["agentShells"],
  overrides: Parameters<typeof insertSession>[1] = {},
): string {
  const id = insertSession(db, overrides);
  agentShells.markAgentLaunched(id);
  return id;
}

describe("writeCarriesTypedInput", () => {
  it("separates what a person typed from what a terminal emits on its own", () => {
    expect(writeCarriesTypedInput("git status\n")).toBe(true);
    // Focus in / cursor position / device attributes are the emulator talking,
    // not a person: they must never count as the user claiming a shell.
    expect(writeCarriesTypedInput("\x1b[I")).toBe(false);
    expect(writeCarriesTypedInput("\x1b[?1;2c")).toBe(false);
    expect(writeCarriesTypedInput("")).toBe(false);
  });
});

describe("agent shell cleanup sweep", () => {
  it("deletes a relaunched shell at once, even after an unclean exit", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "relaunched", chatSessionId: "chat-1", status: "failed", exitCode: 1 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });
    db.run("update agent_shell_cleanup set retired_reason = 'relaunch' where session_id = ?", [id]);

    expect(agentShells.sweep(NOW_MS)).toEqual([id]);
    expect(rowExists(db, id)).toBe(false);
  });

  it("deletes a clean exit only after the grace period", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "clean", chatSessionId: "chat-1", status: "completed", exitCode: 0 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });

    expect(agentShells.sweep(NOW_MS + MINUTE)).toEqual([]);
    expect(rowExists(db, id)).toBe(true);
    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([id]);
    expect(rowExists(db, id)).toBe(false);
  });

  it("deletes a crashed shell whose chat was deleted, instead of waiting for it forever", async () => {
    // Deleting a chat does NOT clear the shell's `chat_session_id` (the column
    // has no foreign key), so the shell keeps an id whose row is gone. The
    // unclean end is the case `parentQuiet` decides: before this rule that
    // shell could never be swept, because the parent it was waiting to settle
    // no longer existed.
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "orphan-crashed", chatSessionId: "deleted-chat", status: "failed", exitCode: 1 });

    expect(agentShells.sweep(NOW_MS + MINUTE)).toEqual([id]);
    expect(rowExists(db, id)).toBe(false);
  });

  it("never deletes a shell somebody typed into, chat or no chat", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "orphan-typed", chatSessionId: "deleted-chat", status: "failed", exitCode: 1 });
    agentShells.markUserInput(id);

    expect(agentShells.sweep(NOW_MS + GRACE * 4)).toEqual([]);
    expect(rowExists(db, id)).toBe(true);
  });

  it("treats an ADE stop as a clean end, waiting out the same grace period", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "stopped", chatSessionId: "chat-1", status: "failed", exitCode: 1 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });
    db.run("update agent_shell_cleanup set retired_reason = 'stop' where session_id = ?", [id]);

    expect(agentShells.sweep(NOW_MS + MINUTE)).toEqual([]);
    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([id]);
    expect(rowExists(db, id)).toBe(false);
  });

  it("holds a crashed shell until its chat settles, and keeps a chatless crash", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "crashed", chatSessionId: "chat-1", status: "failed", exitCode: 1 });
    const chatless = seedAgentShell(db, agentShells, { id: "chatless-crashed", status: "failed", exitCode: 1 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });

    expect(agentShells.sweep(NOW_MS + 10 * MINUTE)).toEqual([]);
    db.run("update terminal_sessions set settled_at = ? where id = 'chat-1'", [NOW]);
    expect(agentShells.sweep(NOW_MS + 10 * MINUTE)).toEqual([id]);
    // A chatless failure has no chat to settle: it stays in view until a
    // relaunch reuses the shell rather than being deleted out from under it.
    expect(rowExists(db, chatless)).toBe(true);
    expect(agentShells.sweep(NOW_MS + GRACE * 4)).toEqual([]);
    expect(rowExists(db, chatless)).toBe(true);
  });

  it("keeps a dead shell a relaunch holds, then deletes it once released", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "held", chatSessionId: "chat-1", status: "completed", exitCode: 0 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });

    const release = agentShells.hold(id);
    // Due on its own, but a relaunch is between claiming the shell and running
    // its new process in it: deleting the row there would strand the launch.
    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([]);
    expect(rowExists(db, id)).toBe(true);
    release();
    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([id]);
    expect(rowExists(db, id)).toBe(false);
  });

  it("never deletes a shell the person typed into, and drops its ledger row", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "typed", chatSessionId: "chat-1", status: "completed", exitCode: 0 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });
    db.run("update agent_shell_cleanup set retired_reason = 'relaunch' where session_id = ?", [id]);
    agentShells.markUserInput(id);

    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([]);
    expect(rowExists(db, id)).toBe(true);
    // The ledger only needs rows that may still be deleted; a claimed shell is done.
    expect(ledgerCount(db, id)).toBe(0);
  });

  it("leaves running and detached shells alone", async () => {
    const { db, agentShells } = await createHarness();
    const running = seedAgentShell(db, agentShells, { id: "running", chatSessionId: "chat-1", status: "running", endedAt: null });
    const detached = seedAgentShell(db, agentShells, { id: "detached", chatSessionId: "chat-1", status: "detached", endedAt: null });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });
    db.run("update agent_shell_cleanup set retired_reason = 'relaunch' where session_id in ('running','detached')");

    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([]);
    expect(rowExists(db, running)).toBe(true);
    expect(rowExists(db, detached)).toBe(true);
    expect(ledgerCount(db, running)).toBe(1);
  });

  it("trims the ledger once the shell it tracked is deleted", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "gone", chatSessionId: "chat-1", status: "completed", exitCode: 0 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });

    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([id]);
    expect(rowExists(db, id)).toBe(false);
    expect(ledgerCount(db, id)).toBe(0);
  });
});

describe("relaunch eligibility", () => {
  it.each([
    ["the same chat", {}, { laneId: "lane-1", chatSessionId: "chat-1" }, true],
    ["both chatless", { chatSessionId: null }, { laneId: "lane-1", chatSessionId: null }, true],
    ["typed into", { typed: true }, { laneId: "lane-1", chatSessionId: "chat-1" }, false],
    ["archived", { archivedAt: NOW }, { laneId: "lane-1", chatSessionId: "chat-1" }, false],
    ["another chat's", {}, { laneId: "lane-1", chatSessionId: "chat-2" }, false],
    ["a chatless shell for a chat's launch", { chatSessionId: null }, { laneId: "lane-1", chatSessionId: "chat-1" }, false],
    ["in another lane", {}, { laneId: "lane-2", chatSessionId: "chat-1" }, false],
    ["still running", { status: "running", endedAt: null }, { laneId: "lane-1", chatSessionId: "chat-1" }, false],
  ])("answers a relaunch for a shell that is %s", async (
    _label: string,
    overrides: NonNullable<Parameters<typeof insertSession>[1]> & { typed?: boolean },
    scope: { laneId: string; chatSessionId: string | null },
    expected: boolean,
  ) => {
    const { db, agentShells } = await createHarness();
    const { typed, ...sessionOverrides } = overrides;
    const id = seedAgentShell(db, agentShells, {
      id: "candidate",
      chatSessionId: "chat-1",
      status: "completed",
      exitCode: 0,
      ...sessionOverrides,
    });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });
    if (typed) agentShells.markUserInput(id);

    expect(agentShells.canRelaunchIn(id, scope)).toBe(expected);
  });
});
