/* @vitest-environment node */
import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestrationService } from "../../orchestration/orchestrationService";
import {
  buildOrchestrationSandboxConfig,
  createOrchestrationToolSet,
  deriveMessageAgentRequestId,
  type OrchestrationAgentChatHandle,
  type OrchestrationSessionContext,
  type OrchestrationToolSetOptions,
} from "./orchestrationTools";
import { drainOutbox } from "./orchestrationOutbox";
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

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

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

async function setupWithRun(
  role: "lead" | "worker" | "validator",
  options: { now?: () => Date } = {},
): Promise<Setup> {
  const laneRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-orch-tools-"));
  const svc = createOrchestrationService({
    resolveLaneWorktree: () => laneRoot,
    ...(options.now ? { now: options.now } : {}),
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
    expect(createArgs.spawnKind).toBe("subagent");
    expect(createArgs.provider).toBe("claude");
    expect(createArgs.model).toBe("claude-sonnet-5");
    expect(createArgs.claudePermissionMode).toBe("bypassPermissions");
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.agents.some((a) => a.sessionId === "S-spawned-1")).toBe(true);
    const spawned = manifest.agents.find((a) => a.sessionId === "S-spawned-1")!;
    expect(spawned.spawnFingerprint).toMatchObject({
      provider: "claude",
      modelId: "claude-sonnet-5",
      routingKey: "fallback",
    });
    expect(setup.chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("replays the original worker for an identical derived spawn request", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const spawn = makeToolSet(setup, "lead", "S-lead").spawnAgent!;
    const input = {
      role: "worker" as const,
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
    };

    const first: any = await spawn.execute(input);
    const duplicate: any = await spawn.execute(input);

    expect(first).toMatchObject({ ok: true, sessionId: "S-spawned-1" });
    expect(duplicate).toMatchObject({
      ok: true,
      sessionId: "S-spawned-1",
      deduped: true,
    });
    expect(setup.chat.createSession).toHaveBeenCalledTimes(1);
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(
      manifest.agents.filter((agent) => agent.sessionId === "S-spawned-1"),
    ).toHaveLength(1);
  });

  it("deduplicates spawn requests by an explicit requestId", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const spawn = makeToolSet(setup, "lead", "S-lead").spawnAgent!;
    const input = {
      role: "worker" as const,
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
      requestId: "spawn-explicit-1",
    };

    const first: any = await spawn.execute(input);
    const duplicate: any = await spawn.execute({
      ...input,
      goalSummary: "A re-emitted call with changed non-key prose",
    });

    expect(first.sessionId).toBe("S-spawned-1");
    expect(duplicate).toMatchObject({
      ok: true,
      sessionId: "S-spawned-1",
      deduped: true,
    });
    expect(setup.chat.createSession).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed brief durable and redelivers it during recovery", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    setup = await setupWithRun("lead", { now: () => clock });
    await approveRun(setup);
    setup.chat.sendMessage
      .mockRejectedValueOnce(new Error("provider temporarily unavailable"))
      .mockResolvedValue(undefined);
    const tools = makeToolSet(setup, "lead", "S-lead");

    const spawned: any = await tools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
    });

    expect(spawned).toMatchObject({ ok: true, sessionId: "S-spawned-1" });
    let manifest = setup.svc.getManifestForRun(setup.runId)!;
    let brief = manifest.outbox?.find((entry) => entry.kind === "brief");
    expect(brief).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "provider temporarily unavailable",
    });
    expect(manifest.agents.some((agent) => agent.sessionId === "S-spawned-1")).toBe(true);

    clock = new Date(brief!.nextAttemptAt!);
    const recovered: any = await tools.recoverStaleTasks!.execute({});

    expect(recovered.ok).toBe(true);
    manifest = setup.svc.getManifestForRun(setup.runId)!;
    brief = manifest.outbox?.find((entry) => entry.id === brief!.id);
    expect(brief?.status).toBe("delivered");
    expect(setup.chat.sendMessage).toHaveBeenCalledTimes(2);
    expect(setup.chat.sendMessage.mock.calls[1]![0]).toMatchObject({
      sessionId: "S-spawned-1",
      text: VALID_BRIEF,
    });
  });

  it("redelivers a backoff-deferred brief via a self-armed timer with no further mutation", async () => {
    // Real service clock (no injected `now`) so the deferred-retry timer's
    // wall-clock delay matches the service's dueness check.
    setup = await setupWithRun("lead");
    await approveRun(setup);
    // Fail the first delivery, then succeed on the timer-driven retry.
    setup.chat.sendMessage
      .mockRejectedValueOnce(new Error("provider temporarily unavailable"))
      .mockResolvedValue(undefined);
    const tools = makeToolSet(setup, "lead", "S-lead");

    const spawned: any = await tools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
    });
    expect(spawned).toMatchObject({ ok: true, sessionId: "S-spawned-1" });

    const briefId = setup.svc
      .getManifestForRun(setup.runId)!
      .outbox!.find((entry) => entry.kind === "brief")!.id;
    const briefStatus = () =>
      setup.svc.getManifestForRun(setup.runId)!.outbox!.find((e) => e.id === briefId)!.status;
    // Deferred by the first failure; only ONE delivery attempt so far.
    expect(briefStatus()).toBe("pending");
    expect(setup.chat.sendMessage).toHaveBeenCalledTimes(1);

    // Deliberately issue NO further tool call / mutation. The timer armed by the
    // deferred drain must retry on its own once the (500ms) backoff elapses.
    await vi.waitFor(() => expect(briefStatus()).toBe("delivered"), {
      timeout: 5000,
      interval: 25,
    });
    expect(setup.chat.sendMessage).toHaveBeenCalledTimes(2);
    expect(setup.chat.sendMessage.mock.calls[1]![0]).toMatchObject({
      sessionId: "S-spawned-1",
      text: VALID_BRIEF,
    });
  });

  it("does not replay a pending receipt as a successful spawn", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const requestId = "spawn-pending-1";
    // Simulate a concurrent / crashed spawn: a receipt is reserved (pending) but
    // never completed — no session and no agent row exist for it.
    const reserved = await setup.svc.reserveReceipt(setup.runId, setup.bundlePath, {
      requestId,
      kind: "spawnAgent",
    });
    expect(reserved).toMatchObject({ ok: true, status: "reserved" });

    const spawn = makeToolSet(setup, "lead", "S-lead").spawnAgent!;
    const result: any = await spawn.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
      requestId,
    });

    // No fabricated success, no undefined session, no second session, no agent row.
    expect(result).toMatchObject({ ok: false, error: "spawn_in_progress", retryable: true });
    expect(result.sessionId).toBeUndefined();
    expect(setup.chat.createSession).not.toHaveBeenCalled();
    expect(
      setup.svc.getManifestForRun(setup.runId)!.agents.some((a) => a.role === "worker"),
    ).toBe(false);
  });

  it("surfaces a permanently undeliverable brief in the decision log", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    setup = await setupWithRun("lead", { now: () => clock });
    await approveRun(setup);
    setup.chat.sendMessage.mockRejectedValue(new Error("provider stays down"));
    const tools = makeToolSet(setup, "lead", "S-lead");

    await tools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
    });

    let brief = setup.svc
      .getManifestForRun(setup.runId)!
      .outbox?.find((entry) => entry.kind === "brief")!;
    for (let pass = 0; brief.status === "pending" && pass < 10; pass += 1) {
      clock = new Date(brief.nextAttemptAt!);
      await drainOutbox(setup.svc, setup.chat, {
        runId: setup.runId,
        bundlePath: setup.bundlePath,
      });
      brief = setup.svc
        .getManifestForRun(setup.runId)!
        .outbox?.find((entry) => entry.id === brief.id)!;
    }

    expect(brief).toMatchObject({
      status: "failed",
      lastError: "provider stays down",
    });
    expect(brief.attempts).toBe(brief.maxAttempts);
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(
      manifest.decisions.some(
        (decision) =>
          decision.summary.includes("outbox delivery failed permanently") &&
          decision.summary.includes("brief") &&
          decision.summary.includes("S-spawned-1"),
      ),
    ).toBe(true);
  });

  it("delivers persisted outbox entries when a run is loaded on a fresh service (no mutation)", async () => {
    setup = await setupWithRun("lead");
    // Persist a pending brief to disk, then simulate a process restart: a fresh
    // service instance (empty runs map, no surviving in-flight drain/timer) loads
    // the same bundle. Delivery must happen on load — no mutating tool is run.
    const enqueue = await setup.svc.enqueueOutbox(setup.runId, setup.bundlePath, [
      {
        kind: "brief",
        targetSessionId: "S-worker",
        delivery: { op: "sendMessage", text: "your brief" },
      },
    ]);
    expect(enqueue.ok).toBe(true);

    const svc2 = createOrchestrationService({ resolveLaneWorktree: () => setup.laneRoot });
    const chat2 = makeChatStub();
    svc2.registerRunActivationDrainer(({ runId, bundlePath }) => {
      void drainOutbox(svc2, chat2, { runId, bundlePath });
    });

    // Loading the run (subscribe) is the sole trigger — no spawn/message tool call.
    await svc2.subscribe(setup.runId, setup.bundlePath);
    await vi.waitFor(() =>
      expect(chat2.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "S-worker", text: "your brief" }),
        expect.anything(),
      ),
    );
    const entry = svc2
      .getManifestForRun(setup.runId)!
      .outbox?.find((e) => e.kind === "brief")!;
    expect(entry.status).toBe("delivered");
    await svc2.dispose();
  });

  it("reconciles a spawn receipt to an existing agent instead of duplicating (pruned receipt)", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const requestId = "spawn:reconcile-fixed";
    // Materialize an agent linked to this requestId via a completed receipt.
    const reserved = await setup.svc.reserveReceipt(setup.runId, setup.bundlePath, {
      requestId,
      kind: "spawnAgent",
    });
    expect(reserved).toMatchObject({ ok: true, status: "reserved" });
    const completed = await setup.svc.completeReceipt(
      setup.runId,
      setup.bundlePath,
      { requestId, result: { sessionId: "S-existing" } },
      [
        {
          op: "add",
          path: "/agents/-",
          value: {
            sessionId: "S-existing",
            role: "worker",
            tag: "backend",
            goalSummary: "Implement T-1",
            status: "pending",
            spawnedAt: new Date().toISOString(),
            spawnRequestId: requestId,
          },
        },
      ],
    );
    expect(completed.ok).toBe(true);

    // Emulate RECEIPT_CAP pruning of the completed receipt: strip receipts on
    // disk, then reload on a fresh service and re-reserve the same requestId.
    const manifestPath = path.join(setup.bundlePath, "manifest.json");
    const raw = JSON.parse(await fsp.readFile(manifestPath, "utf-8")) as {
      receipts?: unknown[];
    };
    raw.receipts = [];
    await fsp.writeFile(manifestPath, JSON.stringify(raw), "utf-8");

    const svc2 = createOrchestrationService({ resolveLaneWorktree: () => setup.laneRoot });
    const reReserve = await svc2.reserveReceipt(setup.runId, setup.bundlePath, {
      requestId,
      kind: "spawnAgent",
    });
    // Deduped to the existing agent — NOT re-reserved (which would spawn a twin).
    expect(reReserve).toMatchObject({ ok: true, status: "duplicate" });
    expect((reReserve as { receipt: { status: string; result?: { sessionId?: string } } }).receipt)
      .toMatchObject({ status: "completed", result: { sessionId: "S-existing" } });
    await svc2.dispose();
  });

  it("reconciles a messageAgent receipt to an existing outbox entry instead of re-enqueuing", async () => {
    setup = await setupWithRun("lead");
    const requestId = "msg:reconcile-fixed";
    // A delivery already enqueued under this requestId (its completed receipt was
    // later pruned). Re-reserving must dedupe, not append a duplicate ping.
    const enq = await setup.svc.enqueueOutbox(setup.runId, setup.bundlePath, [
      { kind: "ping", targetSessionId: "S-w", delivery: { op: "steer", text: "hi" }, requestId },
    ]);
    expect(enq.ok).toBe(true);

    const svc2 = createOrchestrationService({ resolveLaneWorktree: () => setup.laneRoot });
    const res = await svc2.reserveReceipt(setup.runId, setup.bundlePath, {
      requestId,
      kind: "messageAgent",
    });
    expect(res).toMatchObject({ ok: true, status: "duplicate" });
    expect((res as { receipt: { status: string } }).receipt).toMatchObject({ status: "completed" });
    await svc2.dispose();
  });

  it("allows the lead to override the cosmetic spawn kind", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const tools = makeToolSet(setup, "lead", "S-lead");

    const result: any = await tools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "Implement T-1",
      stepId: "T-1",
      initialMessage: VALID_BRIEF,
      spawnKind: "peer",
    });

    expect(result.ok).toBe(true);
    expect(setup.chat.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ spawnKind: "peer" }),
    );
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
              fastMode: provider === "codex",
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

