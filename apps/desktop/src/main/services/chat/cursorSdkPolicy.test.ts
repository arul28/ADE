import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowCursorHook,
  buildCursorSdkLocalRunOptions,
  cursorProjectSlugForPath,
  cursorSdkLocalAgentMode,
  CURSOR_SDK_READONLY_TOOLS,
  denyCursorHook,
  evaluateCursorSdkHook,
  resolveCursorSdkPolicy,
  summarizeCursorHook,
} from "./cursorSdkPolicy";
import { cursorProjectSlug } from "../../../shared/cursorProjectSlug";

describe("Cursor SDK policy", () => {
  it("maps Cursor modes to ADE permission policies", () => {
    expect(resolveCursorSdkPolicy({ cursorModeId: "ask" })).toMatchObject({
      chatMode: "ask",
      approvalPolicy: "read-only",
      sandbox: "cursor-native",
      fullAuto: false,
      autoReview: false,
      tools: [...CURSOR_SDK_READONLY_TOOLS],
    });
    expect(resolveCursorSdkPolicy({ cursorModeId: "plan" })).toMatchObject({
      chatMode: "plan",
      approvalPolicy: "read-only",
      sandbox: "cursor-native",
      fullAuto: false,
      autoReview: false,
      tools: [...CURSOR_SDK_READONLY_TOOLS],
    });
    expect(resolveCursorSdkPolicy({ cursorModeId: "agent" })).toMatchObject({
      chatMode: "agent",
      approvalPolicy: "on-request",
      sandbox: "ade",
      fullAuto: false,
      autoReview: true,
    });
    expect(resolveCursorSdkPolicy({ cursorModeId: "agent" }).tools).toBeUndefined();
    expect(resolveCursorSdkPolicy({ cursorModeId: "agent" }).disallowedTools).toBeUndefined();
    expect(resolveCursorSdkPolicy({ cursorModeId: "ask" }).disallowedTools).toBeUndefined();
    expect(resolveCursorSdkPolicy({ cursorModeId: "full-auto" })).toMatchObject({
      chatMode: "agent",
      approvalPolicy: "never",
      sandbox: "off",
      fullAuto: true,
      autoReview: false,
    });
    expect(resolveCursorSdkPolicy({ cursorModeId: "full-auto" }).tools).toBeUndefined();
    expect(resolveCursorSdkPolicy({ cursorModeId: "full-auto" }).disallowedTools).toBeUndefined();
  });

  it("maps ADE modes onto SDK agent/plan + local tools/sandbox/autoReview and never names a mode auto", () => {
    const expected: Record<string, {
      mode: "agent" | "plan";
      tools?: string[];
      sandboxDirective: "enable" | "disable" | "inherit";
      autoReview: boolean;
    }> = {
      agent: { mode: "agent", sandboxDirective: "inherit", autoReview: true },
      ask: { mode: "plan", tools: ["read", "grep", "glob", "ls"], sandboxDirective: "enable", autoReview: false },
      plan: { mode: "plan", tools: ["read", "grep", "glob", "ls"], sandboxDirective: "enable", autoReview: false },
      "full-auto": { mode: "agent", sandboxDirective: "disable", autoReview: false },
    };
    for (const modeId of ["agent", "ask", "plan", "full-auto"] as const) {
      const policy = resolveCursorSdkPolicy({ cursorModeId: modeId });
      const local = buildCursorSdkLocalRunOptions(policy);
      expect(cursorSdkLocalAgentMode(policy)).toBe(expected[modeId]!.mode);
      expect(cursorSdkLocalAgentMode(policy)).not.toBe("auto");
      expect(local.mode).toBe(expected[modeId]!.mode);
      expect(local.mode).not.toBe("auto");
      expect(local.autoReview).toBe(expected[modeId]!.autoReview);
      expect(local.sandboxDirective).toBe(expected[modeId]!.sandboxDirective);
      if (expected[modeId]!.tools) {
        expect(local.tools).toEqual(expected[modeId]!.tools);
      } else {
        expect(local.tools).toBeUndefined();
      }
      expect(local.disallowedTools).toBeUndefined();
    }
  });

  it("copies disallowedTools onto local run options when the policy sets them", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "ask" });
    const local = buildCursorSdkLocalRunOptions({
      ...policy,
      disallowedTools: ["shell", "edit", "task"],
    });
    expect(local.tools).toEqual(["read", "grep", "glob", "ls"]);
    expect(local.disallowedTools).toEqual(["shell", "edit", "task"]);
  });

  it("disables native sandbox in local run options when the host does not support it", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "ask" });
    expect(buildCursorSdkLocalRunOptions(policy, { sandboxSupported: false })).toMatchObject({
      mode: "plan",
      tools: ["read", "grep", "glob", "ls"],
      autoReview: false,
      sandboxDirective: "disable",
    });
  });

  it("keeps the full-auto permission mode off the SDK's run-expiry option", () => {
    // `fullAuto` is a permission level. The Cursor SDK's `local.force` expires
    // an active run, which is a recovery action — mapping one onto the other
    // made every full-auto send silently kill a turn that was still working.
    for (const modeId of ["ask", "plan", "agent", "full-auto"]) {
      expect(resolveCursorSdkPolicy({ cursorModeId: modeId })).not.toHaveProperty("force");
    }
    expect(resolveCursorSdkPolicy({ cursorModeId: "full-auto" }).fullAuto).toBe(true);
  });

  it("denies Cursor's own edit/shell/subagent tools for an orchestrator lead", () => {
    const laneRoot = "/tmp/ade-lane";
    // Leads run under the same permissive full-auto profile as workers; only
    // the lead gate distinguishes them.
    const leadPolicy = resolveCursorSdkPolicy({
      cursorModeId: "full-auto",
      interactionMode: "orchestrator-lead",
      orchestrationRole: "lead",
    });
    const workerPolicy = resolveCursorSdkPolicy({
      cursorModeId: "full-auto",
      interactionMode: "orchestrator-worker",
      orchestrationRole: "worker",
    });
    expect(leadPolicy).toMatchObject({ approvalPolicy: "never", orchestrationLead: true });
    expect(workerPolicy).toMatchObject({ approvalPolicy: "never", orchestrationLead: false });

    const nativeWriteTools = [
      { toolName: "write", toolInput: { path: "README.md", contents: "x" } },
      { toolName: "edit", toolInput: { path: "README.md" } },
      { toolName: "apply_patch", toolInput: { path: "README.md" } },
      { toolName: "delete", toolInput: { path: "README.md" } },
    ];
    const nativeShellTools = [
      { toolName: "shell", toolInput: { command: "echo hi > README.md" } },
      { toolName: "run_command", toolInput: { command: "npm test" } },
    ];
    const nativeTaskTools = [{ toolName: "task", toolInput: { prompt: "edit README" } }];

    for (const raw of [...nativeWriteTools, ...nativeShellTools, ...nativeTaskTools]) {
      const request = summarizeCursorHook(raw, laneRoot);
      expect(evaluateCursorSdkHook({ request, policy: leadPolicy, laneRoot })).toBe("deny");
      // Same tool, same permissive profile, worker role: still allowed.
      const workerRequest = summarizeCursorHook(raw, laneRoot);
      expect(evaluateCursorSdkHook({ request: workerRequest, policy: workerPolicy, laneRoot })).toBe("allow");
    }

    // Reads stay available so the lead can still plan.
    const read = summarizeCursorHook({ toolName: "read", toolInput: { path: "src/app.ts" } }, laneRoot);
    expect(evaluateCursorSdkHook({ request: read, policy: leadPolicy, laneRoot })).toBe("allow");

    // Unrecognised tool names classify as risk "unknown" and must fail closed
    // for a lead even though `approvalPolicy: never` would wave them through.
    const unknown = summarizeCursorHook({ toolName: "some_future_write_tool", toolInput: {} }, laneRoot);
    expect(evaluateCursorSdkHook({ request: unknown, policy: leadPolicy, laneRoot })).toBe("deny");
    const unknownForWorker = summarizeCursorHook({ toolName: "some_future_write_tool", toolInput: {} }, laneRoot);
    expect(evaluateCursorSdkHook({ request: unknownForWorker, policy: workerPolicy, laneRoot })).toBe("allow");
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
      "npm --prefix=C:\\Users\\admin\\outside test",
      "git -C C:\\Users\\admin\\outside status",
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

  it("denies shell path escapes when hook payload input is a raw string", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
    const laneRoot = "/tmp/ade-lane";
    const request = summarizeCursorHook({
      toolName: "shell",
      toolInput: "cd /etc && cat /etc/passwd",
    }, laneRoot);

    expect(evaluateCursorSdkHook({
      request,
      policy,
      laneRoot,
    })).toBe("deny");
    expect(request.reason).toContain("/etc");
  });

  // The guard deliberately leaves backslash tokens alone on POSIX, where `\` is
  // a legal filename character, so these escape shapes have no POSIX analogue.
  // WINDOWS-GATE: Windows-only shell path syntax; verified green on a native Windows host.
  it.runIf(process.platform === "win32")("denies Windows-shell lane escapes written with backslashes or %VAR% expansion", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
    const laneRoot = path.join(path.parse(path.resolve("/")).root, "Users", "admin", "lane");
    const userHomeDir = path.join(path.parse(path.resolve("/")).root, "Users", "admin");
    const cases: Array<[string, string]> = [
      ["type ..\\..\\..\\.ssh\\id_rsa", "outside the active lane"],
      ["type .\\..\\..\\secret.txt", "outside the active lane"],
      ["type %USERPROFILE%\\.ssh\\id_rsa", "outside the active lane"],
      ["Get-Content $env:USERPROFILE\\.aws\\credentials", "outside the active lane"],
      ["type .ade\\secrets\\token", "protected by ADE"],
    ];
    for (const [command, reason] of cases) {
      const request = summarizeCursorHook({ toolName: "shell", toolInput: { command } }, laneRoot);
      expect(evaluateCursorSdkHook({ request, policy, laneRoot, userHomeDir })).toBe("deny");
      expect(request.reason).toContain(reason);
    }
  });

  it("keeps POSIX-style backslash filenames out of the Windows path heuristics", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
    const laneRoot = path.join(path.parse(path.resolve("/")).root, "tmp", "ade-lane");
    const request = summarizeCursorHook({
      toolName: "shell",
      toolInput: { command: "echo hello" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request, policy, laneRoot })).toBe("allow");
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
    // Build the lane root from the platform's own filesystem root: on Windows
    // `path.resolve` prefixes the current drive, so a hard-coded POSIX path
    // yields a different (drive-prefixed) slug there.
    const fsRoot = path.parse(path.resolve("/")).root;
    const userHomeDir = path.join(fsRoot, "Users", "admin");
    const laneRoot = path.join(userHomeDir, "Projects", "Versic", ".ade", "worktrees", "private-sharing-5d14c47a");
    const slug = cursorProjectSlugForPath(laneRoot);
    // Cursor's own rule: every non-alphanumeric character becomes a dash, runs
    // collapse, leading/trailing dashes are trimmed. The Windows drive letter
    // therefore survives as a leading `C-` segment.
    expect(slug).toBe(cursorProjectSlug(path.resolve(laneRoot)));
    expect(slug).toMatch(/Users-admin-Projects-Versic-ade-worktrees-private-sharing-5d14c47a$/u);

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

  it.skipIf(process.platform === "win32")("denies Cursor support reads when the active project support root is symlinked outside Cursor projects", () => {
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

  it.skipIf(process.platform === "win32")("denies symlink escapes through paths that appear to be inside the lane", () => {
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

describe("cursor sandbox directive", () => {
  const directiveFor = (mode: string, sandboxSupported = true): string =>
    buildCursorSdkLocalRunOptions(
      resolveCursorSdkPolicy({ cursorModeId: mode }),
      { sandboxSupported },
    ).sandboxDirective;

  it("asks for a sandbox in the read-only modes", () => {
    expect(directiveFor("ask")).toBe("enable");
    expect(directiveFor("plan")).toBe("enable");
  });

  it("says nothing in agent mode so the user's sandbox.json decides", () => {
    // An explicit false would return insecure_none without ever reading the
    // user's policy file. ADE has no sandbox UI for this mode, so it must not
    // state an opinion either way.
    expect(directiveFor("agent")).toBe("inherit");
  });

  it("disables the sandbox outright for full access", () => {
    // Full access means no sandbox, including for a user who wrote a policy.
    expect(directiveFor("full-auto")).toBe("disable");
  });

  it("disables the sandbox when the environment cannot provide one", () => {
    // The retry after a ConfigurationError: the alternative is a hard failure,
    // so this is the one case where "false" is the honest answer.
    expect(directiveFor("ask", false)).toBe("disable");
    expect(directiveFor("agent", false)).toBe("disable");
  });
});
