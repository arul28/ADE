/* @vitest-environment node */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestrationService } from "../../orchestration/orchestrationService";
import {
  assessOrchestrationPlanQuality,
  buildOrchestrationSandboxConfig,
  createOrchestrationToolSet,
  type OrchestrationAgentChatHandle,
  type OrchestrationSessionContext,
  type OrchestrationToolSetOptions,
} from "./orchestrationTools";
import { DEFAULT_WORKER_SANDBOX_CONFIG } from "./workerSandboxDefaults";

const VALID_BRIEF = `
## TASK

Implement T-1.

## FILES

- src/foo.ts

## DEPENDENCIES

none

## GATES

reverify_changes

## PEERS

none

## SUCCESS

tests pass
`.trim();

const VALID_APPROVAL_PLAN = `
## Goal and assumptions
Implement the requested orchestration hardening with the current ADE patterns.

## In scope
Prompt guidance, runtime plan approval, and focused tests.

## Out of scope
No PR publishing, release work, or unrelated refactors.

## Alternatives and tradeoffs
Considered a strict template, but chose a minimum-quality gate so the planner can add deeper sections.

## UI decisions
No UI changes are required for this backend-only plan.

## Implementation order
First update prompts, then add the approval gate, then update tests. The prompt and tool work can run in parallel after shared requirements are locked.

## Agent plan
Spawn one worker with tag prompt-tools for implementation and one validator with tag validation for focused checks. Model routing is selected before approval.

## Coordination log
Workers use plan.md and manifest updates for progress updates, stuck reports, failures, and final handoff notes.

## Validation plan
Run targeted vitest files, typecheck, and diff checks as proof.
`.trim();

function makeChatStub(): OrchestrationAgentChatHandle & {
  createSession: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  readTranscript: ReturnType<typeof vi.fn>;
} {
  return {
    createSession: vi.fn(async () => ({ id: "S-spawned-1" })),
    deleteSession: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    readTranscript: vi.fn(async () => []),
  };
}

type Setup = {
  laneRoot: string;
  bundlePath: string;
  svc: ReturnType<typeof createOrchestrationService>;
  chat: ReturnType<typeof makeChatStub>;
  runId: string;
};

async function setupWithRun(role: "lead" | "worker" | "validator"): Promise<Setup> {
  const laneRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-orch-tools-"));
  const svc = createOrchestrationService({
    resolveLaneWorktree: () => laneRoot,
  });
  const created = await svc.runCreate({
    laneId: "L-test",
    leadSessionId: role === "lead" ? "S-lead" : "S-lead",
    bundleRoot: laneRoot,
    title: "test run",
    goalSummary: "do the thing",
  });
  return {
    laneRoot,
    bundlePath: created.manifest.bundlePath,
    svc,
    chat: makeChatStub(),
    runId: created.runId,
  };
}

async function cleanup(s: Setup): Promise<void> {
  await s.svc.dispose();
  await fsp.rm(s.laneRoot, { recursive: true, force: true });
}

async function approveRun(setup: Setup): Promise<void> {
  const approvedAt = new Date().toISOString();
  const res = await setup.svc.approvePlan(
    setup.runId,
    setup.bundlePath,
    [
      { op: "add", path: "/leadState/planApprovedAt", value: approvedAt },
      { op: "add", path: "/leadState/planApprovedBySessionId", value: "S-lead" },
      { op: "replace", path: "/currentPhase", value: "developing" },
      { op: "replace", path: "/phases/{id:planning}/status", value: "done" },
      { op: "replace", path: "/phases/{id:developing}/status", value: "active" },
    ],
    "approve plan",
  );
  expect(res.ok).toBe(true);
}

