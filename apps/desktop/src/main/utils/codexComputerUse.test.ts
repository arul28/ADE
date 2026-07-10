import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

import {
  codexComputerUseClientCandidates,
  codexComputerUseOptedIn,
  isOpenAiSignedComputerUseClient,
  resolveCodexComputerUseMcpConfig,
} from "./codexComputerUse";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-cu-"));
  tempRoots.push(root);
  return root;
}

function makeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\n", { mode: 0o755 });
}

afterEach(() => {
  mocks.execFile.mockReset();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function mockValidCodesign(): void {
  mocks.execFile.mockImplementation((
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const details = args[0] === "-dv"
      ? "Identifier=com.openai.sky.CUAService.cli\nTeamIdentifier=2DC432GLL2\n"
      : "";
    queueMicrotask(() => callback(null, "", details));
    return {};
  });
}

describe("codexComputerUseOptedIn", () => {
  it("requires the bundled plugin to be explicitly enabled", () => {
    expect(codexComputerUseOptedIn(`
[plugins."computer-use@openai-bundled"]
enabled = true
`)).toBe(true);
    expect(codexComputerUseOptedIn(`
[plugins."computer-use@openai-bundled"]
enabled = false
`)).toBe(false);
    expect(codexComputerUseOptedIn("[plugins.\"browser@openai-bundled\"]\nenabled = true\n")).toBe(false);
  });

  it("accepts an enabled canonical computer_use MCP section", () => {
    expect(codexComputerUseOptedIn(`
[mcp_servers.computer_use]
command = "/signed/client"
args = ["mcp"]
`)).toBe(true);
    expect(codexComputerUseOptedIn(`
[mcp_servers.computer_use]
enabled = false
`)).toBe(false);
  });
});

describe("resolveCodexComputerUseMcpConfig", () => {
  it("returns no config off macOS or without user opt-in", async () => {
    const root = makeTempRoot();
    const stable = codexComputerUseClientCandidates(root)[0]!;
    makeExecutable(stable);
    await expect(resolveCodexComputerUseMcpConfig({
      platform: "linux",
      codexHome: root,
      configText: '[plugins."computer-use@openai-bundled"]\nenabled = true',
      verifySignature: () => true,
    })).resolves.toBeNull();
    await expect(resolveCodexComputerUseMcpConfig({
      platform: "darwin",
      codexHome: root,
      configText: "",
      verifySignature: () => true,
    })).resolves.toBeNull();
  });

  it("prefers the stable signed client path", async () => {
    const root = makeTempRoot();
    const stable = codexComputerUseClientCandidates(root)[0]!;
    makeExecutable(stable);
    await expect(resolveCodexComputerUseMcpConfig({
      platform: "darwin",
      codexHome: root,
      configText: '[plugins."computer-use@openai-bundled"]\nenabled = true',
      verifySignature: () => true,
    })).resolves.toEqual({ command: stable, args: ["mcp"], enabled: true });
  });

  it("falls back to the newest executable cached client", async () => {
    const root = makeTempRoot();
    const cacheRoot = path.join(root, "plugins", "cache", "openai-bundled", "computer-use");
    const relative = path.relative(root, codexComputerUseClientCandidates(root)[0]!)
      .replace(/^computer-use[\\/]/, "");
    const oldClient = path.join(cacheRoot, "1.0.9", relative);
    const newestClient = path.join(cacheRoot, "1.0.10", relative);
    makeExecutable(oldClient);
    makeExecutable(newestClient);
    await expect(resolveCodexComputerUseMcpConfig({
      platform: "darwin",
      codexHome: root,
      configText: '[plugins."computer-use@openai-bundled"]\nenabled = true',
      verifySignature: () => true,
    })).resolves.toMatchObject({ command: newestClient });
  });

  it("rejects executable clients that fail OpenAI signature verification", async () => {
    const root = makeTempRoot();
    makeExecutable(codexComputerUseClientCandidates(root)[0]!);
    await expect(resolveCodexComputerUseMcpConfig({
      platform: "darwin",
      codexHome: root,
      configText: '[plugins."computer-use@openai-bundled"]\nenabled = true',
      verifySignature: () => false,
    })).resolves.toBeNull();
  });

  it("coalesces concurrent cold signature verification for one binary", async () => {
    const root = makeTempRoot();
    const client = codexComputerUseClientCandidates(root)[0]!;
    makeExecutable(client);
    mockValidCodesign();

    const [first, second] = await Promise.all([
      isOpenAiSignedComputerUseClient(client),
      isOpenAiSignedComputerUseClient(client),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it("fails closed when codesign errors or times out", async () => {
    const root = makeTempRoot();
    const client = codexComputerUseClientCandidates(root)[0]!;
    makeExecutable(client);
    mocks.execFile.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const error = Object.assign(new Error("codesign timed out"), {
        code: "ETIMEDOUT",
        killed: true,
      });
      queueMicrotask(() => callback(error, "", ""));
      return {};
    });

    await expect(isOpenAiSignedComputerUseClient(client)).resolves.toBe(false);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it("re-verifies when the binary fingerprint changes", async () => {
    const root = makeTempRoot();
    const client = codexComputerUseClientCandidates(root)[0]!;
    makeExecutable(client);
    mockValidCodesign();

    await expect(isOpenAiSignedComputerUseClient(client)).resolves.toBe(true);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);

    fs.appendFileSync(client, "# upgraded\n");

    await expect(isOpenAiSignedComputerUseClient(client)).resolves.toBe(true);
    expect(mocks.execFile).toHaveBeenCalledTimes(4);
  });
});
