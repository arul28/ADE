/* @vitest-environment node */
import { describe, expect, it, beforeEach, vi } from "vitest";
import path from "node:path";

import { createOrchestrationDomainService } from "./orchestrationDomain";
import {
  normalizeManifestShape,
  validateManifestShape,
} from "./manifestNormalization";
import type { OrchestrationService } from "./orchestrationService";
import type {
  OrchestrationAgentInjectRequest,
  OrchestrationAsset,
  OrchestrationManifest,
  OrchestrationManifestPatchResponse,
} from "../../../shared/types/orchestration";

// A spawn brief that satisfies validateSpawnBrief (all required sections present).
const VALID_BRIEF = `## TASK
Build login
## FILES
src/x.ts
## DEPENDENCIES
none
## GATES
reverify_changes
## PEERS
none
## SUCCESS
tests pass`;

const LANE_PATH = "/tmp/ade-lane-fixed";

/**
 * Build a manifest whose plan is approved (currentPhase !== "planning" makes
 * isOrchestrationPlanApproved return true) and whose modelRouting is empty so
 * resolveOrchestrationModel falls through to the claude fallback.
 */
function makeApprovedManifest(
  overrides: Partial<OrchestrationManifest> = {},
): OrchestrationManifest {
  return {
    version: 1,
    schemaCompatibility: { minReader: 1, maxKnown: 1 },
    runId: "R-1",
    laneId: "L-1",
    bundlePath: path.join(LANE_PATH, ".ade", "orchestration", "R-1"),
    etag: "etag-0",
    serverGeneration: 0,
    createdAt: "now",
    updatedAt: "now",
    title: "Run",
    goalSummary: "do the thing",
    currentPhase: "developing",
    phases: [],
    agents: [],
    tasks: [],
    validationStrategy: { steps: [], checklist: [] },
    modelRouting: {},
    assets: [],
    decisions: [],
    userOverrides: [],
    leadState: {},
    history: [],
    ...overrides,
  };
}

function patchOk(etag: string): OrchestrationManifestPatchResponse {
  return { ok: true, manifest: makeApprovedManifest({ etag }), etag };
}

function patchEtagConflict(nextEtag: string): OrchestrationManifestPatchResponse {
  return {
    ok: false,
    error: "etag_conflict",
    manifest: makeApprovedManifest({ etag: nextEtag }),
    etag: nextEtag,
  };
}

function makeDeps() {
  const orchestrationService = {
    getManifestForRun: vi.fn(),
    runCreate: vi.fn(),
    manifestPatch: vi.fn(),
    // Best-effort lineage write. Defaults to a no-op failure so the spawn falls
    // back to the agent-append etag (existing assertions unchanged); tests that
    // care override it to assert the ledger etag is surfaced.
    recordDelegationSpawn: vi.fn(async () => ({ ok: false as const, error: "skip", message: "test default" })),
  };
  const agentChatService = {
    createSession: vi.fn(async (..._args: any[]) => ({ id: "sess-1" })),
    deleteSession: vi.fn(async (..._args: any[]) => undefined),
    sendMessage: vi.fn(async (..._args: any[]) => undefined),
    steer: vi.fn(async (..._args: any[]) => undefined),
    interrupt: vi.fn(async (..._args: any[]) => undefined),
    setOrchestrationFields: vi.fn((..._args: any[]) => undefined),
  };
  const laneService = {
    getLaneWorktreePath: vi.fn(() => LANE_PATH),
  };
  // The domain service only calls the three orchestrationService methods above;
  // cast through unknown to satisfy the full OrchestrationService surface.
  const service = createOrchestrationDomainService({
    orchestrationService: orchestrationService as unknown as OrchestrationService,
    laneService,
    agentChatService: agentChatService as never,
  });
  return { service, orchestrationService, agentChatService, laneService };
}

const SPAWN_ARG = {
  laneId: "L-1",
  leadSessionId: "S-lead",
  runId: "R-1",
  role: "worker" as const,
  tag: "impl",
  goalSummary: "implement login",
  stepId: "step-1",
  initialMessage: VALID_BRIEF,
};

