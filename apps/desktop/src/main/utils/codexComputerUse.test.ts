import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexComputerUseClientCandidates,
  codexComputerUseOptedIn,
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
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
  it("returns no config off macOS or without user opt-in", () => {
    const root = makeTempRoot();
    const stable = codexComputerUseClientCandidates(root)[0]!;
    makeExecutable(stable);
    expect(resolveCodexComputerUseMcpConfig({
      platform: "linux",
      codexHome: root,
      configText: '[plugins."computer-use@openai-bundled"]\nenabled = true',
      verifySignature: () => true,
    })).toBeNull();
    expect(resolveCodexComputerUseMcpConfig({
      platform: "darwin",
      codexHome: root,
      configText: "",
      verifySignature: () => true,
    })).toBeNull();
  });

  it("prefers the stable signed client path", () => {
    const root = makeTempRoot();
    const stable = codexComputerUseClientCandidates(root)[0]!;
    makeExecutable(stable);
    expect(resolveCodexComputerUseMcpConfig({
      platform: "darwin",
      codexHome: root,
      configText: '[plugins."computer-use@openai-bundled"]\nenabled = true',
      verifySignature: () => true,
    })).toEqual({ command: stable, args: ["mcp"], enabled: true });
  });

  it("falls back to the newest executable cached client", () => {
    const root = makeTempRoot();
    const cacheRoot = path.join(root, "plugins", "cache", "openai-bundled", "computer-use");
    const relative = path.relative(root, codexComputerUseClientCandidates(root)[0]!)
      .replace(/^computer-use[\\/]/, "");
    const oldClient = path.join(cacheRoot, "1.0.9", relative);
    const newestClient = path.join(cacheRoot, "1.0.10", relative);
    makeExecutable(oldClient);
    makeExecutable(newestClient);
    expect(resolveCodexComputerUseMcpConfig({
      platform: "darwin",
      codexHome: root,
      configText: '[plugins."computer-use@openai-bundled"]\nenabled = true',
      verifySignature: () => true,
    })?.command).toBe(newestClient);
  });

  it("rejects executable clients that fail OpenAI signature verification", () => {
    const root = makeTempRoot();
    makeExecutable(codexComputerUseClientCandidates(root)[0]!);
    expect(resolveCodexComputerUseMcpConfig({
      platform: "darwin",
      codexHome: root,
      configText: '[plugins."computer-use@openai-bundled"]\nenabled = true',
      verifySignature: () => false,
    })).toBeNull();
  });
});
