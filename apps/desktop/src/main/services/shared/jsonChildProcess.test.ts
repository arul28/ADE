import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOnboardingDiscoveryResponse } from "../onboarding/onboardingDiscoveryWorker";
import { discoverOnboardingProjects, terminateOnboardingDiscoveryWorkers } from "../onboarding/onboardingDiscoveryClient";
import { runJsonChildProcess, type JsonChildProcessSet } from "./jsonChildProcess";

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("runJsonChildProcess", () => {
  it("rejects malformed child output and answer shapes, then releases the child", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-json-child-"));
    const workerPath = path.join(tempDir, "worker.cjs");
    fs.writeFileSync(workerPath, 'process.stdout.write("not-json")', "utf8");
    const live: JsonChildProcessSet = new Set();

    const outcome = await runJsonChildProcess({ workerPath, request: { operation: "discover" }, live });

    expect(outcome.kind).toBe("failed");
    expect(live.size).toBe(0);
    expect(outcome.kind === "failed" && outcome.reason.length).toBeGreaterThan(0);
    expect(parseOnboardingDiscoveryResponse({
      ok: true,
      kind: "discover",
      projects: [{}],
      cache: { otherProviderChats: null, projectChatLists: {} },
      logs: [],
    })).toBeNull();
  });

  it("terminates an outstanding onboarding discovery child during shutdown", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-json-child-"));
    const workerPath = path.join(tempDir, "worker.cjs");
    const markerPath = path.join(tempDir, "started");
    const pidPath = path.join(tempDir, "pid");
    fs.writeFileSync(
      workerPath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started");
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.stdin.resume(); setInterval(() => {}, 1000);`,
      "utf8",
    );
    const previousWorkerPath = process.env.ADE_ONBOARDING_DISCOVERY_WORKER_PATH;
    process.env.ADE_ONBOARDING_DISCOVERY_WORKER_PATH = workerPath;
    const warning = vi.fn();
    // Assigned inside the promise below; the cast keeps TS from narrowing it to null.
    let watcher = null as fs.FSWatcher | null;
    const childStarted = new Promise<void>((resolve, reject) => {
      watcher = fs.watch(tempDir!, () => {
        if (fs.existsSync(markerPath)) {
          watcher?.close();
          resolve();
        }
      });
      watcher.on("error", reject);
    });
    let discovery: Promise<Awaited<ReturnType<typeof discoverOnboardingProjects>>> | null = null;

    try {
      discovery = discoverOnboardingProjects({ knownRoots: [], logger: { warn: warning } });
      await childStarted;

      expect(terminateOnboardingDiscoveryWorkers()).toBe(1);
      const result = await discovery;

      expect(result.projects).toEqual([]);
      expect(warning).toHaveBeenCalledWith("onboarding.discovery_worker_failed", expect.objectContaining({ kind: "discover" }));
    } finally {
      watcher?.close();
      if (previousWorkerPath == null) delete process.env.ADE_ONBOARDING_DISCOVERY_WORKER_PATH;
      else process.env.ADE_ONBOARDING_DISCOVERY_WORKER_PATH = previousWorkerPath;
      if (fs.existsSync(pidPath)) {
        try {
          process.kill(Number(fs.readFileSync(pidPath, "utf8")), "SIGTERM");
        } catch {
          // The shutdown path already ended the worker.
        }
      }
      if (discovery) await discovery;
    }
  });
});