describe("orchestrationDomain", () => {
  let h: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    h = makeDeps();
  });

  // --- spawnAgent gates -----------------------------------------------------

  it("spawnAgent throws when the run manifest is not loaded", async () => {
    h.orchestrationService.getManifestForRun.mockReturnValue(null);
    await expect(h.service.spawnAgent(SPAWN_ARG)).rejects.toThrow(
      /not loaded — call orchestrationBundleRead first/,
    );
    expect(h.agentChatService.createSession).not.toHaveBeenCalled();
  });

  it("rejects a runId that would escape the bundle root before any work", async () => {
    await expect(
      h.service.spawnAgent({ ...SPAWN_ARG, runId: "../../etc/passwd" }),
    ).rejects.toThrow(/invalid orchestration runId/);
    expect(h.orchestrationService.getManifestForRun).not.toHaveBeenCalled();
  });

  it("spawnAgent throws when the plan is not approved", async () => {
    // currentPhase "planning" with no planApprovedAt => not approved.
    h.orchestrationService.getManifestForRun.mockReturnValue(
      makeApprovedManifest({ currentPhase: "planning", leadState: {} }),
    );
    await expect(h.service.spawnAgent(SPAWN_ARG)).rejects.toThrow(
      /blocked until the user approves the orchestration plan/,
    );
    expect(h.agentChatService.createSession).not.toHaveBeenCalled();
  });

  it("spawnAgent throws and lists missing sections for an invalid brief", async () => {
    h.orchestrationService.getManifestForRun.mockReturnValue(makeApprovedManifest());
    await expect(
      h.service.spawnAgent({ ...SPAWN_ARG, initialMessage: "no sections here" }),
    ).rejects.toThrow(/spawn brief missing required sections: .*## TASK/);
    expect(h.agentChatService.createSession).not.toHaveBeenCalled();
  });

  // --- spawnAgent happy path / retry / cleanup ------------------------------

  it("spawnAgent creates a session, patches the manifest, sends the brief, and returns {sessionId, etag}", async () => {
    h.orchestrationService.getManifestForRun.mockReturnValue(
      makeApprovedManifest({ etag: "etag-A" }),
    );
    h.orchestrationService.manifestPatch.mockResolvedValue(patchOk("etag-B"));

    const result = await h.service.spawnAgent(SPAWN_ARG);

    expect(result).toEqual({ sessionId: "sess-1", etag: "etag-B" });
    expect(h.agentChatService.createSession).toHaveBeenCalledTimes(1);
    expect(h.agentChatService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ spawnKind: "subagent" }),
    );
    expect(h.orchestrationService.manifestPatch).toHaveBeenCalledTimes(1);
  });

  it("spawnAgent surfaces the lineage-write etag (not the stale agent-append etag)", async () => {
    h.orchestrationService.getManifestForRun.mockReturnValue(
      makeApprovedManifest({ etag: "etag-A" }),
    );
    h.orchestrationService.manifestPatch.mockResolvedValue(patchOk("etag-B"));
    // The delegation-edge write advances the manifest etag past the agent append.
    h.orchestrationService.recordDelegationSpawn.mockResolvedValue({
      ok: true as const,
      etag: "etag-C",
      edgeId: "D-1",
    } as never);

    const result = await h.service.spawnAgent(SPAWN_ARG);

    expect(result).toEqual({ sessionId: "sess-1", etag: "etag-C" });
    expect(h.orchestrationService.recordDelegationSpawn).toHaveBeenCalledTimes(1);
    // first patch uses the loaded manifest etag and adds the agent at /agents/-
    const [patchReq] = h.orchestrationService.manifestPatch.mock.calls[0]!;
    expect(patchReq.ifMatchEtag).toBe("etag-A");
    expect(patchReq.patches[0]).toMatchObject({ op: "add", path: "/agents/-" });
    expect(patchReq.patches[0].value.sessionId).toBe("sess-1");
    // initial message is dispatched to the new session
    const [sendArg] = h.agentChatService.sendMessage.mock.calls[0]!;
    expect(sendArg).toMatchObject({ sessionId: "sess-1", text: VALID_BRIEF });
    expect(h.agentChatService.deleteSession).not.toHaveBeenCalled();
  });

  it("spawnAgent retries the manifest patch with the conflict etag and succeeds", async () => {
    h.orchestrationService.getManifestForRun.mockReturnValue(
      makeApprovedManifest({ etag: "etag-A" }),
    );
    h.orchestrationService.manifestPatch
      .mockResolvedValueOnce(patchEtagConflict("etag-RETRY"))
      .mockResolvedValueOnce(patchOk("etag-FINAL"));

    const result = await h.service.spawnAgent(SPAWN_ARG);

    expect(result.etag).toBe("etag-FINAL");
    expect(h.orchestrationService.manifestPatch).toHaveBeenCalledTimes(2);
    const [firstReq] = h.orchestrationService.manifestPatch.mock.calls[0]!;
    const [secondReq] = h.orchestrationService.manifestPatch.mock.calls[1]!;
    expect(firstReq.ifMatchEtag).toBe("etag-A");
    expect(secondReq.ifMatchEtag).toBe("etag-RETRY");
    expect(h.agentChatService.deleteSession).not.toHaveBeenCalled();
  });

  it("spawnAgent deletes the orphaned session and throws when the patch ultimately fails", async () => {
    h.orchestrationService.getManifestForRun.mockReturnValue(
      makeApprovedManifest({ etag: "etag-A" }),
    );
    // First returns a conflict (with manifest), retry returns a hard validation failure.
    h.orchestrationService.manifestPatch
      .mockResolvedValueOnce(patchEtagConflict("etag-RETRY"))
      .mockResolvedValueOnce({
        ok: false,
        error: "validation_failed",
        message: "boom",
      });

    await expect(h.service.spawnAgent(SPAWN_ARG)).rejects.toThrow(
      /spawn manifest patch failed/,
    );
    expect(h.agentChatService.deleteSession).toHaveBeenCalledWith({ sessionId: "sess-1" });
    expect(h.agentChatService.sendMessage).not.toHaveBeenCalled();
  });

  // --- agentInject three modes + gate ---------------------------------------

  function injectManifest(): OrchestrationManifest {
    return makeApprovedManifest({
      agents: [
        {
          sessionId: "S-from",
          role: "lead",
          goalSummary: "lead",
          status: "running",
          spawnedAt: "now",
        },
        {
          sessionId: "S-target",
          role: "worker",
          goalSummary: "worker",
          status: "running",
          spawnedAt: "now",
        },
      ],
    });
  }

  function injectReq(
    kind: OrchestrationAgentInjectRequest["payload"]["kind"],
  ): OrchestrationAgentInjectRequest {
    return {
      runId: "R-1",
      fromSessionId: "S-from",
      targetSessionId: "S-target",
      payload: { kind, intent: "directive", text: "do this", taskId: "T-1" },
    };
  }

  it("agentInject queue mode steers the target session", async () => {
    h.orchestrationService.getManifestForRun.mockReturnValue(injectManifest());
    await h.service.agentInject(injectReq("queue"));
    expect(h.agentChatService.steer).toHaveBeenCalledTimes(1);
    expect(h.agentChatService.steer.mock.calls[0]![0]).toMatchObject({
      sessionId: "S-target",
      text: "do this",
    });
    expect(h.agentChatService.sendMessage).not.toHaveBeenCalled();
    expect(h.agentChatService.interrupt).not.toHaveBeenCalled();
  });

  it("agentInject interrupt-replace mode interrupts then sends a fresh message", async () => {
    h.orchestrationService.getManifestForRun.mockReturnValue(injectManifest());
    await h.service.agentInject(injectReq("interrupt-replace"));
    expect(h.agentChatService.interrupt).toHaveBeenCalledWith({ sessionId: "S-target" });
    expect(h.agentChatService.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.agentChatService.sendMessage.mock.calls[0]![0]).toMatchObject({
      sessionId: "S-target",
      text: "do this",
    });
    expect(h.agentChatService.steer).not.toHaveBeenCalled();
    // interrupt must precede sendMessage
    expect(h.agentChatService.interrupt.mock.invocationCallOrder[0]!).toBeLessThan(
      h.agentChatService.sendMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("agentInject default (wake) mode only sends a message", async () => {
    h.orchestrationService.getManifestForRun.mockReturnValue(injectManifest());
    await h.service.agentInject(injectReq("wake"));
    expect(h.agentChatService.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.agentChatService.steer).not.toHaveBeenCalled();
    expect(h.agentChatService.interrupt).not.toHaveBeenCalled();
  });

  it("agentInject throws when source/target are not both in the manifest agents", async () => {
    h.orchestrationService.getManifestForRun.mockReturnValue(
      makeApprovedManifest({
        agents: [
          {
            sessionId: "S-from",
            role: "lead",
            goalSummary: "lead",
            status: "running",
            spawnedAt: "now",
          },
        ],
      }),
    );
    await expect(h.service.agentInject(injectReq("queue"))).rejects.toThrow(
      /source\/target not in same run/,
    );
    expect(h.agentChatService.steer).not.toHaveBeenCalled();
  });

  // --- runCreate best-effort field stitch -----------------------------------

  it("runCreate resolves with the service result even when setOrchestrationFields throws", async () => {
    const createdManifest = makeApprovedManifest({
      bundlePath: "/bundle/R-1",
    });
    h.orchestrationService.runCreate.mockResolvedValue({
      runId: "R-1",
      manifest: createdManifest,
      etag: "etag-create",
    });
    h.agentChatService.setOrchestrationFields.mockImplementation(() => {
      throw new Error("persist failed");
    });

    const result = await h.service.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      title: "Run",
      goalSummary: "goal",
    });

    expect(result).toMatchObject({ runId: "R-1", etag: "etag-create" });
    // best-effort stitch was attempted (and swallowed)
    expect(h.agentChatService.setOrchestrationFields).toHaveBeenCalledWith("S-lead", {
      orchestrationRunId: "R-1",
      orchestrationRole: "lead",
      orchestrationBundlePath: "/bundle/R-1",
    });
    // the bundleRoot passed to the service is the resolved lane worktree
    expect(h.orchestrationService.runCreate.mock.calls[0]![0]).toMatchObject({
      bundleRoot: LANE_PATH,
    });
  });
});