function makeToolSet(
  setup: Setup,
  role: "lead" | "worker" | "validator",
  sessionId: string,
  overrides: Partial<OrchestrationToolSetOptions> = {},
) {
  const interactionMode =
    role === "lead"
      ? "orchestrator-lead"
      : role === "validator"
        ? "orchestrator-validator"
        : "orchestrator-worker";
  const ctx: OrchestrationSessionContext = {
    sessionId,
    runId: setup.runId,
    role,
    bundlePath: setup.bundlePath,
    laneId: "L-test",
    leadSessionId: role === "lead" ? undefined : "S-lead",
  };
  return createOrchestrationToolSet({
    cwd: setup.laneRoot,
    interactionMode,
    sessionContext: ctx,
    orchestrationService: setup.svc,
    agentChatService: setup.chat,
    universal: { permissionMode: "full-auto" },
    ...overrides,
  });
}

describe("createOrchestrationToolSet", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("lead toolset has no editFile/writeFile/bash and exposes spawn/messageAgent", async () => {
    setup = await setupWithRun("lead");
    const tools = makeToolSet(setup, "lead", "S-lead");
    expect(tools.readFile).toBeDefined();
    expect(tools.grep).toBeDefined();
    expect(tools.gitStatus).toBeDefined();
    expect(tools.editFile).toBeUndefined();
    expect(tools.writeFile).toBeUndefined();
    expect(tools.bash).toBeUndefined();
    expect(tools.exitPlanMode).toBeUndefined();
    expect(tools.spawnAgent).toBeDefined();
    expect(tools.messageAgent).toBeDefined();
    expect(tools.getAgentTranscript).toBeDefined();
    expect(tools.manifestPatch).toBeDefined();
    expect(tools.planAppend).toBeDefined();
    expect(tools.planWrite).toBeDefined();
    expect(tools.requestPlanApproval).toBeDefined();
    expect(tools.askUserForModelSelection).toBeDefined();
    expect(tools.registerAsset).toBeDefined();
    expect(tools.claimTask).toBeDefined();
    expect(tools.releaseTask).toBeDefined();
    expect(tools.recordValidationRun).toBeDefined();
  });

  it("worker toolset has editFile/writeFile/bash + orchestration tools but no lead-only tools", async () => {
    setup = await setupWithRun("worker");
    const tools = makeToolSet(setup, "worker", "S-worker");
    expect(tools.readFile).toBeDefined();
    expect(tools.editFile).toBeDefined();
    expect(tools.writeFile).toBeDefined();
    expect(tools.bash).toBeDefined();
    expect(tools.spawnAgent).toBeUndefined();
    expect(tools.planWrite).toBeUndefined();
    expect(tools.requestPlanApproval).toBeUndefined();
    expect(tools.askUserForModelSelection).toBeUndefined();
    expect(tools.claimTask).toBeDefined();
    expect(tools.releaseTask).toBeDefined();
    expect(tools.manifestPatch).toBeDefined();
    expect(tools.planAppend).toBeDefined();
    expect(tools.messageAgent).toBeDefined();
    expect(tools.getAgentTranscript).toBeDefined();
    expect(tools.registerAsset).toBeDefined();
    expect(tools.recordValidationRun).toBeDefined();
  });

  it("worker bash aborts when the manifest requests cancellation", async () => {
    setup = await setupWithRun("worker");
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    await setup.svc.manifestPatch(
      {
        runId: setup.runId,
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
              spawnedAt: new Date().toISOString(),
            },
          },
        ],
      },
      setup.bundlePath,
    );
    const tools = makeToolSet(setup, "worker", "S-worker", {
      universal: {
        permissionMode: "full-auto",
        sandboxConfig: {
          ...DEFAULT_WORKER_SANDBOX_CONFIG,
          safeCommands: [...DEFAULT_WORKER_SANDBOX_CONFIG.safeCommands, "^sleep\\b"],
        },
      },
    });
    const bash = tools.bash!;
    const run = bash.execute({
      command: "sleep 30",
      timeout: 30_000,
    }) as Promise<{ stdout: string; stderr: string; exitCode: number }>;

    await new Promise((resolve) => setTimeout(resolve, 50));
    const current = setup.svc.getManifestForRun(setup.runId)!;
    expect(current.agents.some((agent) => agent.sessionId === "S-worker")).toBe(true);
    const cancelPatch = await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: current.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/agents/{sessionId:S-worker}/cancellationRequested",
            value: true,
          },
        ],
      },
      setup.bundlePath,
    );
    expect(cancelPatch.ok).toBe(true);

    const result = await run;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("orchestration cancellation requested");
  }, 10_000);

  it("validator toolset matches worker shape but server enforces patch scope (smoke-check via parallel surface)", async () => {
    setup = await setupWithRun("validator");
    const tools = makeToolSet(setup, "validator", "S-validator");
    expect(tools.editFile).toBeDefined();
    expect(tools.writeFile).toBeDefined();
    expect(tools.bash).toBeDefined();
    expect(tools.manifestPatch).toBeDefined();
    expect(tools.planAppend).toBeDefined();
    expect(tools.spawnAgent).toBeUndefined();
    expect(tools.planWrite).toBeUndefined();
    expect(tools.askUserForModelSelection).toBeUndefined();
  });
});

