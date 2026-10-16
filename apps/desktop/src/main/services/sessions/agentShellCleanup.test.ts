import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createSessionService } from "./sessionService";
import { writeCarriesTypedInput } from "./agentShellCleanup";

/**
 * `agentShellCleanup` archives a dead shell an agent started under a chat, and
 * only then. The rules are the whole contract: a relaunch goes at once, a clean
 * exit or an ADE stop waits out the grace period, a crash waits for the chat to
 * settle, anything the person typed into is theirs and is never archived, and a
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

function archivedAt(db: Db, id: string): string | null {
  return db.get<{ archivedAt: string | null }>("select archived_at as archivedAt from terminal_sessions where id = ?", [id])?.archivedAt ?? null;
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
  it("archives a relaunched shell at once, even after an unclean exit", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "relaunched", chatSessionId: "chat-1", status: "failed", exitCode: 1 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });
    db.run("update agent_shell_cleanup set retired_reason = 'relaunch' where session_id = ?", [id]);

    expect(agentShells.sweep(NOW_MS)).toEqual([id]);
    expect(archivedAt(db, id)).not.toBeNull();
  });

  it("archives a clean exit only after the grace period", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "clean", chatSessionId: "chat-1", status: "completed", exitCode: 0 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });

    expect(agentShells.sweep(NOW_MS + MINUTE)).toEqual([]);
    expect(archivedAt(db, id)).toBeNull();
    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([id]);
  });

  it("treats an ADE stop as a clean end, waiting out the same grace period", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "stopped", chatSessionId: "chat-1", status: "failed", exitCode: 1 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });
    db.run("update agent_shell_cleanup set retired_reason = 'stop' where session_id = ?", [id]);

    expect(agentShells.sweep(NOW_MS + MINUTE)).toEqual([]);
    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([id]);
  });

  it("holds a crashed shell until its chat settles", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "crashed", chatSessionId: "chat-1", status: "failed", exitCode: 1 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });

    expect(agentShells.sweep(NOW_MS + 10 * MINUTE)).toEqual([]);
    db.run("update terminal_sessions set settled_at = ? where id = 'chat-1'", [NOW]);
    expect(agentShells.sweep(NOW_MS + 10 * MINUTE)).toEqual([id]);
  });

  it("never archives a shell the person typed into, and drops its ledger row", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "typed", chatSessionId: "chat-1", status: "completed", exitCode: 0 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });
    db.run("update agent_shell_cleanup set retired_reason = 'relaunch' where session_id = ?", [id]);
    agentShells.markUserInput(id);

    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([]);
    expect(archivedAt(db, id)).toBeNull();
    // The ledger only needs rows that may still be archived; a claimed shell is done.
    expect(ledgerCount(db, id)).toBe(0);
  });

  it("leaves running and detached shells alone", async () => {
    const { db, agentShells } = await createHarness();
    const running = seedAgentShell(db, agentShells, { id: "running", chatSessionId: "chat-1", status: "running", endedAt: null });
    const detached = seedAgentShell(db, agentShells, { id: "detached", chatSessionId: "chat-1", status: "detached", endedAt: null });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });
    db.run("update agent_shell_cleanup set retired_reason = 'relaunch' where session_id in ('running','detached')");

    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([]);
    expect(archivedAt(db, running)).toBeNull();
    expect(archivedAt(db, detached)).toBeNull();
    expect(ledgerCount(db, running)).toBe(1);
  });

  it("trims the ledger once the shell it tracked is archived", async () => {
    const { db, agentShells } = await createHarness();
    const id = seedAgentShell(db, agentShells, { id: "gone", chatSessionId: "chat-1", status: "completed", exitCode: 0 });
    insertSession(db, { id: "chat-1", toolType: "codex-chat" });

    expect(agentShells.sweep(NOW_MS + GRACE)).toEqual([id]);
    expect(ledgerCount(db, id)).toBe(0);
  });
});
