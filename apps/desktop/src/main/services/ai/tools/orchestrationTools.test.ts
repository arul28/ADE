/* @vitest-environment node */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOrchestrationService } from "../../orchestration/orchestrationService";
import {
  buildOrchestrationSandboxConfig,
  createOrchestrationToolSet,
  type OrchestrationAgentChatHandle,
  type OrchestrationSessionContext,
  type OrchestrationToolSetOptions,
} from "./orchestrationTools";

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

function makeChatStub(): OrchestrationAgentChatHandle & {
  createSession: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  readTranscript: ReturnType<typeof vi.fn>;
} {
  return {
    createSession: vi.fn(async () => ({ id: "S-spawned-1" })),
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
    expect(tools.askUserForModelSelection).toBeDefined();
    expect(tools.registerAsset).toBeDefined();
    expect(tools.claimTask).toBeDefined();
    expect(tools.releaseTask).toBeDefined();
  });

  it("worker toolset has editFile/writeFile/bash + orchestration tools but no spawnAgent/planWrite/askUserForModelSelection", async () => {
    setup = await setupWithRun("worker");
    const tools = makeToolSet(setup, "worker", "S-worker");
    expect(tools.readFile).toBeDefined();
    expect(tools.editFile).toBeDefined();
    expect(tools.writeFile).toBeDefined();
    expect(tools.bash).toBeDefined();
    expect(tools.spawnAgent).toBeUndefined();
    expect(tools.planWrite).toBeUndefined();
    expect(tools.askUserForModelSelection).toBeUndefined();
    expect(tools.claimTask).toBeDefined();
    expect(tools.releaseTask).toBeDefined();
    expect(tools.manifestPatch).toBeDefined();
    expect(tools.planAppend).toBeDefined();
    expect(tools.messageAgent).toBeDefined();
    expect(tools.getAgentTranscript).toBeDefined();
    expect(tools.registerAsset).toBeDefined();
  });

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
    const tools = makeToolSet(setup, "lead", "S-lead");
    const spawn = tools.spawnAgent!;
    const result: any = await spawn.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "Implement T-1",
      initialMessage: VALID_BRIEF,
    });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe("S-spawned-1");
    expect(setup.chat.createSession).toHaveBeenCalledTimes(1);
    const createArgs = setup.chat.createSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(createArgs.interactionMode).toBe("orchestrator-worker");
    expect(createArgs.orchestrationRunId).toBe(setup.runId);
    expect(createArgs.orchestrationRole).toBe("worker");
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.agents.some((a) => a.sessionId === "S-spawned-1")).toBe(true);
    expect(setup.chat.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("messageAgent tool", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("worker messageAgent rejects intent=cancellation at runtime even if the schema bypassed", async () => {
    setup = await setupWithRun("worker");
    // First, spawn a peer worker so messageAgent can find it.
    const leadTools = makeToolSet(setup, "lead", "S-lead");
    await (leadTools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "task",
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
    // Spawn a target so the manifest membership check passes.
    const leadTools = makeToolSet(setup, "lead", "S-lead");
    const spawnResult: any = await leadTools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "task",
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
    const leadTools = makeToolSet(setup, "lead", "S-lead");
    const spawnResult: any = await leadTools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "task",
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
