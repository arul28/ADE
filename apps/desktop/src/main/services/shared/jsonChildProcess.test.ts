import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { parseOnboardingDiscoveryResponse } from "../onboarding/onboardingDiscoveryWorker";
import {
  runJsonChildProcess,
  terminateJsonChildProcesses,
  type JsonChildProcessSet,
} from "./jsonChildProcess";

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

  it("terminates an outstanding child during shutdown and settles its request", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-json-child-"));
    const workerPath = path.join(tempDir, "worker.cjs");
    fs.writeFileSync(workerPath, "process.stdin.resume(); setInterval(() => {}, 1000);", "utf8");
    const live: JsonChildProcessSet = new Set();
    const result = runJsonChildProcess({ workerPath, request: { operation: "discover" }, live });
    const child = [...live][0];
    expect(child, "the child is tracked before shutdown can be requested").toBeTruthy();
    await once(child!, "spawn");

    expect(terminateJsonChildProcesses(live)).toBe(1);
    const outcome = await result;

    expect(live.size).toBe(0);
    expect(child!.killed).toBe(true);
    expect(outcome.kind).toBe("failed");
  });
});