/**
 * Round-trip a manifest the way the service does on load: serialize to JSON,
 * JSON.parse it back (as the runtime does from disk), normalize its shape, then
 * validate. Returns the normalized manifest so callers can assert field
 * survival, plus the validation error string (null == valid).
 */
function roundTrip(manifest: OrchestrationManifest): {
  next: OrchestrationManifest;
  error: string | null;
} {
  const parsed = JSON.parse(JSON.stringify(manifest)) as OrchestrationManifest;
  const next = normalizeManifestShape(parsed);
  return { next, error: validateManifestShape(next) };
}

/** A minimal manifest that satisfies validateManifestShape (>=1 agent, valid phase). */
function baseManifest(
  overrides: Partial<OrchestrationManifest> = {},
): OrchestrationManifest {
  return {
    version: 1,
    schemaCompatibility: { minReader: 1, maxKnown: 1 },
    runId: "R-1",
    laneId: "L-1",
    bundlePath: "/tmp/ade-lane/.ade/orchestration/R-1",
    etag: "etag-0",
    serverGeneration: 0,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    title: "Run",
    goalSummary: "do the thing",
    currentPhase: "developing",
    phases: [],
    agents: [
      {
        sessionId: "S-lead",
        role: "lead",
        goalSummary: "lead",
        status: "running",
        spawnedAt: "2026-07-22T00:00:00.000Z",
      },
    ],
    tasks: [],
    validationStrategy: { steps: [], checklist: [] },
    modelRouting: {},
    assets: [],
    decisions: [],
    userOverrides: [],
    leadState: {},
    history: [],
    ...overrides,
  };
}

