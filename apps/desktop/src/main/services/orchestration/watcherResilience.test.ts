/* @vitest-environment node */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

import { createOrchestrationService } from "./orchestrationService";

async function makeTempLane(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), "ade-orch-watcher-"));
}

describe("orchestration watcher resilience", () => {
  let lane: string;
  beforeEach(async () => {
    lane = await makeTempLane();
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
    // etag should differ
    expect(m2.etag).not.toBe(e1);
    // serverGeneration should be strictly increasing
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