describe("spawnAgent tool", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("rejects briefs missing required sections", async () => {
    setup = await setupWithRun("lead");
    const tools = makeToolSet(setup, "lead", "S-lead");
    const spawn = tools.spawnAgent!;
    const result: any = await spawn.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: "## TASK\nDo something\n## FILES\n- a.ts\n",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("spawn_brief_missing_sections");
    expect(result.missing).toEqual(
      expect.arrayContaining(["## DEPENDENCIES", "## GATES", "## PEERS", "## SUCCESS"]),
    );
    expect(setup.chat.createSession).not.toHaveBeenCalled();
  });

  it("creates a session and patches the agents array when the brief is valid", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const tools = makeToolSet(setup, "lead", "S-lead");
    const spawn = tools.spawnAgent!;
    const result: any = await spawn.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
    });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe("S-spawned-1");
    expect(setup.chat.createSession).toHaveBeenCalledTimes(1);
    const createArgs = setup.chat.createSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(createArgs.interactionMode).toBe("orchestrator-worker");
    expect(createArgs.orchestrationRunId).toBe(setup.runId);
    expect(createArgs.orchestrationRole).toBe("worker");
    expect(createArgs.orchestrationStepId).toBe("T-1");
    expect(createArgs.provider).toBe("claude");
    expect(createArgs.model).toBe("claude-sonnet-4-6");
    expect(createArgs.claudePermissionMode).toBe("bypassPermissions");
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.agents.some((a) => a.sessionId === "S-spawned-1")).toBe(true);
    const spawned = manifest.agents.find((a) => a.sessionId === "S-spawned-1")!;
    expect(spawned.spawnFingerprint).toMatchObject({
      provider: "claude",
      modelId: "claude-sonnet-4-6",
      routingKey: "fallback",
    });
    expect(setup.chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks spawning until the orchestration plan is approved", async () => {
    setup = await setupWithRun("lead");
    const tools = makeToolSet(setup, "lead", "S-lead");
    const result: any = await tools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_not_approved");
    expect(setup.chat.createSession).not.toHaveBeenCalled();
  });

  it("does not treat planning phase done as plan approval", async () => {
    setup = await setupWithRun("lead");
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    const patched = await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "replace",
            path: "/phases/{id:planning}/status",
            value: "done",
          },
        ],
      },
      setup.bundlePath,
    );
    expect(patched.ok).toBe(false);

    const tools = makeToolSet(setup, "lead", "S-lead");
    const result: any = await tools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_not_approved");
    expect(setup.chat.createSession).not.toHaveBeenCalled();
  });

  it.each([
    ["codex", { codexSandbox: "danger-full-access", codexApprovalPolicy: "never", codexConfigSource: "flags" }],
    ["cursor", { cursorModeId: "full-auto" }],
    ["droid", { droidPermissionMode: "auto-high" }],
    ["opencode", { opencodePermissionMode: "full-auto" }],
  ] as const)("spawns %s workers with the provider full-access profile", async (provider, expected) => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    const routed = await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{
          op: "add",
          path: "/modelRouting/byRoleTag",
          value: {
            "worker:backend": {
              provider,
              modelId: `${provider}-model`,
              reasoningEffort: provider === "codex" ? "high" : null,
              codexFastMode: provider === "codex",
            },
          },
        }],
      },
      setup.bundlePath,
    );
    expect(routed.ok).toBe(true);
    const tools = makeToolSet(setup, "lead", "S-lead");
    const result: any = await tools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
    });
    expect(result.ok).toBe(true);
    expect(setup.chat.createSession).toHaveBeenCalledTimes(1);
    expect(setup.chat.createSession.mock.calls[0]![0]).toMatchObject({
      provider,
      model: `${provider}-model`,
      ...expected,
    });
  });
});

