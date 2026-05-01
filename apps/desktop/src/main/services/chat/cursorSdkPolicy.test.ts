import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowCursorHook,
  cursorProjectSlugForPath,
  denyCursorHook,
  evaluateCursorSdkHook,
  resolveCursorSdkPolicy,
  summarizeCursorHook,
} from "./cursorSdkPolicy";

describe("Cursor SDK policy", () => {
  it("maps Cursor modes to ADE permission policies", () => {
    expect(resolveCursorSdkPolicy({ cursorModeId: "ask" })).toMatchObject({
      chatMode: "ask",
      approvalPolicy: "read-only",
      force: false,
    });
    expect(resolveCursorSdkPolicy({ cursorModeId: "plan" })).toMatchObject({
      chatMode: "plan",
      approvalPolicy: "read-only",
      force: false,
    });
    expect(resolveCursorSdkPolicy({ cursorModeId: "full-auto" })).toMatchObject({
      chatMode: "agent",
      approvalPolicy: "never",
      force: true,
    });
  });

  it("allows reads, asks for risky tools, and denies protected paths", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "agent" });
    const laneRoot = "/tmp/ade-lane";

    const read = summarizeCursorHook({
      toolName: "read",
      toolInput: { path: "src/app.ts" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: read, policy, laneRoot })).toBe("allow");

    const shell = summarizeCursorHook({
      toolName: "shell",
      toolInput: { command: "npm test" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: shell, policy, laneRoot })).toBe("ask");

    const secret = summarizeCursorHook({
      toolName: "write",
      toolInput: { path: ".ade/secrets/key.json" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: secret, policy, laneRoot })).toBe("deny");
    expect(secret.reason).toContain("protected");
  });

  it("blocks side effects in read-only policy", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "plan" });
    const request = summarizeCursorHook({
      toolName: "write",
      toolInput: { path: "src/app.ts", content: "x" },
    }, "/tmp/ade-lane");
    expect(evaluateCursorSdkHook({ request, policy, laneRoot: "/tmp/ade-lane" })).toBe("deny");
  });

  it("does not special-case model-visible planning tools in read-only Cursor plan mode", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "plan" });
    const laneRoot = "/tmp/ade-lane";

    const planTool = summarizeCursorHook({
      toolName: "TodoWrite",
      toolInput: {
        todos: [{ content: "Inspect wiring", status: "in_progress" }],
      },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: planTool, policy, laneRoot })).toBe("deny");

    const mcpRequest = summarizeCursorHook({
      toolName: "mcp",
      toolInput: {
        serverName: "stale-planning-tools",
        toolName: "update_plan",
        arguments: { steps: [{ text: "Plan via ADE", status: "pending" }] },
      },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: mcpRequest, policy, laneRoot })).toBe("deny");
  });

  it("formats hook decisions for Cursor hooks", () => {
    expect(allowCursorHook()).toEqual({ permission: "allow" });
    expect(denyCursorHook("nope")).toEqual({
      permission: "deny",
      user_message: "nope",
      agent_message: "nope",
    });
  });

  it("denies any path-traversal escape from the lane root regardless of approval policy", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
    const laneRoot = "/tmp/ade-lane";

    const escape = summarizeCursorHook({
      toolName: "read",
      toolInput: { path: "/etc/passwd" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: escape, policy, laneRoot })).toBe("deny");

    const traversal = summarizeCursorHook({
      toolName: "read",
      toolInput: { path: "../../etc/passwd" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: traversal, policy, laneRoot })).toBe("deny");
  });

  it("denies shell path escapes even in full-auto mode", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
    const laneRoot = "/tmp/ade-lane";

    for (const command of [
      "cat /etc/passwd",
      "git -C /tmp status",
      "npm --prefix ../other test",
      "npm --prefix=/tmp/outside test",
      "AWS_SHARED_CREDENTIALS_FILE=/Users/admin/.aws/credentials aws sts get-caller-identity",
      "cd /outside && ls",
      "echo ok > /tmp/ade-outside.txt",
      "cat ~/.aws/credentials",
      "cat $HOME/.aws/credentials",
    ]) {
      const request = summarizeCursorHook({
        toolName: "shell",
        toolInput: { command },
      }, laneRoot);
      expect(evaluateCursorSdkHook({
        request,
        policy,
        laneRoot,
        userHomeDir: "/Users/admin",
      })).toBe("deny");
    }
  });

  it("denies shell cwd escapes even when the command text is otherwise safe", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
    const laneRoot = "/tmp/ade-lane";
    const request = summarizeCursorHook({
      toolName: "shell",
      toolInput: { command: "npm test", cwd: "/tmp/outside-lane" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request, policy, laneRoot })).toBe("deny");
  });

  it("allows Cursor SDK transcript and terminal reads for the active lane only", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
    const laneRoot = "/Users/admin/Projects/Versic/.ade/worktrees/private-sharing-5d14c47a";
    const userHomeDir = "/Users/admin";
    const slug = cursorProjectSlugForPath(laneRoot);
    expect(slug).toBe("Users-admin-Projects-Versic-ade-worktrees-private-sharing-5d14c47a");

    const transcript = summarizeCursorHook({
      toolName: "read",
      toolInput: {
        path: path.join(userHomeDir, ".cursor", "projects", slug, "agent-transcripts", "run.jsonl"),
      },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: transcript, policy, laneRoot, userHomeDir })).toBe("allow");

    const terminalGlob = summarizeCursorHook({
      toolName: "glob",
      toolInput: {
        pattern: "*.json",
        targetDirectory: path.join(userHomeDir, ".cursor", "projects", slug, "terminals"),
      },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: terminalGlob, policy, laneRoot, userHomeDir })).toBe("allow");

    const writeTranscript = summarizeCursorHook({
      toolName: "write",
      toolInput: {
        path: path.join(userHomeDir, ".cursor", "projects", slug, "agent-transcripts", "run.jsonl"),
      },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: writeTranscript, policy, laneRoot, userHomeDir })).toBe("deny");
  });

  it("denies Cursor support reads when the active project support root is symlinked outside Cursor projects", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-support-"));
    const home = path.join(root, "home");
    const laneRoot = path.join(root, "repo", ".ade", "worktrees", "lane");
    const outside = path.join(root, "outside");
    const slug = cursorProjectSlugForPath(laneRoot);
    fs.mkdirSync(path.join(home, ".cursor", "projects"), { recursive: true });
    fs.mkdirSync(laneRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(home, ".cursor", "projects", slug), "dir");

    try {
      const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
      const request = summarizeCursorHook({
        toolName: "read",
        toolInput: {
          path: path.join(home, ".cursor", "projects", slug, "agent-transcripts", "run.jsonl"),
        },
      }, laneRoot);
      expect(evaluateCursorSdkHook({
        request,
        policy,
        laneRoot,
        userHomeDir: home,
      })).toBe("deny");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies symlink escapes through paths that appear to be inside the lane", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-policy-"));
    const laneRoot = path.join(root, "lane");
    const outside = path.join(root, "outside");
    fs.mkdirSync(laneRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(laneRoot, "linked-outside"), "dir");

    try {
      const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
      const request = summarizeCursorHook({
        toolName: "read",
        toolInput: { path: "linked-outside/secret.txt" },
      }, laneRoot);
      expect(evaluateCursorSdkHook({ request, policy, laneRoot })).toBe("deny");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows shells in full-auto without prompting", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
    const laneRoot = "/tmp/ade-lane";
    const shell = summarizeCursorHook({
      toolName: "shell",
      toolInput: { command: "npm install", cwd: laneRoot },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: shell, policy, laneRoot })).toBe("allow");
  });
});
