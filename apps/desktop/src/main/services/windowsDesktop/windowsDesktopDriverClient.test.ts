import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const binary = vi.hoisted(() => ({ path: "" }));
vi.mock("../native/nativeHelperPaths", () => ({
  resolveWindowsDesktopDriverBinary: () => binary.path,
}));

import { acquireSharedWindowsDesktopDriverClient } from "./windowsDesktopDriverClient";

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function createChild(pid: number) {
  const emitter = new EventEmitter();
  const child = {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kill: vi.fn(() => {
      child.killed = true;
      child.exitCode = 0;
      process.nextTick(() => emitter.emit("close", 0, null));
      return true;
    }),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
  };
  process.nextTick(() => emitter.emit("spawn"));
  return child;
}

describe("the Windows driver shared by every open project", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "win-driver-shared-"));
    tempDirs.push(dir);
    binary.path = path.join(dir, "ade-desktop-driver.exe");
    fs.writeFileSync(binary.path, "");
    const children: Array<ReturnType<typeof createChild>> = [];
    const spawnProcess = vi.fn(() => {
      const next = createChild(700 + children.length);
      children.push(next);
      return next;
    });
    const attach = (liveLaneIds: string[]) => {
      const events: Array<Record<string, unknown>> = [];
      const lost: string[] = [];
      const client = acquireSharedWindowsDesktopDriverClient({
        logger,
        platform: "win32",
        adeHome: path.join(dir, "home"),
        onHealthChanged: () => {},
        onDriverLost: (reason) => lost.push(reason),
        liveLaneIds: () => liveLaneIds,
        spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
      });
      client.onEvent((event) => events.push(event));
      return { client, events, lost };
    };
    return { children, spawnProcess, attach };
  }

  it("starts one host for two projects, and keeps each project's lanes its own", async () => {
    const { children, spawnProcess, attach } = setup();
    const projectA = attach(["lane-a"]);
    const projectB = attach([]);
    await projectA.client.ensureStarted();
    await projectB.client.ensureStarted();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const host = children[0]!;

    // Project A names its lane; project B reconciles on its first start.
    const create = projectA.client.request("display.create", { laneId: "lane-a" });
    await settle();
    const createSent = JSON.parse(host.stdin.read()!.toString());
    host.stdout.write(`${JSON.stringify({ id: createSent.id, ok: true, result: {} })}\n`);
    await create;
    const reconcile = projectB.client.request("display.reconcile", { liveLaneIds: [] });
    await settle();
    const reconcileSent = JSON.parse(host.stdin.read()!.toString());
    // B's cleanup must not destroy the screen A is using.
    expect(reconcileSent.liveLaneIds).toEqual(["lane-a"]);
    host.stdout.write(`${JSON.stringify({ id: reconcileSent.id, ok: true, result: { destroyed: [] } })}\n`);
    await reconcile;

    host.stdout.write(`${JSON.stringify({ event: "windows-changed", laneId: "lane-a", windows: [] })}\n`);
    host.stdout.write(`${JSON.stringify({ event: "windows-state-changed", locked: true })}\n`);
    await settle();
    expect(projectA.events.map((event) => event.event)).toEqual(["windows-changed", "windows-state-changed"]);
    // B gets the PC-wide event, never A's lane.
    expect(projectB.events.map((event) => event.event)).toEqual(["windows-state-changed"]);
  });

  it("keeps the host while any project holds it, and stops it after the last one leaves", async () => {
    const { children, spawnProcess, attach } = setup();
    const projectA = attach([]);
    const projectB = attach([]);
    await projectA.client.ensureStarted();

    projectA.client.dispose();
    await settle();
    expect(projectB.client.isRunning()).toBe(true);
    expect(children[0]!.killed).toBe(false);

    projectB.client.dispose();
    await settle();
    // A project opened after that gets a host of its own, not the stopped one.
    const projectC = attach([]);
    await projectC.client.ensureStarted();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(projectC.client.isRunning()).toBe(true);
    projectC.client.dispose();
  });
});