describe("requestPlanApproval and model routing tools", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("records plan approval through a plan_approval pending input", async () => {
    setup = await setupWithRun("lead");
    const onAskUser = vi.fn(async () => ({ answer: "approved", decision: "accept" as const }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const result: any = await tools.requestPlanApproval!.execute({
      planSummary: VALID_APPROVAL_PLAN,
    });
    expect(result.ok).toBe(true);
    expect(onAskUser).toHaveBeenCalledWith(expect.objectContaining({
      pendingInputKind: "plan_approval",
      providerMetadata: expect.objectContaining({
        orchestrationPlanApproval: true,
        planQuality: expect.objectContaining({ ok: true }),
      }),
    }));
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.currentPhase).toBe("developing");
    expect(manifest.leadState.planApprovedAt).toBeTruthy();
    expect(manifest.leadState.planApprovedBySessionId).toBe("S-lead");
  });

  it("blocks plan approval until the minimum plan sections are present", async () => {
    setup = await setupWithRun("lead");
    const onAskUser = vi.fn(async () => ({ answer: "approved", decision: "accept" as const }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const result: any = await tools.requestPlanApproval!.execute({
      planSummary: "1. do it\n2. verify something",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_quality_missing_sections");
    expect(result.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "out_of_scope" }),
      expect.objectContaining({ id: "agent_plan" }),
      expect.objectContaining({ id: "ui_impact" }),
      expect.objectContaining({ id: "coordination_log" }),
    ]));
    expect(onAskUser).not.toHaveBeenCalled();
  });

  it("accepts concise plans that include the minimum approval anatomy", () => {
    const assessment = assessOrchestrationPlanQuality(VALID_APPROVAL_PLAN);
    expect(assessment).toEqual({ ok: true, missing: [] });
  });

  it("writes model picker selections into role/tag routing", async () => {
    setup = await setupWithRun("lead");
    const selection = {
      provider: "codex",
      modelId: "gpt-5.4",
      reasoningEffort: "high",
      codexFastMode: true,
    };
    const onAskUser = vi.fn(async () => ({
      answer: JSON.stringify(selection),
      decision: "accept" as const,
    }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const result: any = await tools.askUserForModelSelection!.execute({
      role: "worker",
      tag: "web-ui",
    });
    expect(result.ok).toBe(true);
    expect(onAskUser).toHaveBeenCalledWith(expect.objectContaining({
      pendingInputKind: "model_selection",
      providerMetadata: expect.objectContaining({
        role: "worker",
        tag: "web-ui",
      }),
    }));
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.modelRouting.byRoleTag?.["worker:web-ui"]).toEqual(selection);
  });

  it.each([
    ["Not approved — don't start yet", "decline"],
    ["No, don't proceed with this plan", "none"],
    ["Please revise before we proceed", "decline"],
  ] as const)("does not treat rejection text %j as approval when decision is %s", async (answer, decision) => {
    setup = await setupWithRun("lead");
    const onAskUser = vi.fn(async () => ({ answer, decision }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const result: any = await tools.requestPlanApproval!.execute({
      planSummary: VALID_APPROVAL_PLAN,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_rejected");
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.currentPhase).toBe("planning");
    expect(manifest.leadState.planApprovedAt).toBeUndefined();
  });
});

describe("orchestration heartbeats", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("touches worker heartbeat and notifies the lead after a mutating tool succeeds", async () => {
    setup = await setupWithRun("worker");
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    const patched = await setup.svc.manifestPatch(
      {
        runId: setup.runId,
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
      setup.bundlePath,
    );
    expect(patched.ok).toBe(true);
    const tools = makeToolSet(setup, "worker", "S-worker");
    const result: any = await tools.planAppend!.execute({
      section: "Worker evidence",
      body: "Patched the target module.",
    });
    expect(result.ok).toBe(true);
    const updated = setup.svc.getManifestForRun(setup.runId)!;
    const worker = updated.agents.find((agent) => agent.sessionId === "S-worker")!;
    expect(worker.lastHeartbeatAt).toBeTruthy();
    expect(setup.chat.steer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "S-lead",
      metadata: expect.objectContaining({
        orchestrationOrigin: expect.objectContaining({
          runId: setup.runId,
          fromSessionId: "S-worker",
          intent: "status",
        }),
      }),
    }));
  });
});

describe("messageAgent tool", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("worker messageAgent rejects intent=cancellation at runtime even if the schema bypassed", async () => {
    setup = await setupWithRun("worker");
    await approveRun(setup);
    // First, spawn a peer worker so messageAgent can find it.
    const leadTools = makeToolSet(setup, "lead", "S-lead");
    await (leadTools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "task",
      stepId: "T-peer",
      initialMessage: VALID_BRIEF,
    }) as Promise<unknown>);
    // Inject the actor worker into the manifest too so it's discoverable.
    const m = setup.svc.getManifestForRun(setup.runId)!;
    await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: m.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/agents/-",
            value: {
              sessionId: "S-worker",
              role: "worker",
              tag: "other",
              goalSummary: "g",
              status: "running",
              spawnedAt: new Date().toISOString(),
            },
          },
        ],
      },
      setup.bundlePath,
    );
    const tools = makeToolSet(setup, "worker", "S-worker");
    const messageAgent = tools.messageAgent!;
    // Schema rejects cancellation; bypass via `any` to confirm defence-in-depth.
    const result: any = await (messageAgent.execute as (input: unknown) => Promise<unknown>)({
      targetSessionId: "S-spawned-1",
      kind: "queue",
      intent: "cancellation",
      text: "halt",
    });
    // zod refinement on input may either return validation error from execute
    // or pass through with our defence-in-depth runtime check. Both ok.
    if (typeof result?.error === "string") {
      expect(["intent_not_allowed", "schema_validation"]).toContain(result.error);
    } else {
      expect(result.ok).toBe(false);
    }
  });

  it("lead messageAgent with kind=interrupt-replace invokes interrupt + sendMessage", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    // Spawn a target so the manifest membership check passes.
    const leadTools = makeToolSet(setup, "lead", "S-lead");
    const spawnResult: any = await leadTools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "task",
      stepId: "T-cancel",
      initialMessage: VALID_BRIEF,
    });
    expect(spawnResult.ok).toBe(true);
    const messageAgent = leadTools.messageAgent!;
    setup.chat.sendMessage.mockClear();
    const result: any = await messageAgent.execute({
      targetSessionId: spawnResult.sessionId,
      kind: "interrupt-replace",
      intent: "cancellation",
      text: "stop and revert",
      cancellation: { revert: true, reason: "test" },
    });
    expect(result.ok).toBe(true);
    expect(setup.chat.interrupt).toHaveBeenCalledWith({ sessionId: spawnResult.sessionId });
    expect(setup.chat.sendMessage).toHaveBeenCalledTimes(1);
    const sendArgs = setup.chat.sendMessage.mock.calls[0]![0] as Record<string, any>;
    expect(sendArgs.metadata.orchestrationOrigin.intent).toBe("cancellation");
    expect(sendArgs.metadata.orchestrationCancellation).toEqual({
      revert: true,
      reason: "test",
    });
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.agents.find((agent) => agent.sessionId === spawnResult.sessionId)?.cancellationRequested).toBe(true);
    expect(manifest.decisions.some((decision) =>
      decision.summary.includes(`Cancellation requested for ${spawnResult.sessionId}`),
    )).toBe(true);
  });
});