// Walk the deterministic planning sequence to `rounds_complete` so the gated
// tools (askUserForModelSelection) unlock.
async function completeDeliberationRounds(setup: Setup): Promise<void> {
  const at = () => new Date().toISOString();
  const intake = await setup.svc.recordPlanningIntake(setup.runId, setup.bundlePath, {
    recordedAt: at(),
    projectShape: "monorepo · TS",
    testStack: "vitest",
    inFlightWork: "fresh lane",
    ancillarySurfaces: [],
    ciGates: ["npm run typecheck"],
  });
  expect(intake.ok).toBe(true);
  for (const kind of ["functional", "ui", "extras"] as const) {
    const round = await setup.svc.recordPlanningRound(setup.runId, setup.bundlePath, {
      id: "",
      kind,
      askedAt: at(),
      question: `Round ${kind}?`,
      lockedSummary: `${kind} locked`,
      selectedOptionIds: ["a"],
      answeredAt: at(),
    });
    expect(round.ok).toBe(true);
  }
}

// Full planning so requestPlanApproval reaches the approval pending input:
// intake + rounds + a derived validation step + model routing + a plan.md that
// covers the required sections.
async function completePlanningSequence(
  setup: Setup,
  opts: { planMd?: string } = {},
): Promise<void> {
  await completeDeliberationRounds(setup);
  const patch = async (op: ManifestPatchOpForTest) => {
    const m = setup.svc.getManifestForRun(setup.runId)!;
    const res = await setup.svc.manifestPatch(
      { runId: setup.runId, ifMatchEtag: m.etag, actorRole: "lead", actorSessionId: "S-lead", patches: [op] },
      setup.bundlePath,
    );
    expect(res.ok).toBe(true);
  };
  await patch({
    op: "add",
    path: "/validationStrategy/steps/-",
    value: {
      id: "VS-1",
      concern: "reverify_changes",
      scope: "per_worker",
      required: true,
      prompt: "re-verify the changed files",
      evidenceRequired: ["plan_md_section"],
    },
  });
  await patch({
    op: "add",
    path: "/modelRouting/byRoleTag",
    value: { "worker:prompt-tools": { provider: "codex", modelId: "gpt-5.4" } },
  });
  const m = setup.svc.getManifestForRun(setup.runId)!;
  const wrote = await setup.svc.planWrite(
    { runId: setup.runId, nextPlanMd: opts.planMd ?? VALID_APPROVAL_PLAN, ifMatchEtag: m.etag },
    setup.bundlePath,
  );
  expect("error" in wrote).toBe(false);
}

