import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerSandboxConfig } from "../../../../shared/types";
import { DEFAULT_WORKER_SANDBOX_CONFIG } from "../../orchestrator/orchestratorConstants";
import { checkWorkerSandbox, createUniversalToolSet } from "./universalTools";

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

function sandboxWith(overrides: Partial<WorkerSandboxConfig>): WorkerSandboxConfig {
  return {
    ...DEFAULT_WORKER_SANDBOX_CONFIG,
    ...overrides
  };
}

// ============================================================================
// checkWorkerSandbox
// ============================================================================

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

  it("blocks commands matching explicit blocked patterns", () => {
    const config = sandboxWith({
      blockedCommands: ["\\brm\\s+-rf\\b"],
    });
    const result = checkWorkerSandbox("rm -rf /", config, "/tmp/project");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Blocked command pattern");
  });

  it("allows safe-listed read-only commands inside the project root", () => {
    const result = checkWorkerSandbox("ls -la ./src", DEFAULT_WORKER_SANDBOX_CONFIG, "/tmp/project");
    expect(result.allowed).toBe(true);
  });

  it("allows paths within allowed extra directories", () => {
    const cwd = "/tmp/project";
    const config = sandboxWith({
      allowedPaths: ["./", "/tmp/extra"],
    });
    const result = checkWorkerSandbox("cat /tmp/extra/data.json", config, cwd);
    expect(result.allowed).toBe(true);
  });

  it("allows /usr/bin and /usr/local/bin paths", () => {
    const result = checkWorkerSandbox("cat /usr/bin/env", DEFAULT_WORKER_SANDBOX_CONFIG, "/tmp/project");
    expect(result.allowed).toBe(true);
  });

  it("blocks commands that are not in the safe list when blockByDefault is enabled", () => {
    const config = sandboxWith({
      blockByDefault: true,
      safeCommands: ["^echo\\b"],
    });
    const result = checkWorkerSandbox("curl http://example.com", config, "/tmp/project");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blockByDefault");
  });

  it("allows commands matching safeCommands when blockByDefault is enabled", () => {
    const config = sandboxWith({
      blockByDefault: true,
      safeCommands: ["^echo\\b"],
    });
    const result = checkWorkerSandbox("echo hello", config, "/tmp/project");
    expect(result.allowed).toBe(true);
  });

  it("detects home directory expansion in paths", () => {
    const cwd = "/tmp/project";
    const config = sandboxWith({
      allowedPaths: ["./"],
    });
    const result = checkWorkerSandbox("cat ~/some-file.txt", config, cwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path outside sandbox");
  });

  it("detects redirect target paths for write-like commands", () => {
    const cwd = "/tmp/project";
    const config = sandboxWith({
      protectedFiles: ["\\.env"],
    });
    const result = checkWorkerSandbox("echo secret >> .env", config, cwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("protected file pattern");
  });

  it("allows commands with no path references at all", () => {
    const result = checkWorkerSandbox("echo hello world", DEFAULT_WORKER_SANDBOX_CONFIG, "/tmp/project");
    expect(result.allowed).toBe(true);
  });

  it("handles URL-like tokens without treating them as paths", () => {
    const result = checkWorkerSandbox("curl https://example.com/api", DEFAULT_WORKER_SANDBOX_CONFIG, "/tmp/project");
    // Should not try to resolve URLs as filesystem paths
    if (result.reason) {
      expect(result.reason).not.toContain("Path outside sandbox");
    }
  });

  it("blocks write to protected file via cp command", () => {
    const config = sandboxWith({
      protectedFiles: ["\\.env"],
    });
    const result = checkWorkerSandbox("cp my-secrets .env", config, "/tmp/project");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("protected file pattern");
  });
});

// ============================================================================
// createUniversalToolSet
// ============================================================================