describe("getAgentTranscript tool", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("rejects sessions not in the run", async () => {
    setup = await setupWithRun("lead");
    const tools = makeToolSet(setup, "lead", "S-lead");
    const result: any = await tools.getAgentTranscript!.execute({
      sessionId: "S-not-in-run",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent_not_in_run");
    expect(setup.chat.readTranscript).not.toHaveBeenCalled();
  });

  it("forwards to readTranscript when the session is in the run", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const leadTools = makeToolSet(setup, "lead", "S-lead");
    const spawnResult: any = await leadTools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "task",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
    });
    setup.chat.readTranscript.mockResolvedValueOnce([
      { role: "user", text: "hi", timestamp: "2026-01-01T00:00:00.000Z" },
    ]);
    const result: any = await leadTools.getAgentTranscript!.execute({
      sessionId: spawnResult.sessionId,
      limit: 50,
    });
    expect(result.ok).toBe(true);
    expect(setup.chat.readTranscript).toHaveBeenCalledWith(spawnResult.sessionId, 50, undefined);
    expect(result.entries).toHaveLength(1);
  });
});

describe("claimTask tool", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("validator may not claim a non-validation phase task (surface check)", async () => {
    setup = await setupWithRun("validator");
    // Insert a developing-phase task.
    const m = setup.svc.getManifestForRun(setup.runId)!;
    await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: m.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-1",
              phaseId: "developing",
              title: "build it",
              description: "x",
              status: "pending",
              validationGate: { required: false, stepIds: [] },
            },
          },
        ],
      },
      setup.bundlePath,
    );
    const tools = makeToolSet(setup, "validator", "S-validator");
    const result: any = await tools.claimTask!.execute({ taskId: "T-1" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("validator_non_validation_task");
  });
});