type ManifestPatchOpForTest = { op: "add" | "replace"; path: string; value: unknown };

describe("requestPlanApproval and model routing tools", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("records plan approval against the live plan after the gated sequence", async () => {
    setup = await setupWithRun("lead");
    await completePlanningSequence(setup);
    const onAskUser = vi.fn(async () => ({ answer: "approved", decision: "accept" as const }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const result: any = await tools.requestPlanApproval!.execute({});
    expect(result.ok).toBe(true);
    expect(onAskUser).toHaveBeenCalledWith(expect.objectContaining({
      pendingInputKind: "plan_approval",
      body: VALID_APPROVAL_PLAN,
      providerMetadata: expect.objectContaining({
        orchestrationPlanApproval: true,
        planContentHash: expect.any(String),
        planContent: VALID_APPROVAL_PLAN,
      }),
    }));
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.currentPhase).toBe("developing");
    expect(manifest.leadState.planApprovedAt).toBeTruthy();
    expect(manifest.leadState.planApprovedBySessionId).toBe("S-lead");
    expect(manifest.planSpec?.approval.state).toBe("approved");
  });

  it("requires fresh approval when plan.md changes while approval is pending", async () => {
    setup = await setupWithRun("lead");
    await completePlanningSequence(setup);
    const changedPlan = `${VALID_APPROVAL_PLAN}\n\n## Late edit\nThis should need another approval.`;
    const onAskUser = vi.fn(async () => {
      const manifest = setup.svc.getManifestForRun(setup.runId)!;
      const wrote = await setup.svc.planWrite(
        { runId: setup.runId, nextPlanMd: changedPlan, ifMatchEtag: manifest.etag },
        setup.bundlePath,
      );
      expect("error" in wrote).toBe(false);
      return { answer: "approved", decision: "accept" as const };
    });
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });

    const result: any = await tools.requestPlanApproval!.execute({});

    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_changed_after_review");
    expect(result.reviewedPlanContentHash).toBe(sha256Text(VALID_APPROVAL_PLAN));
    expect(result.currentPlanContentHash).toBe(sha256Text(changedPlan));
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.currentPhase).toBe("planning");
    expect(manifest.leadState.planApprovedAt).toBeUndefined();
    expect(manifest.planSpec?.approval.state).toBe("changes_requested");
    expect(manifest.planSpec?.approval.lastReviewedPlanContentHash).toBe(
      sha256Text(VALID_APPROVAL_PLAN),
    );
    expect(manifest.planSpec?.approval.approvedPlanContentHash).toBeUndefined();
  });

  it("does not approve if manifest readiness changes while approval is pending", async () => {
    setup = await setupWithRun("lead");
    await completePlanningSequence(setup);
    const onAskUser = vi.fn(async () => {
      const manifest = setup.svc.getManifestForRun(setup.runId)!;
      const res = await setup.svc.manifestPatch(
        {
          runId: setup.runId,
          ifMatchEtag: manifest.etag,
          actorRole: "lead",
          actorSessionId: "S-lead",
          patches: [{ op: "remove", path: "/modelRouting/byRoleTag" }],
        },
        setup.bundlePath,
      );
      expect(res.ok).toBe(true);
      return { answer: "approved", decision: "accept" as const };
    });
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });

    const result: any = await tools.requestPlanApproval!.execute({});

    expect(result.ok).toBe(false);
    expect(result.error).toBe("planning_incomplete");
    expect(result.missing).toContain(
      "model routing (pick a model for at least one role/tag before approval)",
    );
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.currentPhase).toBe("planning");
    expect(manifest.leadState.planApprovedAt).toBeUndefined();
    expect(manifest.planSpec?.approval.state).toBe("ready");
  });

  it("records changes requested when the plan approval prompt cannot be shown", async () => {
    setup = await setupWithRun("lead");
    await completePlanningSequence(setup);
    const onAskUser = vi.fn(async () => {
      throw new Error("renderer disconnected");
    });
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });

    const result: any = await tools.requestPlanApproval!.execute({});

    expect(result.ok).toBe(false);
    expect(result.error).toBe("approval_prompt_failed");
    expect(result.detail).toBe("renderer disconnected");
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.currentPhase).toBe("planning");
    expect(manifest.leadState.planApprovedAt).toBeUndefined();
    expect(manifest.planSpec?.approval.state).toBe("changes_requested");
    expect(manifest.planSpec?.approval.lastReviewedPlanContentHash).toBe(
      sha256Text(VALID_APPROVAL_PLAN),
    );
  });

  it("blocks approval until the deterministic planning sequence is complete", async () => {
    setup = await setupWithRun("lead");
    const onAskUser = vi.fn(async () => ({ answer: "approved", decision: "accept" as const }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const result: any = await tools.requestPlanApproval!.execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("planning_incomplete");
    expect(onAskUser).not.toHaveBeenCalled();
  });

  it("blocks approval until plan.md covers the required sections", async () => {
    setup = await setupWithRun("lead");
    await completePlanningSequence(setup, { planMd: "# Plan\n\n## Goal\nDo the one thing only." });
    const onAskUser = vi.fn(async () => ({ answer: "approved", decision: "accept" as const }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const result: any = await tools.requestPlanApproval!.execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_not_ready");
    expect(result.missing.map((entry: any) => entry.id)).toEqual(
      expect.arrayContaining(["out_of_scope", "coordination"]),
    );
    expect(onAskUser).not.toHaveBeenCalled();
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.leadState.planning?.stage).toBe("rounds_complete");
    expect(manifest.planSpec?.approval.state).not.toBe("ready");
  });

  it("blocks model selection until the deliberation rounds are recorded", async () => {
    setup = await setupWithRun("lead");
    const onAskUser = vi.fn(async () => ({ answer: "{}", decision: "accept" as const }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const result: any = await tools.askUserForModelSelection!.execute({ role: "worker", tag: "web-ui" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("planning_not_ready");
    expect(onAskUser).not.toHaveBeenCalled();
  });

  it("returns the actual next stage after intake skips pre-waived rounds", async () => {
    setup = await setupWithRun("lead");
    const override = await setup.svc.recordPlanningOverride(setup.runId, setup.bundlePath, {
      skippedRounds: ["functional"],
      skipReason: "skip the functional round",
    });
    expect(override.ok).toBe(true);
    const tools = makeToolSet(setup, "lead", "S-lead");

    const intake: any = await tools.recordCodebaseIntake!.execute({
      projectShape: "desktop app",
      testStack: "vitest",
      inFlightWork: "fresh lane",
    });

    expect(intake.ok).toBe(true);
    expect(intake.nextStage).toBe("round_ui");
  });

  it("validates planning-round stage before prompting the user", async () => {
    setup = await setupWithRun("lead");
    const onAskUser = vi.fn(async () => ({ answer: "ui", decision: "accept" as const }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });

    const result: any = await tools.askPlanningRound!.execute({
      kind: "ui",
      question: "Which UI path?",
      options: [{ id: "ui", label: "UI path" }],
      lockedSummary: "Choose the UI path.",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("stage_conflict");
    expect(onAskUser).not.toHaveBeenCalled();
  });

  it("does not copy selected option ids into planning round free text", async () => {
    setup = await setupWithRun("lead");
    const onAskUser = vi.fn(async () => ({
      answer: "safe",
      answers: { "round-functional": ["safe"] },
      responseText: null,
      decision: "accept" as const,
    }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const intake: any = await tools.recordCodebaseIntake!.execute({
      projectShape: "desktop app",
      testStack: "vitest",
      inFlightWork: "fresh lane",
    });
    expect(intake.ok).toBe(true);

    const result: any = await tools.askPlanningRound!.execute({
      kind: "functional",
      question: "Which path?",
      options: [
        { id: "safe", label: "Safe path", description: "Small scoped fix." },
        { id: "broad", label: "Broad path", description: "Larger refactor." },
      ],
      lockedSummary: "Use the safe path.",
    });

    expect(result.ok).toBe(true);
    expect(result.selectedOptionIds).toEqual(["safe"]);
    expect(result.freeText).toBeUndefined();
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    const planning = manifest.leadState.planning;
    expect(planning).toBeDefined();
    expect(planning!.rounds[0]).toMatchObject({
      kind: "functional",
      selectedOptionIds: ["safe"],
    });
    expect(planning!.rounds[0]!.freeText).toBeUndefined();
  });

  it("splits custom answer text from selected planning option ids", async () => {
    setup = await setupWithRun("lead");
    const onAskUser = vi.fn(async () => ({
      answer: "safe",
      answers: { "round-functional": ["safe", "Keep the migration reversible."] },
      responseText: "Prefer a small first pass.",
      decision: "accept" as const,
    }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const intake: any = await tools.recordCodebaseIntake!.execute({
      projectShape: "desktop app",
      testStack: "vitest",
      inFlightWork: "fresh lane",
    });
    expect(intake.ok).toBe(true);

    const result: any = await tools.askPlanningRound!.execute({
      kind: "functional",
      question: "Which path?",
      options: [
        { id: "safe", label: "Safe path", description: "Small scoped fix." },
        { id: "broad", label: "Broad path", description: "Larger refactor." },
      ],
      lockedSummary: "Use the safe path.",
    });

    expect(result.ok).toBe(true);
    expect(result.selectedOptionIds).toEqual(["safe"]);
    expect(result.freeText).toBe("Prefer a small first pass.\n\nKeep the migration reversible.");
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    const round = manifest.leadState.planning!.rounds[0]!;
    expect(round.selectedOptionIds).toEqual(["safe"]);
    expect(round.freeText).toBe("Prefer a small first pass.\n\nKeep the migration reversible.");
    expect(round.lockedSummary).toBe("Selected: Safe path. Notes: Prefer a small first pass. Keep the migration reversible.");
  });

  it("preserves plain string answers for option-based planning rounds", async () => {
    setup = await setupWithRun("lead");
    const onAskUser = vi.fn(async () => "Use a smaller reversible change.");
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const intake: any = await tools.recordCodebaseIntake!.execute({
      projectShape: "desktop app",
      testStack: "vitest",
      inFlightWork: "fresh lane",
    });
    expect(intake.ok).toBe(true);

    const result: any = await tools.askPlanningRound!.execute({
      kind: "functional",
      question: "Which path?",
      options: [
        { id: "safe", label: "Safe path", description: "Small scoped fix." },
        { id: "broad", label: "Broad path", description: "Larger refactor." },
      ],
      lockedSummary: "Use the safe path.",
    });

    expect(result.ok).toBe(true);
    expect(result.selectedOptionIds).toEqual([]);
    expect(result.freeText).toBe("Use a smaller reversible change.");
    const round = setup.svc.getManifestForRun(setup.runId)!.leadState.planning!.rounds[0]!;
    expect(round.freeText).toBe("Use a smaller reversible change.");
    expect(round.lockedSummary).toBe("Notes: Use a smaller reversible change.");
  });

  it("derives planning round summary from the actual user response", async () => {
    setup = await setupWithRun("lead");
    const onAskUser = vi.fn(async () => ({
      answer: "broad",
      answers: { "round-functional": ["broad"] },
      responseText: "Include the shared service migration.",
      decision: "accept" as const,
    }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const intake: any = await tools.recordCodebaseIntake!.execute({
      projectShape: "desktop app",
      testStack: "vitest",
      inFlightWork: "fresh lane",
    });
    expect(intake.ok).toBe(true);

    const result: any = await tools.askPlanningRound!.execute({
      kind: "functional",
      question: "Which path?",
      options: [
        { id: "safe", label: "Safe path", description: "Small scoped fix." },
        { id: "broad", label: "Broad path", description: "Larger refactor." },
      ],
      lockedSummary: "Use the safe path.",
    });

    expect(result.ok).toBe(true);
    const round = setup.svc.getManifestForRun(setup.runId)!.leadState.planning!.rounds[0]!;
    expect(round.selectedOptionIds).toEqual(["broad"]);
    expect(round.lockedSummary).toBe(
      "Selected: Broad path. Notes: Include the shared service migration.",
    );
    expect(round.lockedSummary).not.toContain("safe");
  });

  it("writes model picker selections into role/tag routing once rounds are complete", async () => {
    setup = await setupWithRun("lead");
    await completeDeliberationRounds(setup);
    const selection = {
      provider: "codex",
      modelId: "gpt-5.4",
      reasoningEffort: "high",
      fastMode: true,
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
      workDescription: "Build the web UI",
      filesHint: ["src/web/app.tsx"],
    });
    expect(result.ok).toBe(true);
    expect(onAskUser).toHaveBeenCalledWith(expect.objectContaining({
      pendingInputKind: "model_selection",
      providerMetadata: expect.objectContaining({
        role: "worker",
        tag: "web-ui",
        workDescription: "Build the web UI",
        filesHint: ["src/web/app.tsx"],
      }),
    }));
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.modelRouting.byRoleTag?.["worker:web-ui"]).toEqual(selection);
  });

  it("rejects model selection for non-spawnable lead role", async () => {
    setup = await setupWithRun("lead");
    await completeDeliberationRounds(setup);
    const onAskUser = vi.fn(async () => ({ answer: "{}", decision: "accept" as const }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const result: any = await tools.askUserForModelSelection!.execute({
      role: "lead",
      tag: "web-ui",
      workDescription: "Lead should not be routed for spawn",
    } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unsupported_model_role");
    expect(onAskUser).not.toHaveBeenCalled();
  });

  it("reports an error when declined-plan state cannot be persisted", async () => {
    setup = await setupWithRun("lead");
    await completePlanningSequence(setup);
    vi.spyOn(setup.svc, "setPlanApprovalState").mockResolvedValueOnce({
      ok: false,
      error: "manifest_patch_failed",
      message: "write failed",
    } as any);
    const onAskUser = vi.fn(async () => ({ answer: "Please revise", decision: "decline" as const }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });

    const result: any = await tools.requestPlanApproval!.execute({});

    expect(result.ok).toBe(false);
    expect(result.error).toBe("manifest_patch_failed");
    expect(result.detail).toBe("write failed");
  });

  it.each([
    ["Not approved — don't start yet", "decline"],
    ["No, don't proceed with this plan", "none"],
    ["Please revise before we proceed", "decline"],
  ] as const)("does not treat rejection text %j as approval when decision is %s", async (answer, decision) => {
    setup = await setupWithRun("lead");
    await completePlanningSequence(setup);
    const onAskUser = vi.fn(async () => ({ answer, decision }));
    const tools = makeToolSet(setup, "lead", "S-lead", {
      universal: { permissionMode: "full-auto", onAskUser },
    });
    const result: any = await tools.requestPlanApproval!.execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_rejected");
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.currentPhase).toBe("planning");
    expect(manifest.leadState.planApprovedAt).toBeUndefined();
    expect(manifest.planSpec?.approval.state).toBe("changes_requested");
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

describe("deriveMessageAgentRequestId (intentional-repeat semantics)", () => {
  type Manifest = Parameters<typeof deriveMessageAgentRequestId>[0];
  const parts = {
    runId: "R-1",
    fromSessionId: "S-lead",
    targetSessionId: "S-worker",
    kind: "queue",
    intent: "status",
    taskId: "T-1",
    text: "keep going",
  };
  const manifestOf = (receipts: unknown[], outbox: unknown[]): Manifest =>
    ({ receipts, outbox } as unknown as Manifest);

  it("path 1 — fresh send: no prior committed send yields the bare base key", () => {
    const id = deriveMessageAgentRequestId(manifestOf([], []), parts);
    expect(id.startsWith("msg:")).toBe(true);
    expect(id.includes("#")).toBe(false);
  });

  it("path 2 — transient retry: a pending receipt (no outbox row) does NOT bump the epoch, so the retry reuses the same requestId and dedupes", () => {
    const base = deriveMessageAgentRequestId(manifestOf([], []), parts);
    // A crashed/in-flight reservation left a PENDING receipt but never enqueued.
    const retry = deriveMessageAgentRequestId(
      manifestOf([{ requestId: base, kind: "messageAgent", status: "pending" }], []),
      parts,
    );
    expect(retry).toBe(base);
  });

  it("path 3 — intentional repeat after success: a committed send (completed receipt + outbox row) salts a fresh requestId", () => {
    const base = deriveMessageAgentRequestId(manifestOf([], []), parts);
    const repeat = deriveMessageAgentRequestId(
      manifestOf(
        [{ requestId: base, kind: "messageAgent", status: "completed" }],
        [{ id: "O-1", requestId: base, status: "delivered" }],
      ),
      parts,
    );
    expect(repeat).toBe(`${base}#1`);
    // The receipt+outbox for one send are unioned by requestId → counted once.
    expect(repeat).not.toBe(`${base}#2`);
  });

  it("path 3 — survives receipt pruning: an outbox row alone (completed receipt pruned) still marks the send committed", () => {
    const base = deriveMessageAgentRequestId(manifestOf([], []), parts);
    const repeat = deriveMessageAgentRequestId(
      manifestOf([], [{ id: "O-1", requestId: base, status: "delivered" }]),
      parts,
    );
    expect(repeat).toBe(`${base}#1`);
  });

  it("epoch increments across successive intentional repeats", () => {
    const base = deriveMessageAgentRequestId(manifestOf([], []), parts);
    const third = deriveMessageAgentRequestId(
      manifestOf(
        [
          { requestId: base, kind: "messageAgent", status: "completed" },
          { requestId: `${base}#1`, kind: "messageAgent", status: "completed" },
        ],
        [],
      ),
      parts,
    );
    expect(third).toBe(`${base}#2`);
  });

  it("different logical content derives a different base key", () => {
    const a = deriveMessageAgentRequestId(manifestOf([], []), parts);
    const b = deriveMessageAgentRequestId(manifestOf([], []), { ...parts, text: "stop" });
    expect(a).not.toBe(b);
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

  it("records cancellation and interrupts a native worker with an active task", async () => {
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
    const beforeTask = setup.svc.getManifestForRun(setup.runId)!;
    const taskPatch = await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: beforeTask.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        summary: "assign cancellation test task",
        patches: [{
          op: "add",
          path: "/tasks/-",
          value: {
            id: "T-cancel",
            phaseId: "developing",
            title: "Native worker task",
            description: "Run provider-native Bash work.",
            status: "in_progress",
            assigneeSessionId: spawnResult.sessionId,
            claimedAt: "2026-01-01T00:00:00.000Z",
            claimLeaseUntil: "2099-01-01T00:00:00.000Z",
            attempts: [],
            validationGate: { required: false, stepIds: [] },
          },
        }],
      },
      setup.bundlePath,
    );
    expect(taskPatch.ok).toBe(true);
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
    expect(setup.chat.sendMessage).not.toHaveBeenCalled();
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(manifest.agents.find((agent) => agent.sessionId === spawnResult.sessionId)?.cancellationRequested).toBe(true);
    const task = manifest.tasks.find((entry) => entry.id === "T-cancel")!;
    expect(task.attempts?.find((attempt) => attempt.id === task.currentAttemptId)).toMatchObject({
      sessionId: spawnResult.sessionId,
      outcome: "cancelled",
      failureReason: "test",
    });
    expect(
      manifest.outbox?.some(
        (entry) =>
          entry.kind === "cancel_interrupt" &&
          entry.targetSessionId === spawnResult.sessionId &&
          entry.status === "delivered",
      ),
    ).toBe(true);
    expect(manifest.decisions.some((decision) =>
      decision.summary.includes(`Cancellation requested for ${spawnResult.sessionId}`),
    )).toBe(true);
  });

  it("does not persist cancellation state when completeReceipt fails (atomic with the receipt)", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const leadTools = makeToolSet(setup, "lead", "S-lead");
    const spawnResult: any = await leadTools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "task",
      stepId: "T-cancel",
      initialMessage: VALID_BRIEF,
    });
    expect(spawnResult.ok).toBe(true);
    // Give the target an active task so a cancellation would record an attempt.
    const beforeTask = setup.svc.getManifestForRun(setup.runId)!;
    const taskPatch = await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: beforeTask.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        summary: "assign cancellation test task",
        patches: [{
          op: "add",
          path: "/tasks/-",
          value: {
            id: "T-cancel",
            phaseId: "developing",
            title: "Native worker task",
            description: "Run provider-native Bash work.",
            status: "in_progress",
            assigneeSessionId: spawnResult.sessionId,
            claimedAt: "2026-01-01T00:00:00.000Z",
            claimLeaseUntil: "2099-01-01T00:00:00.000Z",
            attempts: [],
            validationGate: { required: false, stepIds: [] },
          },
        }],
      },
      setup.bundlePath,
    );
    expect(taskPatch.ok).toBe(true);

    const releaseSpy = vi.spyOn(setup.svc, "releaseReceipt");
    // The cancellation's flag/decision/attempt patches are folded into
    // completeReceipt, so a failing completeReceipt persists NONE of them.
    vi.spyOn(setup.svc, "completeReceipt").mockResolvedValueOnce({
      ok: false,
      error: "etag_conflict",
      message: "manifest advanced",
    });

    const result: any = await leadTools.messageAgent!.execute({
      targetSessionId: spawnResult.sessionId,
      kind: "interrupt-replace",
      intent: "cancellation",
      text: "stop and revert",
      cancellation: { revert: true, reason: "test" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("delivery_failed");
    // Receipt released so the deterministic requestId stays reservable.
    expect(releaseSpy).toHaveBeenCalledTimes(1);

    const after = setup.svc.getManifestForRun(setup.runId)!;
    // Cancellation state must NOT be durable: no flag, no decision, no attempt,
    // no orphaned outbox entry — a retry re-derives everything from scratch.
    expect(
      after.agents.find((a) => a.sessionId === spawnResult.sessionId)?.cancellationRequested,
    ).toBeFalsy();
    expect(
      after.decisions.some((d) => d.summary.includes("Cancellation requested")),
    ).toBe(false);
    const task = after.tasks.find((t) => t.id === "T-cancel");
    expect(task?.attempts?.some((a) => a.outcome === "cancelled")).toBeFalsy();
    expect((after.outbox ?? []).some((e) => e.kind === "cancel_interrupt")).toBe(false);
  });

  it("releases the receipt when completeReceipt fails (no leaked pending receipt, no orphaned outbox entry)", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const leadTools = makeToolSet(setup, "lead", "S-lead");
    const spawnResult: any = await leadTools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "task",
      stepId: "T-msg",
      initialMessage: VALID_BRIEF,
    });
    expect(spawnResult.ok).toBe(true);

    const releaseSpy = vi.spyOn(setup.svc, "releaseReceipt");
    // The atomic path folds the outbox `add` into completeReceipt, so a failing
    // completeReceipt persists NEITHER the receipt completion nor the outbox
    // entry.
    vi.spyOn(setup.svc, "completeReceipt").mockResolvedValueOnce({
      ok: false,
      error: "etag_conflict",
      message: "manifest advanced",
    });

    const messageAgent = leadTools.messageAgent!;
    const result: any = await messageAgent.execute({
      targetSessionId: spawnResult.sessionId,
      kind: "queue",
      intent: "status",
      text: "status ping",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("delivery_failed");
    // The reserved receipt must be released so its deterministic requestId stays
    // reservable — no permanently-wedged pending receipt.
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect((manifest.receipts ?? []).every((r) => r.status !== "pending")).toBe(true);
    // No orphaned outbox entry: because enqueue is atomic with completeReceipt,
    // the failed transaction leaves nothing for a later drain to deliver. (The
    // spawn brief for this session is kind "brief"; the ping would be "ping".)
    expect(
      (manifest.outbox ?? []).some(
        (entry) =>
          entry.kind === "ping" &&
          entry.targetSessionId === spawnResult.sessionId,
      ),
    ).toBe(false);
  });

  it("does not double-deliver on retry after a completeReceipt failure", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const leadTools = makeToolSet(setup, "lead", "S-lead");
    const spawnResult: any = await leadTools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "task",
      stepId: "T-msg",
      initialMessage: VALID_BRIEF,
    });
    expect(spawnResult.ok).toBe(true);

    // First attempt: completeReceipt fails once. With the atomic enqueue this
    // persists no outbox entry and releases the receipt (requestId reservable).
    const completeSpy = vi
      .spyOn(setup.svc, "completeReceipt")
      .mockResolvedValueOnce({
        ok: false,
        error: "etag_conflict",
        message: "manifest advanced",
      });

    const messageAgent = leadTools.messageAgent!;
    const pingArgs = {
      targetSessionId: spawnResult.sessionId,
      kind: "queue" as const,
      intent: "status" as const,
      text: "status ping",
    };
    const first: any = await messageAgent.execute(pingArgs);
    expect(first.ok).toBe(false);
    expect(first.error).toBe("delivery_failed");

    // Retry the SAME logical message → same deterministic requestId. reserveReceipt
    // succeeds (not a duplicate) because the failed attempt orphaned nothing, and
    // this time the real completeReceipt commits exactly one outbox entry.
    const second: any = await messageAgent.execute(pingArgs);
    expect(second.ok).toBe(true);
    expect(completeSpy).toHaveBeenCalledTimes(2);

    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    const pingEntries = (manifest.outbox ?? []).filter(
      (entry) =>
        entry.kind === "ping" &&
        entry.targetSessionId === spawnResult.sessionId,
    );
    // Exactly one ping delivery — no duplicate from the retry.
    expect(pingEntries).toHaveLength(1);
    expect(pingEntries[0]!.status).toBe("delivered");
    expect(setup.chat.steer).toHaveBeenCalledTimes(1);
  });

  it("delivers an intentional repeat after a prior identical send succeeded (not deduped)", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const leadTools = makeToolSet(setup, "lead", "S-lead");
    const spawnResult: any = await leadTools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "task",
      stepId: "T-msg",
      initialMessage: VALID_BRIEF,
    });
    expect(spawnResult.ok).toBe(true);

    const messageAgent = leadTools.messageAgent!;
    const pingArgs = {
      targetSessionId: spawnResult.sessionId,
      kind: "queue" as const,
      intent: "status" as const,
      text: "status ping",
    };

    setup.chat.steer.mockClear();
    const first: any = await messageAgent.execute(pingArgs);
    expect(first.ok).toBe(true);
    expect(first.deduped).toBeUndefined();

    // Same logical content, deliberately sent again after the first delivered.
    // Content-fingerprint dedupe alone would swallow this as `deduped:true`; the
    // epoch salt must reserve fresh so the intentional repeat is delivered.
    const second: any = await messageAgent.execute(pingArgs);
    expect(second.ok).toBe(true);
    expect(second.deduped).toBeUndefined();

    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    const pingEntries = (manifest.outbox ?? []).filter(
      (entry) =>
        entry.kind === "ping" && entry.targetSessionId === spawnResult.sessionId,
    );
    // Two distinct deliveries — the repeat was NOT deduped.
    expect(pingEntries).toHaveLength(2);
    expect(new Set(pingEntries.map((e) => e.requestId)).size).toBe(2);
    expect(pingEntries.every((e) => e.status === "delivered")).toBe(true);
    expect(setup.chat.steer).toHaveBeenCalledTimes(2);
  });

  it("does not replay a pending receipt as a delivered message", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    const leadTools = makeToolSet(setup, "lead", "S-lead");
    const spawnResult: any = await leadTools.spawnAgent!.execute({
      role: "worker",
      tag: "backend",
      goalSummary: "task",
      stepId: "T-msg",
      initialMessage: VALID_BRIEF,
    });
    expect(spawnResult.ok).toBe(true);

    const requestId = "msg-pending-1";
    // A prior message reservation that never completed (concurrent / crashed):
    // pending receipt, but no outbox entry was ever enqueued.
    const reserved = await setup.svc.reserveReceipt(setup.runId, setup.bundlePath, {
      requestId,
      kind: "messageAgent",
    });
    expect(reserved).toMatchObject({ ok: true, status: "reserved" });

    setup.chat.steer.mockClear();
    setup.chat.sendMessage.mockClear();
    const result: any = await leadTools.messageAgent!.execute({
      targetSessionId: spawnResult.sessionId,
      kind: "queue",
      intent: "status",
      text: "status ping",
      requestId,
    });

    // In-progress, not a fabricated success — and nothing was enqueued/delivered.
    expect(result).toMatchObject({ ok: false, error: "delivery_in_progress", retryable: true });
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect(
      (manifest.outbox ?? []).some(
        (entry) => entry.kind === "ping" && entry.targetSessionId === spawnResult.sessionId,
      ),
    ).toBe(false);
    expect(setup.chat.steer).not.toHaveBeenCalled();
    expect(setup.chat.sendMessage).not.toHaveBeenCalled();
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
    const blocked: any = await tools.recordValidationRun!.execute({
      taskId: "T-1",
      stepId: "V-1",
      status: "passed",
      notes: "Still found a blocking regression.",
      findings: [{
        severity: "blocker",
        title: "Release still loses validation evidence",
        regressionTestTarget: "recordValidationRun rejects passed blocker findings",
      }],
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("validation_failed");
    expect(blocked.message).toContain("blocker or high");
    expect(setup.svc.getManifestForRun(setup.runId)!.validationStrategy.checklist).toEqual([]);

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

// Seed a developing task assigned to a worker/validator, ready to release.
async function seedAssignedTask(
  setup: Setup,
  args: {
    sessionId: string;
    role: "worker" | "validator";
    tag?: string;
    taskId?: string;
    phaseId?: "developing" | "validating";
    status?: "running";
  },
): Promise<void> {
  const m = setup.svc.getManifestForRun(setup.runId)!;
  const taskId = args.taskId ?? "T-1";
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
            sessionId: args.sessionId,
            role: args.role,
            ...(args.tag ? { tag: args.tag } : {}),
            goalSummary: "do work",
            status: args.status ?? "running",
            spawnedAt: "now",
          },
        },
        {
          op: "add",
          path: "/tasks/-",
          value: {
            id: taskId,
            phaseId: args.phaseId ?? "developing",
            title: "build it",
            description: "x",
            status: "claimed",
            validationGate: { required: false, stepIds: [] },
            assigneeSessionId: args.sessionId,
          },
        },
      ],
    },
    setup.bundlePath,
  );
  expect(seeded.ok).toBe(true);
}

describe("completion outbox on worker/validator terminal transition", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("enqueues a completion entry to the lead when a worker releases its task done", async () => {
    setup = await setupWithRun("worker");
    await approveRun(setup);
    await seedAssignedTask(setup, { sessionId: "S-worker", role: "worker", tag: "impl" });

    const tools = makeToolSet(setup, "worker", "S-worker");
    const res: any = await tools.releaseTask!.execute({ taskId: "T-1", status: "done" });
    expect(res.ok).toBe(true);

    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    const completion = (manifest.outbox ?? []).find(
      (e) => e.kind === "completion" && e.targetSessionId === "S-lead",
    );
    expect(completion).toBeDefined();
    const detail = (completion!.delivery.metadata as any)?.orchestrationCompletion;
    expect(detail?.sessionId).toBe("S-worker");
    expect(detail?.outcome).toBe("completed");
    expect(detail?.tag).toBe("impl");
    // Plain-language, human-readable text (SKILL §14).
    expect(completion!.delivery.text).toContain("impl finished");
    expect(completion!.delivery.text).toContain("done");
  });

  it("records outcome=failed when a worker releases its task failed", async () => {
    setup = await setupWithRun("worker");
    await approveRun(setup);
    await seedAssignedTask(setup, { sessionId: "S-worker", role: "worker", tag: "impl" });

    const tools = makeToolSet(setup, "worker", "S-worker");
    const res: any = await tools.releaseTask!.execute({ taskId: "T-1", status: "failed" });
    expect(res.ok).toBe(true);

    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    const completion = (manifest.outbox ?? []).find((e) => e.kind === "completion");
    expect((completion!.delivery.metadata as any)?.orchestrationCompletion?.outcome).toBe("failed");
    expect(completion!.delivery.text).toContain("failed");
  });

  it("does not also enqueue a generic lead_status ping on a terminal release (single notification)", async () => {
    setup = await setupWithRun("worker");
    await approveRun(setup);
    await seedAssignedTask(setup, { sessionId: "S-worker", role: "worker", tag: "impl" });

    const tools = makeToolSet(setup, "worker", "S-worker");
    const res: any = await tools.releaseTask!.execute({ taskId: "T-1", status: "done" });
    expect(res.ok).toBe(true);

    const outbox = setup.svc.getManifestForRun(setup.runId)!.outbox ?? [];
    // Exactly one structured completion entry to the lead...
    expect(
      outbox.filter((e) => e.kind === "completion" && e.targetSessionId === "S-lead"),
    ).toHaveLength(1);
    // ...and NO generic lead_status ping for that same transition — the lead is
    // notified once, not twice.
    expect(outbox.some((e) => e.kind === "lead_status")).toBe(false);
  });

  it("still sends a generic lead_status ping for a non-terminal release (review)", async () => {
    setup = await setupWithRun("worker");
    await approveRun(setup);
    await seedAssignedTask(setup, { sessionId: "S-worker", role: "worker", tag: "impl" });

    const tools = makeToolSet(setup, "worker", "S-worker");
    // `review` is not a terminal completion, so no completion entry is enqueued
    // and the generic status ping is the only notification — it must survive.
    const res: any = await tools.releaseTask!.execute({ taskId: "T-1", status: "review" });
    expect(res.ok).toBe(true);

    const outbox = setup.svc.getManifestForRun(setup.runId)!.outbox ?? [];
    expect(outbox.some((e) => e.kind === "completion")).toBe(false);
    expect(outbox.some((e) => e.kind === "lead_status" && e.targetSessionId === "S-lead")).toBe(true);
  });

  it("does not enqueue a completion when the lead itself releases a task", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    // Lead claims + releases a planning-seed task on its own session.
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
              id: "T-lead",
              phaseId: "developing",
              title: "lead seed",
              description: "x",
              status: "claimed",
              validationGate: { required: false, stepIds: [] },
              assigneeSessionId: "S-lead",
            },
          },
        ],
      },
      setup.bundlePath,
    );
    const tools = makeToolSet(setup, "lead", "S-lead");
    const res: any = await tools.releaseTask!.execute({ taskId: "T-lead", status: "done" });
    expect(res.ok).toBe(true);
    const manifest = setup.svc.getManifestForRun(setup.runId)!;
    expect((manifest.outbox ?? []).some((e) => e.kind === "completion")).toBe(false);
  });
});

describe("awaitAgent tool", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("is registered for the lead and not for workers", async () => {
    setup = await setupWithRun("lead");
    expect(makeToolSet(setup, "lead", "S-lead").awaitAgent).toBeDefined();
    expect(makeToolSet(setup, "worker", "S-worker").awaitAgent).toBeUndefined();
  });

  it("short-circuits immediately when the target is already settled", async () => {
    setup = await setupWithRun("lead");
    const m = setup.svc.getManifestForRun(setup.runId)!;
    await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: m.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{
          op: "add",
          path: "/agents/-",
          value: {
            sessionId: "S-worker",
            role: "worker",
            tag: "impl",
            goalSummary: "done already",
            status: "completed",
            spawnedAt: "now",
          },
        }],
      },
      setup.bundlePath,
    );
    const tools = makeToolSet(setup, "lead", "S-lead");
    const res: any = await tools.awaitAgent!.execute({ sessionIds: ["S-worker"] });
    expect(res.ok).toBe(true);
    expect(res.done).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.agents[0].status).toBe("completed");
  });

  it("rejects unknown target sessions", async () => {
    setup = await setupWithRun("lead");
    const tools = makeToolSet(setup, "lead", "S-lead");
    const res: any = await tools.awaitAgent!.execute({ sessionIds: ["S-nope"] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("agent_not_in_run");
    expect(res.unknownSessionIds).toEqual(["S-nope"]);
  });

  it("resolves when the target reaches a terminal state via a completion event", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    await seedAssignedTask(setup, { sessionId: "S-worker", role: "worker", tag: "impl" });

    const leadTools = makeToolSet(setup, "lead", "S-lead");
    const workerTools = makeToolSet(setup, "worker", "S-worker");

    // Start awaiting BEFORE the worker finishes; the Promise executor installs
    // the subscription synchronously, so no event can be missed.
    const pending = leadTools.awaitAgent!.execute({ sessionIds: ["S-worker"], timeoutMs: 5000 });
    await workerTools.releaseTask!.execute({ taskId: "T-1", status: "done" });
    const res: any = await pending;
    expect(res.ok).toBe(true);
    expect(res.done).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.agents[0].status).toBe("completed");
  });

  it("returns a structured still-running result on timeout", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    await seedAssignedTask(setup, { sessionId: "S-worker", role: "worker", tag: "impl" });

    const tools = makeToolSet(setup, "lead", "S-lead");
    const res: any = await tools.awaitAgent!.execute({ sessionIds: ["S-worker"], timeoutMs: 30 });
    expect(res.ok).toBe(true);
    expect(res.done).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.stillRunning.map((s: any) => s.sessionId)).toContain("S-worker");
  });

  it("waitFor 'any' resolves when at least one target settles", async () => {
    setup = await setupWithRun("lead");
    const m = setup.svc.getManifestForRun(setup.runId)!;
    await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: m.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          { op: "add", path: "/agents/-", value: { sessionId: "S-a", role: "worker", tag: "a", goalSummary: "x", status: "completed", spawnedAt: "now" } },
          { op: "add", path: "/agents/-", value: { sessionId: "S-b", role: "worker", tag: "b", goalSummary: "x", status: "running", spawnedAt: "now" } },
        ],
      },
      setup.bundlePath,
    );
    const tools = makeToolSet(setup, "lead", "S-lead");
    const anyRes: any = await tools.awaitAgent!.execute({ sessionIds: ["S-a", "S-b"], waitFor: "any" });
    expect(anyRes.done).toBe(true);
    // "all" would time out because S-b is still running.
    const allRes: any = await tools.awaitAgent!.execute({ sessionIds: ["S-a", "S-b"], waitFor: "all", timeoutMs: 30 });
    expect(allRes.timedOut).toBe(true);
  });

  it("does not leak event subscriptions across duplicate calls", async () => {
    setup = await setupWithRun("lead");
    await approveRun(setup);
    await seedAssignedTask(setup, { sessionId: "S-worker", role: "worker", tag: "impl" });

    let subscribes = 0;
    let unsubscribes = 0;
    const realOn = setup.svc.on.bind(setup.svc);
    (setup.svc as any).on = (name: "event", cb: (payload: any) => void) => {
      subscribes += 1;
      const off = realOn(name, cb);
      return () => {
        unsubscribes += 1;
        off();
      };
    };

    const tools = makeToolSet(setup, "lead", "S-lead");
    await Promise.all([
      tools.awaitAgent!.execute({ sessionIds: ["S-worker"], timeoutMs: 30 }),
      tools.awaitAgent!.execute({ sessionIds: ["S-worker"], timeoutMs: 30 }),
    ]);
    expect(subscribes).toBe(2);
    expect(unsubscribes).toBe(2);
  });
});