describe("createUniversalToolSet", () => {
  // ── Tool set structure ──────────────────────────────────────────

  it("returns all expected tool keys in the default configuration", () => {
    const cwd = makeTmpDir("ade-tools-keys-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    expect(tools.readFile).toBeDefined();
    expect(tools.grep).toBeDefined();
    expect(tools.glob).toBeDefined();
    expect(tools.listDir).toBeDefined();
    expect(tools.gitStatus).toBeDefined();
    expect(tools.gitDiff).toBeDefined();
    expect(tools.gitLog).toBeDefined();
    expect(tools.webFetch).toBeDefined();
    expect(tools.webSearch).toBeDefined();
    expect(tools.editFile).toBeDefined();
    expect(tools.writeFile).toBeDefined();
    expect(tools.bash).toBeDefined();
    expect(tools.askUser).toBeDefined();
    expect(tools.exitPlanMode).toBeDefined();
  });

  it("does not include memory tools when memoryService is not provided", () => {
    const cwd = makeTmpDir("ade-tools-nomem-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    expect(tools.memorySearch).toBeUndefined();
    expect(tools.memoryAdd).toBeUndefined();
  });

  it("includes memoryUpdateCore tool when onMemoryUpdateCore is provided", () => {
    const cwd = makeTmpDir("ade-tools-memcore-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      onMemoryUpdateCore: () => ({ version: 1, updatedAt: new Date().toISOString() }),
    });

    expect(tools.memoryUpdateCore).toBeDefined();
  });

  it("does not include memoryUpdateCore tool when onMemoryUpdateCore is not provided", () => {
    const cwd = makeTmpDir("ade-tools-nomemcore-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    expect(tools.memoryUpdateCore).toBeUndefined();
  });

  // ── Sandbox enforcement ─────────────────────────────────────────

  it("applies DEFAULT_WORKER_SANDBOX_CONFIG when sandboxConfig is omitted", async () => {
    const cwd = makeTmpDir("ade-tools-default-sandbox-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });
    const bashTool = tools.bash as any;

    const result = await bashTool.execute({
      command: "chmod 777 ./missing-file",
      timeout: 5_000
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("SANDBOX BLOCKED");
  });

  // ── writeFile tool ──────────────────────────────────────────────

  it("blocks writeFile writes outside project root when no explicit allowlist is provided", async () => {
    const cwd = makeTmpDir("ade-tools-write-root-");
    const outsideDir = `${cwd}-outside`;
    fs.mkdirSync(outsideDir, { recursive: true });
    tmpDirs.push(outsideDir);
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
    const cwd = makeTmpDir("ade-tools-write-allowed-");
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
    const cwd = makeTmpDir("ade-tools-write-allowlist-root-");
    const allowlistedDir = makeTmpDir("ade-tools-write-allowlist-extra-");
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

  it("creates parent directories automatically for writeFile", async () => {
    const cwd = makeTmpDir("ade-tools-write-mkdir-");
    const deepPath = path.join(cwd, "a", "b", "c", "file.txt");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.writeFile as any).execute({
      file_path: deepPath,
      content: "deep write",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(deepPath, "utf-8")).toBe("deep write");
  });

  // ── editFile tool ───────────────────────────────────────────────

  it("performs a single-occurrence edit successfully", async () => {
    const cwd = makeTmpDir("ade-tools-edit-");
    const filePath = path.join(cwd, "target.txt");
    fs.writeFileSync(filePath, "Hello world\nfoo bar\n", "utf-8");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "foo bar",
      new_string: "baz qux",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("Hello world\nbaz qux\n");
  });

  it("fails when old_string is not found", async () => {
    const cwd = makeTmpDir("ade-tools-edit-notfound-");
    const filePath = path.join(cwd, "target.txt");
    fs.writeFileSync(filePath, "Hello world\n", "utf-8");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "does not exist",
      new_string: "replacement",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("fails when old_string matches multiple times without replace_all", async () => {
    const cwd = makeTmpDir("ade-tools-edit-multi-");
    const filePath = path.join(cwd, "target.txt");
    fs.writeFileSync(filePath, "foo bar\nfoo bar\n", "utf-8");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "foo bar",
      new_string: "baz",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("multiple times");
  });

  it("replaces all occurrences when replace_all is true", async () => {
    const cwd = makeTmpDir("ade-tools-edit-replaceall-");
    const filePath = path.join(cwd, "target.txt");
    fs.writeFileSync(filePath, "foo bar\nfoo bar\n", "utf-8");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "foo bar",
      new_string: "baz",
      replace_all: true,
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("baz\nbaz\n");
  });

  it("returns an error when the file does not exist for editFile", async () => {
    const cwd = makeTmpDir("ade-tools-edit-missing-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.editFile as any).execute({
      file_path: path.join(cwd, "nonexistent.txt"),
      old_string: "foo",
      new_string: "bar",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("File not found");
  });

  // ── Memory guard ────────────────────────────────────────────────

  it("blocks mutating tools on required turns until memory orientation is satisfied", async () => {
    const cwd = makeTmpDir("ade-tools-memory-guard-");
    const targetPath = path.join(cwd, "blocked.txt");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "required",
        orientationSatisfied: false,
        explicitSearchPerformed: false,
      },
    });

    const result = await (tools.writeFile as any).execute({
      file_path: targetPath,
      content: "blocked",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Search memory before mutating files");
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("blocks editFile on required turns until memory orientation is satisfied", async () => {
    const cwd = makeTmpDir("ade-tools-memory-guard-edit-");
    const filePath = path.join(cwd, "edit-target.txt");
    fs.writeFileSync(filePath, "original\n", "utf-8");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "required",
        orientationSatisfied: false,
        explicitSearchPerformed: false,
      },
    });

    const result = await (tools.editFile as any).execute({
      file_path: filePath,
      old_string: "original",
      new_string: "modified",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Search memory before mutating files");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original\n");
  });

  it("blocks mutating bash commands on required turns", async () => {
    const cwd = makeTmpDir("ade-tools-memory-guard-bash-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "required",
        orientationSatisfied: false,
        explicitSearchPerformed: false,
      },
    });

    const result = await (tools.bash as any).execute({
      command: "rm -rf ./some-dir",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("EXECUTION DENIED");
  });

  it("does not block read-only bash commands on required turns", async () => {
    const cwd = makeTmpDir("ade-tools-memory-readonly-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "required",
        orientationSatisfied: false,
        explicitSearchPerformed: false,
      },
    });

    const result = await (tools.bash as any).execute({
      command: "pwd",
      timeout: 5_000,
    });

    expect(result.stderr).not.toContain("EXECUTION DENIED");
  });

  it("allows mutating tools once memory orientation is satisfied", async () => {
    const cwd = makeTmpDir("ade-tools-memory-satisfied-");
    const targetPath = path.join(cwd, "allowed.txt");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "required",
        orientationSatisfied: true,
        explicitSearchPerformed: true,
      },
    });

    const result = await (tools.writeFile as any).execute({
      file_path: targetPath,
      content: "allowed write",
    });

    expect(result.success).toBe(true);
  });

  it("does not block when classification is casual", async () => {
    const cwd = makeTmpDir("ade-tools-memory-casual-");
    const targetPath = path.join(cwd, "casual.txt");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      turnMemoryPolicyState: {
        classification: "none",
        orientationSatisfied: false,
        explicitSearchPerformed: false,
      },
    });

    const result = await (tools.writeFile as any).execute({
      file_path: targetPath,
      content: "casual write",
    });

    expect(result.success).toBe(true);
  });

  // ── Permission modes ────────────────────────────────────────────

  it("denies bash execution in plan mode when no approval handler is configured", async () => {
    const cwd = makeTmpDir("ade-tools-plan-deny-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "plan" });

    const result = await (tools.bash as any).execute({
      command: "echo hello",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("EXECUTION DENIED");
  });

  it("denies write in plan mode when no approval handler is configured", async () => {
    const cwd = makeTmpDir("ade-tools-plan-write-deny-");
    const targetPath = path.join(cwd, "blocked.txt");
    const tools = createUniversalToolSet(cwd, { permissionMode: "plan" });

    const result = await (tools.writeFile as any).execute({
      file_path: targetPath,
      content: "blocked",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Execution denied");
  });

  it("denies bash execution in edit mode when no approval handler is configured", async () => {
    const cwd = makeTmpDir("ade-tools-edit-deny-bash-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "edit" });

    const result = await (tools.bash as any).execute({
      command: "echo hello",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("EXECUTION DENIED");
  });

  it("allows writeFile in edit mode without approval handler", async () => {
    const cwd = makeTmpDir("ade-tools-edit-allow-write-");
    const targetPath = path.join(cwd, "allowed.txt");
    const tools = createUniversalToolSet(cwd, { permissionMode: "edit" });

    const result = await (tools.writeFile as any).execute({
      file_path: targetPath,
      content: "edit-mode write",
    });

    expect(result.success).toBe(true);
  });

  it("invokes approval handler and allows if approved", async () => {
    const cwd = makeTmpDir("ade-tools-approval-allow-");
    const onApprovalRequest = vi.fn().mockResolvedValue({ approved: true });
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "plan",
      onApprovalRequest,
    });

    const result = await (tools.bash as any).execute({
      command: "echo approved",
      timeout: 5_000,
    });

    expect(onApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "bash",
        description: expect.stringContaining("echo approved"),
      }),
    );
    expect(result.exitCode).not.toBe(126);
  });

  it("invokes approval handler and blocks if rejected", async () => {
    const cwd = makeTmpDir("ade-tools-approval-deny-");
    const onApprovalRequest = vi.fn().mockResolvedValue({ approved: false, reason: "user rejected" });
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "plan",
      onApprovalRequest,
    });

    const result = await (tools.bash as any).execute({
      command: "echo rejected",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("user rejected");
  });

  // ── askUser tool ────────────────────────────────────────────────

  it("returns error when askUser callback is not configured", async () => {
    const cwd = makeTmpDir("ade-tools-askuser-nocb-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.askUser as any).execute({ question: "What?" });

    expect(result.error).toContain("not configured");
  });

  it("returns user answer from askUser callback", async () => {
    const cwd = makeTmpDir("ade-tools-askuser-cb-");
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      onAskUser: async () => "user answer",
    });

    const result = await (tools.askUser as any).execute({ question: "What?" });

    expect(result.answer).toBe("user answer");
  });

  // ── exitPlanMode tool ───────────────────────────────────────────

  it("returns failure when no approval handler is configured for exitPlanMode", async () => {
    const cwd = makeTmpDir("ade-tools-exitplan-nocb-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.exitPlanMode as any).execute({});

    expect(result.approved).toBe(false);
    expect(result.message).toContain("No approval handler");
  });

  it("returns approved when user approves plan exit", async () => {
    const cwd = makeTmpDir("ade-tools-exitplan-approve-");
    const onApprovalRequest = vi.fn().mockResolvedValue({ approved: true });
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      onApprovalRequest,
    });

    const result = await (tools.exitPlanMode as any).execute({
      planDescription: "My plan summary",
    });

    expect(result.approved).toBe(true);
    expect(result.message).toContain("Proceed with implementation");
  });

  it("returns feedback when user rejects plan exit", async () => {
    const cwd = makeTmpDir("ade-tools-exitplan-reject-");
    const onApprovalRequest = vi.fn().mockResolvedValue({
      approved: false,
      reason: "Please add more tests first.",
    });
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      onApprovalRequest,
    });

    const result = await (tools.exitPlanMode as any).execute({});

    expect(result.approved).toBe(false);
    expect(result.message).toContain("Please add more tests first");
  });

  // ── memoryUpdateCore tool ───────────────────────────────────────

  it("invokes onMemoryUpdateCore with patch and returns result", async () => {
    const cwd = makeTmpDir("ade-tools-memcore-exec-");
    const onMemoryUpdateCore = vi.fn().mockReturnValue({
      version: 2,
      updatedAt: "2026-03-26T00:00:00.000Z",
    });
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      onMemoryUpdateCore,
    });

    const result = await (tools.memoryUpdateCore as any).execute({
      projectSummary: "An ADE desktop application.",
      activeFocus: ["Release 9 stabilization"],
    });

    expect(onMemoryUpdateCore).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSummary: "An ADE desktop application.",
        activeFocus: ["Release 9 stabilization"],
      }),
    );
    expect(result.updated).toBe(true);
    expect(result.version).toBe(2);
  });

  it("returns error from memoryUpdateCore when no fields are provided", async () => {
    const cwd = makeTmpDir("ade-tools-memcore-empty-");
    const onMemoryUpdateCore = vi.fn();
    const tools = createUniversalToolSet(cwd, {
      permissionMode: "full-auto",
      onMemoryUpdateCore,
    });

    const result = await (tools.memoryUpdateCore as any).execute({});

    expect(result.updated).toBe(false);
    expect(result.error).toContain("At least one core-memory field");
    expect(onMemoryUpdateCore).not.toHaveBeenCalled();
  });

  // ── bash tool ───────────────────────────────────────────────────

  it("executes a basic bash command and returns output", async () => {
    const cwd = makeTmpDir("ade-tools-bash-basic-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.bash as any).execute({
      command: "echo hello from bash",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from bash");
  });

  it("returns nonzero exit code for failing commands", async () => {
    const cwd = makeTmpDir("ade-tools-bash-fail-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    const result = await (tools.bash as any).execute({
      command: "exit 42",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(42);
  });

  it("clamps timeout to max 600000ms", async () => {
    const cwd = makeTmpDir("ade-tools-bash-timeout-clamp-");
    const tools = createUniversalToolSet(cwd, { permissionMode: "full-auto" });

    // Just verify it doesn't throw; internally the timeout is clamped
    const result = await (tools.bash as any).execute({
      command: "echo clamped",
      timeout: 9_999_999,
    });

    expect(result.exitCode).toBe(0);
  });
});