describe("recordValidationRun tool", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("lets a worker record an owned per-worker gate before release", async () => {
    setup = await setupWithRun("worker");
    const m = setup.svc.getManifestForRun(setup.runId)!;
    const seeded = await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: m.etag,
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
              id: "V-1",
              concern: "reverify_changes",
              scope: "per_worker",
              required: true,
              prompt: "Re-read touched files.",
              evidenceRequired: ["plan_md_section"],
            },
          },
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-1",
              phaseId: "developing",
              title: "build it",
              description: "x",
              status: "claimed",
              validationGate: { required: true, stepIds: ["V-1"] },
              assigneeSessionId: "S-worker",
            },
          },
        ],
      },
      setup.bundlePath,
    );
    expect(seeded.ok).toBe(true);

    const tools = makeToolSet(setup, "worker", "S-worker");
    const result: any = await tools.recordValidationRun!.execute({
      taskId: "T-1",
      stepId: "V-1",
      status: "passed",
      notes: "plan evidence appended",
    });
    expect(result.ok).toBe(true);
    expect(result.checklistItemId).toMatch(/T-1/);
    expect(setup.chat.steer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "S-lead",
      text: expect.stringContaining("recorded validation V-1"),
    }));

    const release: any = await tools.releaseTask!.execute({ taskId: "T-1", status: "done" });
    expect(release.ok).toBe(true);
  });

  it("lets a validator record an assigned validation gate", async () => {
    setup = await setupWithRun("validator");
    const m = setup.svc.getManifestForRun(setup.runId)!;
    const seeded = await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: m.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/agents/-",
            value: {
              sessionId: "S-validator",
              role: "validator",
              tag: "final",
              goalSummary: "validate task",
              status: "running",
              spawnedAt: "now",
              currentStepId: "V-final",
            },
          },
          {
            op: "add",
            path: "/validationStrategy/steps/-",
            value: {
              id: "V-final",
              concern: "pre_completion_gate",
              scope: "per_step",
              required: true,
              prompt: "Validate the final state and record proof.",
              evidenceRequired: ["plan_md_section"],
              appliesToTaskIds: ["T-1"],
            },
          },
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-1",
              phaseId: "validating",
              title: "validate T-1",
              description: "check the worker output",
              status: "claimed",
              validationGate: { required: true, stepIds: ["V-final"] },
              assigneeSessionId: "S-validator",
            },
          },
        ],
      },
      setup.bundlePath,
    );
    expect(seeded.ok).toBe(true);

    const tools = makeToolSet(setup, "validator", "S-validator");
    const result: any = await tools.recordValidationRun!.execute({
      taskId: "T-1",
      stepId: "V-final",
      status: "failed",
      notes: "Found a regression; lead needs to delegate a fix task.",
    });
    expect(result.ok).toBe(true);
    const checklist = result.manifest.validationStrategy.checklist.find(
      (item: { taskId?: string; stepId: string }) =>
        item.taskId === "T-1" && item.stepId === "V-final",
    );
    expect(checklist).toBeTruthy();
    const latest = checklist!.runs.find((run: { id: string }) => run.id === checklist!.latestRunId);
    expect(latest).toMatchObject({
      runBySessionId: "S-validator",
      status: "failed",
    });
    expect(setup.chat.steer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "S-lead",
      text: expect.stringContaining("recorded validation V-final"),
    }));
  });

  it("rejects a validator recording an unassigned validation gate", async () => {
    setup = await setupWithRun("validator");
    const m = setup.svc.getManifestForRun(setup.runId)!;
    const seeded = await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: m.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/agents/-",
            value: {
              sessionId: "S-validator",
              role: "validator",
              tag: "final",
              goalSummary: "validate another gate",
              status: "running",
              spawnedAt: "now",
              currentStepId: "V-other",
            },
          },
          {
            op: "add",
            path: "/validationStrategy/steps/-",
            value: {
              id: "V-final",
              concern: "pre_completion_gate",
              scope: "per_step",
              required: true,
              prompt: "Validate the final state and record proof.",
              evidenceRequired: ["plan_md_section"],
              appliesToTaskIds: ["T-1"],
            },
          },
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-1",
              phaseId: "developing",
              title: "validate T-1",
              description: "check the worker output",
              status: "review",
              validationGate: { required: true, stepIds: ["V-final"] },
              assigneeSessionId: "S-worker",
            },
          },
        ],
      },
      setup.bundlePath,
    );
    expect(seeded.ok).toBe(true);

    const tools = makeToolSet(setup, "validator", "S-validator");
    const result: any = await tools.recordValidationRun!.execute({
      taskId: "T-1",
      stepId: "V-final",
      status: "passed",
      notes: "Trying to write a gate I was not assigned.",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("policy_denied");
    expect(result.message).toContain("assigned validation gates");
  });
});

describe("buildOrchestrationSandboxConfig", () => {
  it("adds manifest.json + plan.md to protectedFiles and sets blockByDefault", () => {
    const cfg = buildOrchestrationSandboxConfig("/tmp/bundle");
    expect(cfg.blockByDefault).toBe(true);
    const blob = cfg.protectedFiles.join("|");
    expect(blob).toContain("manifest\\.json");
    expect(blob).toContain("plan\\.md");
    expect(blob).toContain("/tmp/bundle");
  });
});

describe("validateSpawnBrief re-export", () => {
  it("is exported and round-trips through the tool factory module", async () => {
    const mod = await import("./orchestrationTools");
    expect(typeof mod.validateSpawnBrief).toBe("function");
    expect(mod.validateSpawnBrief("## TASK\n\n## FILES\n\n## DEPENDENCIES\n\n## GATES\n\n## PEERS\n\n## SUCCESS\n").ok).toBe(true);
    expect(mod.validateSpawnBrief("## TASK\nfoo").ok).toBe(false);
  });
});