describe("orchestration manifest schema extensions", () => {
  it("round-trips new-kind assets with externalRef intact", () => {
    const assets: OrchestrationAsset[] = [
      {
        id: "A-1",
        path: "artifacts/proof/login.png",
        kind: "proof_artifact",
        version: 1,
        approval: "approved",
        externalRef: { artifactId: "proof-abc123", url: "ade://proof/abc123" },
      },
      {
        id: "A-2",
        path: "artifacts/pr/link.json",
        kind: "pr_link",
        version: 1,
        externalRef: { prNumber: 868, url: "https://github.com/org/repo/pull/868" },
      },
      {
        id: "A-3",
        path: "artifacts/linear/issue.json",
        kind: "linear_issue",
        version: 1,
        externalRef: { linearId: "ADE-122", url: "https://linear.app/x/issue/ADE-122" },
      },
      {
        id: "A-4",
        path: "artifacts/deeplink.txt",
        kind: "deeplink",
        version: 1,
        externalRef: { url: "ade://run/R-1" },
      },
    ];

    const { next, error } = roundTrip(
      baseManifest({
        assets,
        goalSource: { kind: "linear", ref: "ADE-122" },
        capabilities: {
          allowed: ["proof_capture", "linear", "pr"],
          required: ["proof_capture"],
          notes: "capture before/after screenshots of the login screen",
        },
        scheduledFollowups: [
          {
            id: "F-1",
            summary: "re-check CI in 30 minutes",
            scheduledFor: "2026-07-22T00:30:00.000Z",
            status: "pending",
          },
        ],
      }),
    );

    expect(error).toBeNull();
    // New asset kinds + externalRef survive the serialize→parse→normalize trip.
    expect(next.assets).toHaveLength(4);
    expect(next.assets[0]).toMatchObject({
      kind: "proof_artifact",
      externalRef: { artifactId: "proof-abc123", url: "ade://proof/abc123" },
    });
    expect(next.assets[1].externalRef).toEqual({
      prNumber: 868,
      url: "https://github.com/org/repo/pull/868",
    });
    expect(next.assets[2].externalRef).toEqual({
      linearId: "ADE-122",
      url: "https://linear.app/x/issue/ADE-122",
    });
    // New top-level manifest fields survive.
    expect(next.goalSource).toEqual({ kind: "linear", ref: "ADE-122" });
    expect(next.capabilities?.required).toEqual(["proof_capture"]);
    expect(next.scheduledFollowups?.[0]).toMatchObject({
      id: "F-1",
      summary: "re-check CI in 30 minutes",
      status: "pending",
    });
  });

  it("still parses an OLD manifest with no new fields", () => {
    // A pre-extension manifest: only the original four asset kinds, no
    // externalRef, no goalSource / capabilities / scheduledFollowups.
    const legacy = baseManifest({
      assets: [
        { id: "A-1", path: "artifacts/ui/spec.html", kind: "html_spec", version: 1 },
        { id: "A-2", path: "artifacts/screens/home.png", kind: "screenshot", version: 2 },
        { id: "A-3", path: "artifacts/test.log", kind: "test_log", version: 1 },
        { id: "A-4", path: "artifacts/readme.md", kind: "doc", version: 1 },
      ],
    });

    const { next, error } = roundTrip(legacy);

    expect(error).toBeNull();
    // Normalization must not inject the new optional fields.
    expect(next.goalSource).toBeUndefined();
    expect(next.capabilities).toBeUndefined();
    expect(next.scheduledFollowups).toBeUndefined();
    // Legacy assets pass through untouched (no externalRef synthesized).
    expect(next.assets).toHaveLength(4);
    expect(next.assets.every((a) => a.externalRef === undefined)).toBe(true);
    expect(next.assets.map((a) => a.kind)).toEqual([
      "html_spec",
      "screenshot",
      "test_log",
      "doc",
    ]);
  });
});
