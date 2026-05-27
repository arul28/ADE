/* @vitest-environment node */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  createOrchestrationService,
  applyPatches,
  validateSpawnBrief,
} from "./orchestrationService";
import { CURSOR_AVAILABLE_MODE_IDS } from "../../../shared/cursorModes";
import type {
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexSandbox,
  AgentChatDroidPermissionMode,
  AgentChatOpenCodePermissionMode,
} from "../../../shared/types/chat";
import type {
  ModelRouting,
  ModelSelection,
} from "../../../shared/types/orchestration";

async function makeTempLane(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-orch-"));
  return root;
}

async function rmTree(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

describe("orchestrationService", () => {
  let lane: string;
  beforeEach(async () => {
    lane = await makeTempLane();
  });
  afterEach(async () => {
    await rmTree(lane);
  });

  it("creates a run, persists the manifest + plan, and assigns an etag", async () => {
    const svc = createOrchestrationService({
      resolveLaneWorktree: () => lane,
    });
    const { manifest, runId, etag } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Test run",
      goalSummary: "do the thing",
    });
    expect(runId).toMatch(/^R-/);
    expect(etag).toBeTruthy();
    expect(manifest.title).toBe("Test run");
    expect(manifest.agents).toHaveLength(1);
    expect(manifest.agents[0]!.role).toBe("lead");
    expect(manifest.phases[0]!.status).toBe("active");
    const onDisk = JSON.parse(
      await fsp.readFile(path.join(manifest.bundlePath, "manifest.json"), "utf-8"),
    );
    expect(onDisk.runId).toBe(runId);
    await svc.dispose();
  });

  it("hydrates lane runs from the persistent discovery index after restart", async () => {
    const svc = createOrchestrationService({
      resolveLaneWorktree: () => lane,
    });
    const created = [];
    for (const title of ["First run", "Second run", "Third run"]) {
      created.push(
        await svc.runCreate({
          laneId: "L-1",
          leadSessionId: `S-${title}`,
          bundleRoot: lane,
          title,
          goalSummary: `goal ${title}`,
        }),
      );
    }
    const index = JSON.parse(
      await fsp.readFile(path.join(lane, ".ade", "orchestration", "index.json"), "utf-8"),
    );
    expect(index.runs.map((entry: { runId: string }) => entry.runId)).toEqual(
      created.map((entry) => entry.runId),
    );
    await svc.dispose();

    const restarted = createOrchestrationService({
      resolveLaneWorktree: () => lane,
    });
    const list = await restarted.runList("L-1");
    expect(list).toHaveLength(3);
    expect(list.map((entry) => entry.runId)).toEqual(
      created.map((entry) => entry.runId),
    );
    expect(list.map((entry) => entry.title)).toEqual([
      "First run",
      "Second run",
      "Third run",
    ]);
    expect(list.map((entry) => entry.goalSummary)).toEqual([
      "goal First run",
      "goal Second run",
      "goal Third run",
    ]);
    await restarted.dispose();
  });

  it("falls back to scanning manifests when the discovery index is missing", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const first = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-1",
      bundleRoot: lane,
      title: "Indexed one",
    });
    const second = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-2",
      bundleRoot: lane,
      title: "Indexed two",
    });
    await fsp.rm(path.join(lane, ".ade", "orchestration", "index.json"), {
      force: true,
    });
    await svc.dispose();

    const restarted = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const list = await restarted.runList("L-1");
    expect(list.map((entry) => entry.runId).sort()).toEqual(
      [first.runId, second.runId].sort(),
    );
    expect(list.map((entry) => entry.title).sort()).toEqual([
      "Indexed one",
      "Indexed two",
    ]);
    const repaired = JSON.parse(
      await fsp.readFile(path.join(lane, ".ade", "orchestration", "index.json"), "utf-8"),
    ) as { runs: Array<{ runId: string }> };
    expect(repaired.runs.map((entry) => entry.runId).sort()).toEqual(
      [first.runId, second.runId].sort(),
    );
    await restarted.dispose();
  });

  it("merges scanned manifests back into a partial discovery index", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const first = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-1",
      bundleRoot: lane,
      title: "Indexed one",
    });
    const second = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-2",
      bundleRoot: lane,
      title: "Indexed two",
    });
    const indexPath = path.join(lane, ".ade", "orchestration", "index.json");
    const index = JSON.parse(await fsp.readFile(indexPath, "utf-8")) as {
      version: number;
      runs: Array<{ runId: string }>;
    };
    await fsp.writeFile(
      indexPath,
      JSON.stringify({
        version: index.version,
        runs: index.runs.filter((entry) => entry.runId === second.runId),
      }, null, 2),
    );
    await svc.dispose();

    const restarted = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const list = await restarted.runList("L-1");
    expect(list.map((entry) => entry.runId).sort()).toEqual(
      [first.runId, second.runId].sort(),
    );
    const repaired = JSON.parse(await fsp.readFile(indexPath, "utf-8")) as {
      runs: Array<{ runId: string }>;
    };
    expect(repaired.runs.map((entry) => entry.runId).sort()).toEqual(
      [first.runId, second.runId].sort(),
    );
    await restarted.dispose();
  });

  it("falls back to scanning manifests when the discovery index is corrupt", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const created = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-1",
      bundleRoot: lane,
      title: "Recoverable run",
    });
    await fsp.writeFile(path.join(lane, ".ade", "orchestration", "index.json"), "{nope");
    await svc.dispose();

    const restarted = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const list = await restarted.runList("L-1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      runId: created.runId,
      title: "Recoverable run",
    });
    await restarted.dispose();
  });

  it("skips stale discovery index entries whose manifest is gone", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const stale = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-stale",
      bundleRoot: lane,
      title: "Stale run",
    });
    const kept = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-kept",
      bundleRoot: lane,
      title: "Kept run",
    });
    await fsp.rm(path.join(stale.manifest.bundlePath, "manifest.json"), {
      force: true,
    });
    await svc.dispose();

    const restarted = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const list = await restarted.runList("L-1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      runId: kept.runId,
      title: "Kept run",
    });
    await restarted.dispose();
  });

  it("rejects mismatched etag on manifestPatch", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Test",
    });
    const res = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: "bogus-etag",
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{ op: "replace", path: "/title", value: "Renamed" }],
      },
      manifest.bundlePath,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("etag_conflict");
    }
    await svc.dispose();
  });

  it("updates an agent heartbeat without requiring a manifest etag", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    const withWorker = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{
          op: "add",
          path: "/agents/-",
          value: {
            sessionId: "S-worker",
            role: "worker",
            tag: "impl",
            goalSummary: "implement",
            status: "running",
            spawnedAt: new Date().toISOString(),
          },
        }],
      },
      manifest.bundlePath,
    );
    expect(withWorker.ok).toBe(true);

    const heartbeat = await svc.agentHeartbeat(
      { runId: manifest.runId, sessionId: "S-worker" },
      manifest.bundlePath,
    );
    expect(heartbeat.ok).toBe(true);
    const current = svc.getManifestForRun(manifest.runId)!;
    expect(current.agents.find((agent) => agent.sessionId === "S-worker")?.lastHeartbeatAt).toBeTruthy();
    await svc.dispose();
  });

  it("denies worker patching of validation gates", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    // Add a task as lead first
    const m1 = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-1",
              phaseId: "developing",
              title: "Implement login",
              description: "",
              status: "pending",
              validationGate: { required: true, stepIds: [] },
              assigneeSessionId: "S-worker",
            },
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;
    const denied = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: m1.etag,
        actorRole: "worker",
        actorSessionId: "S-worker",
        patches: [
          {
            op: "replace",
            path: "/tasks/{id:T-1}/validationGate",
            value: { required: false, stepIds: [] },
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error).toBe("policy_denied");
    }
    await svc.dispose();
  });

  it("rejects status=done for tasks with required gate when checklist incomplete", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    const m1 = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-1",
              phaseId: "developing",
              title: "Implement login",
              description: "",
              status: "in_progress",
              validationGate: { required: true, stepIds: ["V-1"] },
              assigneeSessionId: "S-worker",
            },
          },
          {
            op: "add",
            path: "/validationStrategy/checklist/-",
            value: {
              id: "C-1",
              stepId: "V-1",
              taskId: "T-1",
              runs: [
                {
                  id: "R-1",
                  runBySessionId: "S-validator",
                  status: "running",
                  startedAt: new Date().toISOString(),
                },
              ],
              latestRunId: "R-1",
            },
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;
    const blocked = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: m1.etag,
        actorRole: "worker",
        actorSessionId: "S-worker",
        patches: [
          {
            op: "replace",
            path: "/tasks/{id:T-1}/status",
            value: "done",
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toBe("validation_failed");
    }
    await svc.dispose();
  });

  it("allows status=done when humanOverride + UserOverrideEntry present in same patch", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    const m1 = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-1",
              phaseId: "developing",
              title: "x",
              description: "",
              status: "in_progress",
              validationGate: { required: true, stepIds: ["V-1"] },
              assigneeSessionId: "S-worker",
            },
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;
    const overridden = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: m1.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "replace",
            path: "/tasks/{id:T-1}/status",
            value: "done",
          },
          {
            op: "add",
            path: "/tasks/{id:T-1}/humanOverride",
            value: {
              at: new Date().toISOString(),
              fromStatus: "in_progress",
              toStatus: "done",
              reason: "shipping",
            },
          },
          {
            op: "add",
            path: "/userOverrides/-",
            value: {
              id: "O-1",
              at: new Date().toISOString(),
              scope: "task",
              appliedToId: "T-1",
              instruction: "skip validation, ship it",
            },
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(overridden.ok).toBe(true);
    await svc.dispose();
  });

  it("applies patches by id-predicate and rejects numeric indices", () => {
    const initial = {
      version: 1 as const,
      schemaCompatibility: { minReader: 1 as const, maxKnown: 1 as const },
      runId: "R-1",
      laneId: "L-1",
      bundlePath: "/tmp",
      etag: "e0",
      serverGeneration: 0,
      createdAt: "now",
      updatedAt: "now",
      title: "x",
      goalSummary: "",
      currentPhase: "planning" as const,
      phases: [],
      agents: [],
      tasks: [
        {
          id: "T-1",
          phaseId: "developing" as const,
          title: "a",
          description: "",
          status: "pending" as const,
          validationGate: { required: false, stepIds: [] },
        },
      ],
      validationStrategy: { steps: [], checklist: [] },
      modelRouting: {},
      assets: [],
      decisions: [],
      userOverrides: [],
      leadState: {},
      history: [],
    };
    const next = applyPatches(initial, [
      { op: "replace", path: "/tasks/{id:T-1}/status", value: "in_progress" },
    ]);
    expect(next.tasks[0]!.status).toBe("in_progress");
    expect(() =>
      applyPatches(initial, [{ op: "replace", path: "/tasks/0/status", value: "x" }]),
    ).toThrow(/numeric/i);
  });

  it("validates spawn-brief required sections", () => {
    expect(validateSpawnBrief("nothing here").ok).toBe(false);
    const good = `## TASK\nBuild login\n## FILES\nsrc/x.ts\n## DEPENDENCIES\nnone\n## GATES\nreverify_changes\n## PEERS\nnone\n## SUCCESS\ntests pass`;
    expect(validateSpawnBrief(good).ok).toBe(true);
  });
});