describe("lead read-only ADE capability tools", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("registers the curated read-only tools for the lead only", async () => {
    setup = await setupWithRun("lead");
    const lead = makeToolSet(setup, "lead", "S-lead");
    for (const name of ["searchWorkspace", "readLinearIssue", "readPr", "listProofArtifacts", "mintDeeplink"]) {
      expect(lead[name]).toBeDefined();
    }
    const worker = makeToolSet(setup, "worker", "S-worker");
    for (const name of ["searchWorkspace", "readLinearIssue", "readPr", "listProofArtifacts", "mintDeeplink"]) {
      expect(worker[name]).toBeUndefined();
    }
  });

  it("returns a clean 'unavailable' result when the backing service is null", async () => {
    setup = await setupWithRun("lead");
    const tools = makeToolSet(setup, "lead", "S-lead"); // no leadReadServices wired
    for (const name of ["searchWorkspace", "readLinearIssue", "readPr", "listProofArtifacts", "mintDeeplink"]) {
      const res: any = await tools[name]!.execute(
        name === "searchWorkspace"
          ? { query: "x" }
          : name === "readLinearIssue"
            ? { issueId: "ADE-1" }
            : name === "mintDeeplink"
              ? { target: { kind: "lane", laneId: "x" } }
              : {},
      );
      expect(res.ok).toBe(false);
      expect(res.error).toBe("unavailable");
    }
  });

  it("passes through a wired backing and flattens thrown errors to a result", async () => {
    setup = await setupWithRun("lead");
    const tools = makeToolSet(setup, "lead", "S-lead", {
      leadReadServices: {
        searchWorkspace: async ({ query }) => ({ ok: true, results: [{ id: `hit:${query}` }] }),
        readLinearIssue: async () => {
          throw new Error("linear exploded");
        },
      },
    });
    const ok: any = await tools.searchWorkspace!.execute({ query: "login" });
    expect(ok.ok).toBe(true);
    expect(ok.results[0].id).toBe("hit:login");

    const thrown: any = await tools.readLinearIssue!.execute({ issueId: "ADE-9" });
    expect(thrown.ok).toBe(false);
    expect(thrown.error).toBe("read_failed");
    expect(thrown.message).toContain("linear exploded");
  });

  it("validates mintDeeplink targets with a discriminated schema", async () => {
    setup = await setupWithRun("lead");
    const lead = makeToolSet(setup, "lead", "S-lead");
    const schema = lead.mintDeeplink!.inputSchema;
    // Valid targets across kinds parse.
    expect(schema.safeParse({ target: { kind: "lane", laneId: "L-1" } }).success).toBe(true);
    expect(
      schema.safeParse({ target: { kind: "pr", repoOwner: "o", repoName: "r", prNumber: 12 } }).success,
    ).toBe(true);
    expect(schema.safeParse({ target: { kind: "file", path: "src/a.ts", line: 3 } }).success).toBe(true);
    expect(
      schema.safeParse({ target: { kind: "linear-issue", issueIdentifier: "ADE-1" } }).success,
    ).toBe(true);
    // Unknown kind rejected (previously passed as a loose record and produced a
    // malformed/undefined URL while still reporting success).
    expect(schema.safeParse({ target: { kind: "bogus", laneId: "x" } }).success).toBe(false);
    // Missing a kind-specific required field rejected (pr without prNumber).
    expect(schema.safeParse({ target: { kind: "pr", repoOwner: "o", repoName: "r" } }).success).toBe(false);
    // Wrong field type rejected (prNumber must be a positive integer, not a string).
    expect(
      schema.safeParse({ target: { kind: "pr", repoOwner: "o", repoName: "r", prNumber: "12" } }).success,
    ).toBe(false);
    // Missing discriminant entirely rejected.
    expect(schema.safeParse({ target: { laneId: "x" } }).success).toBe(false);
  });
});

