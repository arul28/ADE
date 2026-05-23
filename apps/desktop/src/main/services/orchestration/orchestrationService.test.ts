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