// --- Model routing precedence (consolidated from modelRouting.test.ts) ---

function resolveModel(
  routing: ModelRouting,
  role: "worker" | "validator",
  tag: string,
  fallback: ModelSelection,
  override?: ModelSelection,
): { selection: ModelSelection; routingKey: string } {
  if (override) return { selection: override, routingKey: "override" };
  if (routing.byRoleTag?.[`${role}:${tag}`]) {
    return { selection: routing.byRoleTag[`${role}:${tag}`]!, routingKey: "byRoleTag" };
  }
  if (routing.byTag?.[tag]) {
    return { selection: routing.byTag[tag]!, routingKey: "byTag" };
  }
  if (routing.byRole?.[role]) {
    return { selection: routing.byRole[role]!, routingKey: "byRole" };
  }
  if (routing.default) {
    return { selection: routing.default, routingKey: "default" };
  }
  return { selection: fallback, routingKey: "fallback" };
}

const MODEL_FALLBACK: ModelSelection = {
  provider: "claude",
  modelId: "claude-sonnet-4-6",
  reasoningEffort: null,
};

describe("model routing precedence", () => {
  it("byRoleTag wins over byTag/byRole/default", () => {
    const routing: ModelRouting = {
      default: { provider: "claude", modelId: "default" },
      byRole: { worker: { provider: "claude", modelId: "byrole" } },
      byTag: { "web-ui": { provider: "claude", modelId: "bytag" } },
      byRoleTag: { "worker:web-ui": { provider: "claude", modelId: "byroletag" } },
    };
    const res = resolveModel(routing, "worker", "web-ui", MODEL_FALLBACK);
    expect(res.selection.modelId).toBe("byroletag");
    expect(res.routingKey).toBe("byRoleTag");
  });

  it("byTag wins over byRole/default when no byRoleTag", () => {
    const routing: ModelRouting = {
      default: { provider: "claude", modelId: "default" },
      byRole: { worker: { provider: "claude", modelId: "byrole" } },
      byTag: { "web-ui": { provider: "claude", modelId: "bytag" } },
    };
    const res = resolveModel(routing, "worker", "web-ui", MODEL_FALLBACK);
    expect(res.selection.modelId).toBe("bytag");
    expect(res.routingKey).toBe("byTag");
  });

  it("byRole wins over default when no byTag", () => {
    const routing: ModelRouting = {
      default: { provider: "claude", modelId: "default" },
      byRole: { worker: { provider: "claude", modelId: "byrole" } },
    };
    const res = resolveModel(routing, "worker", "anything", MODEL_FALLBACK);
    expect(res.selection.modelId).toBe("byrole");
    expect(res.routingKey).toBe("byRole");
  });

  it("default wins when nothing else applies", () => {
    const routing: ModelRouting = {
      default: { provider: "claude", modelId: "default" },
    };
    const res = resolveModel(routing, "validator", "anything", MODEL_FALLBACK);
    expect(res.selection.modelId).toBe("default");
    expect(res.routingKey).toBe("default");
  });

  it("caller fallback when routing is empty", () => {
    const res = resolveModel({}, "validator", "anything", MODEL_FALLBACK);
    expect(res.selection.modelId).toBe("claude-sonnet-4-6");
    expect(res.routingKey).toBe("fallback");
  });

  it("override wins everything", () => {
    const routing: ModelRouting = {
      default: { provider: "claude", modelId: "default" },
      byRoleTag: { "worker:web-ui": { provider: "claude", modelId: "byroletag" } },
    };
    const override: ModelSelection = { provider: "codex", modelId: "o-1" };
    const res = resolveModel(routing, "worker", "web-ui", MODEL_FALLBACK, override);
    expect(res.selection.provider).toBe("codex");
    expect(res.routingKey).toBe("override");
  });
});

