import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoJargon } from "../../../test/jargonGuard";
import { boundLaunchdLogs } from "../../../../../ade-cli/src/services/runtime/runtimeLogMaintenance";
import { createAgentChatService } from "../chat/agentChatService";
import { readThreadPointerLedger } from "../chat/threadPointerLedger";
import {
  computeStartupBackoffMs,
  readLastFailure,
  recordLastFailure,
} from "../runtime/lastFailureStore";
import { createProjectRecoveryService, type ProjectRecoveryConnectionPool } from "../runtime/projectRecoveryService";
import { readJsonWithRecovery, writeJsonWithPrevious } from "../state/durableFile";
import { openKvDb, rebuildTableInTransaction, type AdeDb, type TableRebuildPlan } from "../state/kvDb";
import { createDiskPressureMonitor } from "../storage/diskPressure";
import { createHistoryCompressor } from "../storage/historyCompression";
import { createStorageInsightsService } from "../storage/storageInsightsService";
import { constrainSqliteMaxPages, injectFsFault } from "../../../test/faultInjection";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (dbPath: string) => DatabaseSyncType;
};

const GIB = 1024 ** 3;
const roots: string[] = [];

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ade-${label}-`));
  roots.push(root);
  return root;
}

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function isPointerMetadata(value: unknown): value is {
  version: 2;
  sessionId: string;
  provider: "codex";
  threadId: string;
  updatedAt: string;
} {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 2
    && typeof record.sessionId === "string"
    && record.provider === "codex"
    && typeof record.threadId === "string"
    && typeof record.updatedAt === "string";
}

function automationRebuildPlan(): TableRebuildPlan {
  return {
    tableName: "automation_ingress_events",
    stagingName: "__ade_crr_repair_automation_ingress_events",
    createStagingSql: `
      create table "__ade_crr_repair_automation_ingress_events" (
        id text primary key,
        project_id text not null,
        source text not null,
        event_key text not null,
        raw_payload_json text,
        received_at text not null,
        foreign key(project_id) references projects(id)
      )
    `,
    columnsSql: '"id", "project_id", "source", "event_key", "raw_payload_json", "received_at"',
    indexSqlsToRecreate: [
      "create unique index idx_automation_ingress_events_project_key on automation_ingress_events(project_id, source, event_key)",
    ],
  };
}

function sessionServiceFor(row: Record<string, any>) {
  return {
    get: vi.fn((sessionId: string) => sessionId === row.id ? row : null),
    list: vi.fn(() => [row]),
    setResumeCommand: vi.fn((_sessionId: string, command: string | null) => { row.resumeCommand = command; }),
    end: vi.fn(),
    reopen: vi.fn(),
    updateMeta: vi.fn(),
    setLastOutputPreview: vi.fn(),
    clearTurnStartMarkers: vi.fn(),
    markLastTurnFailed: vi.fn(),
    clearLastTurnFailed: vi.fn(),
    setSummary: vi.fn(),
    setHeadShaStart: vi.fn(),
    setHeadShaEnd: vi.fn(),
    deleteSession: vi.fn(),
    archiveSession: vi.fn(),
    unarchiveSession: vi.fn(),
    upsertClaudeSessionPointer: vi.fn(),
    getClaudeSessionPointer: vi.fn(() => null),
    getClaudeSessionPointerByChatSessionId: vi.fn(() => null),
    listClaudeSessionPointers: vi.fn(() => []),
  } as any;
}

function recoveryPool(): ProjectRecoveryConnectionPool {
  return {
    getStatus: vi.fn(() => ({
      connectionState: "idle",
      runtimeMode: "primary",
      versionSkew: { state: "none", appVersion: null, runtimeVersion: null, message: null, updatedAt: null },
      serviceInstall: { state: "not_attempted", attempted: false, path: null, message: null, exitCode: null, updatedAt: null },
      serviceHealth: { state: "unknown", installed: null, running: null, path: null, message: null, checkedAt: null },
    })),
    installServiceBestEffort: vi.fn(async () => {}),
    uninstallServiceBestEffort: vi.fn(async () => {}),
    callSync: vi.fn(async () => ({ pong: true })) as any,
    ensureProject: vi.fn(async () => ({ projectId: "project-incident" } as any)),
    callActionForRoot: vi.fn(async () => ({ result: [] } as any)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("disk-full incident integration matrix", () => {
  it("replays the full incident without losing database rows or the original provider thread", async () => {
    // On July 12, 2026, ADE ran out of disk while rebuilding
    // automation_ingress_events and persisting a Codex thread pointer. The
    // database restart then encountered the abandoned rebuild shape while the
    // chat risked resuming as a silently fresh thread. This fixture keeps that
    // entire failure chain together so either half can never regress alone.
    const projectRoot = tempRoot("disk-full-incident");
    const adeDir = path.join(projectRoot, ".ade");
    const dbPath = path.join(adeDir, "ade.db");
    const chatSessionsDir = path.join(adeDir, "cache", "chat-sessions");
    const chatTranscriptsDir = path.join(adeDir, "transcripts", "chat");
    const sessionId = "session-incident";
    const metadataPath = path.join(chatSessionsDir, `${sessionId}.json`);
    fs.mkdirSync(chatSessionsDir, { recursive: true });
    fs.mkdirSync(chatTranscriptsDir, { recursive: true });

    // First reconstruct the pre-incident world: the real ADE schema, the
    // excluded automation table and unique index, all 9,136 ingress rows, and
    // three independent durable references to the original Codex thread.
    const initial = await openKvDb(dbPath, logger());
    initial.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      ["project-incident", projectRoot, "Incident fixture", "main", "2026-07-12T12:00:00.000Z", "2026-07-12T12:00:00.000Z"],
    );
    initial.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      pragma foreign_keys = on;
      create table automation_ingress_events (
        id text primary key,
        project_id text not null,
        source text not null,
        event_key text not null,
        raw_payload_json text,
        received_at text not null,
        foreign key(project_id) references projects(id)
      );
      create unique index idx_automation_ingress_events_project_key
        on automation_ingress_events(project_id, source, event_key);
      begin;
    `);
    const insert = raw.prepare(`
      insert into automation_ingress_events(id, project_id, source, event_key, raw_payload_json, received_at)
      values (?, ?, ?, ?, ?, ?)
    `);
    const payload = JSON.stringify({ body: "x".repeat(1_024) });
    for (let index = 0; index < 9_136; index += 1) {
      insert.run(`event-${index}`, "project-incident", "github", `key-${index}`, payload, "2026-07-12T12:00:00.000Z");
    }
    raw.exec("commit");

    const pointerMetadata = {
      version: 2 as const,
      sessionId,
      laneId: "lane-incident",
      provider: "codex" as const,
      model: "gpt-5.4",
      threadId: "thread-original",
      updatedAt: "2026-07-12T12:00:00.000Z",
    };
    writeJsonWithPrevious(metadataPath, pointerMetadata);
    writeJsonWithPrevious(metadataPath, pointerMetadata);
    fs.writeFileSync(path.join(chatSessionsDir, "thread-pointers.jsonl"), `${JSON.stringify({
      sessionId,
      provider: "codex",
      pointer: "thread-original",
      prevPointer: null,
      reason: "persist_change",
      at: "2026-07-12T12:00:00.000Z",
    })}\n`);
    fs.writeFileSync(path.join(chatTranscriptsDir, `${sessionId}.jsonl`), `${JSON.stringify({
      sessionId,
      sequence: 1,
      timestamp: "2026-07-12T12:00:00.000Z",
      event: { type: "codex_token_usage", usage: { threadId: "thread-original", total: { inputTokens: 10, outputTokens: 5 } } },
    })}\n`);
    const metadataBefore = fs.readFileSync(metadataPath);
    const lkgBefore = fs.readFileSync(`${metadataPath}.lkg`);

    // Recreate both writes that failed as the volume filled: SQLite reaches
    // SQLITE_FULL during the transactional copy, then the metadata atomic
    // rename receives ENOSPC. Both operations must leave their old generation
    // authoritative and clean up every staging/temp artifact.
    const currentPages = Number((raw.prepare("pragma page_count").get() as { page_count: number }).page_count);
    constrainSqliteMaxPages(raw, currentPages + 2);
    expect(() => rebuildTableInTransaction(raw, automationRebuildPlan())).toThrow(/database or disk is full/i);

    const metadataFault = injectFsFault({
      op: "renameSync",
      matchPath: (candidate) => path.resolve(candidate) === path.resolve(metadataPath),
    });
    expect(() => writeJsonWithPrevious(metadataPath, { ...pointerMetadata, threadId: "thread-replacement" }))
      .toThrow(/ENOSPC|no space/i);
    expect(metadataFault.calls()).toBe(1);
    metadataFault.restore();

    expect(raw.prepare("pragma quick_check").get()).toEqual({ quick_check: "ok" });
    expect((raw.prepare("select count(*) as count from automation_ingress_events").get() as { count: number }).count).toBe(9_136);
    expect(raw.prepare("select 1 from sqlite_master where name = '__ade_crr_repair_automation_ingress_events'").get()).toBeUndefined();
    expect(fs.readFileSync(metadataPath)).toEqual(metadataBefore);
    expect(fs.readFileSync(`${metadataPath}.lkg`)).toEqual(lkgBefore);
    expect(fs.readdirSync(chatSessionsDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    constrainSqliteMaxPages(raw, 2_147_483_646);
    raw.close();

    // A process restart must open the same database without the historical
    // "table already exists" crash. The primary pointer remains readable. If
    // both metadata generations are then lost, reconciliation must rebuild the
    // exact original pointer from the ledger/resume command/transcript instead
    // of ever creating a fresh provider thread.
    const restarted = await openKvDb(dbPath, logger());
    expect(restarted.get<{ count: number }>("select count(*) as count from automation_ingress_events")?.count).toBe(9_136);
    expect(restarted.get("select 1 from sqlite_master where name = '__ade_crr_repair_automation_ingress_events'")).toBeNull();
    restarted.close();
    expect(readJsonWithRecovery(metadataPath, isPointerMetadata)).toMatchObject({
      source: "primary",
      value: { threadId: "thread-original" },
    });

    fs.rmSync(metadataPath);
    fs.writeFileSync(`${metadataPath}.lkg`, "{");
    const row = {
      id: sessionId,
      laneId: "lane-incident",
      toolType: "codex-chat",
      status: "detached",
      title: "Incident chat",
      startedAt: "2026-07-12T12:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-07-12T12:00:00.000Z",
      archivedAt: null,
      transcriptPath: path.join(chatTranscriptsDir, `${sessionId}.jsonl`),
      resumeCommand: "chat:codex:thread-original",
    };
    const sessionService = sessionServiceFor(row);
    const chatService = createAgentChatService({
      projectRoot,
      transcriptsDir: path.join(adeDir, "transcripts"),
      laneService: { list: vi.fn(async () => []) } as any,
      sessionService,
      projectConfigService: { get: vi.fn(() => ({ effective: { ai: { permissions: {}, chat: {}, sessionIntelligence: {} } } })) } as any,
      aiIntegrationService: { getMode: vi.fn(() => "subscription") } as any,
      logger: logger(),
      appVersion: "incident-test",
      getDirtyFileTextForPath: () => undefined,
    });
    const reconciled = chatService.reconcileThreadPointerFromRedundantSources(sessionId);
    expect(reconciled?.threadId).toBe("thread-original");
    expect(readThreadPointerLedger(chatSessionsDir).get(sessionId)?.pointer).toBe("thread-original");
    expect(readJsonWithRecovery(metadataPath, isPointerMetadata)).toMatchObject({
      source: "primary",
      value: { threadId: "thread-original" },
    });
    chatService.forceDisposeAll();

    // Finally preserve the diagnostic evidence the brain uses to detect a
    // startup loop: the first identical disk-full report is immediate, while
    // the third report inside the loop window introduces a bounded backoff.
    const target = { kind: "project" as const, projectRoot };
    const first = recordLastFailure(target, {
      code: "disk_full",
      message: "Project data could not be opened because the disk is full.",
      component: "project_db_open",
      projectRoot,
      at: "2026-07-12T12:01:00.000Z",
    });
    expect(readLastFailure(target)).toEqual(first);
    expect(computeStartupBackoffMs(first, new Date("2026-07-12T12:01:01.000Z"))).toBe(0);
    recordLastFailure(target, {
      code: "disk_full", message: "Still full.", component: "project_db_open", projectRoot, at: "2026-07-12T12:01:02.000Z",
    });
    const third = recordLastFailure(target, {
      code: "disk_full", message: "Still full.", component: "project_db_open", projectRoot, at: "2026-07-12T12:01:03.000Z",
    });
    expect(third?.count).toBe(3);
    expect(computeStartupBackoffMs(third, new Date("2026-07-12T12:01:04.000Z"))).toBeGreaterThan(0);
  });

  it("bounds a crash-loop launchd log once with copytruncate", () => {
    const root = tempRoot("launchd-log");
    const runtimeDir = path.join(root, "runtime");
    const logPath = path.join(runtimeDir, "launchd.err.log");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(logPath, Buffer.alloc(11 * 1024 * 1024, 0x61));
    fs.writeFileSync(path.join(runtimeDir, "launchd.out.log"), "");

    boundLaunchdLogs(runtimeDir);
    expect(fs.statSync(logPath).size).toBe(0);
    expect(fs.statSync(`${logPath}.1`).size).toBe(1024 * 1024);
    const rotatedBefore = fs.readFileSync(`${logPath}.1`);

    boundLaunchdLogs(runtimeDir);
    expect(fs.statSync(logPath).size).toBe(0);
    expect(fs.readFileSync(`${logPath}.1`)).toEqual(rotatedBefore);
  });

  it("fails repair for low space, then self-heals stranded migration state and counts chats", async () => {
    const projectRoot = tempRoot("repair-flow");
    const adeDir = path.join(projectRoot, ".ade");
    const dbPath = path.join(adeDir, "ade.db");
    const sessionsDir = path.join(adeDir, "cache", "chat-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "one.json"), JSON.stringify({ id: "one" }));
    fs.writeFileSync(path.join(sessionsDir, "two.json"), JSON.stringify({ id: "two", continuityRecovery: { state: "required" } }));

    const db = await openKvDb(dbPath, logger());
    db.run("create table incident_fixture (id integer primary key, value text not null)");
    db.run("insert into incident_fixture values (?, ?)", [1, "authoritative"]);
    db.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec("create table __ade_crr_repair_incident_fixture (id integer primary key, value text not null)");
    raw.close();

    let free = 8 * 1024 * 1024;
    const service = createProjectRecoveryService({
      adeHome: projectRoot,
      logger: logger(),
      connectionPool: recoveryPool(),
      socketPath: path.join(rootPathForSocket(projectRoot), "ade.sock"),
      statfs: vi.fn(async () => ({ bavail: free, bsize: 1 })),
      probeSocket: vi.fn(async () => false),
      waitForSocketState: vi.fn(async (_socketPath, reachable) => reachable),
      quickCheck: vi.fn(async () => ({ healthy: true, detail: "ok" })),
      readFailureReports: vi.fn(async () => ({ project: null, machine: null })),
      clearFailureReports: vi.fn(async () => {}),
    });

    const blocked = await service.repair(projectRoot);
    expect(blocked).toMatchObject({ ok: false, failureCode: "disk_full" });
    expect(blocked.steps[0]).toMatchObject({ id: "check_space", status: "failed" });
    expect(blocked.nextAction).toMatch(/\d+ GB/);

    free = 8 * GIB;
    const repaired = await service.repair(projectRoot);
    expect(repaired).toMatchObject({ ok: true, dbHealthy: true, chatsTotal: 2, chatsNeedingAttention: 1 });
    expect(repaired.steps.find((step) => step.id === "resolve_migrations")).toMatchObject({ status: "ok" });
    const verified = await openKvDb(dbPath, logger());
    expect(verified.get<{ value: string }>("select value from incident_fixture where id = 1")?.value).toBe("authoritative");
    expect(verified.get("select 1 from sqlite_master where name = '__ade_crr_repair_incident_fixture'")).toBeNull();
    verified.close();
  });

  it("never follows a symlink farm during snapshot, cleanup preview, or compression listing", async () => {
    const projectRoot = tempRoot("symlink-project");
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outside-symlink-"));
    roots.push(externalRoot);
    const adeHome = tempRoot("symlink-home");
    const adeDir = path.join(projectRoot, ".ade");
    const cacheDir = path.join(adeDir, "cache");
    const chatDir = path.join(adeDir, "transcripts", "chat");
    const sentinelPath = path.join(externalRoot, "sentinel.jsonl");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(sentinelPath, Buffer.alloc(4 * 1024 * 1024, 0x73));
    fs.symlinkSync(externalRoot, path.join(cacheDir, "external-dir"));
    fs.symlinkSync(sentinelPath, path.join(cacheDir, "external-file"));
    fs.symlinkSync(sentinelPath, path.join(chatDir, "external-history.jsonl"));

    const db = await openKvDb(path.join(adeDir, "ade.db"), logger());
    const storage = createStorageInsightsService({ projectRoot, adeHome, db, logger: logger() });
    const snapshot = await storage.getSnapshot({ forceRefresh: true });
    const caches = snapshot.categories.find((category) => category.id === "caches")!;
    expect(caches.bytes).toBeLessThan(fs.statSync(sentinelPath).size);
    expect(snapshot.categories.flatMap((category) => category.items).every((item) => !item.path.startsWith(externalRoot))).toBe(true);

    const linkPath = path.join(cacheDir, "external-dir");
    const linkedTarget = path.join(linkPath, "sentinel.jsonl");
    const preview = await storage.cleanupPreview([
      { kind: "rebuildable_cache", path: linkPath },
      { kind: "rebuildable_cache", path: linkedTarget },
    ]);
    expect(preview.items).toEqual([]);
    expect(preview.blocked).toHaveLength(2);

    const compressor = createHistoryCompressor({ logger: logger(), minAgeDays: 0, isPathActive: () => false });
    expect(await compressor.listCandidates([{ path: chatDir, kind: "chat_transcript" }])).toEqual([]);
    expect(fs.existsSync(sentinelPath)).toBe(true);
    expect(fs.statSync(sentinelPath).size).toBe(4 * 1024 * 1024);
    storage.dispose();
    db.close();
  });
});

function rootPathForSocket(projectRoot: string): string {
  const runtime = path.join(projectRoot, ".ade", "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  return runtime;
}