describe("registerAsset accepts Unit S evidence kinds + externalRef", () => {
  let setup: Setup;
  afterEach(async () => {
    if (setup) await cleanup(setup);
  });

  it("registers a proof_artifact with an externalRef.artifactId", async () => {
    setup = await setupWithRun("worker");
    await approveRun(setup);
    const m = setup.svc.getManifestForRun(setup.runId)!;
    await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: m.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{
          op: "add",
          path: "/agents/-",
          value: { sessionId: "S-worker", role: "worker", tag: "impl", goalSummary: "x", status: "running", spawnedAt: "now" },
        }],
      },
      setup.bundlePath,
    );
    const tools = makeToolSet(setup, "worker", "S-worker");
    const res: any = await tools.registerAsset!.execute({
      relPath: "artifacts/evidence/shot.png",
      kind: "proof_artifact",
      externalRef: { artifactId: "CU-123", url: "https://example.test/CU-123" },
    });
    expect(res.ok).toBe(true);
    expect(res.asset.kind).toBe("proof_artifact");
    expect(res.asset.externalRef.artifactId).toBe("CU-123");
  });

  it("accepts every new asset kind at the tool boundary", async () => {
    setup = await setupWithRun("worker");
    await approveRun(setup);
    const m = setup.svc.getManifestForRun(setup.runId)!;
    await setup.svc.manifestPatch(
      {
        runId: setup.runId,
        ifMatchEtag: m.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{
          op: "add",
          path: "/agents/-",
          value: { sessionId: "S-worker", role: "worker", tag: "impl", goalSummary: "x", status: "running", spawnedAt: "now" },
        }],
      },
      setup.bundlePath,
    );
    const tools = makeToolSet(setup, "worker", "S-worker");
    for (const kind of ["computer_use", "video", "pr_link", "linear_issue", "deeplink"]) {
      const res: any = await tools.registerAsset!.execute({
        relPath: `artifacts/evidence/${kind}.bin`,
        kind,
      });
      expect(res.ok).toBe(true);
      expect(res.asset.kind).toBe(kind);
    }
  });
});
