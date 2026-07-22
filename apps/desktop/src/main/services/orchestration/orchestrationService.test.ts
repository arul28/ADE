/* @vitest-environment node */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

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
  OrchestrationTask,
} from "../../../shared/types/orchestration";

async function makeTempLane(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-orch-"));
  return root;
}

async function rmTree(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

function makeTask(id: string): OrchestrationTask {
  return {
    id,
    phaseId: "developing",
    title: `Task ${id}`,
    description: "",
    status: "pending",
    validationGate: { required: false, stepIds: [] },
  };
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

  it("reserves, completes, replays, and releases idempotency receipts", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const created = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Receipt behavior",
    });

    const reserved = await svc.reserveReceipt(created.runId, created.manifest.bundlePath, {
      requestId: "spawn-request-1",
      kind: "spawnAgent",
    });
    expect(reserved).toEqual({ ok: true, status: "reserved" });

    const pendingDuplicate = await svc.reserveReceipt(
      created.runId,
      created.manifest.bundlePath,
      { requestId: "spawn-request-1", kind: "spawnAgent" },
    );
    expect(pendingDuplicate).toMatchObject({
      ok: true,
      status: "duplicate",
      receipt: { requestId: "spawn-request-1", status: "pending" },
    });

    const completed = await svc.completeReceipt(
      created.runId,
      created.manifest.bundlePath,
      { requestId: "spawn-request-1", result: { sessionId: "S-worker" } },
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok) throw new Error(completed.message);

    const completedDuplicate = await svc.reserveReceipt(
      created.runId,
      created.manifest.bundlePath,
      { requestId: "spawn-request-1", kind: "spawnAgent" },
    );
    expect(completedDuplicate).toMatchObject({
      ok: true,
      status: "duplicate",
      receipt: {
        status: "completed",
        result: { sessionId: "S-worker", etag: completed.etag },
      },
    });

    await svc.reserveReceipt(created.runId, created.manifest.bundlePath, {
      requestId: "retryable-request",
      kind: "messageAgent",
    });
    const released = await svc.releaseReceipt(
      created.runId,
      created.manifest.bundlePath,
      { requestId: "retryable-request" },
    );
    expect(released.ok).toBe(true);
    expect(
      svc
        .getManifestForRun(created.runId)!
        .receipts?.some((receipt) => receipt.requestId === "retryable-request"),
    ).toBe(false);
    const reservedAgain = await svc.reserveReceipt(
      created.runId,
      created.manifest.bundlePath,
      { requestId: "retryable-request", kind: "messageAgent" },
    );
    expect(reservedAgain).toEqual({ ok: true, status: "reserved" });
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

  it("relocates a cached runtime and writes subsequent changes to the moved bundle", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const movedWorktree = path.join(lane, "moved-worktree");
    const { runId, manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Placement move",
    });
    const movedBundlePath = path.join(movedWorktree, ".ade", "orchestration", runId);
    await fsp.mkdir(path.dirname(movedBundlePath), { recursive: true });
    await fsp.cp(manifest.bundlePath, movedBundlePath, { recursive: true });

    expect(svc.getBundlePathForRun(runId)).toBe(manifest.bundlePath);
    await svc.subscribe(runId, manifest.bundlePath);
    await svc.relocateRunBundle(runId, movedBundlePath);
    expect(svc.getBundlePathForRun(runId)).toBe(movedBundlePath);

    const loaded = await svc.bundleRead(runId, movedBundlePath);
    const patched = await svc.manifestPatch(
      {
        runId,
        ifMatchEtag: loaded.manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{ op: "replace", path: "/title", value: "Moved write" }],
      },
      movedBundlePath,
    );
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.manifest.bundlePath).toBe(movedBundlePath);

    const movedManifest = JSON.parse(
      await fsp.readFile(path.join(movedBundlePath, "manifest.json"), "utf-8"),
    ) as { title: string; bundlePath: string };
    const originalManifest = JSON.parse(
      await fsp.readFile(path.join(manifest.bundlePath, "manifest.json"), "utf-8"),
    ) as { title: string };
    expect(movedManifest.title).toBe("Moved write");
    expect(movedManifest.bundlePath).toBe(movedBundlePath);
    expect(originalManifest.title).toBe("Placement move");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const externallyUpdated = {
      ...movedManifest,
      title: "External moved update",
      serverGeneration: patched.manifest.serverGeneration + 1,
      etag: `g${patched.manifest.serverGeneration + 1}-external`,
    };
    await fsp.writeFile(
      path.join(movedBundlePath, "manifest.json"),
      JSON.stringify(externallyUpdated, null, 2),
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (svc.getManifestForRun(runId)?.title === "External moved update") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(svc.getManifestForRun(runId)?.title).toBe("External moved update");
    await svc.release(runId);
    await svc.dispose();
  });

  it("does not create a runtime when relocating an unsubscribed run", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    await svc.relocateRunBundle("R-not-loaded", path.join(lane, "moved", ".ade", "orchestration", "R-not-loaded"));
    expect(svc.getBundlePathForRun("R-not-loaded")).toBeNull();
    await svc.dispose();
  });

  it("relocates a cached runtime even when no subscriber is attached", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { runId, manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Cached placement move",
    });
    const movedBundlePath = path.join(lane, "moved-cached", ".ade", "orchestration", runId);
    await fsp.mkdir(path.dirname(movedBundlePath), { recursive: true });
    await fsp.cp(manifest.bundlePath, movedBundlePath, { recursive: true });

    await svc.relocateRunBundle(runId, movedBundlePath);

    expect(svc.getBundlePathForRun(runId)).toBe(movedBundlePath);
    await svc.dispose();
  });

  it("does not move a relocated runtime back when a stale caller passes the old bundle path", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { runId, manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Stale path move",
    });
    const movedBundlePath = path.join(lane, "moved-stale-caller", ".ade", "orchestration", runId);
    await fsp.mkdir(path.dirname(movedBundlePath), { recursive: true });
    await fsp.cp(manifest.bundlePath, movedBundlePath, { recursive: true });
    await svc.relocateRunBundle(runId, movedBundlePath);

    const loaded = await svc.bundleRead(runId, movedBundlePath);
    const patched = await svc.manifestPatch(
      {
        runId,
        ifMatchEtag: loaded.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{ op: "replace", path: "/title", value: "Moved write from stale caller" }],
      },
      manifest.bundlePath,
    );

    expect(patched.ok).toBe(true);
    expect(svc.getBundlePathForRun(runId)).toBe(movedBundlePath);
    const movedManifest = JSON.parse(
      await fsp.readFile(path.join(movedBundlePath, "manifest.json"), "utf-8"),
    ) as { title: string };
    const originalManifest = JSON.parse(
      await fsp.readFile(path.join(manifest.bundlePath, "manifest.json"), "utf-8"),
    ) as { title: string };
    expect(movedManifest.title).toBe("Moved write from stale caller");
    expect(originalManifest.title).toBe("Stale path move");
    await svc.dispose();
  });

  it("keeps manifest and generation writes on the same bundle during concurrent relocation", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { runId, manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Concurrent placement move",
    });
    await svc.subscribe(runId, manifest.bundlePath);
    const manifestPath = path.join(manifest.bundlePath, "manifest.json");
    const movedBundlePath = path.join(lane, "moved-worktree-late", ".ade", "orchestration", runId);
    const originalRename = fsp.rename.bind(fsp);
    let relocatePromise: Promise<void> | null = null;
    const renameSpy = vi.spyOn(fsp, "rename").mockImplementation((async (from: any, to: any) => {
      await originalRename(from, to);
      if (!relocatePromise && path.resolve(String(to)) === path.resolve(manifestPath)) {
        relocatePromise = svc.relocateRunBundle(runId, movedBundlePath);
      }
    }) as any);
    try {
      const patched = await svc.manifestPatch(
        {
          runId,
          ifMatchEtag: manifest.etag,
          actorRole: "lead",
          actorSessionId: "S-lead",
          patches: [{ op: "replace", path: "/title", value: "Concurrent write" }],
        },
        manifest.bundlePath,
      );
      expect(patched.ok).toBe(true);
      if (!patched.ok) return;
      const originalGen = await fsp.readFile(path.join(manifest.bundlePath, ".gen"), "utf-8");
      expect(Number.parseInt(originalGen.trim(), 10)).toBe(patched.manifest.serverGeneration);
    } finally {
      renameSpy.mockRestore();
    }
    if (relocatePromise) {
      await relocatePromise;
    }
    await svc.release(runId);
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
    if (!withWorker.ok) return;
    const manifestPath = path.join(manifest.bundlePath, "manifest.json");
    const genPath = path.join(manifest.bundlePath, ".gen");
    const manifestBefore = await fsp.readFile(manifestPath, "utf-8");
    const genBefore = await fsp.readFile(genPath, "utf-8");

    const heartbeat = await svc.agentHeartbeat(
      { runId: manifest.runId, sessionId: "S-worker" },
      manifest.bundlePath,
    );
    expect(heartbeat.ok).toBe(true);
    expect(heartbeat.etag).toBe(withWorker.etag);
    const current = svc.getManifestForRun(manifest.runId)!;
    expect(current.agents.find((agent) => agent.sessionId === "S-worker")?.lastHeartbeatAt).toBeTruthy();
    expect(await fsp.readFile(manifestPath, "utf-8")).toBe(manifestBefore);
    expect(await fsp.readFile(genPath, "utf-8")).toBe(genBefore);
    const heartbeats = JSON.parse(await fsp.readFile(path.join(manifest.bundlePath, "heartbeats.json"), "utf-8"));
    expect(heartbeats["S-worker"]).toBeTruthy();
    await svc.dispose();
  });

  it("rejects duplicate agent session ids in service-internal direct patches", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    await expect(
      svc.approvePlan(
        manifest.runId,
        manifest.bundlePath,
        [{
          op: "add",
          path: "/agents/-",
          value: {
            sessionId: "S-lead",
            role: "worker",
            tag: "dupe",
            goalSummary: "duplicate",
            status: "running",
            spawnedAt: "now",
          },
        }],
        "duplicate-agent-test",
      ),
    ).rejects.toThrow(/duplicate sessionId/);
    await svc.dispose();
  });

  it("rejects service-internal direct patches that remove all agents", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    await expect(
      svc.approvePlan(
        manifest.runId,
        manifest.bundlePath,
        [{ op: "replace", path: "/agents", value: [] }],
        "empty-agents-test",
      ),
    ).rejects.toThrow(/at least one agent/);
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

  it("rejects duplicate task ids appended in one manifest patch", async () => {
    const svc = createOrchestrationService({
      resolveLaneWorktree: () => lane,
    });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });

    const result = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          { op: "add", path: "/tasks/-", value: makeTask("T-1") },
          { op: "add", path: "/tasks/-", value: makeTask("T-1") },
        ],
      },
      manifest.bundlePath,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("validation_failed");
    if (!("message" in result)) throw new Error("expected validation failure message");
    expect(result.message).toMatch(/duplicate id T-1/);

    const onDisk = JSON.parse(
      await fsp.readFile(path.join(manifest.bundlePath, "manifest.json"), "utf-8"),
    ) as { tasks: unknown[] };
    expect(onDisk.tasks).toHaveLength(0);
    await svc.dispose();
  });

  it("rejects re-adding an existing task id through manifestPatch", async () => {
    const svc = createOrchestrationService({
      resolveLaneWorktree: () => lane,
    });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });

    const first = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{ op: "add", path: "/tasks/-", value: makeTask("T-1") }],
      },
      manifest.bundlePath,
    );

    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const duplicate = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: first.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{ op: "add", path: "/tasks/-", value: makeTask("T-1") }],
      },
      manifest.bundlePath,
    );

    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.error).toBe("validation_failed");
    if (!("message" in duplicate)) throw new Error("expected validation failure message");
    expect(duplicate.message).toMatch(/duplicate id T-1/);

    const onDisk = JSON.parse(
      await fsp.readFile(path.join(manifest.bundlePath, "manifest.json"), "utf-8"),
    ) as { tasks: unknown[] };
    expect(onDisk.tasks).toHaveLength(1);
    await svc.dispose();
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
  modelId: "claude-sonnet-5",
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
    expect(res.selection.modelId).toBe("claude-sonnet-5");
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
              currentStepId: "T-val",
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
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-val",
              phaseId: "validating",
              title: "validate",
              description: "",
              status: "claimed",
              validationGate: { required: true, stepIds: ["V-1"] },
              assigneeSessionId: "S-validator",
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

  it("denies a validator that self-wrote currentStepId to forge an unassigned gate", async () => {
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
              goalSummary: "validate",
              status: "running",
              spawnedAt: "now",
              // Attacker-writable field pointed straight at the target step id.
              currentStepId: "V-final",
            },
          },
          {
            op: "add",
            path: "/validationStrategy/steps/-",
            value: {
              id: "V-final",
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
              validationGate: { required: true, stepIds: ["V-final"] },
              assigneeSessionId: "S-worker",
            },
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;

    const forged = await svc.recordValidationRun(
      {
        runId: manifest.runId,
        taskId: "T-1",
        stepId: "V-final",
        sessionId: "S-validator",
        status: "passed",
        notes: "forged pass via self-written currentStepId",
      },
      manifest.bundlePath,
    );
    expect(forged.ok).toBe(false);
    if (!forged.ok) {
      expect(forged.error).toBe("policy_denied");
    }
    await svc.dispose();
  });

  it("lets a validator that claimed the validating task record its gate as passed", async () => {
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
              goalSummary: "validate",
              status: "running",
              spawnedAt: "now",
            },
          },
          {
            op: "add",
            path: "/validationStrategy/steps/-",
            value: {
              id: "V-final",
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
              phaseId: "validating",
              title: "x",
              description: "",
              status: "claimed",
              validationGate: { required: true, stepIds: ["V-final"] },
              assigneeSessionId: "S-validator",
            },
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;

    const recorded = await svc.recordValidationRun(
      {
        runId: manifest.runId,
        taskId: "T-1",
        stepId: "V-final",
        sessionId: "S-validator",
        status: "passed",
        notes: "validator proof appended to plan.md",
      },
      manifest.bundlePath,
    );
    expect(recorded.ok).toBe(true);
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

  it.each(["done", "failed"] as const)(
    "rejects claims against %s tasks",
    async (terminalStatus) => {
      const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
      const { manifest } = await svc.runCreate({
        laneId: "L-1",
        leadSessionId: "S-lead",
        bundleRoot: lane,
      });
      const seeded = await svc.manifestPatch(
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
              path: "/agents/-",
              value: {
                sessionId: "S-other-worker",
                role: "worker",
                tag: "other",
                goalSummary: "try to claim terminal work",
                status: "running",
                spawnedAt: "now",
              },
            },
            {
              op: "add",
              path: "/tasks/-",
              value: {
                id: "T-terminal",
                phaseId: "developing",
                title: "terminal task",
                description: "",
                status: "claimed",
                validationGate: { required: false, stepIds: [] },
                assigneeSessionId: "S-worker",
                claimLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
              },
            },
          ],
        },
        manifest.bundlePath,
      );
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) {
        throw new Error("failed to seed terminal task claim test");
      }

      const released = await svc.releaseTask(
        {
          runId: manifest.runId,
          taskId: "T-terminal",
          sessionId: "S-worker",
          status: terminalStatus,
        },
        manifest.bundlePath,
      );
      const releasedTask = released.manifest.tasks.find(
        (task) => task.id === "T-terminal",
      );
      expect(releasedTask?.status).toBe(terminalStatus);
      expect(releasedTask?.claimLeaseUntil).toBeNull();

      const claimed = await svc.claimTask(
        {
          runId: manifest.runId,
          taskId: "T-terminal",
          sessionId: "S-worker",
          leaseMs: 30 * 60 * 1000,
        },
        manifest.bundlePath,
      );
      expect(claimed.ok).toBe(false);
      if (claimed.ok) {
        throw new Error("terminal task claim unexpectedly succeeded");
      }
      expect(claimed.reason).toContain(`terminal (${terminalStatus})`);
      const taskAfterClaim = claimed.manifest.tasks.find(
        (task) => task.id === "T-terminal",
      );
      expect(taskAfterClaim?.status).toBe(terminalStatus);
      expect(taskAfterClaim?.claimLeaseUntil).toBeNull();

      const otherClaim = await svc.claimTask(
        {
          runId: manifest.runId,
          taskId: "T-terminal",
          sessionId: "S-other-worker",
          leaseMs: 30 * 60 * 1000,
        },
        manifest.bundlePath,
      );
      expect(otherClaim.ok).toBe(false);
      if (otherClaim.ok) {
        throw new Error("terminal task claim by other worker unexpectedly succeeded");
      }
      expect(otherClaim.reason).toContain(`terminal (${terminalStatus})`);
      const taskAfterOtherClaim = otherClaim.manifest.tasks.find(
        (task) => task.id === "T-terminal",
      );
      expect(taskAfterOtherClaim?.status).toBe(terminalStatus);
      expect(taskAfterOtherClaim?.claimLeaseUntil).toBeNull();
      await svc.dispose();
    },
  );

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

  it("blocks manifest writes after an external manifest runId swap", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest, etag } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Original run",
    });
    const manifestPath = path.join(manifest.bundlePath, "manifest.json");
    const foreign = {
      ...JSON.parse(await fsp.readFile(manifestPath, "utf-8")),
      runId: "R-foreign-checkout",
      etag: "etag-foreign",
      title: "Foreign branch manifest",
    };
    await fsp.writeFile(manifestPath, JSON.stringify(foreign, null, 2));

    const patch = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{ op: "replace", path: "/title", value: "Stale write attempt" }],
      },
      manifest.bundlePath,
    );
    expect(patch.ok).toBe(false);
    if (patch.ok) return;
    expect(patch.error).toBe("validation_failed");
    if (patch.error !== "validation_failed") return;
    expect(patch.message).toContain("suspended");

    const heartbeat = await svc.agentHeartbeat(
      { runId: manifest.runId, sessionId: "S-lead" },
      manifest.bundlePath,
    );
    expect(heartbeat.ok).toBe(false);
    if (!heartbeat.ok) {
      expect(heartbeat.reason).toContain("suspended");
    }

    const onDisk = JSON.parse(await fsp.readFile(manifestPath, "utf-8"));
    expect(onDisk.runId).toBe("R-foreign-checkout");
    expect(onDisk.title).toBe("Foreign branch manifest");
    await svc.dispose();
  });

  it("cleans failed temp writes and emits suspension after an in-flight runId swap", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest, etag } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Original run",
    });
    const events: any[] = [];
    const off = svc.on("event", (payload) => events.push(payload));
    await svc.subscribe(manifest.runId, manifest.bundlePath);
    const manifestPath = path.join(manifest.bundlePath, "manifest.json");
    const originalReadFile = fsp.readFile.bind(fsp);
    const foreign = {
      ...JSON.parse(await originalReadFile(manifestPath, "utf-8")),
      runId: "R-foreign-mid-commit",
      etag: "etag-foreign-mid-commit",
      title: "Foreign branch manifest",
    };
    let manifestReadCount = 0;
    let injectedForeignManifest = false;
    const readSpy = vi.spyOn(fsp, "readFile").mockImplementation((async (file: any, options?: any) => {
      if (
        !injectedForeignManifest
        && path.resolve(String(file)) === path.resolve(manifestPath)
        && options === "utf-8"
      ) {
        manifestReadCount++;
        if (manifestReadCount === 2) {
          injectedForeignManifest = true;
          await fsp.writeFile(manifestPath, JSON.stringify(foreign, null, 2));
        }
      }
      return originalReadFile(file, options);
    }) as any);
    try {
      const patch = await svc.manifestPatch(
        {
          runId: manifest.runId,
          ifMatchEtag: etag,
          actorRole: "lead",
          actorSessionId: "S-lead",
          patches: [{ op: "replace", path: "/title", value: "Stale write attempt" }],
        },
        manifest.bundlePath,
      );
      expect(patch.ok).toBe(false);
      if (patch.ok) return;
      expect(patch.error).toBe("validation_failed");
    } finally {
      readSpy.mockRestore();
    }

    await vi.waitFor(() => {
      expect(events.some((event) =>
        event.runId === manifest.runId
        && event.kind === "lifecycle"
        && event.status === "suspended",
      )).toBe(true);
    });
    const files = await fsp.readdir(manifest.bundlePath);
    expect(files.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    off();
    await svc.dispose();
  });

  it("returns etag_conflict instead of overwriting a newer on-disk manifest", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Initial",
    });
    const manifestPath = path.join(manifest.bundlePath, "manifest.json");
    const external = {
      ...JSON.parse(await fsp.readFile(manifestPath, "utf-8")),
      title: "external-title",
      serverGeneration: manifest.serverGeneration + 1,
      etag: `g${manifest.serverGeneration + 1}-external`,
    };
    await fsp.writeFile(manifestPath, JSON.stringify(external, null, 2));

    const patchRes = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [{ op: "replace", path: "/title", value: "patched-title" }],
      },
      manifest.bundlePath,
    );

    expect(patchRes.ok).toBe(false);
    if (patchRes.ok) return;
    expect(patchRes.error).toBe("etag_conflict");

    const onDisk = JSON.parse(await fsp.readFile(manifestPath, "utf-8")) as {
      title: string;
      serverGeneration: number;
    };
    expect(onDisk.title).toBe("external-title");
    expect(onDisk.serverGeneration).toBe(manifest.serverGeneration + 1);
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

  it("reloads manifest and plan when both external files change inside the debounce window", async () => {
    const creator = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await creator.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
      title: "Initial",
    });
    await creator.dispose();

    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const events: Array<{
      kind?: string;
      manifest?: { title?: string };
      planMd?: string;
    }> = [];
    const off = svc.on("event", (payload) => events.push(payload));
    try {
      await svc.subscribe(manifest.runId, manifest.bundlePath);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const manifestPath = path.join(manifest.bundlePath, "manifest.json");
      const planPath = path.join(manifest.bundlePath, "plan.md");
      const currentManifest = JSON.parse(
        await fsp.readFile(manifestPath, "utf-8"),
      ) as typeof manifest;
      const externalManifest = {
        ...currentManifest,
        title: "Externally updated manifest",
        serverGeneration: currentManifest.serverGeneration + 1,
        etag: `g${currentManifest.serverGeneration + 1}-external`,
      };
      const externalPlan = "# Externally updated plan\n\nBoth files changed in one batch.\n";

      await Promise.all([
        fsp.writeFile(manifestPath, JSON.stringify(externalManifest, null, 2)),
        fsp.writeFile(planPath, externalPlan),
      ]);

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.kind === "manifest"
          && event.manifest?.title === externalManifest.title,
        )).toBe(true);
        expect(events.some((event) =>
          event.kind === "plan" && event.planMd === externalPlan,
        )).toBe(true);
      }, { timeout: 2_000 });

      const bundle = await svc.bundleRead(manifest.runId, manifest.bundlePath);
      expect(bundle.manifest.title).toBe(externalManifest.title);
      expect(bundle.planMd).toBe(externalPlan);
    } finally {
      off();
      await svc.dispose();
    }
  });

  describe("delegation lineage", () => {
    const BRIEF =
      "## TASK\ndo it\n## FILES\nx\n## DEPENDENCIES\nnone\n## GATES\nnone\n## PEERS\nnone\n## SUCCESS\ndone";

    function makeRun(svc: ReturnType<typeof createOrchestrationService>) {
      return svc.runCreate({ laneId: "L-1", leadSessionId: "S-lead", bundleRoot: lane });
    }

    async function seedChild(
      svc: ReturnType<typeof createOrchestrationService>,
      manifest: { runId: string; etag: string; bundlePath: string },
      opts: { sessionId: string; role?: "worker" | "validator"; status?: string; taskId?: string },
    ) {
      const res = await svc.manifestPatch(
        {
          runId: manifest.runId,
          ifMatchEtag: manifest.etag,
          actorRole: "lead" as const,
          actorSessionId: "S-lead",
          patches: [
            {
              op: "add" as const,
              path: "/agents/-",
              value: {
                sessionId: opts.sessionId,
                role: opts.role ?? "worker",
                tag: "impl",
                goalSummary: "g",
                status: opts.status ?? "running",
                spawnedAt: "now",
              },
            },
            ...(opts.taskId
              ? [
                  {
                    op: "add" as const,
                    path: "/tasks/-",
                    value: {
                      id: opts.taskId,
                      phaseId: "developing",
                      title: "t",
                      description: "",
                      status: "claimed",
                      validationGate: { required: false, stepIds: [] },
                      assigneeSessionId: opts.sessionId,
                      claimLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
                    },
                  },
                ]
              : []),
          ],
        },
        manifest.bundlePath,
      );
      if (!res.ok) throw new Error("failed to seed child agent");
    }

    it("records a running delegation edge at spawn with a brief digest + fingerprint", async () => {
      const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
      const { manifest } = await makeRun(svc);
      await seedChild(svc, manifest, { sessionId: "S-worker" });
      const res = await svc.recordDelegationSpawn(
        {
          runId: manifest.runId,
          parentSessionId: "S-lead",
          childSessionId: "S-worker",
          childRole: "worker",
          childTag: "impl",
          stepId: "T-1",
          briefText: BRIEF,
          spawnFingerprint: {
            provider: "claude",
            modelId: "claude-sonnet-5",
            reasoningEffort: null,
            resolvedAt: "now",
            routingKey: "default",
          },
        },
        manifest.bundlePath,
      );
      expect(res.ok).toBe(true);
      const bundle = await svc.bundleRead(manifest.runId, manifest.bundlePath);
      const lineage = bundle.manifest.lineage ?? [];
      expect(lineage).toHaveLength(1);
      const edge = lineage[0]!;
      expect(edge.status).toBe("running");
      expect(edge.parentSessionId).toBe("S-lead");
      expect(edge.childSessionId).toBe("S-worker");
      expect(edge.childRole).toBe("worker");
      expect(edge.briefDigest).toBe(crypto.createHash("sha256").update(BRIEF).digest("hex"));
      expect(edge.spawnFingerprint?.provider).toBe("claude");
      expect(edge.resultSummary).toBeUndefined();
      await svc.dispose();
    });

    it("recordDelegationSpawn is idempotent per child session", async () => {
      const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
      const { manifest } = await makeRun(svc);
      await seedChild(svc, manifest, { sessionId: "S-worker" });
      const first = await svc.recordDelegationSpawn(
        { runId: manifest.runId, parentSessionId: "S-lead", childSessionId: "S-worker", childRole: "worker", briefText: BRIEF },
        manifest.bundlePath,
      );
      const second = await svc.recordDelegationSpawn(
        { runId: manifest.runId, parentSessionId: "S-lead", childSessionId: "S-worker", childRole: "worker", briefText: BRIEF },
        manifest.bundlePath,
      );
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) expect(second.edgeId).toBe(first.edgeId);
      const bundle = await svc.bundleRead(manifest.runId, manifest.bundlePath);
      expect(bundle.manifest.lineage ?? []).toHaveLength(1);
      await svc.dispose();
    });

    it("rejects a spawn edge with an unregistered parent/child or a role mismatch (no orphan edges)", async () => {
      const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
      const { manifest } = await makeRun(svc);
      const noChild = await svc.recordDelegationSpawn(
        { runId: manifest.runId, parentSessionId: "S-lead", childSessionId: "S-ghost", childRole: "worker", briefText: BRIEF },
        manifest.bundlePath,
      );
      expect(noChild.ok).toBe(false);
      await seedChild(svc, manifest, { sessionId: "S-worker" });
      const noParent = await svc.recordDelegationSpawn(
        { runId: manifest.runId, parentSessionId: "S-nobody", childSessionId: "S-worker", childRole: "worker", briefText: BRIEF },
        manifest.bundlePath,
      );
      expect(noParent.ok).toBe(false);
      const roleMismatch = await svc.recordDelegationSpawn(
        { runId: manifest.runId, parentSessionId: "S-lead", childSessionId: "S-worker", childRole: "validator", briefText: BRIEF },
        manifest.bundlePath,
      );
      expect(roleMismatch.ok).toBe(false);
      const bundle = await svc.bundleRead(manifest.runId, manifest.bundlePath);
      expect(bundle.manifest.lineage ?? []).toHaveLength(0);
      await svc.dispose();
    });

    it("closes the edge to completed when the worker releases its task done", async () => {
      const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
      const { manifest } = await makeRun(svc);
      await seedChild(svc, manifest, { sessionId: "S-worker", taskId: "T-1" });
      await svc.recordDelegationSpawn(
        { runId: manifest.runId, parentSessionId: "S-lead", childSessionId: "S-worker", childRole: "worker", briefText: BRIEF },
        manifest.bundlePath,
      );
      const released = await svc.releaseTask(
        { runId: manifest.runId, taskId: "T-1", sessionId: "S-worker", status: "done" },
        manifest.bundlePath,
      );
      const edge = (released.manifest.lineage ?? []).find((e) => e.childSessionId === "S-worker")!;
      expect(edge.status).toBe("completed");
      expect(edge.resultSummary).toBe("done: T-1");
      expect(edge.completedAt).toBeTruthy();
      expect(edge.taskIds).toContain("T-1");
      await svc.dispose();
    });

    it("closes the edge to failed when the worker releases its task failed", async () => {
      const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
      const { manifest } = await makeRun(svc);
      await seedChild(svc, manifest, { sessionId: "S-worker", taskId: "T-1" });
      await svc.recordDelegationSpawn(
        { runId: manifest.runId, parentSessionId: "S-lead", childSessionId: "S-worker", childRole: "worker", briefText: BRIEF },
        manifest.bundlePath,
      );
      const released = await svc.releaseTask(
        { runId: manifest.runId, taskId: "T-1", sessionId: "S-worker", status: "failed" },
        manifest.bundlePath,
      );
      const edge = (released.manifest.lineage ?? []).find((e) => e.childSessionId === "S-worker")!;
      expect(edge.status).toBe("failed");
      expect(edge.resultSummary).toContain("failed: T-1");
      await svc.dispose();
    });

    it("reconciles a running edge whose child agent has gone terminal (validator self-completed)", async () => {
      const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
      const { manifest } = await makeRun(svc);
      // Validator self-marks completed (an allowed self-status patch); no task release fires.
      await seedChild(svc, manifest, { sessionId: "S-val", role: "validator", status: "completed" });
      await svc.recordDelegationSpawn(
        { runId: manifest.runId, parentSessionId: "S-lead", childSessionId: "S-val", childRole: "validator", briefText: BRIEF },
        manifest.bundlePath,
      );
      const before = await svc.bundleRead(manifest.runId, manifest.bundlePath);
      expect((before.manifest.lineage ?? []).find((e) => e.childSessionId === "S-val")!.status).toBe("running");
      const recovered = await svc.releaseStaleClaims(manifest.runId, manifest.bundlePath);
      expect(recovered.ok).toBe(true);
      const after = await svc.bundleRead(manifest.runId, manifest.bundlePath);
      const edge = (after.manifest.lineage ?? []).find((e) => e.childSessionId === "S-val")!;
      expect(edge.status).toBe("completed");
      expect(edge.completedAt).toBeTruthy();
      await svc.dispose();
    });

    it("reconcile snapshots taskIds against the post-reset state (excludes a recovered stale task)", async () => {
      const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
      const { manifest } = await makeRun(svc);
      // A failed worker still holding a stale (expired-lease) claimed task.
      const seeded = await svc.manifestPatch(
        {
          runId: manifest.runId,
          ifMatchEtag: manifest.etag,
          actorRole: "lead" as const,
          actorSessionId: "S-lead",
          patches: [
            {
              op: "add" as const,
              path: "/agents/-",
              value: { sessionId: "S-worker", role: "worker", tag: "impl", goalSummary: "g", status: "failed", spawnedAt: "now" },
            },
            {
              op: "add" as const,
              path: "/tasks/-",
              value: {
                id: "T-stale",
                phaseId: "developing",
                title: "t",
                description: "",
                status: "claimed",
                validationGate: { required: false, stepIds: [] },
                assigneeSessionId: "S-worker",
                claimLeaseUntil: new Date(Date.now() - 60_000).toISOString(),
              },
            },
          ],
        },
        manifest.bundlePath,
      );
      expect(seeded.ok).toBe(true);
      await svc.recordDelegationSpawn(
        { runId: manifest.runId, parentSessionId: "S-lead", childSessionId: "S-worker", childRole: "worker", briefText: BRIEF },
        manifest.bundlePath,
      );
      const recovered = await svc.releaseStaleClaims(manifest.runId, manifest.bundlePath);
      expect(recovered.ok).toBe(true);
      const after = await svc.bundleRead(manifest.runId, manifest.bundlePath);
      const edge = (after.manifest.lineage ?? []).find((e) => e.childSessionId === "S-worker")!;
      expect(edge.status).toBe("failed");
      // T-stale was un-assigned in the same transaction → not snapshotted onto the edge.
      expect(edge.taskIds ?? []).not.toContain("T-stale");
      await svc.dispose();
    });

    it("keeps the edge at its first terminal outcome when the worker takes a second task (v1 per-session-lifetime semantic)", async () => {
      const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
      const { manifest } = await makeRun(svc);
      const seeded = await svc.manifestPatch(
        {
          runId: manifest.runId,
          ifMatchEtag: manifest.etag,
          actorRole: "lead" as const,
          actorSessionId: "S-lead",
          patches: [
            {
              op: "add" as const,
              path: "/agents/-",
              value: { sessionId: "S-worker", role: "worker", tag: "impl", goalSummary: "g", status: "running", spawnedAt: "now" },
            },
            {
              op: "add" as const,
              path: "/tasks/-",
              value: {
                id: "T-1",
                phaseId: "developing",
                title: "t1",
                description: "",
                status: "claimed",
                validationGate: { required: false, stepIds: [] },
                assigneeSessionId: "S-worker",
                claimLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
              },
            },
            {
              op: "add" as const,
              path: "/tasks/-",
              value: {
                id: "T-2",
                phaseId: "developing",
                title: "t2",
                description: "",
                status: "pending",
                validationGate: { required: false, stepIds: [] },
              },
            },
          ],
        },
        manifest.bundlePath,
      );
      expect(seeded.ok).toBe(true);
      await svc.recordDelegationSpawn(
        { runId: manifest.runId, parentSessionId: "S-lead", childSessionId: "S-worker", childRole: "worker", briefText: BRIEF },
        manifest.bundlePath,
      );
      await svc.releaseTask(
        { runId: manifest.runId, taskId: "T-1", sessionId: "S-worker", status: "done" },
        manifest.bundlePath,
      );
      // The worker picks up a second task after completing the first.
      const claimed = await svc.claimTask(
        { runId: manifest.runId, taskId: "T-2", sessionId: "S-worker", leaseMs: 60_000 },
        manifest.bundlePath,
      );
      expect(claimed.ok).toBe(true);
      const released2 = await svc.releaseTask(
        { runId: manifest.runId, taskId: "T-2", sessionId: "S-worker", status: "done" },
        manifest.bundlePath,
      );
      const edges = (released2.manifest.lineage ?? []).filter((e) => e.childSessionId === "S-worker");
      // Exactly one edge per child session; it stays at the first terminal outcome.
      expect(edges).toHaveLength(1);
      expect(edges[0]!.status).toBe("completed");
      expect(edges[0]!.resultSummary).toBe("done: T-1");
      await svc.dispose();
    });

    it("defaults lineage to [] for a legacy manifest persisted without it", async () => {
      const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
      const { manifest } = await makeRun(svc);
      const manifestPath = path.join(manifest.bundlePath, "manifest.json");
      const onDisk = JSON.parse(await fsp.readFile(manifestPath, "utf-8"));
      delete onDisk.lineage;
      await fsp.writeFile(manifestPath, JSON.stringify(onDisk, null, 2));
      await svc.dispose();
      const restarted = createOrchestrationService({ resolveLaneWorktree: () => lane });
      const bundle = await restarted.bundleRead(manifest.runId, manifest.bundlePath);
      expect(Array.isArray(bundle.manifest.lineage)).toBe(true);
      expect(bundle.manifest.lineage ?? []).toHaveLength(0);
      await restarted.dispose();
    });
  });
});
