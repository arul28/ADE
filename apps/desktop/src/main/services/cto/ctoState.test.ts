import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdeGitignore } from "../../../shared/adeLayout";
import type { LinearSyncConfig, LinearWorkflowConfig } from "../../../shared/types";
import { createMemoryService } from "../memory/memoryService";
import { openKvDb } from "../state/kvDb";
import { createCtoStateService } from "./ctoStateService";
import { createFlowPolicyService } from "./flowPolicyService";
import { createLinearWorkflowFileService } from "./linearWorkflowFileService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

async function createStateFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cto-state-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const dbPath = path.join(adeDir, "ade.db");
  const db = await openKvDb(dbPath, createLogger());
  const projectId = "project-test";
  return { root, adeDir, db, projectId };
}

async function createStateFixtureWithMemory() {
  const fixture = await createStateFixture();
  fixture.db.run(
    `INSERT OR IGNORE INTO projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [fixture.projectId, fixture.root, "test-project", "main", new Date().toISOString(), new Date().toISOString()]
  );
  const memoryService = createMemoryService(fixture.db);
  return { ...fixture, memoryService };
}

describe("ctoStateService", () => {
  it("creates default CTO identity/core memory when absent", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.identity.name).toBe("CTO");
    expect(snapshot.identity.version).toBeGreaterThanOrEqual(1);
    expect(snapshot.coreMemory.version).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(path.join(fixture.adeDir, "cto", "identity.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.adeDir, "cto", "core-memory.json"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.adeDir, "cto", "MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.adeDir, "cto", "CURRENT.md"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.adeDir, "cto", "sessions.jsonl"))).toBe(false);
    expect(buildAdeGitignore()).not.toContain("cto/identity.yaml");
    expect(buildAdeGitignore()).toContain("cto/core-memory.json");
    expect(buildAdeGitignore()).toContain("cto/CURRENT.md");
    expect(buildAdeGitignore()).toContain("cto/openclaw-history.json");

    fixture.db.close();
  });

  it("recreates files from DB-only state", async () => {
    const fixture = await createStateFixture();
    const identityPayload = {
      name: "CTO",
      version: 7,
      persona: "DB canonical identity",
      modelPreferences: { provider: "claude", model: "sonnet" },
      memoryPolicy: {
        autoCompact: true,
        compactionThreshold: 0.7,
        preCompactionFlush: true,
        temporalDecayHalfLifeDays: 30,
      },
      updatedAt: "2026-03-05T12:00:00.000Z",
    };
    const corePayload = {
      version: 9,
      updatedAt: "2026-03-05T12:00:00.000Z",
      projectSummary: "DB summary",
      criticalConventions: ["strict typing"],
      userPreferences: ["tests first"],
      activeFocus: [],
      notes: [],
    };

    fixture.db.run(
      `insert into cto_identity_state(project_id, version, payload_json, updated_at) values(?, ?, ?, ?)`,
      [fixture.projectId, identityPayload.version, JSON.stringify(identityPayload), identityPayload.updatedAt]
    );
    fixture.db.run(
      `insert into cto_core_memory_state(project_id, version, payload_json, updated_at) values(?, ?, ?, ?)`,
      [fixture.projectId, corePayload.version, JSON.stringify(corePayload), corePayload.updatedAt]
    );

    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });
    const snapshot = service.getSnapshot();
    expect(snapshot.identity.persona).toBe("DB canonical identity");
    expect(snapshot.coreMemory.projectSummary).toBe("DB summary");

    const identityFile = fs.readFileSync(path.join(fixture.adeDir, "cto", "identity.yaml"), "utf8");
    expect(identityFile).toContain("DB canonical identity");
    const coreFile = JSON.parse(fs.readFileSync(path.join(fixture.adeDir, "cto", "core-memory.json"), "utf8"));
    expect(coreFile.projectSummary).toBe("DB summary");

    fixture.db.close();
  });

  it("recreates DB rows from file-only state", async () => {
    const fixture = await createStateFixture();
    const ctoDir = path.join(fixture.adeDir, "cto");
    fs.mkdirSync(ctoDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctoDir, "identity.yaml"),
      [
        "name: CTO",
        "version: 4",
        'persona: "File identity"',
        "modelPreferences:",
        '  provider: "codex"',
        '  model: "gpt-5.3-codex"',
        "memoryPolicy:",
        "  autoCompact: true",
        "  compactionThreshold: 0.8",
        "  preCompactionFlush: true",
        "  temporalDecayHalfLifeDays: 45",
        'updatedAt: "2026-03-05T13:00:00.000Z"',
        "",
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(ctoDir, "core-memory.json"),
      JSON.stringify(
        {
          version: 6,
          updatedAt: "2026-03-05T13:00:00.000Z",
          projectSummary: "File core memory",
          criticalConventions: ["no force push"],
          userPreferences: ["small PRs"],
          activeFocus: ["stability"],
          notes: ["remember regression suite"],
        },
        null,
        2
      ),
      "utf8"
    );

    createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const identityRow = fixture.db.get<{ payload_json: string }>(
      `select payload_json from cto_identity_state where project_id = ? limit 1`,
      [fixture.projectId]
    );
    const coreRow = fixture.db.get<{ payload_json: string }>(
      `select payload_json from cto_core_memory_state where project_id = ? limit 1`,
      [fixture.projectId]
    );
    expect(JSON.parse(identityRow?.payload_json ?? "{}").persona).toBe("File identity");
    expect(JSON.parse(coreRow?.payload_json ?? "{}").projectSummary).toBe("File core memory");

    fixture.db.close();
  });

  it("uses newer doc and prefers file when timestamps tie", async () => {
    const fixture = await createStateFixture();
    const ctoDir = path.join(fixture.adeDir, "cto");
    fs.mkdirSync(ctoDir, { recursive: true });

    // DB newer than file -> DB should win.
    fs.writeFileSync(
      path.join(ctoDir, "core-memory.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-03-01T00:00:00.000Z",
          projectSummary: "old file",
          criticalConventions: [],
          userPreferences: [],
          activeFocus: [],
          notes: [],
        },
        null,
        2
      ),
      "utf8"
    );
    fixture.db.run(
      `insert into cto_core_memory_state(project_id, version, payload_json, updated_at) values(?, ?, ?, ?)`,
      [
        fixture.projectId,
        2,
        JSON.stringify({
          version: 2,
          updatedAt: "2026-03-02T00:00:00.000Z",
          projectSummary: "new db",
          criticalConventions: [],
          userPreferences: [],
          activeFocus: [],
          notes: [],
        }),
        "2026-03-02T00:00:00.000Z",
      ]
    );

    let service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });
    expect(service.getCoreMemory().projectSummary).toBe("new db");

    // Tie timestamp with different content -> file should win.
    const tiePayload = {
      version: 3,
      updatedAt: "2026-03-03T00:00:00.000Z",
      projectSummary: "file wins tie",
      criticalConventions: [],
      userPreferences: [],
      activeFocus: [],
      notes: [],
    };
    fs.writeFileSync(path.join(ctoDir, "core-memory.json"), JSON.stringify(tiePayload, null, 2), "utf8");
    fixture.db.run(
      `update cto_core_memory_state set version = ?, payload_json = ?, updated_at = ? where project_id = ?`,
      [
        3,
        JSON.stringify({ ...tiePayload, projectSummary: "db loses tie" }),
        tiePayload.updatedAt,
        fixture.projectId,
      ]
    );

    service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });
    expect(service.getCoreMemory().projectSummary).toBe("file wins tie");

    fixture.db.close();
  });

  it("keeps session log integrity and backfills DB from jsonl", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const entry = service.appendSessionLog({
      sessionId: "session-1",
      summary: "First CTO session",
      startedAt: "2026-03-05T10:00:00.000Z",
      endedAt: "2026-03-05T10:05:00.000Z",
      provider: "codex",
      modelId: "openai/gpt-5.3-codex",
      capabilityMode: "full_tooling",
    });
    expect(entry.sessionId).toBe("session-1");
    expect(service.getSessionLogs(10).length).toBe(1);

    fixture.db.run(`delete from cto_session_logs where project_id = ? and session_id = ?`, [fixture.projectId, "session-1"]);
    const afterDelete = fixture.db.get<{ count: number }>(
      `select count(*) as count from cto_session_logs where project_id = ? and session_id = ?`,
      [fixture.projectId, "session-1"]
    );
    expect(Number(afterDelete?.count ?? 0)).toBe(0);

    const recovered = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });
    const logs = recovered.getSessionLogs(10);
    expect(logs.length).toBe(1);
    expect(logs[0]?.summary).toBe("First CTO session");

    fixture.db.close();
  });

  it("normalizes legacy full_mcp session logs as full tooling", async () => {
    const fixture = await createStateFixture();
    const ctoDir = path.join(fixture.adeDir, "cto");
    fs.mkdirSync(ctoDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctoDir, "sessions.jsonl"),
      `${JSON.stringify({
        sessionId: "legacy-session",
        summary: "Legacy CTO session",
        startedAt: "2026-03-05T10:00:00.000Z",
        endedAt: "2026-03-05T10:05:00.000Z",
        provider: "codex",
        modelId: "openai/gpt-5.3-codex",
        capabilityMode: "full_mcp",
        createdAt: "2026-03-05T10:06:00.000Z",
      })}\n`,
      "utf8"
    );

    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    expect(service.getSessionLogs(10)[0]?.capabilityMode).toBe("full_tooling");

    fixture.db.close();
  });

  it("tracks subordinate activity and exposes it in CTO reconstruction context", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const entry = service.appendSubordinateActivity({
      agentId: "mobile-dev",
      agentName: "Mobile Dev",
      activityType: "chat_turn",
      summary: "Investigated navigation regressions and proposed a stack-level fix.",
      sessionId: "session-mobile",
      taskKey: "task:navigation-fix",
      issueKey: "ISSUE-77",
    });

    expect(entry.agentId).toBe("mobile-dev");
    const snapshot = service.getSnapshot(10);
    expect(snapshot.recentSubordinateActivity.length).toBe(1);
    expect(snapshot.recentSubordinateActivity[0]?.summary).toContain("navigation regressions");

    const reconstruction = service.buildReconstructionContext(10);
    expect(reconstruction).toContain("Layer 3 — Current working context");
    expect(reconstruction).toContain("Recent worker activity");
    expect(reconstruction).toContain("Mobile Dev");
    expect(reconstruction).toContain("task:navigation-fix");

    fixture.db.close();
  });

  it("generates long-term memory docs from core memory and promoted durable memories", async () => {
    const fixture = await createStateFixtureWithMemory();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
      memoryService: fixture.memoryService,
    });

    service.updateCoreMemory({
      projectSummary: "ADE is a local-first orchestration desktop app.",
      criticalConventions: ["Never force-push shared branches"],
      activeFocus: ["CTO continuity"],
    });
    fixture.memoryService.addMemory({
      projectId: fixture.projectId,
      scope: "project",
      category: "decision",
      content: "Decision: keep CTO memory layered as identity, brief, current context, and searchable durable memory.",
      importance: "high",
    });

    service.syncDerivedMemoryDocs();

    const memoryDoc = fs.readFileSync(path.join(fixture.adeDir, "cto", "MEMORY.md"), "utf8");
    const currentDoc = fs.readFileSync(path.join(fixture.adeDir, "cto", "CURRENT.md"), "utf8");
    expect(memoryDoc).toContain("ADE is a local-first orchestration desktop app.");
    expect(memoryDoc).toContain("Never force-push shared branches");
    expect(memoryDoc).toContain("keep CTO memory layered");
    expect(currentDoc).toContain("CTO continuity");

    fixture.db.close();
  });

  it("appendDailyLog creates the directory and file with timestamped entry", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    service.appendDailyLog("Reviewed PR #42 and approved.", "2026-03-14");

    const dailyDir = path.join(fixture.adeDir, "cto", "daily");
    expect(fs.existsSync(dailyDir)).toBe(true);

    const logFile = path.join(dailyDir, "2026-03-14.md");
    expect(fs.existsSync(logFile)).toBe(true);

    const content = fs.readFileSync(logFile, "utf8");
    expect(content).toMatch(/^- \[\d{2}:\d{2}:\d{2}\] Reviewed PR #42 and approved\.\n$/);

    fixture.db.close();
  });

  it("appendDailyLog appends to existing log", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    service.appendDailyLog("First entry", "2026-03-14");
    service.appendDailyLog("Second entry", "2026-03-14");

    const logFile = path.join(fixture.adeDir, "cto", "daily", "2026-03-14.md");
    const content = fs.readFileSync(logFile, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/- \[\d{2}:\d{2}:\d{2}\] First entry/);
    expect(lines[1]).toMatch(/- \[\d{2}:\d{2}:\d{2}\] Second entry/);

    fixture.db.close();
  });

  it("readDailyLog returns null for non-existent date", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    expect(service.readDailyLog("1999-01-01")).toBeNull();

    fixture.db.close();
  });

  it("readDailyLog reads back what was written", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    service.appendDailyLog("Deployed v2.1.0 to staging.", "2026-03-13");
    const content = service.readDailyLog("2026-03-13");
    expect(content).not.toBeNull();
    expect(content).toMatch(/Deployed v2\.1\.0 to staging\./);

    fixture.db.close();
  });

  it("listDailyLogs returns dates in reverse chronological order", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    service.appendDailyLog("entry", "2026-03-10");
    service.appendDailyLog("entry", "2026-03-12");
    service.appendDailyLog("entry", "2026-03-11");

    const dates = service.listDailyLogs();
    expect(dates).toEqual(["2026-03-12", "2026-03-11", "2026-03-10"]);

    fixture.db.close();
  });

  it("listDailyLogs respects the limit parameter", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    service.appendDailyLog("entry", "2026-03-08");
    service.appendDailyLog("entry", "2026-03-09");
    service.appendDailyLog("entry", "2026-03-10");
    service.appendDailyLog("entry", "2026-03-11");
    service.appendDailyLog("entry", "2026-03-12");

    const dates = service.listDailyLogs(2);
    expect(dates).toEqual(["2026-03-12", "2026-03-11"]);

    fixture.db.close();
  });

  it("appendContinuityCheckpoint writes a compaction carry-forward into the daily log", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    service.appendContinuityCheckpoint({
      reason: "compaction",
      entries: [
        { role: "user", text: "We should make the CTO remember the project brief more explicitly." },
        { role: "assistant", text: "I’ll split the memory model into long-term brief, current context, and durable searchable memory." },
      ],
    });

    const latestDate = service.listDailyLogs(1)[0];
    expect(latestDate).toBeTruthy();
    const content = service.readDailyLog(latestDate);
    expect(content).toContain("Compaction checkpoint");
    expect(content).toContain("project brief");
    expect(content).toContain("durable searchable memory");

    fixture.db.close();
  });

  it("preserves onboarding state and extended identity fields across reloads", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    service.updateIdentity({
      personality: "casual",
      constraints: ["no force push", "write tests"],
      systemPromptExtension: "Stay calm under pressure.",
      communicationStyle: {
        verbosity: "adaptive",
        proactivity: "balanced",
        escalationThreshold: "low",
      },
    });
    service.completeOnboardingStep("identity");

    const reloaded = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    expect(reloaded.getOnboardingState().completedSteps).toEqual(["identity"]);
    expect(reloaded.getOnboardingState().completedAt).toBeTruthy();
    expect(reloaded.getIdentity().personality).toBe("casual");
    expect(reloaded.getIdentity().constraints).toEqual(["no force push", "write tests"]);
    expect(reloaded.getIdentity().systemPromptExtension).toBe("Stay calm under pressure.");
    expect(reloaded.getIdentity().communicationStyle).toEqual({
      verbosity: "adaptive",
      proactivity: "balanced",
      escalationThreshold: "low",
    });

    fixture.db.close();
  });

  it("builds a structured CTO prompt preview with immutable doctrine and preset overlay", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const preview = service.previewSystemPrompt();
    expect(preview.sections.map((section) => section.id)).toEqual(["doctrine", "personality", "memory", "knowledge", "capabilities"]);
    expect(preview.sections[0]?.content).toContain("You are the CTO for the current project inside ADE.");
    expect(preview.sections[1]?.content).toContain("Operate as a strategic CTO.");
    expect(preview.sections[2]?.content).toContain("Immutable doctrine");
    expect(preview.sections[2]?.content).toContain("Use memoryUpdateCore only when the standing project brief changes");
    expect(preview.sections[2]?.content).toContain("Do not write ephemeral turn-by-turn status");
    // Knowledge section: ADE architecture, chat vs terminal disambiguation, task routing, model selection
    expect(preview.sections[3]?.content).toContain("ADE Architecture");
    expect(preview.sections[3]?.content).toContain("spawnChat");
    expect(preview.sections[3]?.content).toContain("createTerminal");
    expect(preview.sections[3]?.content).toContain("spawnChat");
    expect(preview.sections[3]?.content).toContain("Model Selection");
    // Capabilities section: organized tool reference with descriptions
    expect(preview.sections[4]?.content).toContain("ADE Operator Tools");
    expect(preview.sections[4]?.content).toContain("listLanes");
    expect(preview.sections[4]?.content).toContain("UI navigation is suggestion-only.");
    expect(preview.prompt).toContain("Immutable ADE doctrine");
    expect(preview.prompt).toContain("Selected personality overlay");
    expect(preview.prompt).toContain("ADE environment knowledge");
    expect(preview.prompt).toContain("ADE operator tools");

    fixture.db.close();
  });

  it("uses the custom personality overlay without removing the immutable doctrine", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const snapshot = service.updateIdentity({
      personality: "custom",
      customPersonality: "Be sharp, skeptical, and deeply execution-focused.",
      persona: "Legacy custom note",
    });
    const preview = service.previewSystemPrompt(snapshot.identity);

    expect(preview.sections[0]?.content).toContain("You are the CTO for the current project inside ADE.");
    expect(preview.sections[1]?.content).toContain("Be sharp, skeptical, and deeply execution-focused.");
    expect(preview.prompt).toContain("Immutable ADE doctrine");
    expect(preview.prompt).toContain("Be sharp, skeptical, and deeply execution-focused.");

    fixture.db.close();
  });
});

async function createFlowPolicyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-flow-policy-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const dbPath = path.join(adeDir, "ade.db");
  const db = await openKvDb(dbPath, createLogger());
  const projectId = "project-flow-policy";
  const legacyConfig: LinearSyncConfig = {
    enabled: true,
    projects: [{ slug: "acme-platform", defaultWorker: "backend-dev" }],
    autoDispatch: { default: "auto", rules: [{ id: "rule-1", action: "auto", match: { labels: ["bug"] } }] },
  };
  const projectConfigService = {
    getEffective: () => ({ linearSync: legacyConfig }),
  };
  const workflowFileService = createLinearWorkflowFileService({ projectRoot: root });
  return { db, root, projectId, projectConfigService, workflowFileService };
}

describe("flowPolicyService", () => {
  it("bootstraps from generated migration, saves repo workflows, and rolls back revisions", async () => {
    const fixture = await createFlowPolicyFixture();
    const service = createFlowPolicyService({
      db: fixture.db,
      projectId: fixture.projectId,
      projectConfigService: fixture.projectConfigService,
      workflowFileService: fixture.workflowFileService,
    });

    const bootstrapped = service.getPolicy();
    expect(bootstrapped.workflows.length).toBeGreaterThan(0);
    expect(bootstrapped.migration?.needsSave).toBe(true);
    expect(bootstrapped.intake.activeStateTypes).toEqual(["backlog", "unstarted", "started"]);
    expect(bootstrapped.intake.terminalStateTypes).toEqual(["completed", "canceled"]);

    const toSave: LinearWorkflowConfig = {
      ...bootstrapped,
      workflows: bootstrapped.workflows.map((workflow, index) => ({
        ...workflow,
        priority: 200 - index,
      })),
      intake: {
        projectSlugs: ["acme-platform"],
        activeStateTypes: ["backlog", "unstarted"],
        terminalStateTypes: ["completed", "canceled"],
      },
    };

    const saved = service.savePolicy(toSave, "user-a");
    expect(saved.source).toBe("repo");
    expect(saved.intake.projectSlugs).toEqual(["acme-platform"]);
    expect(saved.intake.activeStateTypes).toEqual(["backlog", "unstarted"]);
    expect(fs.readdirSync(path.join(fixture.root, ".ade", "workflows", "linear")).some((entry) => entry.endsWith(".yaml"))).toBe(true);

    const revisions = service.listRevisions(10);
    expect(revisions.length).toBe(2);
    expect(revisions[0]?.actor).toBe("user-a");

    const bootstrapRevision = revisions.find((revision) => revision.actor === "bootstrap");
    expect(bootstrapRevision).toBeTruthy();
    const rolledBack = service.rollbackRevision(bootstrapRevision!.id, "user-b");
    expect(rolledBack.workflows[0]?.name).toBeTruthy();
    expect(service.listRevisions(10)[0]?.actor).toBe("user-b");

    fixture.db.close();
  });

  it("validates duplicate workflow ids", async () => {
    const fixture = await createFlowPolicyFixture();
    const service = createFlowPolicyService({
      db: fixture.db,
      projectId: fixture.projectId,
      projectConfigService: fixture.projectConfigService,
      workflowFileService: fixture.workflowFileService,
    });

    const validation = service.validatePolicy({
      version: 1,
      source: "generated",
      intake: {
        projectSlugs: ["acme-platform"],
        activeStateTypes: ["backlog", "unstarted", "started"],
        terminalStateTypes: ["completed", "canceled"],
      },
      settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
      workflows: [
        {
          id: "dup",
          name: "One",
          enabled: true,
          priority: 100,
          triggers: { assignees: ["CTO"] },
          target: { type: "mission" },
          steps: [{ id: "launch", type: "launch_target" }],
        },
        {
          id: "DUP",
          name: "Two",
          enabled: true,
          priority: 90,
          triggers: { assignees: ["CTO"] },
          target: { type: "review_gate" },
          steps: [{ id: "launch", type: "launch_target" }],
        },
      ],
      files: [],
      migration: { hasLegacyConfig: false, needsSave: true },
      legacyConfig: null,
    });

    expect(validation.ok).toBe(false);
    expect(validation.issues.join(" ")).toContain("Duplicate workflow id");

    fixture.db.close();
  });
});
