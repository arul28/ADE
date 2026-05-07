import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMacosVmService } from "./macosVmService";
import type { Logger } from "../logging/logger";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeTempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-macos-vm-test-"));
  const laneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-one");
  fs.mkdirSync(laneRoot, { recursive: true });
  return {
    projectRoot,
    laneRoot,
    lane: {
      id: "lane-1",
      name: "Lane One",
      worktreePath: laneRoot,
    },
  };
}

describe("createMacosVmService", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it("reports platform and provider status without requiring Lume to be installed", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "ls") return { exitCode: 1, signal: null, stdout: "", stderr: "missing" };
      return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const status = await service.getStatus({ laneId: "lane-1" });

    expect(status.supported).toBe(true);
    expect(status.activeProvider.kind).toBe("lume");
    expect(status.activeProvider.available).toBe(false);
    expect(status.laneVm).toBeNull();
  });

  it("uses a sanitized mirror when a lane root contains .ade/secrets", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const primaryLaneRoot = path.join(temp.projectRoot, "primary");
    fs.mkdirSync(path.join(primaryLaneRoot, ".ade", "secrets"), { recursive: true });
    let vmExists = false;
    let vmRunning = false;
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command === "rsync") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0", stderr: "" };
      if (args[0] === "get") {
        if (!vmExists) return { exitCode: 1, signal: null, stdout: "", stderr: "missing" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ name: args[1], state: vmRunning ? "running" : "stopped" }),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
      if (args[0] === "pull") {
        vmExists = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [{ id: "primary", name: "Primary", worktreePath: primaryLaneRoot }],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const policy = await service.getSharePolicy({ laneId: "primary" });
    const started = await service.start({ laneId: "primary", createIfMissing: true });

    expect(policy.allowed).toBe(true);
    expect(policy.syncMode).toBe("sanitized-mirror");
    expect(policy.hostPath).toContain(path.join(".ade", "cache", "macos-vms", "shares", "primary", "worktree"));
    expect(policy.originalHostPath).toBe(primaryLaneRoot);
    expect(started.sharedDirectory).toBe(policy.hostPath);
    expect(started.metadata.shareMode).toBe("sanitized-mirror");
    expect(commands.some(({ command, args }) => command === "rsync" && args.includes("-rlpt"))).toBe(true);
    expect(commands.some(({ command, args }) => command === "rsync" && args.includes("-a"))).toBe(false);
    expect(commands.some(({ command, args }) => command === "rsync" && args.includes("--delete-excluded"))).toBe(true);
    expect(commands.some(({ command, args }) => command === "rsync" && args.includes("--exclude") && args.includes("/.ade/secrets/***"))).toBe(true);
    expect(commands.some(({ command, args }) => command === "rsync" && args.includes("--exclude") && args.includes("/.ade/ade.db*"))).toBe(true);
    expect(commands.some(({ command, args }) => command === "rsync" && args.includes("--exclude") && args.includes("/.ade/cto/openclaw-*.json"))).toBe(true);
    expect(commands.filter(({ command }) => command === "rsync")).toHaveLength(1);
    expect(commands.some(({ command, args }) =>
      path.basename(command) === "lume" && JSON.stringify(args) === JSON.stringify(["run", started.name, "--shared-dir", policy.hostPath]),
    )).toBe(true);
  });

  it("provisions and starts a lane VM through Lume with the lane mounted", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    let vmExists = false;
    let vmRunning = false;
    const commands: string[][] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      commands.push(args);
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        if (!vmExists) return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            name: args[1],
            state: vmRunning ? "running" : "stopped",
            ipAddress: vmRunning ? "192.168.64.2" : null,
            vncUrl: vmRunning ? "vnc://127.0.0.1:5901" : null,
          }),
          stderr: "",
        };
      }
      if (args[0] === "ls") {
        return {
          exitCode: 0,
          signal: null,
        stdout: JSON.stringify(vmExists ? [{ name: "lane-vm", state: vmRunning ? "running" : "stopped" }] : []),
          stderr: "",
        };
      }
      if (args[0] === "pull") {
        vmExists = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const provisioned = await service.provision({ laneId: "lane-1", mode: "pull-image" });
    const started = await service.start({ laneId: "lane-1" });

    expect(provisioned.name).toContain("lane-one");
    expect(started.state).toBe("running");
    expect(started.ipAddress).toBe("192.168.64.2");
    expect(commands).toContainEqual(["pull", "macos-tahoe-vanilla:latest", provisioned.name]);
    expect(commands).toContainEqual(["run", provisioned.name, "--shared-dir", temp.laneRoot]);
  });

  it("starts by creating a missing VM from the default prepared image", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    let vmExists = false;
    let vmRunning = false;
    const commands: string[][] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      commands.push(args);
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        if (!vmExists) return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            name: args[1],
            state: vmRunning ? "running" : "stopped",
          }),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
      if (args[0] === "pull") {
        vmExists = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const started = await service.start({ laneId: "lane-1", createIfMissing: true });

    expect(started.state).toBe("running");
    expect(commands).toContainEqual(["pull", "macos-tahoe-vanilla:latest", started.name]);
    expect(commands).toContainEqual(["run", started.name, "--shared-dir", temp.laneRoot]);
  });

  it("builds agent guidance around the mounted lane", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand: vi.fn(async (_command, args) => {
        if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0", stderr: "" };
        if (args[0] === "get") return { exitCode: 1, signal: null, stdout: "", stderr: "missing" };
        if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }),
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const guide = await service.getAgentGuide({ laneId: "lane-1" });

    expect(guide.vmName).toContain("lane-one");
    expect(guide.target.kind).toBe("macos_vm_target");
    expect(guide.target.windowTitleQuery).toContain("lane-one");
    expect(guide.text).toContain(temp.laneRoot);
    expect(guide.text).toContain("/Volumes/My Shared Files");
    expect(guide.text).toContain("prefer ADE's macos-vm screenshot/click/type tools");
  });

  it("starts headlessly with a managed VNC credential and drives the VM through direct VNC", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    let vmExists = true;
    let vmRunning = false;
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        if (!vmExists) return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            name: args[1],
            state: vmRunning ? "running" : "stopped",
            vncUrl: vmRunning ? "vnc://127.0.0.1:5999" : null,
          }),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: JSON.stringify([{ name: "lane-vm", state: "stopped" }]), stderr: "" };
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const directVncClient = {
      captureScreenshot: vi.fn(async () => ({
        width: 640,
        height: 480,
        pngData: Buffer.from("png"),
      })),
      click: vi.fn(async (_connection: unknown, x: number, y: number) => ({
        width: 640,
        height: 480,
        x,
        y,
      })),
      typeText: vi.fn(async (_connection: unknown, text: string) => ({
        width: 640,
        height: 480,
        typedLength: text.length,
      })),
    };
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      directVncClient,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const started = await service.start({ laneId: "lane-1", openDisplay: false });
    const screenshot = await service.captureScreenshot({ laneId: "lane-1" });
    const selected = await service.selectPoint({ laneId: "lane-1", x: 25, y: 35 });
    const clicked = await service.click({ laneId: "lane-1", x: 25, y: 35 });
    const typed = await service.typeText({ laneId: "lane-1", text: "hello" });

    const run = commands.find(({ args }) => args[0] === "run");
    expect(started.state).toBe("running");
    expect(run?.args).toEqual([
      "run",
      started.name,
      "--shared-dir",
      temp.laneRoot,
      "--no-display",
      "--vnc-password",
      expect.any(String),
    ]);
    expect(String(run?.args.at(-1))).toHaveLength(8);
    expect(screenshot.captureMode).toBe("direct-vnc");
    expect(screenshot.window.processName).toBe("direct-vnc");
    expect(screenshot.window.frame).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(screenshot.dataUrl).toBe("data:image/png;base64,cG5n");
    expect(selected.source).toBe("direct-vnc");
    expect(clicked).toMatchObject({ ok: true, x: 25, y: 35, window: { processName: "direct-vnc" } });
    expect(typed).toMatchObject({ ok: true, window: { processName: "direct-vnc" } });
    expect(directVncClient.captureScreenshot).toHaveBeenCalled();
    expect(directVncClient.click).toHaveBeenCalledWith(
      { host: "127.0.0.1", port: 5999, password: expect.any(String) },
      25,
      35,
      10_000,
    );
    expect(commands.some(({ command }) => command === "osascript" || command === "screencapture")).toBe(false);
  });

  it("focuses, screenshots, selects, clicks, and types into the VM window through macOS utilities", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (path.basename(command) === "lume") {
        if (args[0] === "get") return { exitCode: 1, signal: null, stdout: "", stderr: "missing" };
        if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
        return { exitCode: 0, signal: null, stdout: "lume 1.0", stderr: "" };
      }
      if (command === "osascript") {
        const script = args.join("\n");
        if (script.includes("click at") || script.includes("keystroke")) {
          return { exitCode: 0, signal: null, stdout: "", stderr: "" };
        }
        return {
          exitCode: 0,
          signal: null,
          stdout: "Lume\tade-ade-lane-one-lane-1\t10\t20\t800\t600",
          stderr: "",
        };
      }
      if (command === "screencapture") {
        const outputPath = args.at(-1);
        if (outputPath) fs.writeFileSync(outputPath, Buffer.from("png"));
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const target = await service.focusWindow({ laneId: "lane-1" });
    const screenshot = await service.captureScreenshot({ laneId: "lane-1" });
    const selected = await service.selectPoint({ laneId: "lane-1", x: 30, y: 40 });
    const clicked = await service.click({ laneId: "lane-1", x: 30, y: 40 });
    const typed = await service.typeText({ laneId: "lane-1", text: "hello" });

    expect(target.processName).toBe("Lume");
    expect(screenshot.captureMode).toBe("window-region");
    expect(screenshot.path).toContain(path.join(".ade", "artifacts", "macos-vms", "lane-1"));
    expect(screenshot.dataUrl).toBe("data:image/png;base64,cG5n");
    expect(selected.source).toBe("coordinate-fallback");
    expect(selected.item.kind).toBe("macos_vm_target");
    expect(selected.item.screenshotDataUrl).toBe("data:image/png;base64,cG5n");
    expect(selected.item.metadata.selectedPoint).toEqual({ x: 30, y: 40, coordinateSpace: "window" });
    expect(selected.item.metadata.screenshotPath).toContain(path.join(".ade", "artifacts", "macos-vms", "lane-1"));
    expect(clicked).toMatchObject({ ok: true, x: 40, y: 60 });
    expect(typed.ok).toBe(true);
    expect(commands).toContainEqual({
      command: "screencapture",
      args: ["-x", "-R", "10,20,800,600", screenshot.path],
    });
    expect(commands.some(({ command, args }) => command === "osascript" && args.join("\n").includes("click at {40, 60}"))).toBe(true);
    expect(commands.some(({ command, args }) => command === "osascript" && args.join("\n").includes('keystroke "hello"'))).toBe(true);
  });

  it("falls back to a single visible Screen Sharing VNC window for Lume VMs", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (path.basename(command) === "lume") {
        if (args[0] === "get") {
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              name: args[1],
              state: "running",
              vncUrl: "vnc://127.0.0.1:5900",
            }),
            stderr: "",
          };
        }
        if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
        return { exitCode: 0, signal: null, stdout: "lume 1.0", stderr: "" };
      }
      if (command === "osascript") {
        return {
          exitCode: 0,
          signal: null,
          stdout: "Screen Sharing\tVirtualization\t100\t120\t1024\t768",
          stderr: "",
        };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const target = await service.focusWindow({ laneId: "lane-1" });
    const focusScript = commands.find(({ command }) => command === "osascript")?.args.join("\n") ?? "";

    expect(target.processName).toBe("Screen Sharing");
    expect(target.windowTitle).toBe("Virtualization");
    expect(target.frame).toEqual({ x: 100, y: 120, width: 1024, height: 768 });
    expect(focusScript).toContain("set allowVncFallback to true");
    expect(focusScript).toContain("set restrictToVmViewer to true");
    expect(focusScript).toContain("if (not restrictToVmViewer) or procName is \"Screen Sharing\" or procName is \"Lume\" then");
    expect(focusScript).toContain("if procName is \"Screen Sharing\" or procName is \"Lume\" then");
    expect(focusScript).toContain("        end repeat\n      end if\n    end repeat");
  });
});
