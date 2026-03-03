import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkerSandboxConfig } from "../../../../shared/types";
import { DEFAULT_WORKER_SANDBOX_CONFIG } from "../../orchestrator/orchestratorConstants";
import { checkWorkerSandbox, createUniversalToolSet } from "./universalTools";

function sandboxWith(overrides: Partial<WorkerSandboxConfig>): WorkerSandboxConfig {
  return {
    ...DEFAULT_WORKER_SANDBOX_CONFIG,
    ...overrides
  };
}

describe("checkWorkerSandbox", () => {
  it("blocks protected file writes even when command matches a safe allowlist pattern", () => {
    const result = checkWorkerSandbox("echo hello > .env", DEFAULT_WORKER_SANDBOX_CONFIG, "/tmp/project");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("protected file pattern");
  });

  it("validates relative paths by resolving them against cwd", () => {
    const cwd = path.join(os.tmpdir(), "ade-sandbox-cwd");
    const result = checkWorkerSandbox("cat ../outside.txt", sandboxWith({ allowedPaths: ["./"] }), cwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path outside sandbox");
  });

  it("does not allow safe-listed commands to bypass path checks", () => {
    const cwd = path.join(os.tmpdir(), "ade-sandbox-cwd-safe");
    const result = checkWorkerSandbox("echo hello > ../outside.txt", sandboxWith({ allowedPaths: ["./"] }), cwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path outside sandbox");
  });
});

describe("createUniversalToolSet", () => {
  it("applies DEFAULT_WORKER_SANDBOX_CONFIG when sandboxConfig is omitted", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-default-sandbox-"));
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });
    const bashTool = tools.bash as any;

    const result = await bashTool.execute({
      command: "chmod 777 ./missing-file",
      timeout: 5_000
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("SANDBOX BLOCKED");
  });

  it("blocks writeFile writes outside project root when no explicit allowlist is provided", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-write-root-"));
    const outsideDir = `${cwd}-outside`;
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsidePath = path.join(outsideDir, "blocked.txt");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });
    const writeTool = tools.writeFile as any;

    const result = await writeTool.execute({
      file_path: outsidePath,
      content: "blocked write",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("outside allowed roots");
    expect(fs.existsSync(outsidePath)).toBe(false);
  });

  it("allows writeFile within project root", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-write-allowed-"));
    const targetPath = path.join(cwd, "notes", "output.txt");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });
    const writeTool = tools.writeFile as any;

    const result = await writeTool.execute({
      file_path: targetPath,
      content: "hello",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("hello");
  });

  it("allows writeFile outside project root when sandbox allowlist explicitly permits it", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-write-allowlist-root-"));
    const allowlistedDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-write-allowlist-extra-"));
    const targetPath = path.join(allowlistedDir, "allowed.txt");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      sandboxConfig: sandboxWith({ allowedPaths: ["./", allowlistedDir] }),
    });
    const writeTool = tools.writeFile as any;

    const result = await writeTool.execute({
      file_path: targetPath,
      content: "allowlisted",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("allowlisted");
  });
});
