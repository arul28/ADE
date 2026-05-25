import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdeGitignore } from "../../../shared/adeLayout";
import type { LinearSyncConfig, LinearWorkflowConfig } from "../../../shared/types";
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

describe("ctoStateService", () => {
  it("creates default CTO identity and current context when absent", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.identity.name).toBe("CTO");
    expect(snapshot.identity.version).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(path.join(fixture.adeDir, "cto", "identity.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.adeDir, "cto", "CURRENT.md"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.adeDir, "cto", "sessions.jsonl"))).toBe(false);
    expect(buildAdeGitignore()).toContain("!cto/identity.yaml");
    expect(buildAdeGitignore()).not.toContain("cto/CURRENT.md");

    fixture.db.close();
  });

  it("recreates files from DB-only state", async () => {
    const fixture = await createStateFixture();
    const identityPayload = {
      name: "CTO",
      version: 7,
      persona: "DB canonical identity",
      modelPreferences: { provider: "claude", model: "sonnet" },
      updatedAt: "2026-03-05T12:00:00.000Z",
    };

    fixture.db.run(
      `insert into cto_identity_state(project_id, version, payload_json, updated_at) values(?, ?, ?, ?)`,
      [fixture.projectId, identityPayload.version, JSON.stringify(identityPayload), identityPayload.updatedAt]
    );

    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });
    const snapshot = service.getSnapshot();
    expect(snapshot.identity.persona).toBe("DB canonical identity");

    const identityFile = fs.readFileSync(path.join(fixture.adeDir, "cto", "identity.yaml"), "utf8");
    expect(identityFile).toContain("DB canonical identity");

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
        'updatedAt: "2026-03-05T13:00:00.000Z"',
        "",
      ].join("\n"),
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
    expect(JSON.parse(identityRow?.payload_json ?? "{}").persona).toBe("File identity");

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
    expect(reconstruction).toContain("Current working context");
    expect(reconstruction).toContain("Recent worker activity");
    expect(reconstruction).toContain("Mobile Dev");
    expect(reconstruction).toContain("task:navigation-fix");

    fixture.db.close();
  });

  it("generates current context docs from recent activity", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    service.appendSubordinateActivity({
      agentId: "qa",
      agentName: "QA",
      activityType: "worker_run",
      summary: "Verified release checks.",
    });

    service.syncDerivedContextDoc();

    const currentDoc = fs.readFileSync(path.join(fixture.adeDir, "cto", "CURRENT.md"), "utf8");
    expect(currentDoc).toContain("Recent worker activity");
    expect(currentDoc).toContain("Verified release checks");

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
    expect(preview.sections.map((section) => section.id)).toEqual(["doctrine", "personality", "continuity", "knowledge", "capabilities"]);
    expect(preview.sections[0]?.content).toContain("You are the CTO for the current project inside ADE.");
    expect(preview.sections[1]?.content).toContain("Operate as a strategic CTO.");
    expect(preview.sections[2]?.content).toContain("Immutable doctrine");
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
          target: { type: "worker_run" },
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