// --- Permission profile canary (consolidated from permissionProfile.test.ts) ---

const PERMISSION_PROFILE = {
  claude: { claudePermissionMode: "bypassPermissions" as AgentChatClaudePermissionMode },
  codex: {
    codexSandbox: "danger-full-access" as AgentChatCodexSandbox,
    codexApprovalPolicy: "never" as AgentChatCodexApprovalPolicy,
  },
  cursor: { cursorModeId: "full-auto" as const },
  droid: { droidPermissionMode: "auto-high" as AgentChatDroidPermissionMode },
  opencode: { opencodePermissionMode: "full-auto" as AgentChatOpenCodePermissionMode },
};

describe("orchestration permission profile (canary)", () => {
  it("cursor worker mode is full-auto (not 'agent')", () => {
    expect(PERMISSION_PROFILE.cursor.cursorModeId).toBe("full-auto");
    expect(CURSOR_AVAILABLE_MODE_IDS).toContain(PERMISSION_PROFILE.cursor.cursorModeId);
  });

  it("claude worker mode is bypassPermissions", () => {
    const allowed: AgentChatClaudePermissionMode[] = [
      "default",
      "auto",
      "plan",
      "acceptEdits",
      "bypassPermissions",
    ];
    expect(allowed).toContain(PERMISSION_PROFILE.claude.claudePermissionMode);
    expect(PERMISSION_PROFILE.claude.claudePermissionMode).toBe("bypassPermissions");
  });

  it("codex worker sandbox is danger-full-access with approvals=never", () => {
    const sandboxes: AgentChatCodexSandbox[] = [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ];
    expect(sandboxes).toContain(PERMISSION_PROFILE.codex.codexSandbox);
    expect(PERMISSION_PROFILE.codex.codexSandbox).toBe("danger-full-access");
    const policies: AgentChatCodexApprovalPolicy[] = [
      "untrusted",
      "on-request",
      "on-failure",
      "never",
    ];
    expect(policies).toContain(PERMISSION_PROFILE.codex.codexApprovalPolicy);
    expect(PERMISSION_PROFILE.codex.codexApprovalPolicy).toBe("never");
  });

  it("droid worker mode is auto-high", () => {
    const allowed: AgentChatDroidPermissionMode[] = [
      "read-only",
      "auto-low",
      "auto-medium",
      "auto-high",
    ];
    expect(allowed).toContain(PERMISSION_PROFILE.droid.droidPermissionMode);
    expect(PERMISSION_PROFILE.droid.droidPermissionMode).toBe("auto-high");
  });

  it("opencode worker mode is full-auto", () => {
    const allowed: AgentChatOpenCodePermissionMode[] = ["plan", "edit", "full-auto", "config-toml"];
    expect(allowed).toContain(PERMISSION_PROFILE.opencode.opencodePermissionMode);
    expect(PERMISSION_PROFILE.opencode.opencodePermissionMode).toBe("full-auto");
  });
});

