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
