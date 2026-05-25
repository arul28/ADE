/* @vitest-environment node */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

import { createOrchestrationService } from "./orchestrationService";

async function makeTempLane(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), "ade-orch-vc-"));
}

describe("validation concerns gating", () => {
  let lane: string;
  beforeEach(async () => {
    lane = await makeTempLane();
  });
  afterEach(async () => {
    await fsp.rm(lane, { recursive: true, force: true });
  });

  it("rejects worker patch when required gates not passed; accepts when validator flips passed", async () => {
    const svc = createOrchestrationService({ resolveLaneWorktree: () => lane });
    const { manifest } = await svc.runCreate({
      laneId: "L-1",
      leadSessionId: "S-lead",
      bundleRoot: lane,
    });
    // Lead sets up a task + checklist run (running)
    const m1 = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
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
                  startedAt: "now",
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

    // Worker tries to flip task to done — should be rejected
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

    // Validator flips checklist run to passed via new run entry
    const m2 = await svc.manifestPatch(
      {
        runId: manifest.runId,
        ifMatchEtag: m1.etag,
        actorRole: "validator",
        actorSessionId: "S-validator",
        patches: [
          {
            op: "add",
            path: "/validationStrategy/checklist/{id:C-1}/runs/-",
            value: {
              id: "R-2",
              runBySessionId: "S-validator",
              status: "passed",
              startedAt: "now",
              endedAt: "now",
              supersedes: "R-1",
            },
          },
          {
            op: "replace",
            path: "/validationStrategy/checklist/{id:C-1}/latestRunId",
            value: "R-2",
          },
        ],
      },
      manifest.bundlePath,
    );
    expect(m2.ok).toBe(true);
    if (!m2.ok) return;

    // Now worker should succeed
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
