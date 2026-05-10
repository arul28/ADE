import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTuiHeartbeat, type TuiHeartbeat } from "../heartbeat";

const heartbeats: TuiHeartbeat[] = [];

function tempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-heartbeat-"));
}

function heartbeatFile(projectRoot: string): string {
  return path.join(projectRoot, ".ade", "cache", "ade-code", "clients", `${process.pid}.json`);
}

afterEach(() => {
  for (const heartbeat of heartbeats.splice(0)) {
    heartbeat.stop();
  }
});

describe("startTuiHeartbeat", () => {
  it("shares process cleanup handlers across active heartbeats", () => {
    const exitListeners = process.listenerCount("exit");
    const sigintListeners = process.listenerCount("SIGINT");
    const firstRoot = tempProjectRoot();
    const secondRoot = tempProjectRoot();

    const first = startTuiHeartbeat(firstRoot);
    heartbeats.push(first);
    const second = startTuiHeartbeat(secondRoot);
    heartbeats.push(second);

    expect(process.listenerCount("exit")).toBe(exitListeners + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);
    expect(fs.existsSync(heartbeatFile(firstRoot))).toBe(true);
    expect(fs.existsSync(heartbeatFile(secondRoot))).toBe(true);

    first.stop();
    expect(process.listenerCount("exit")).toBe(exitListeners + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);
    expect(fs.existsSync(heartbeatFile(firstRoot))).toBe(false);
    expect(fs.existsSync(heartbeatFile(secondRoot))).toBe(true);

    second.stop();
    expect(process.listenerCount("exit")).toBe(exitListeners);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(fs.existsSync(heartbeatFile(secondRoot))).toBe(false);
  });

  it("makes stop idempotent", () => {
    const exitListeners = process.listenerCount("exit");
    const projectRoot = tempProjectRoot();
    const heartbeat = startTuiHeartbeat(projectRoot);
    heartbeats.push(heartbeat);

    heartbeat.stop();
    heartbeat.stop();

    expect(process.listenerCount("exit")).toBe(exitListeners);
    expect(fs.existsSync(heartbeatFile(projectRoot))).toBe(false);
  });
});