// --- Validation concerns gating (consolidated from validationConcerns.test.ts) ---

describe("validation concerns gating", () => {
  let lane: string;
  beforeEach(async () => {
    lane = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-orch-vc-"));
  });
  afterEach(async () => {
    await fsp.rm(lane, { recursive: true, force: true });
  });

  it("rejects worker patch when required gates not passed; accepts when validator records passed", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    const m1 = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/agents/-",
            value: {
              sessionId: "S-validator",
              role: "validator",
              tag: "review",
              goalSummary: "validate T-1",
              status: "running",
              spawnedAt: "now",
              currentStepId: "V-1",
            },
          },
          {
            op: "add",
            path: "/validationStrategy/steps/-",
            value: {
              id: "V-1",
              concern: "reverify_changes",
              scope: "per_worker",
              required: true,
              prompt: "Re-read every touched file and walk error paths.",
              evidenceRequired: ["plan_md_section"],
            },
          },
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-1",
              phaseId: "developing",
              title: "x",
              description: "",
              status: "in_progress",
              validationGate: { required: true, stepIds: ["V-1"] },
              assigneeSessionId: "S-worker",
            },
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;

    const rejected = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: m1.etag,
        actorRole: "worker",
        actorSessionId: "S-worker",
        patches: [
          {
            op: "replace",
            path: "/tasks/{id:T-1}/status",
            value: "done",
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(rejected.ok).toBe(false);

    const m2 = await svc.recordValidationRun(
      {
        runId: manifest.runId,
        taskId: "T-1",
        stepId: "V-1",
        sessionId: "S-validator",
        status: "passed",
        notes: "validator proof appended to plan.md",
      },
      manifest.bundlePath,
    );
    expect(m2.ok).toBe(true);
    if (!m2.ok) return;

    const accepted = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: m2.etag,
        actorRole: "worker",
        actorSessionId: "S-worker",
        patches: [
          {
            op: "replace",
            path: "/tasks/{id:T-1}/status",
            value: "done",
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(accepted.ok).toBe(true);
    await svc.dispose();
  });

  it("lets an assigned worker record its per-worker gate and release done", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    const m1 = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/agents/-",
            value: {
              sessionId: "S-worker",
              role: "worker",
              tag: "impl",
              goalSummary: "implement",
              status: "running",
              spawnedAt: "now",
            },
          },
          {
            op: "add",
            path: "/validationStrategy/steps/-",
            value: {
              id: "V-worker-reverify",
              concern: "reverify_changes",
              scope: "per_worker",
              required: true,
              prompt: "Re-read every touched file and append evidence to plan.md.",
              evidenceRequired: ["plan_md_section"],
            },
          },
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-1",
              phaseId: "developing",
              title: "x",
              description: "",
              status: "claimed",
              validationGate: { required: true, stepIds: ["V-worker-reverify"] },
              assigneeSessionId: "S-worker",
            },
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;

    const beforeGate = await svc.releaseTask(
      {
        runId: manifest.runId,
        taskId: "T-1",
        sessionId: "S-worker",
        status: "done",
      },
      manifest.bundlePath,
    ).then(
      () => "unexpected",
      (err) => String(err),
    );
    expect(beforeGate).toContain("required validation gates not satisfied");

    const gate = await svc.recordValidationRun(
      {
        runId: manifest.runId,
        taskId: "T-1",
        stepId: "V-worker-reverify",
        sessionId: "S-worker",
        status: "passed",
        notes: "plan.md evidence appended; npm test passed",
      },
      manifest.bundlePath,
    );
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.manifest.validationStrategy.checklist).toMatchObject([
      {
        stepId: "V-worker-reverify",
        taskId: "T-1",
        latestRunId: gate.runId,
      },
    ]);

    const released = await svc.releaseTask(
      {
        runId: manifest.runId,
        taskId: "T-1",
        sessionId: "S-worker",
        status: "done",
      },
      manifest.bundlePath,
    );
    expect(released.manifest.tasks.find((task) => task.id === "T-1")?.status).toBe("done");
    await svc.dispose();
  });

  it("lead cannot lower validationGate.required without override pair", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    const m1 = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-2",
              phaseId: "developing",
              title: "x",
              description: "",
              status: "pending",
              validationGate: { required: true, stepIds: [] },
            },
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;
    const rejected = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: m1.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "replace",
            path: "/tasks/{id:T-2}/validationGate/required",
            value: false,
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(rejected.ok).toBe(false);
    await svc.dispose();
  });
});

// --- Watcher resilience (consolidated from watcherResilience.test.ts) ---

describe("orchestration watcher resilience", () => {
  let lane: string;
  beforeEach(async () => {
    lane = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-orch-watcher-"));
  });
  afterEach(async () => {
    await fsp.rm(lane, { recursive: true, force: true });
  });

  it("treats etag as monotonic across writes", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest: m1 } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Initial",
    });
    const e1 = m1.etag;
    const m2 = await svc.manifestPatch(
      {
        runId: m1.runId,
        ifMatchEtag: e1,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{ op: "replace", path: "/title", value: "Renamed" }],
      },
      m1.bundlePath,
    );
    expect(m2.ok).toBe(true);
    if (!m2.ok) return;
    expect(m2.etag).not.toBe(e1);
    expect(m2.manifest.serverGeneration).toBeGreaterThan(m1.serverGeneration);
    await svc.dispose();
  });

  it("history ring captures recent etag transitions", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    let etag = manifest.etag;
    for (let i = 0; i < 5; i++) {
      const res = await svc.manifestPatch(
        {
          runId: manifest.runId,
          ifMatchEtag: etag,
          actorRole: "lead",
          actorSessionId: "S-lead",
          patches: [
            {
              op: "replace",
              path: "/title",
              value: `title-${i}`,
            },
          ],
        },
        manifest.bundlePath,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      etag = res.etag;
    }
    const latest = svc.getManifestForRun(manifest.runId);
    expect(latest?.history.length).toBeGreaterThanOrEqual(5);
    expect(latest?.history.at(-1)?.etag).toBe(etag);
    await svc.dispose();
  });

  it("planAppend produces an event with the new contents", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    const events: unknown[] = [];
    const off = svc.on("event", (payload) => events.push(payload));
    await svc.planAppend(
      {
        runId: manifest.runId,
        section: "Worker T-1 progress",
        body: "Touched src/login.tsx and src/auth.ts.",
      },
      manifest.bundlePath,
    );
    expect(events.some((e) => (e as { kind?: string }).kind === "plan")).toBe(true);
    off();
    await svc.dispose();
  });
});
