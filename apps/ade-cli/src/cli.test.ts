import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAdeCodeArgs,
  buildCliPlan,
  findProjectRoots,
  formatOutput,
  graphWaitState,
  isEphemeralRuntimeSocketPath,
  isFailedServiceManagerResult,
  parseCliArgs,
  readRuntimeIdleExitMs,
  renderLaneGraph,
  resolveRoots,
  shouldAutoRegisterProjectForPlan,
  shouldAttemptDesktopSocketConnection,
  summarizeExecution,
  unwrapToolResult,
} from "./cli";

type ResolveRootsOptions = Parameters<typeof resolveRoots>[0];

function baseResolveOpts(): Omit<
  ResolveRootsOptions,
  "projectRoot" | "workspaceRoot"
> {
  return {
    role: "external",
    headless: true,
    requireSocket: false,
    pretty: false,
    text: false,
    timeoutMs: 15_000,
  };
}

describe("ADE CLI", () => {
  it("parses global options without stealing command flags", () => {
    const parsed = parseCliArgs([
      "--project-root",
      "/tmp/project",
      "--role",
      "cto",
      "actions",
      "run",
      "git.stageFile",
      "--arg",
      "laneId=lane-1",
    ]);

    expect(parsed.options.projectRoot).toBe("/tmp/project");
    expect(parsed.options.role).toBe("cto");
    expect(parsed.command).toEqual([
      "actions",
      "run",
      "git.stageFile",
      "--arg",
      "laneId=lane-1",
    ]);
  });

  it("defaults ordinary CLI calls to the agent runtime role", () => {
    const previousRole = process.env.ADE_DEFAULT_ROLE;
    delete process.env.ADE_DEFAULT_ROLE;
    try {
      const parsed = parseCliArgs(["lanes", "list"]);
      expect(parsed.options.role).toBe("agent");
    } finally {
      if (previousRole === undefined) delete process.env.ADE_DEFAULT_ROLE;
      else process.env.ADE_DEFAULT_ROLE = previousRole;
    }
  });

  it("maps ade code to the terminal Work chat launcher", () => {
    const parsed = parseCliArgs([
      "--project-root",
      "/tmp/project",
      "code",
      "--print-state",
    ]);
    expect(parsed.options.projectRoot).toBe("/tmp/project");
    expect(parsed.command).toEqual(["code", "--print-state"]);

    const plan = buildCliPlan(parsed.command);
    expect(plan).toEqual({ kind: "ade-code", rest: ["--print-state"] });
  });

  it("shows socket-aware TUI help for ade code --help", () => {
    const plan = buildCliPlan(["code", "--help"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("ade code --socket /tmp/ade.sock");
    expect(plan.text).toContain("ade code --require-socket");
    expect(plan.text).toContain("ade code --lane <id|name|branch>");
    expect(plan.text).toContain("Command palette");
  });

  it("shows help for bare ade invocations", () => {
    expect(buildCliPlan([])).toEqual({
      kind: "help",
      text: expect.stringContaining(
        "Agent-focused command-line interface for ADE",
      ),
    });
  });

  it("keeps global help on the help surface", () => {
    const plan = buildCliPlan(["--help"]);
    expect(plan.kind).toBe("help");
  });

  it("keeps global version on the version surface", () => {
    const version = buildCliPlan(["--version"]);
    expect(version.kind).toBe("help");
    if (version.kind !== "help") return;
    expect(version.text).toMatch(/^ade \S+\n$/);
    expect(buildCliPlan(["-v"])).toEqual(version);
  });

  it("builds runtime daemon and stdio RPC commands", () => {
    expect(buildCliPlan(["runtime", "status"])).toEqual({
      kind: "runtime",
      rest: ["status"],
    });
    expect(
      buildCliPlan(["runtime", "start", "--socket", "/tmp/ade.sock"]),
    ).toEqual({
      kind: "runtime",
      rest: ["start", "--socket", "/tmp/ade.sock"],
    });
    expect(buildCliPlan(["desktop"])).toEqual({
      kind: "desktop",
      rest: [],
    });
    expect(
      buildCliPlan(["serve", "--socket", "/tmp/ade.sock", "--port", "7777"]),
    ).toEqual({
      kind: "serve",
      rest: ["--socket", "/tmp/ade.sock", "--port", "7777"],
    });
    expect(buildCliPlan(["serve", "--service-status"])).toEqual({
      kind: "serve",
      rest: ["--service-status"],
    });
    expect(buildCliPlan(["rpc", "--stdio"])).toEqual({
      kind: "rpc-stdio",
      rest: [],
    });
    expect(buildCliPlan(["rpc", "stdio", "--trace"])).toEqual({
      kind: "rpc-stdio",
      rest: ["--trace"],
    });
  });

  it("classifies only ADE temp runtime sockets as ephemeral", () => {
    const tempSocket = path.join(os.tmpdir(), "ade-stdio-rpc-test", "sock", "ade.sock");

    expect(isEphemeralRuntimeSocketPath(tempSocket)).toBe(true);
    expect(isEphemeralRuntimeSocketPath(path.join(os.tmpdir(), "other-app", "ade.sock"))).toBe(false);
    expect(isEphemeralRuntimeSocketPath(path.join(os.homedir(), ".ade", "sock", "ade.sock"))).toBe(false);
    expect(isEphemeralRuntimeSocketPath("tcp://127.0.0.1:8765")).toBe(false);
  });

  it("parses runtime idle expiry with a minimum clamp", () => {
    expect(readRuntimeIdleExitMs({ ADE_RUNTIME_IDLE_EXIT_MS: "30000" } as NodeJS.ProcessEnv)).toBe(30_000);
    expect(readRuntimeIdleExitMs({ ADE_RUNTIME_IDLE_EXIT_MS: "100" } as NodeJS.ProcessEnv)).toBe(5_000);
    expect(readRuntimeIdleExitMs({ ADE_RUNTIME_IDLE_EXIT_MS: "nope" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("marks failed service manager results as CLI failures", () => {
    expect(
      isFailedServiceManagerResult({
        ok: false,
        serviceName: "com.ade.runtime",
        action: "install",
        path: "/tmp/com.ade.runtime.plist",
        message: "launchctl failed",
      }),
    ).toBe(true);
    expect(
      isFailedServiceManagerResult({
        ok: true,
        serviceName: "com.ade.runtime",
        action: "install",
        path: "/tmp/com.ade.runtime.plist",
        message: "installed",
      }),
    ).toBe(false);
  });

  it("builds project init command", () => {
    expect(buildCliPlan(["init", "/tmp/project"])).toEqual({
      kind: "init",
      targetPath: "/tmp/project",
    });
    expect(buildCliPlan(["init"])).toEqual({
      kind: "init",
      targetPath: null,
    });
  });

  it("builds machine project registry commands", () => {
    expect(buildCliPlan(["projects", "list"])).toEqual({
      kind: "execute",
      label: "projects list",
      formatter: "projects-list",
      steps: [{ key: "result", method: "projects.list" }],
    });
    expect(buildCliPlan(["project", "add", "/tmp/project"])).toEqual({
      kind: "execute",
      label: "projects add",
      formatter: "projects-list",
      steps: [
        {
          key: "result",
          method: "projects.add",
          params: { rootPath: "/tmp/project" },
        },
      ],
    });
    expect(buildCliPlan(["projects", "remove", "project_abc"])).toEqual({
      kind: "execute",
      label: "projects remove",
      steps: [
        {
          key: "result",
          method: "projects.remove",
          params: { projectId: "project_abc" },
        },
      ],
    });
    expect(
      buildCliPlan(["projects", "touch", "--project-id", "project_abc"]),
    ).toEqual({
      kind: "execute",
      label: "projects touch",
      formatter: "projects-list",
      steps: [
        {
          key: "result",
          method: "projects.touch",
          params: { projectId: "project_abc" },
        },
      ],
    });
  });

  it("does not auto-register cwd for machine-scoped registry commands", () => {
    const projects = buildCliPlan(["projects", "list"]);
    expect(projects.kind).toBe("execute");
    if (projects.kind !== "execute") return;
    expect(shouldAutoRegisterProjectForPlan(projects)).toBe(false);

    const lanes = buildCliPlan(["lanes", "list"]);
    expect(lanes.kind).toBe("execute");
    if (lanes.kind !== "execute") return;
    expect(shouldAutoRegisterProjectForPlan(lanes)).toBe(true);
  });

  it("builds sync status and pairing PIN commands", () => {
    const status = buildCliPlan([
      "sync",
      "status",
      "--include-transfer-readiness",
    ]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps).toEqual([
      {
        key: "result",
        method: "sync.getStatus",
        params: {
          includeTransferReadiness: true,
          forceTransferReadiness: false,
        },
      },
    ]);

    const setPin = buildCliPlan(["sync", "pin", "set", "123456"]);
    expect(setPin.kind).toBe("execute");
    if (setPin.kind !== "execute") return;
    expect(setPin.steps).toEqual([
      {
        key: "result",
        method: "sync.setPin",
        params: { pin: "123456" },
      },
    ]);

    const generatePin = buildCliPlan(["sync", "pin", "generate"]);
    expect(generatePin.kind).toBe("execute");
    if (generatePin.kind !== "execute") return;
    expect(generatePin.steps).toEqual([
      {
        key: "result",
        method: "sync.generatePin",
      },
    ]);
  });

  it("forwards resolved roots and socket intent to ade code", () => {
    const previousRuntimeSocket = process.env.ADE_RUNTIME_SOCKET_PATH;
    const previousRpcSocket = process.env.ADE_RPC_SOCKET_PATH;
    const previousRpcUrl = process.env.ADE_RPC_URL;
    const previousWorkspace = process.env.ADE_WORKSPACE_ROOT;
    delete process.env.ADE_RPC_SOCKET_PATH;
    delete process.env.ADE_RPC_URL;
    delete process.env.ADE_WORKSPACE_ROOT;
    process.env.ADE_RUNTIME_SOCKET_PATH = "/tmp/ade-runtime.sock";
    try {
      const args = buildAdeCodeArgs(["--print-state"], {
        ...baseResolveOpts(),
        projectRoot: "/tmp/project",
        workspaceRoot: null,
        headless: false,
        requireSocket: true,
      });

      expect(args).toEqual([
        "--project-root",
        "/tmp/project",
        "--workspace-root",
        "/tmp/project",
        "--socket",
        "/tmp/ade-runtime.sock",
        "--require-socket",
        "--print-state",
      ]);
    } finally {
      if (previousRuntimeSocket === undefined)
        delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = previousRuntimeSocket;
      if (previousRpcSocket === undefined)
        delete process.env.ADE_RPC_SOCKET_PATH;
      else process.env.ADE_RPC_SOCKET_PATH = previousRpcSocket;
      if (previousRpcUrl === undefined) delete process.env.ADE_RPC_URL;
      else process.env.ADE_RPC_URL = previousRpcUrl;
      if (previousWorkspace === undefined)
        delete process.env.ADE_WORKSPACE_ROOT;
      else process.env.ADE_WORKSPACE_ROOT = previousWorkspace;
    }
  });

  it("preserves command-local value flags that overlap global flags", () => {
    const parsed = parseCliArgs([
      "files",
      "write",
      "src/index.ts",
      "--text",
      "hello",
    ]);
    expect(parsed.options.text).toBe(false);
    expect(parsed.command).toEqual([
      "files",
      "write",
      "src/index.ts",
      "--text",
      "hello",
    ]);

    const plan = buildCliPlan(parsed.command);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "file",
        action: "writeWorkspaceText",
        args: {
          path: "src/index.ts",
          text: "hello",
        },
      },
    });

    const typed = parseCliArgs([
      "ios-sim",
      "type",
      "--value",
      "hello",
      "--text",
    ]);
    expect(typed.options.text).toBe(true);
    expect(typed.command).toEqual(["ios-sim", "type", "--value", "hello"]);
  });

  it("builds a generic ADE action invocation", () => {
    const plan = buildCliPlan([
      "actions",
      "run",
      "git.stageFile",
      "--arg",
      "laneId=lane-1",
      "--arg",
      "path=src/index.ts",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps).toEqual([
      {
        key: "result",
        method: "ade/actions/call",
        params: {
          name: "run_ade_action",
          arguments: {
            domain: "git",
            action: "stageFile",
            args: {
              laneId: "lane-1",
              path: "src/index.ts",
            },
          },
        },
        unwrapToolResult: true,
      },
    ]);
  });

  it("builds a diff patch invocation with an explicit path flag", () => {
    const parsed = parseCliArgs([
      "diff",
      "patch",
      "--lane",
      "main",
      "--path",
      "file.txt",
      "--text",
    ]);
    expect(parsed.options.text).toBe(true);

    const plan = buildCliPlan(parsed.command);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan).toEqual({
      kind: "execute",
      label: "diff patch",
      steps: [
        {
          key: "result",
          method: "ade/actions/call",
          params: {
            name: "run_ade_action",
            arguments: {
              domain: "diff",
              action: "getFilePatch",
              args: {
                filePath: "file.txt",
                mode: "unstaged",
                compareRef: null,
                compareTo: null,
                laneId: "main",
              },
            },
          },
          unwrapToolResult: true,
        },
      ],
    });
  });

  it("builds nested generic ADE action args", () => {
    const plan = buildCliPlan([
      "actions",
      "run",
      "git.status",
      "--arg",
      "filters.clean=false",
      "--arg-json",
      'metadata.tags=["review"]',
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "status",
        args: {
          filters: {
            clean: false,
          },
          metadata: {
            tags: ["review"],
          },
        },
      },
    });
  });

  it("builds documented generic ADE action JSON shapes", () => {
    const objectCall = buildCliPlan([
      "actions",
      "run",
      "git.push",
      "--input-json",
      '{"laneId":"lane-1","setUpstream":true}',
    ]);
    expect(objectCall.kind).toBe("execute");
    if (objectCall.kind !== "execute") return;
    expect(objectCall.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "push",
        args: {
          laneId: "lane-1",
          setUpstream: true,
        },
      },
    });

    const argsListCall = buildCliPlan([
      "actions",
      "run",
      "issue_inventory.savePipelineSettings",
      "--args-list-json",
      '["pr-1",{"maxRounds":3}]',
    ]);
    expect(argsListCall.kind).toBe("execute");
    if (argsListCall.kind !== "execute") return;
    expect(argsListCall.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "issue_inventory",
        action: "savePipelineSettings",
        argsList: ["pr-1", { maxRounds: 3 }],
      },
    });

    const scalarCall = buildCliPlan([
      "actions",
      "run",
      "git.getConflictState",
      "--scalar",
      "lane-1",
    ]);
    expect(scalarCall.kind).toBe("execute");
    if (scalarCall.kind !== "execute") return;
    expect(scalarCall.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "getConflictState",
        arg: "lane-1",
      },
    });
  });







  it("reads wait state from run graphs with a nested visual graph", () => {
    const waitState = graphWaitState({
      domain: "graph_state",
      action: "getRunGraph",
      result: {
        graph: {
          run: { id: "run-1", status: "succeeded" },
          steps: [{ id: "step-1", status: "succeeded" }],
          attempts: [{ id: "attempt-1", status: "completed" }],
          graph: { nodes: [], edges: [] },
        },
      },
    });

    expect(waitState).toEqual({ status: "succeeded", activeCount: 0 });
  });



  it("rejects invalid JSON action shapes before execution", () => {
    expect(() =>
      buildCliPlan(["actions", "run", "git.push", "--input-json", "[1,2]"]),
    ).toThrow(/--input-json must be a JSON object/);
    expect(() =>
      buildCliPlan([
        "actions",
        "run",
        "git.push",
        "--args-list-json",
        '{"laneId":"lane-1"}',
      ]),
    ).toThrow(/--args-list-json must be a JSON array/);
  });

  it("builds chat create with both model and modelId plus generic args", () => {
    const plan = buildCliPlan([
      "chat",
      "create",
      "--lane",
      "lane-1",
      "--provider",
      "claude",
      "--model",
      "anthropic/claude-opus-4-7-1m",
      "--permissions",
      "full-auto",
      "--arg",
      "reasoningEffort=xhigh",
      "--arg",
      "openInUi=true",
    ]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "createSession",
        args: {
          laneId: "lane-1",
          provider: "claude",
          model: "anthropic/claude-opus-4-7-1m",
          modelId: "anthropic/claude-opus-4-7-1m",
          permissionMode: "full-auto",
          droidPermissionMode: null,
          title: null,
          surface: "work",
          reasoningEffort: "xhigh",
          openInUi: true,
        },
      },
    });
  });

  it("rejects --print=value on chat send", () => {
    expect(() => buildCliPlan([
      "chat",
      "send",
      "chat-1",
      "--print=true",
      "--text",
      "Hello",
    ])).toThrow(/--print must be set at session creation time/);
  });

  it("builds chat show/status as positional session summary calls", () => {
    const show = buildCliPlan(["chat", "show", "chat-1"]);
    expect(show.kind).toBe("execute");
    if (show.kind !== "execute") return;
    expect(show.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "getSessionSummary",
        argsList: ["chat-1"],
      },
    });

    const status = buildCliPlan(["chat", "status", "--session-id", "chat-2"]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "getSessionSummary",
        argsList: ["chat-2"],
      },
    });
  });

  it("requires a chat session id for chat show", () => {
    expect(() => buildCliPlan(["chat", "show"])).toThrow(
      /sessionId is required/,
    );
  });

  it("builds chat slash commands for a positional session id", () => {
    const plan = buildCliPlan(["chat", "slash", "chat-1"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("chat slash commands");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "chat",
        action: "getSlashCommands",
        args: { sessionId: "chat-1" },
      },
    });
    expect(() => buildCliPlan(["chat", "slash"])).toThrow(
      /sessionId is required/,
    );
  });

  it("rejects prototype-sensitive generic ADE action arg paths", () => {
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    for (const arg of [
      "__proto__.polluted=true",
      "safe.__proto__.polluted=true",
      "constructor.prototype.polluted=true",
    ]) {
      expect(() =>
        buildCliPlan(["actions", "run", "git.status", "--arg", arg]),
      ).toThrow(/not allowed/);
    }

    expect(() =>
      buildCliPlan([
        "actions",
        "run",
        "git.status",
        "--arg-json",
        "prototype.polluted=true",
      ]),
    ).toThrow(/not allowed/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("maps Path to Merge start to pipeline settings plus resolver tool", () => {
    const plan = buildCliPlan([
      "prs",
      "path-to-merge",
      "pr-1",
      "--model",
      "gpt-5.4",
      "--max-rounds",
      "3",
      "--no-auto-merge",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "issue_inventory",
        action: "savePipelineSettings",
        argsList: ["pr-1", { maxRounds: 3, autoMerge: false }],
      },
    });
    expect(plan.steps[1]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "path_to_merge",
        action: "startPathToMerge",
        args: {
          prId: "pr-1",
          scope: "both",
          modelId: "gpt-5.4",
        },
      },
    });
  });

  it("forwards new pipeline-settings flags through Path to Merge", () => {
    const plan = buildCliPlan([
      "prs",
      "path-to-merge",
      "pr-2",
      "--model",
      "gpt-5.4",
      "--conflict-strategy",
      "auto",
      "--force-finalize",
      "conditional",
      "--at-cap-policy",
      "ci_retry_loop",
      "--at-cap-wait-minutes",
      "12",
      "--at-cap-ci-retry-max",
      "4",
      "--no-force-merge-requires-confirmation",
      "--no-early-merge-on-green",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "issue_inventory",
        action: "savePipelineSettings",
        argsList: [
          "pr-2",
          {
            conflictStrategy: "auto",
            forceFinalizeMode: "conditional",
            atCapPolicy: "ci_retry_loop",
            atCapWaitMinutes: 12,
            atCapCiRetryMax: 4,
            forceMergeRequiresConfirmation: false,
            earlyMergeOnGreen: false,
          },
        ],
      },
    });
    expect(plan.steps[1]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "path_to_merge",
        action: "startPathToMerge",
        args: {
          prId: "pr-2",
          scope: "both",
          modelId: "gpt-5.4",
        },
      },
    });
  });

  it("rejects invalid pipeline-settings enum values", () => {
    expect(() =>
      buildCliPlan([
        "prs",
        "path-to-merge",
        "pr-3",
        "--model",
        "gpt-5.4",
        "--conflict-strategy",
        "wat",
      ]),
    ).toThrow(/--conflict-strategy must be one of/);
    expect(() =>
      buildCliPlan([
        "prs",
        "path-to-merge",
        "pr-3",
        "--model",
        "gpt-5.4",
        "--force-finalize",
        "always",
      ]),
    ).toThrow(/--force-finalize must be one of/);
    expect(() =>
      buildCliPlan([
        "prs",
        "path-to-merge",
        "pr-3",
        "--model",
        "gpt-5.4",
        "--at-cap-policy",
        "forever",
      ]),
    ).toThrow(/--at-cap-policy must be one of/);
    expect(() =>
      buildCliPlan([
        "prs",
        "path-to-merge",
        "pr-3",
        "--model",
        "gpt-5.4",
        "--at-cap-wait-minutes",
        "0",
      ]),
    ).toThrow(/--at-cap-wait-minutes must be at least 1/);
  });

  it("validates required arguments before service execution", () => {
    expect(() => buildCliPlan(["lanes", "create"])).toThrow(/name is required/);
    expect(() => buildCliPlan(["lanes", "child", "--name", "child"])).toThrow(
      /parent lane is required/,
    );
    expect(() => buildCliPlan(["diff", "file", "--lane", "main"])).toThrow(
      /path is required/,
    );
    expect(() => buildCliPlan(["diff", "patch", "--lane", "main"])).toThrow(
      /path is required/,
    );
    expect(() => buildCliPlan(["files", "write", "src/index.ts"])).toThrow(
      /--text, --from-file, or --stdin/,
    );
    expect(() => buildCliPlan(["chat", "send", "hello"])).toThrow(
      /message text is required/,
    );
    expect(() =>
      buildCliPlan(["agent", "spawn", "--prompt", "fix it"]),
    ).toThrow(/laneId is required/);
    expect(() => buildCliPlan(["tests", "run", "--lane", "main"])).toThrow(
      /--suite <id> or --command/,
    );
  });

  it("unwraps typed ADE action results while preserving actions run envelopes", () => {
    const connection = {
      mode: "headless" as const,
      projectRoot: "/tmp/project",
      workspaceRoot: "/tmp/project",
      socketPath: "/tmp/project/.ade/ade.sock",
      request: async () => null,
      close: () => {},
    };

    const typed = summarizeExecution({
      plan: { kind: "execute", label: "git status", steps: [] },
      connection,
      values: {
        result: {
          domain: "git",
          action: "getStatus",
          result: { clean: true },
          statusHints: {},
        },
      },
    } as any);
    expect(typed).toEqual({ clean: true });

    const escapeHatch = summarizeExecution({
      plan: { kind: "execute", label: "action run", steps: [] },
      connection,
      values: {
        result: {
          domain: "git",
          action: "getStatus",
          result: { clean: true },
          statusHints: {},
        },
      },
    } as any);
    expect(escapeHatch).toMatchObject({
      domain: "git",
      action: "getStatus",
      result: { clean: true },
    });
  });


  it("turns ADE action failure envelopes into CLI tool errors", () => {
    expect(() =>
      unwrapToolResult({
        ok: false,
        error: {
          code: -32011,
          message: "Action 'git.nonexistent_action' is not callable.",
        },
      }),
    ).toThrow(/not callable/);
  });

  it("renders richer doctor text", () => {
    const output = formatOutput(
      {
        ok: true,
        cliVersion: "0.0.0",
        mode: "headless",
        projectRoot: "/tmp/project",
        workspaceRoot: "/tmp/project",
        project: { projectInitialized: true },
        desktop: {
          socketAvailable: false,
          socketPath: "/tmp/project/.ade/ade.sock",
        },
        actions: { rpcActionCount: 10, actionCount: 42 },
        git: { message: "Git repository detected on main." },
        github: {
          message:
            "GitHub remote detected and a local auth mechanism is available.",
        },
        linear: { message: "Linear credentials are present locally." },
        providers: {
          message:
            "AI provider configuration or provider CLI availability was detected locally.",
        },
        computerUse: {
          message: "Local macOS computer-use fallback commands are available.",
        },
        path: { message: "ade is available on PATH." },
        recommendation: "Using live ADE desktop state.",
        recommendations: [],
      },
      {
        projectRoot: null,
        workspaceRoot: null,
        role: "agent",
        headless: false,
        requireSocket: false,
        pretty: true,
        text: true,
        timeoutMs: 1000,
      },
      "doctor",
    );

    expect(output).toContain("ADE doctor");
    expect(output).toContain("cli version");
    expect(output).toContain("service actions");
    expect(output).toContain("Git repository detected");
  });

  it("attempts Windows named-pipe desktop sockets without filesystem existence checks", () => {
    expect(shouldAttemptDesktopSocketConnection("\\\\.\\pipe\\ade-123")).toBe(
      true,
    );
    expect(shouldAttemptDesktopSocketConnection("//./pipe/ade-123")).toBe(true);
  });

  it("renders a compact lane graph", () => {
    const graph = renderLaneGraph({
      lanes: [
        { id: "main", name: "main", branchRef: "main" },
        {
          id: "child",
          name: "child",
          branchRef: "feature",
          parentLaneId: "main",
        },
        {
          id: "sibling",
          name: "sibling",
          branchRef: "feature-2",
          parentLaneId: "main",
        },
      ],
    });

    expect(graph).toContain("ADE lanes");
    expect(graph).toContain("\\- main (id: main) [main]");
    expect(graph).toContain("|- child (id: child) [feature]");
    expect(graph).toContain("\\- sibling (id: sibling) [feature-2]");
  });

  it("accepts --option=value syntax equivalently to --option value", () => {
    const spaced = parseCliArgs([
      "--project-root",
      "/tmp/project",
      "--role",
      "cto",
      "lanes",
      "list",
    ]);
    const joined = parseCliArgs([
      "--project-root=/tmp/project",
      "--role=cto",
      "lanes",
      "list",
    ]);
    expect(joined.options.projectRoot).toBe(spaced.options.projectRoot);
    expect(joined.options.role).toBe("cto");
    expect(joined.command).toEqual(["lanes", "list"]);
  });

  it("prefers headless mode for local proof capture commands", () => {
    const screenshot = buildCliPlan(["proof", "screenshot"]);
    const capture = buildCliPlan([
      "proof",
      "capture",
      "--caption",
      "Done",
      "--owner-kind",
      "chat",
      "--owner-id",
      "chat-1",
    ]);
    const record = buildCliPlan(["proof", "record", "--seconds", "3"]);
    const list = buildCliPlan(["proof", "list"]);

    expect(screenshot.kind).toBe("execute");
    expect(capture.kind).toBe("execute");
    expect(record.kind).toBe("execute");
    expect(list.kind).toBe("execute");
    if (
      screenshot.kind !== "execute" ||
      capture.kind !== "execute" ||
      record.kind !== "execute" ||
      list.kind !== "execute"
    )
      return;

    expect(screenshot.preferHeadless).toBe(true);
    expect(capture.preferHeadless).toBe(true);
    expect(capture.steps[0]?.params).toMatchObject({
      name: "screenshot_environment",
      arguments: {
        name: "Done",
        ownerKind: "chat",
        ownerId: "chat-1",
      },
    });
    expect(record.preferHeadless).toBe(true);
    expect(list.preferHeadless).toBeUndefined();
  });

  it("maps proof attach to visual artifact ingestion", () => {
    const plan = buildCliPlan([
      "proof",
      "attach",
      "/tmp/done.png",
      "--caption",
      "Checkout complete",
      "--owner-kind",
      "chat",
      "--owner-id",
      "chat-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps[0]?.params).toMatchObject({
      name: "ingest_computer_use_artifacts",
      arguments: {
        backendStyle: "manual",
        backendName: "ade-cli",
        toolName: "proof attach",
        ownerKind: "chat",
        ownerId: "chat-1",
        inputs: [
          {
            kind: "screenshot",
            title: "Checkout complete",
            description: "Checkout complete",
            path: "/tmp/done.png",
          },
        ],
      },
    });
  });

  it("rejects invalid --role values", () => {
    expect(() => parseCliArgs(["--role", "bogus", "lanes", "list"])).toThrow(
      /--role must be one of/,
    );
  });

  it("maps default lanes/git/prs subcommands to the right RPC actions", () => {
    const lanes = buildCliPlan(["lanes", "list"]);
    expect(lanes.kind).toBe("execute");
    if (lanes.kind !== "execute") return;
    expect(lanes.visualizer).toBe("lanes");
    expect(lanes.steps[0]?.params).toEqual({
      name: "list_lanes",
      arguments: { includeArchived: false },
    });

    const git = buildCliPlan(["git", "status"]);
    expect(git.kind).toBe("execute");
    if (git.kind !== "execute") return;
    expect(git.steps[0]?.params).toEqual({
      name: "git_get_sync_status",
      arguments: {},
    });

    const prs = buildCliPlan(["prs", "list"]);
    expect(prs.kind).toBe("execute");
    if (prs.kind !== "execute") return;
    expect(prs.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "pr", action: "listAll", args: {} },
    });
  });

  it("maps git user-identity and prs list-open to typed RPC tools", () => {
    const identity = buildCliPlan(["git", "user-identity"]);
    expect(identity.kind).toBe("execute");
    if (identity.kind !== "execute") return;
    expect(identity.steps[0]?.params).toEqual({
      name: "git_get_user_identity",
      arguments: {},
    });

    const openPrs = buildCliPlan(["prs", "list-open"]);
    expect(openPrs.kind).toBe("execute");
    if (openPrs.kind !== "execute") return;
    expect(openPrs.steps[0]?.params).toEqual({
      name: "prs_list_open",
      arguments: {},
    });
  });

  it("forwards lane reparent stack base branch override to the runtime action", () => {
    const reparent = buildCliPlan([
      "lanes",
      "reparent",
      "lane-child",
      "--parent",
      "lane-parent",
      "--stack-base-branch",
      "develop",
    ]);
    expect(reparent.kind).toBe("execute");
    if (reparent.kind !== "execute") return;
    expect(reparent.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "reparent",
        args: {
          laneId: "lane-child",
          newParentLaneId: "lane-parent",
          stackBaseBranchRef: "develop",
        },
      },
    });

    const reparentDefault = buildCliPlan([
      "lanes",
      "reparent",
      "lane-child",
      "--parent",
      "lane-parent",
    ]);
    expect(reparentDefault.kind).toBe("execute");
    if (reparentDefault.kind !== "execute") return;
    expect(reparentDefault.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "reparent",
        args: {
          laneId: "lane-child",
          newParentLaneId: "lane-parent",
        },
      },
    });
  });

  it("forwards PR GitHub snapshot full-history flag to the runtime action", () => {
    const snapshot = buildCliPlan([
      "prs",
      "github-snapshot",
      "--include-external-closed",
    ]);
    expect(snapshot.kind).toBe("execute");
    if (snapshot.kind !== "execute") return;
    expect(snapshot.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "pr",
        action: "getGithubSnapshot",
        args: {
          force: false,
          includeExternalClosed: true,
        },
      },
    });
  });

  it("maps discoverable git status, sync, and conflict helpers to existing actions", () => {
    const fullStatus = buildCliPlan([
      "git",
      "status",
      "--full",
      "--lane",
      "lane-1",
    ]);
    expect(fullStatus.kind).toBe("execute");
    if (fullStatus.kind !== "execute") return;
    expect(fullStatus.label).toBe("lane status");
    expect(fullStatus.steps[0]?.params).toEqual({
      name: "get_lane_status",
      arguments: { laneId: "lane-1" },
    });

    const sync = buildCliPlan([
      "git",
      "sync",
      "--lane",
      "lane-1",
      "--rebase",
      "--base",
      "main",
    ]);
    expect(sync.kind).toBe("execute");
    if (sync.kind !== "execute") return;
    expect(sync.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "sync",
        args: { laneId: "lane-1", mode: "rebase", baseRef: "main" },
      },
    });

    const pull = buildCliPlan([
      "git",
      "pull",
      "--lane",
      "lane-1",
      "--rebase",
    ]);
    expect(pull.kind).toBe("execute");
    if (pull.kind !== "execute") return;
    expect(pull.steps[0]?.params).toEqual({
      name: "git_pull",
      arguments: { laneId: "lane-1", mode: "rebase" },
    });
    expect(() =>
      buildCliPlan([
        "git",
        "pull",
        "--lane",
        "lane-1",
        "--mode",
        "merge",
        "--rebase",
      ]),
    ).toThrow(/either --mode or a mode flag/);

    const undo = buildCliPlan([
      "git",
      "undo",
      "--lane",
      "lane-1",
    ]);
    expect(undo.kind).toBe("execute");
    if (undo.kind !== "execute") return;
    expect(undo.steps[0]?.params).toEqual({
      name: "git_undo_last_head_change",
      arguments: { laneId: "lane-1" },
    });

    const redo = buildCliPlan([
      "git",
      "redo",
      "--lane",
      "lane-1",
    ]);
    expect(redo.kind).toBe("execute");
    if (redo.kind !== "execute") return;
    expect(redo.steps[0]?.params).toEqual({
      name: "git_redo_last_head_change",
      arguments: { laneId: "lane-1" },
    });

    const conflictShow = buildCliPlan([
      "git",
      "conflict",
      "show",
      "--lane",
      "lane-1",
    ]);
    expect(conflictShow.kind).toBe("execute");
    if (conflictShow.kind !== "execute") return;
    expect(conflictShow.steps[0]?.params).toEqual({
      name: "get_lane_conflict_state",
      arguments: { laneId: "lane-1" },
    });

    const conflictResolve = buildCliPlan([
      "git",
      "conflict",
      "resolve",
      "--lane",
      "lane-1",
      "--kind",
      "rebase",
    ]);
    expect(conflictResolve.kind).toBe("execute");
    if (conflictResolve.kind !== "execute") return;
    expect(conflictResolve.steps[0]?.params).toEqual({
      name: "rebase_continue",
      arguments: { laneId: "lane-1" },
    });

    const push = buildCliPlan([
      "git",
      "push",
      "--lane",
      "lane-1",
      "--set-upstream",
      "--force-with-lease",
    ]);
    expect(push.kind).toBe("execute");
    if (push.kind !== "execute") return;
    expect(push.steps[0]?.params).toEqual({
      name: "git_push",
      arguments: { laneId: "lane-1", forceWithLease: true, setUpstream: true },
    });
  });

  it("resolves stash OIDs before CLI pop and drop actions", () => {
    const pop = buildCliPlan([
      "git",
      "stash",
      "pop",
      "stash@{0}",
      "--lane",
      "lane-1",
    ]);
    expect(pop.kind).toBe("execute");
    if (pop.kind !== "execute") return;
    expect(pop.steps[0]?.params).toEqual({
      name: "list_stashes",
      arguments: { laneId: "lane-1" },
    });
    const popParams = typeof pop.steps[1]?.params === "function"
      ? pop.steps[1].params({ stashes: { stashes: [{ ref: "stash@{0}", oid: "oid-0" }] } })
      : pop.steps[1]?.params;
    expect(popParams).toEqual({
      name: "stash_pop",
      arguments: {
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-0",
      },
    });

    const drop = buildCliPlan([
      "git",
      "stash",
      "drop",
      "stash@{1}",
      "--lane",
      "lane-1",
    ]);
    expect(drop.kind).toBe("execute");
    if (drop.kind !== "execute") return;
    const dropParams = typeof drop.steps[1]?.params === "function"
      ? drop.steps[1].params({ stashes: { stashes: [{ ref: "stash@{1}", oid: "oid-1" }] } })
      : drop.steps[1]?.params;
    expect(dropParams).toEqual({
      name: "stash_drop",
      arguments: {
        laneId: "lane-1",
        stashRef: "stash@{1}",
        stashOid: "oid-1",
      },
    });
  });

  it("uses the latest lane stash when CLI pop omits a stash ref", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "pop",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    const params = typeof plan.steps[1]?.params === "function"
      ? plan.steps[1].params({ stashes: { stashes: [{ ref: "stash@{3}", oid: "oid-3" }] } })
      : plan.steps[1]?.params;
    expect(params).toEqual({
      name: "stash_pop",
      arguments: {
        laneId: "lane-1",
        stashRef: "stash@{3}",
        stashOid: "oid-3",
      },
    });
  });

  it("resolves a stash ref from an explicit OID when CLI stash omits the ref", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "drop",
      "--stash-oid",
      "oid-3",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    const params = typeof plan.steps[1]?.params === "function"
      ? plan.steps[1].params({
        stashes: {
          stashes: [
            { ref: "stash@{0}", oid: "oid-0" },
            { ref: "stash@{3}", oid: "oid-3" },
          ],
        },
      })
      : plan.steps[1]?.params;
    expect(params).toEqual({
      name: "stash_drop",
      arguments: {
        laneId: "lane-1",
        stashRef: "stash@{3}",
        stashOid: "oid-3",
      },
    });
  });

  it("keeps explicit stash OIDs on direct CLI stash calls", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "drop",
      "stash@{0}",
      "--oid",
      "oid-0",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.params).toEqual({
      name: "stash_drop",
      arguments: {
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-0",
      },
    });
  });

  it("throws a clear CLI error when a stash ref cannot be resolved to an OID", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "pop",
      "stash@{2}",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(() => {
      if (typeof plan.steps[1]?.params !== "function") throw new Error("Expected resolver params.");
      plan.steps[1].params({ stashes: { stashes: [{ ref: "stash@{0}", oid: "oid-0" }] } });
    }).toThrow(/Stash stash@\{2\} is not saved for this lane/);
  });

  it("throws a clear CLI error when a stash OID cannot be resolved to a ref", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "drop",
      "--stash-oid",
      "oid-9",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(() => {
      if (typeof plan.steps[1]?.params !== "function") throw new Error("Expected resolver params.");
      plan.steps[1].params({ stashes: { stashes: [{ ref: "stash@{0}", oid: "oid-0" }] } });
    }).toThrow(/Stash OID oid-9 is not saved for this lane/);
  });

  it("throws a clear CLI error when no default lane stash exists", () => {
    const plan = buildCliPlan([
      "git",
      "stash",
      "drop",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(() => {
      if (typeof plan.steps[1]?.params !== "function") throw new Error("Expected resolver params.");
      plan.steps[1].params({ stashes: { stashes: [] } });
    }).toThrow(/No saved stashes were found for this lane/);
  });

  it("preserves the public git push --set-upstream flag", () => {
    const plan = buildCliPlan([
      "git",
      "push",
      "--lane",
      "lane-1",
      "--set-upstream",
      "--force-with-lease",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "git_push",
      arguments: {
        laneId: "lane-1",
        forceWithLease: true,
        setUpstream: true,
      },
    });
  });

  it("maps action and operation wait aliases to the ADE status poller", () => {
    const actionWait = buildCliPlan([
      "actions",
      "wait",
      "--operation",
      "op-1",
      "--previous-hash",
      "abc",
    ]);
    expect(actionWait.kind).toBe("execute");
    if (actionWait.kind !== "execute") return;
    expect(actionWait.steps[0]?.params).toEqual({
      name: "get_ade_action_status",
      arguments: {
        operationId: "op-1",
        previousHash: "abc",
        waitForMs: 30_000,
      },
    });

    const operationStatus = buildCliPlan([
      "operations",
      "status",
      "--test-run",
      "test-1",
      "--wait-ms",
      "5000",
    ]);
    expect(operationStatus.kind).toBe("execute");
    if (operationStatus.kind !== "execute") return;
    expect(operationStatus.steps[0]?.params).toEqual({
      name: "get_ade_action_status",
      arguments: { testRunId: "test-1", waitForMs: 5000 },
    });
  });

  it("uses the parent ADE project when invoked inside an ADE-managed lane worktree", () => {
    const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-roots-"));
    // findProjectRoots canonicalizes symlinks (e.g. /var -> /private/var on macOS).
    const root = fs.realpathSync.native(rawRoot);
    const worktree = path.join(root, ".ade", "worktrees", "feature-lane");
    const nested = path.join(worktree, "apps", "ade-cli");
    fs.mkdirSync(path.join(root, ".ade"), { recursive: true });
    fs.mkdirSync(path.join(worktree, ".ade"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    expect(findProjectRoots(nested)).toEqual({
      projectRoot: root,
      workspaceRoot: worktree,
    });
  });

  it("defaults workspaceRoot to projectRoot when ADE_PROJECT_ROOT overrides discovery", () => {
    const prevProject = process.env.ADE_PROJECT_ROOT;
    const prevWorkspace = process.env.ADE_WORKSPACE_ROOT;
    try {
      delete process.env.ADE_WORKSPACE_ROOT;
      process.env.ADE_PROJECT_ROOT = "/explicit/project-root";
      const roots = resolveRoots({
        ...baseResolveOpts(),
        projectRoot: null,
        workspaceRoot: null,
      });
      expect(roots.projectRoot).toBe("/explicit/project-root");
      expect(roots.workspaceRoot).toBe("/explicit/project-root");
    } finally {
      if (prevProject === undefined) delete process.env.ADE_PROJECT_ROOT;
      else process.env.ADE_PROJECT_ROOT = prevProject;
      if (prevWorkspace === undefined) delete process.env.ADE_WORKSPACE_ROOT;
      else process.env.ADE_WORKSPACE_ROOT = prevWorkspace;
    }
  });

  it("defaults workspaceRoot to CLI projectRoot when only --project-root is set", () => {
    const prevProject = process.env.ADE_PROJECT_ROOT;
    const prevWorkspace = process.env.ADE_WORKSPACE_ROOT;
    try {
      delete process.env.ADE_PROJECT_ROOT;
      delete process.env.ADE_WORKSPACE_ROOT;
      const roots = resolveRoots({
        ...baseResolveOpts(),
        projectRoot: "/cli/project-root",
        workspaceRoot: null,
      });
      expect(roots.projectRoot).toBe("/cli/project-root");
      expect(roots.workspaceRoot).toBe("/cli/project-root");
    } finally {
      if (prevProject === undefined) delete process.env.ADE_PROJECT_ROOT;
      else process.env.ADE_PROJECT_ROOT = prevProject;
      if (prevWorkspace === undefined) delete process.env.ADE_WORKSPACE_ROOT;
      else process.env.ADE_WORKSPACE_ROOT = prevWorkspace;
    }
  });

  it("still honors ADE_WORKSPACE_ROOT when both project and workspace overrides exist", () => {
    const prevProject = process.env.ADE_PROJECT_ROOT;
    const prevWorkspace = process.env.ADE_WORKSPACE_ROOT;
    try {
      process.env.ADE_PROJECT_ROOT = "/explicit/project-root";
      process.env.ADE_WORKSPACE_ROOT = "/explicit/workspace-root";
      const roots = resolveRoots({
        ...baseResolveOpts(),
        projectRoot: null,
        workspaceRoot: null,
      });
      expect(roots.projectRoot).toBe("/explicit/project-root");
      expect(roots.workspaceRoot).toBe("/explicit/workspace-root");
    } finally {
      if (prevProject === undefined) delete process.env.ADE_PROJECT_ROOT;
      else process.env.ADE_PROJECT_ROOT = prevProject;
      if (prevWorkspace === undefined) delete process.env.ADE_WORKSPACE_ROOT;
      else process.env.ADE_WORKSPACE_ROOT = prevWorkspace;
    }
  });

  it("maps PR link arguments to the service contract", () => {
    const plan = buildCliPlan([
      "prs",
      "link",
      "--lane",
      "lane-1",
      "--url",
      "https://github.com/acme/ade/pull/123",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "pr",
        action: "linkToLane",
        args: {
          laneId: "lane-1",
          prUrlOrNumber: "https://github.com/acme/ade/pull/123",
        },
      },
    });
  });

  it("maps `git checkout <branch>` to git_checkout_branch with mode=existing by default", () => {
    const plan = buildCliPlan([
      "git",
      "checkout",
      "feature/foo",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps[0]?.params).toEqual({
      name: "git_checkout_branch",
      arguments: {
        laneId: "lane-1",
        branchName: "feature/foo",
        mode: "existing",
        acknowledgeActiveWork: false,
      },
    });
  });

  it("maps `git checkout --create` to mode=create with optional --from/--base", () => {
    const plan = buildCliPlan([
      "git",
      "checkout",
      "feature/new",
      "--lane",
      "lane-1",
      "--create",
      "--from",
      "main",
      "--base",
      "main",
      "--ack-active-work",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;

    expect(plan.steps[0]?.params).toEqual({
      name: "git_checkout_branch",
      arguments: {
        laneId: "lane-1",
        branchName: "feature/new",
        mode: "create",
        startPoint: "main",
        baseRef: "main",
        acknowledgeActiveWork: true,
      },
    });
  });

  it("accepts the `-b` short flag as an alias for --create", () => {
    const plan = buildCliPlan([
      "git",
      "checkout",
      "topic-1",
      "--lane",
      "lane-1",
      "-b",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    const args = (
      plan.steps[0]?.params as { arguments: Record<string, unknown> }
    ).arguments;
    expect(args.mode).toBe("create");
    expect(args.branchName).toBe("topic-1");
  });

  it("omits startPoint and baseRef from the call when not supplied", () => {
    const plan = buildCliPlan([
      "git",
      "checkout",
      "feature/x",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    const args = (
      plan.steps[0]?.params as { arguments: Record<string, unknown> }
    ).arguments;
    expect(args).not.toHaveProperty("startPoint");
    expect(args).not.toHaveProperty("baseRef");
  });

  it("rejects `git checkout` without a branch name", () => {
    expect(() => buildCliPlan(["git", "checkout", "--lane", "lane-1"])).toThrow(
      /branchName/,
    );
  });

  it("shows command help from subcommand help flags", () => {
    const prsHelp = buildCliPlan(["prs", "create", "--help"]);
    expect(prsHelp.kind).toBe("help");
    if (prsHelp.kind !== "help") return;
    expect(prsHelp.text).toContain("PR identifiers may be ADE PR ids");
    expect(prsHelp.text).toContain("prs link");

    const actionsHelp = buildCliPlan(["actions", "run", "--help"]);
    expect(actionsHelp.kind).toBe("help");
    if (actionsHelp.kind !== "help") return;
    expect(actionsHelp.text).toContain("Argument shapes");
    expect(actionsHelp.text).toContain("--args-list-json");

    // Regression: --text as output flag must not swallow --help.
    const lanesHelp = buildCliPlan(["lanes", "list", "--text", "--help"]);
    expect(lanesHelp.kind).toBe("help");

    const reparentHelp = buildCliPlan([
      "lanes",
      "reparent",
      "lane-child",
      "--stack-base-branch",
      "develop",
      "--help",
    ]);
    expect(reparentHelp.kind).toBe("help");
  });

  it("maps PR create Linear close flag to the typed RPC tool", () => {
    const plan = buildCliPlan([
      "prs",
      "create",
      "--lane",
      "lane-1",
      "--title",
      "Linked PR",
      "--body",
      "Body",
      "--close-linear-issue-on-merge",
    ]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "create_pr_from_lane",
      arguments: {
        laneId: "lane-1",
        title: "Linked PR",
        body: "Body",
        draft: false,
        closeLinearIssueOnMerge: true,
      },
    });
  });

  it("summarizes PR create output with GitHub and ADE links", () => {
    const connection = {
      mode: "headless" as const,
      projectRoot: "/tmp/project",
      workspaceRoot: "/tmp/project",
      socketPath: "/tmp/project/.ade/ade.sock",
      request: async () => null,
      close: () => {},
    };
    const summarized = summarizeExecution({
      plan: { kind: "execute", label: "PR create", steps: [] },
      connection,
      values: {
        result: {
          pr: {
            id: "pr-42",
            laneId: "lane-1",
            repoOwner: "acme",
            repoName: "ade",
            githubPrNumber: 42,
            githubUrl: "https://github.com/acme/ade/pull/42",
            title: "Add PR deeplinks",
            state: "open",
          },
        },
      },
    } as any);

    expect(summarized).toMatchObject({
      githubUrl: "https://github.com/acme/ade/pull/42",
      adeUrl: "https://ade.app/open?type=pr&repo=acme%2Fade&number=42",
    });

    const text = formatOutput(
      summarized,
      { ...baseResolveOpts(), projectRoot: null, workspaceRoot: null, text: true },
      "pr-create",
    );
    expect(text).toContain("ADE pull request created");
    expect(text).toContain("GitHub URL");
    expect(text).toContain("https://github.com/acme/ade/pull/42");
    expect(text).toContain("ADE URL");
    expect(text).toContain("https://ade.app/open?type=pr&repo=acme%2Fade&number=42");
  });

  it("maps lane create Linear issue JSON to the typed RPC tool", () => {
    const plan = buildCliPlan([
      "lanes",
      "create",
      "--name",
      "Linked lane",
      "--base",
      "main",
      "--branch-name",
      "ade-123-linked-lane",
      "--linear-issue-json",
      '{"id":"issue-1","identifier":"ADE-123","title":"Linked lane"}',
    ]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "create_lane",
      arguments: {
        name: "Linked lane",
        baseBranch: "main",
        branchName: "ade-123-linked-lane",
        linearIssue: {
          id: "issue-1",
          identifier: "ADE-123",
          title: "Linked lane",
        },
      },
    });
  });

  it("maps existing lane Linear issue linking to the lane action", () => {
    const plan = buildCliPlan([
      "lanes",
      "link-linear-issue",
      "lane-1",
      "--linear-issue-json",
      '{"id":"issue-1","identifier":"ADE-123","title":"Linked lane"}',
      "--source",
      "manual",
      "--no-include-in-pr",
    ]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "linkLinearIssues",
        args: {
          laneId: "lane-1",
          issues: [{
            id: "issue-1",
            identifier: "ADE-123",
            title: "Linked lane",
          }],
          source: "manual",
          includeInPr: false,
        },
      },
    });
  });

  it("maps Linear quick view to the typed RPC tool", () => {
    const plan = buildCliPlan(["linear", "quick-view", "--text"]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("Linear quick view");
    expect(plan.formatter).toBe("linear-quick-view");
    expect(plan.steps[0]?.params).toEqual({
      name: "getLinearQuickView",
      arguments: {},
    });
  });

  it("maps Linear picker data to the typed RPC tool", () => {
    const plan = buildCliPlan(["linear", "picker-data", "--text"]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("Linear picker data");
    expect(plan.steps[0]?.params).toEqual({
      name: "getLinearIssuePickerData",
      arguments: {},
    });
  });

  it("maps Linear search-issues filters to the typed RPC tool", () => {
    const plan = buildCliPlan([
      "linear",
      "search-issues",
      "--project-id",
      "proj-1",
      "--state-type",
      "started,unstarted",
      "--query",
      "auth",
      "--first",
      "25",
      "--include-archived",
    ]);

    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("Linear search issues");
    expect(plan.steps[0]?.params).toEqual({
      name: "searchLinearIssues",
      arguments: {
        projectId: "proj-1",
        stateTypes: ["started", "unstarted"],
        query: "auth",
        first: 25,
        includeArchived: true,
      },
    });
  });

  it("shows focused ios-sim help for subcommand help flags", () => {
    const renderHelp = buildCliPlan(["ios-sim", "preview-render", "--help"]);
    expect(renderHelp.kind).toBe("help");
    if (renderHelp.kind !== "help") return;
    expect(renderHelp.text).toContain("iOS Simulator: preview-render");
    expect(renderHelp.text).toContain("--source, --file <p>");
    expect(renderHelp.text).toContain("--index <n>");
    expect(renderHelp.text).toContain("final command agents should run");

    const aliasHelp = buildCliPlan(["help", "ios", "snapshot"]);
    expect(aliasHelp.kind).toBe("help");
    if (aliasHelp.kind !== "help") return;
    expect(aliasHelp.text).toContain("iOS Simulator: snapshot");
    expect(aliasHelp.text).toContain("ADEInspector/accessibility");

    const targetHelp = buildCliPlan([
      "ios-sim",
      "launch",
      "--target",
      "preview-target",
      "--help",
    ]);
    expect(targetHelp.kind).toBe("help");
    if (targetHelp.kind !== "help") return;
    expect(targetHelp.text).toContain("iOS Simulator: launch");
    expect(targetHelp.text).toContain("--target, --target-id <id>");

    const nestedHelp = buildCliPlan(["ios-sim", "help", "select"]);
    expect(nestedHelp.kind).toBe("help");
    if (nestedHelp.kind !== "help") return;
    expect(nestedHelp.text).toContain("iOS Simulator: select");
    expect(nestedHelp.text).toContain("emits a drawer selection event");

    const typeHelp = buildCliPlan(["ios-sim", "type", "--help"]);
    expect(typeHelp.kind).toBe("help");
    if (typeHelp.kind !== "help") return;
    expect(typeHelp.text).toContain("iOS Simulator: type");
    expect(typeHelp.text).toContain("--value, --message <v>");
  });

  it("shell-escapes argv tokens after -- when building shell start commands", () => {
    const plan = buildCliPlan([
      "shell",
      "start",
      "--lane",
      "lane-1",
      "--",
      "cat",
      "file with spaces.txt",
      "literal&name",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "pty",
        action: "create",
        args: expect.objectContaining({
          laneId: "lane-1",
          startupCommand: "cat 'file with spaces.txt' 'literal&name'",
          toolType: "shell",
          cols: 120,
          rows: 36,
          tracked: true,
        }),
      },
    });
  });

  it("maps provider shell launches to start_cli_session", () => {
    const plan = buildCliPlan([
      "shell",
      "start-cli",
      "codex",
      "--lane",
      "lane-1",
      "--permission-mode",
      "edit",
      "--message",
      "fix the tests",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "start_cli_session",
      arguments: expect.objectContaining({
        laneId: "lane-1",
        provider: "codex",
        permissionMode: "edit",
        initialInput: "fix the tests",
        title: "Codex",
        cols: 120,
        rows: 36,
        tracked: true,
      }),
    });
  });

  it("does not treat option values as start-cli providers", () => {
    expect(() =>
      buildCliPlan([
        "shell",
        "start-cli",
        "--lane",
        "lane-1",
        "--permission-mode",
        "edit",
      ]),
    ).toThrow("provider is required");
  });

  it("finds a start-cli provider after value-taking options", () => {
    const plan = buildCliPlan([
      "shell",
      "start-cli",
      "--lane",
      "lane-1",
      "--permission-mode",
      "edit",
      "codex",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      name: "start_cli_session",
      arguments: {
        laneId: "lane-1",
        provider: "codex",
        permissionMode: "edit",
      },
    });
  });

  it("finds a start-cli provider after initial-input value-taking options", () => {
    const plan = buildCliPlan([
      "shell",
      "start-cli",
      "--lane",
      "lane-1",
      "--initial-input",
      "hello agent",
      "codex",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      name: "start_cli_session",
      arguments: {
        laneId: "lane-1",
        provider: "codex",
        initialInput: "hello agent",
      },
    });
  });

  it("accepts Claude auto permission mode for provider CLI launches", () => {
    const plan = buildCliPlan([
      "shell",
      "start-cli",
      "claude",
      "--lane",
      "lane-1",
      "--permission-mode",
      "auto",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      name: "start_cli_session",
      arguments: {
        laneId: "lane-1",
        provider: "claude",
        permissionMode: "auto",
      },
    });
  });

  it("accepts --provider on shell start as the CLI-session launcher", () => {
    const plan = buildCliPlan([
      "shell",
      "start",
      "--provider",
      "claude",
      "--lane",
      "lane-1",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      name: "start_cli_session",
      arguments: {
        laneId: "lane-1",
        provider: "claude",
        permissionMode: "default",
      },
    });
  });

  it("renders an empty lane graph placeholder when no lanes are returned", () => {
    expect(renderLaneGraph({ lanes: [] })).toBe("ADE lanes\n(no lanes)");
    expect(renderLaneGraph(null)).toBe("ADE lanes\n(no lanes)");
  });

  it("automations list maps to the automations.list action", () => {
    const plan = buildCliPlan(["automations", "list"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "automations", action: "list", args: {} },
    });
  });

  it("automations show reads the id from a positional or from --id", () => {
    const byPositional = buildCliPlan(["automations", "show", "rule-42"]);
    expect(byPositional.kind).toBe("execute");
    if (byPositional.kind !== "execute") return;
    expect(byPositional.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "get",
        args: { id: "rule-42" },
      },
    });

    const byFlag = buildCliPlan(["automations", "show", "--id", "rule-42"]);
    expect(byFlag.kind).toBe("execute");
    if (byFlag.kind !== "execute") return;
    expect(byFlag.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "get",
        args: { id: "rule-42" },
      },
    });
  });

  it("automations show errors loudly when id is missing", () => {
    expect(() => buildCliPlan(["automations", "show"])).toThrow(/rule id/);
  });

  it("automations create parses an inline YAML --text body via parseDraftInput", () => {
    // The CLI also accepts --from-file / --stdin; --text is the in-process variant.
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: my-rule\nname: My rule\nenabled: true\n",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "saveRule",
        args: {
          draft: { id: "my-rule", name: "My rule", enabled: true },
        },
      },
    });
  });

  it("automations create accepts an inline JSON --text body", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      '{"id":"json-rule","name":"J"}',
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: { draft: { id: "json-rule", name: "J" } },
      },
    });
  });

  it("automations create rejects an empty body with a usage error", () => {
    expect(() =>
      buildCliPlan(["automations", "create", "--text", "   \n  "]),
    ).toThrow(/empty/i);
  });

  it("automations create rejects unparseable YAML/JSON", () => {
    expect(() =>
      buildCliPlan(["automations", "create", "--text", "{ this is: [unclosed"]),
    ).toThrow(/Failed to parse rule body/i);
  });

  it("automations create rejects a top-level non-object body", () => {
    // A bare string/array wouldn't round-trip through saveDraft safely.
    expect(() =>
      buildCliPlan(["automations", "create", "--text", "- one\n- two\n"]),
    ).toThrow(/must be an object/i);
  });

  it("automations update merges the provided id into the draft payload", () => {
    const plan = buildCliPlan([
      "automations",
      "update",
      "rule-42",
      "--text",
      "name: Renamed\n",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "saveRule",
        args: {
          draft: { name: "Renamed", id: "rule-42" },
        },
      },
    });
  });

  it("automations delete targets the id", () => {
    const plan = buildCliPlan(["automations", "delete", "rule-42"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "deleteRule",
        args: { id: "rule-42" },
      },
    });
  });

  it("automations toggle requires --enabled true|false and coerces to boolean", () => {
    const enabled = buildCliPlan([
      "automations",
      "toggle",
      "rule-42",
      "--enabled",
      "true",
    ]);
    expect(enabled.kind).toBe("execute");
    if (enabled.kind !== "execute") return;
    expect(enabled.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "toggleRule",
        args: { id: "rule-42", enabled: true },
      },
    });

    const disabled = buildCliPlan([
      "automations",
      "toggle",
      "rule-42",
      "--enabled",
      "false",
    ]);
    expect(disabled.kind).toBe("execute");
    if (disabled.kind !== "execute") return;
    expect(disabled.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "toggleRule",
        args: { id: "rule-42", enabled: false },
      },
    });
  });

  it("automations create merges --lane-mode and preset flags into draft.execution", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: r1\nname: R\n",
      "--lane-mode",
      "create",
      "--lane-name-preset",
      "issue-title",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            id: "r1",
            execution: { laneMode: "create", laneNamePreset: "issue-title" },
          },
        },
      },
    });
  });

  it("automations create with --lane-mode reuse and --lane sets targetLaneId", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: r1\n",
      "--lane-mode",
      "reuse",
      "--lane",
      "lane-99",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            execution: { laneMode: "reuse", targetLaneId: "lane-99" },
          },
        },
      },
    });
  });

  it("automations create with implicit reuse accepts --lane", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: r1\n",
      "--lane",
      "lane-99",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            execution: { targetLaneId: "lane-99" },
          },
        },
      },
    });
  });

  it("automations create accepts require-on-trigger lane mode without a target lane", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: r1\n",
      "--lane-mode",
      "require-on-trigger",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            execution: { laneMode: "require-on-trigger" },
          },
        },
      },
    });
  });

  it("automations create rejects --lane with --lane-mode require-on-trigger", () => {
    expect(() =>
      buildCliPlan([
        "automations",
        "create",
        "--text",
        "id: r1\n",
        "--lane-mode",
        "require-on-trigger",
        "--lane",
        "lane-1",
      ]),
    ).toThrow(/--lane is only valid with --lane-mode reuse/);
  });

  it("automations create with --lane-name-preset custom accepts --lane-name-template", () => {
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      "id: r1\n",
      "--lane-mode",
      "create",
      "--lane-name-preset",
      "custom",
      "--lane-name-template",
      "{{trigger.issue.author}}/{{trigger.issue.title}}",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            execution: {
              laneMode: "create",
              laneNamePreset: "custom",
              laneNameTemplate:
                "{{trigger.issue.author}}/{{trigger.issue.title}}",
            },
          },
        },
      },
    });
  });

  it("automations create rejects --lane with --lane-mode create", () => {
    expect(() =>
      buildCliPlan([
        "automations",
        "create",
        "--text",
        "id: r1\n",
        "--lane-mode",
        "create",
        "--lane",
        "lane-1",
      ]),
    ).toThrow(/--lane is only valid with --lane-mode reuse/);
  });

  it("automations create rejects --lane-name-preset with --lane-mode reuse", () => {
    expect(() =>
      buildCliPlan([
        "automations",
        "create",
        "--text",
        "id: r1\n",
        "--lane-mode",
        "reuse",
        "--lane-name-preset",
        "issue-title",
      ]),
    ).toThrow(/--lane-name-preset is only valid with --lane-mode create/);
  });

  it("automations create rejects --lane-name-template with non-custom preset", () => {
    expect(() =>
      buildCliPlan([
        "automations",
        "create",
        "--text",
        "id: r1\n",
        "--lane-mode",
        "create",
        "--lane-name-preset",
        "issue-title",
        "--lane-name-template",
        "{{trigger.issue.title}}",
      ]),
    ).toThrow(
      /--lane-name-template is only valid with --lane-name-preset custom/,
    );
  });

  it("automations create rejects unknown --lane-mode value", () => {
    expect(() =>
      buildCliPlan([
        "automations",
        "create",
        "--text",
        "id: r1\n",
        "--lane-mode",
        "bogus",
      ]),
    ).toThrow(/--lane-mode must be one of create, reuse, require-on-trigger/);
  });

  it("automations runs accepts a --status filter", () => {
    const plan = buildCliPlan([
      "automations",
      "runs",
      "--rule",
      "r1",
      "--status",
      "failed",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "listRuns",
        args: { automationId: "r1", status: "failed" },
      },
    });
  });

  it("automations runs rejects an unknown --status value", () => {
    expect(() =>
      buildCliPlan(["automations", "runs", "--status", "wat"]),
    ).toThrow(/--status must be one of/);
  });

  it("automations example prints a parseable example rule via help kind", () => {
    const plan = buildCliPlan(["automations", "example"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    const parsed = JSON.parse(plan.text);
    expect(parsed).toMatchObject({
      execution: { laneMode: "create", laneNamePreset: "issue-num-title" },
    });
  });

  it("automations create auto-migrates a legacy create-lane first action into laneMode", () => {
    const draft = JSON.stringify({
      id: "legacy-rule",
      actions: [
        { type: "create-lane", laneNameTemplate: "{{trigger.issue.title}}" },
        { type: "agent-session", modelId: "claude-opus-4-7" },
      ],
    });
    const plan = buildCliPlan(["automations", "create", "--text", draft]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            execution: {
              laneMode: "create",
              laneNamePreset: "custom",
              laneNameTemplate: "{{trigger.issue.title}}",
            },
            actions: [{ type: "agent-session" }],
          },
        },
      },
    });
  });

  it("automations create --allow-legacy preserves the legacy create-lane action", () => {
    const draft = JSON.stringify({
      id: "legacy-rule",
      actions: [{ type: "create-lane", laneNameTemplate: "x" }],
    });
    const plan = buildCliPlan([
      "automations",
      "create",
      "--text",
      draft,
      "--allow-legacy",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        args: {
          draft: {
            actions: [{ type: "create-lane", laneNameTemplate: "x" }],
          },
        },
      },
    });
  });

  it("automations run-show wires the automation-run-detail formatter", () => {
    const plan = buildCliPlan(["automations", "run-show", "run-1"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.formatter).toBe("automation-run-detail");
  });

  it("automations toggle errors when --enabled is omitted", () => {
    expect(() => buildCliPlan(["automations", "toggle", "rule-42"])).toThrow(
      /--enabled <true\|false>/,
    );
  });

  it("automations toggle rejects invalid --enabled values", () => {
    expect(() =>
      buildCliPlan(["automations", "toggle", "rule-42", "--enabled", "maybe"]),
    ).toThrow(/must be true or false/);
  });

  it("automations run passes dryRun only when --dry-run is set", () => {
    const plain = buildCliPlan(["automations", "run", "rule-42"]);
    expect(plain.kind).toBe("execute");
    if (plain.kind !== "execute") return;
    expect(plain.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "triggerManually",
        args: { id: "rule-42" },
      },
    });

    const dry = buildCliPlan(["automations", "run", "rule-42", "--dry-run"]);
    expect(dry.kind).toBe("execute");
    if (dry.kind !== "execute") return;
    expect(dry.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "triggerManually",
        args: { id: "rule-42", dryRun: true },
      },
    });
  });

  it("automations run forwards --lane as laneId", () => {
    const plan = buildCliPlan([
      "automations",
      "run",
      "rule-42",
      "--lane",
      "lane-7",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: { args: { id: "rule-42", laneId: "lane-7" } },
    });
  });

  it("automations trigger aliases run and forwards --lane as laneId", () => {
    const plan = buildCliPlan([
      "automations",
      "trigger",
      "rule-42",
      "--lane",
      "lane-7",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "automations",
        action: "triggerManually",
        args: { id: "rule-42", laneId: "lane-7" },
      },
    });
  });

  it("automations runs passes through --rule and --limit as filters", () => {
    const plan = buildCliPlan([
      "automations",
      "runs",
      "--rule",
      "rule-42",
      "--limit",
      "25",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "automations",
        action: "listRuns",
        args: { automationId: "rule-42", limit: 25 },
      },
    });
  });

  it("automations runs sends an empty filter when no flags are given", () => {
    const plan = buildCliPlan(["automations", "runs"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "automations", action: "listRuns", args: {} },
    });
  });

  it("automations run-show / run-detail both map to getRunDetail", () => {
    for (const verb of ["run-show", "run-detail"]) {
      const plan = buildCliPlan(["automations", verb, "run-7"]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") continue;
      expect(plan.steps[0]?.params).toEqual({
        name: "run_ade_action",
        arguments: {
          domain: "automations",
          action: "getRunDetail",
          args: { runId: "run-7" },
        },
      });
    }
  });

  it("automations rejects unknown subcommands with a usage error", () => {
    expect(() => buildCliPlan(["automations", "nope"])).toThrow(
      /list, show, create, update, delete, toggle, run, runs/,
    );
  });

  it("singular `automation` is accepted as an alias for `automations`", () => {
    const plan = buildCliPlan(["automation", "list"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: { domain: "automations", action: "list" },
    });
  });

  it("ios-sim status maps to ios_simulator/getStatus", () => {
    const plan = buildCliPlan(["ios-sim", "status"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.params).toMatchObject({
      name: "run_ade_action",
      arguments: { domain: "ios_simulator", action: "getStatus" },
    });
  });

  it("ios-sim devices / list / ls aliases all map to listDevices", () => {
    for (const sub of ["devices", "list", "ls"]) {
      const plan = buildCliPlan(["ios-sim", sub]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") continue;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: { domain: "ios_simulator", action: "listDevices" },
      });
    }
  });

  it("ios-sim launch passes mode + build flags through to the action", () => {
    const plan = buildCliPlan([
      "ios-sim",
      "launch",
      "--device",
      "AAA-BBB",
      "--mode",
      "snapshot",
      "--no-build",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "launch",
        args: { deviceUdid: "AAA-BBB", mode: "snapshot", build: false },
      },
    });
  });

  it("ios-sim inspect requires both coordinates and forwards them", () => {
    expect(() => buildCliPlan(["ios-sim", "inspect"])).toThrow(/--x|--y/);
    const plan = buildCliPlan([
      "ios-sim",
      "inspect",
      "--x",
      "120",
      "--y",
      "420",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "inspectPoint",
        args: { x: 120, y: 420 },
      },
    });
  });

  it("ios-sim preview commands map to Xcode preview actions", () => {
    const status = buildCliPlan([
      "ios-sim",
      "preview-status",
      "--source",
      "Views/HomeView.swift",
      "--line",
      "42",
    ]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "getPreviewCapability",
        args: { sourceFile: "Views/HomeView.swift", sourceLine: 42 },
      },
    });

    const list = buildCliPlan([
      "ios-sim",
      "previews",
      "--source",
      "Views/HomeView.swift",
    ]);
    expect(list.kind).toBe("execute");
    if (list.kind !== "execute") return;
    expect(list.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "listPreviewTargets",
        args: { sourceFile: "Views/HomeView.swift" },
      },
    });

    const open = buildCliPlan([
      "ios-sim",
      "preview-open",
      "--project-root",
      "/tmp/app",
    ]);
    expect(open.kind).toBe("execute");
    if (open.kind !== "execute") return;
    expect(open.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "openPreviewWorkspace",
        args: { projectRoot: "/tmp/app" },
      },
    });
  });

  it("ios-sim preview-render requires a source file and forwards render options", () => {
    expect(() => buildCliPlan(["ios-sim", "preview-render"])).toThrow(
      /sourceFilePath/,
    );

    const plan = buildCliPlan([
      "ios-sim",
      "preview-render",
      "--source",
      "Views/HomeView.swift",
      "--index",
      "2",
      "--tab",
      "tab-1",
      "--timeout",
      "30",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "renderPreview",
        args: {
          sourceFilePath: "Views/HomeView.swift",
          previewDefinitionIndexInFile: 2,
          tabIdentifier: "tab-1",
          timeoutSec: 30,
        },
      },
    });
  });

  it("ios-sim shutdown forwards --force to the shutdown action", () => {
    const plain = buildCliPlan(["ios-sim", "shutdown"]);
    expect(plain.kind).toBe("execute");
    if (plain.kind !== "execute") return;
    expect(plain.steps[0]?.params).toMatchObject({
      arguments: { domain: "ios_simulator", action: "shutdown" },
    });
    expect((plain.steps[0]?.params as any).arguments.args.force ?? false).toBe(
      false,
    );

    const forced = buildCliPlan(["ios-sim", "shutdown", "--force"]);
    expect(forced.kind).toBe("execute");
    if (forced.kind !== "execute") return;
    expect(forced.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "shutdown",
        args: { force: true },
      },
    });
  });

  it("keeps shell --command when an argument terminator has no trailing tokens", () => {
    const plan = buildCliPlan([
      "shell",
      "start",
      "--lane",
      "lane-1",
      "--command",
      "npm test",
      "--",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "pty",
        action: "create",
        args: {
          startupCommand: "npm test",
        },
      },
    });
  });

  it("keeps start-cli --message when an argument terminator has no trailing tokens", () => {
    const plan = buildCliPlan([
      "shell",
      "start-cli",
      "codex",
      "--lane",
      "lane-1",
      "--message",
      "hello",
      "--",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      name: "start_cli_session",
      arguments: {
        provider: "codex",
        initialInput: "hello",
      },
    });
  });

  it("ios-sim type accepts clear text payload aliases without shadowing output --text", () => {
    const withValue = buildCliPlan([
      "ios-sim",
      "type",
      "--value",
      "hello",
      "--text",
    ]);
    expect(withValue.kind).toBe("execute");
    if (withValue.kind !== "execute") return;
    expect(withValue.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "typeText",
        args: { text: "hello" },
      },
    });

    const withPositional = buildCliPlan([
      "ios-sim",
      "type",
      "hello world",
      "--text",
    ]);
    expect(withPositional.kind).toBe("execute");
    if (withPositional.kind !== "execute") return;
    expect(withPositional.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "ios_simulator",
        action: "typeText",
        args: { text: "hello world" },
      },
    });
  });

  it("attaches shell starts to the active ADE chat session from the environment", () => {
    const previous = process.env.ADE_CHAT_SESSION_ID;
    try {
      process.env.ADE_CHAT_SESSION_ID = "chat-env-1";
      const plan = buildCliPlan([
        "shell",
        "start",
        "--lane",
        "lane-1",
        "--command",
        "npm test",
      ]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") return;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "pty",
          action: "create",
          args: {
            laneId: "lane-1",
            chatSessionId: "chat-env-1",
            startupCommand: "npm test",
          },
        },
      });
    } finally {
      if (previous === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = previous;
    }
  });

  it("lets an explicit shell chat session override the environment", () => {
    const previous = process.env.ADE_CHAT_SESSION_ID;
    try {
      process.env.ADE_CHAT_SESSION_ID = "chat-env-1";
      const plan = buildCliPlan([
        "shell",
        "start",
        "--lane",
        "lane-1",
        "--chat-session",
        "chat-explicit-1",
        "--command",
        "npm test",
      ]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") return;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "pty",
          action: "create",
          args: {
            chatSessionId: "chat-explicit-1",
          },
        },
      });
    } finally {
      if (previous === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = previous;
    }
  });

  it("ignores a blank ADE chat session environment value for shell starts", () => {
    const previous = process.env.ADE_CHAT_SESSION_ID;
    try {
      process.env.ADE_CHAT_SESSION_ID = "   ";
      const plan = buildCliPlan([
        "shell",
        "start",
        "--lane",
        "lane-1",
        "--command",
        "npm test",
      ]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") return;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: {
          domain: "pty",
          action: "create",
          args: expect.not.objectContaining({
            chatSessionId: expect.anything(),
          }),
        },
      });
    } finally {
      if (previous === undefined) delete process.env.ADE_CHAT_SESSION_ID;
      else process.env.ADE_CHAT_SESSION_ID = previous;
    }
  });

  it("`ios` and `simulator` are accepted as aliases for `ios-sim`", () => {
    for (const alias of ["ios", "simulator"]) {
      const plan = buildCliPlan([alias, "devices"]);
      expect(plan.kind).toBe("execute");
      if (plan.kind !== "execute") continue;
      expect(plan.steps[0]?.params).toMatchObject({
        arguments: { domain: "ios_simulator", action: "listDevices" },
      });
    }
  });

  it("app-control status maps to app_control actions", () => {
    const status = buildCliPlan(["app-control", "status"]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps[0]?.params).toMatchObject({
      name: "run_ade_action",
      arguments: { domain: "app_control", action: "getStatus" },
    });
  });

  it("app-control launch requires a command and supports aliases", () => {
    const launch = buildCliPlan([
      "app-control",
      "launch",
      "--command",
      "npm run dev",
      "--debug-port",
      "9333",
      "--force",
    ]);
    expect(launch.kind).toBe("execute");
    if (launch.kind !== "execute") return;
    expect(launch.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "launch",
        args: {
          command: "npm run dev",
          debugPort: 9333,
          force: true,
        },
      },
    });

    const command = buildCliPlan(["electron", "launch", "pnpm", "dev"]);
    expect(command.kind).toBe("execute");
    if (command.kind !== "execute") return;
    expect(command.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "launch",
        args: { command: "pnpm dev" },
      },
    });
  });

  it("macos-vm lifecycle commands map to macos_vm actions", () => {
    const status = buildCliPlan(["macos-vm", "status", "--lane", "lane-1"]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "macos_vm",
        action: "getStatus",
        args: { laneId: "lane-1" },
      },
    });

    const provision = buildCliPlan([
      "macos-vm",
      "provision",
      "--lane",
      "lane-1",
      "--mode",
      "create",
      "--ipsw",
      "latest",
      "--cpu",
      "6",
      "--memory",
      "12GB",
      "--disk",
      "120GB",
    ]);
    expect(provision.kind).toBe("execute");
    if (provision.kind !== "execute") return;
    expect(provision.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "macos_vm",
        action: "provision",
        args: {
          laneId: "lane-1",
          mode: "create",
          ipsw: "latest",
          cpuCores: 6,
          memory: "12GB",
          diskSize: "120GB",
        },
      },
    });

    const start = buildCliPlan([
      "mac-vm",
      "start",
      "lane-1",
      "--create",
      "--no-display",
    ]);
    expect(start.kind).toBe("execute");
    if (start.kind !== "execute") return;
    expect(start.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "macos_vm",
        action: "start",
        args: {
          laneId: "lane-1",
          createIfMissing: true,
          openDisplay: false,
        },
      },
    });
  });

  it("macos-vm guide and actions are available for agent guidance", () => {
    const guide = buildCliPlan(["macos", "guide", "--lane", "lane-1"]);
    expect(guide.kind).toBe("execute");
    if (guide.kind !== "execute") return;
    expect(guide.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "macos_vm",
        action: "getAgentGuide",
        args: { laneId: "lane-1" },
      },
    });

    const actions = buildCliPlan(["macos-vm", "actions"]);
    expect(actions.kind).toBe("execute");
    if (actions.kind !== "execute") return;
    expect(actions.steps[0]?.params).toMatchObject({
      name: "list_ade_actions",
      arguments: { domain: "macos_vm" },
    });
  });

  it("macos-vm window control commands map to VM computer-use actions", () => {
    const screenshot = buildCliPlan([
      "macos-vm",
      "screenshot",
      "--lane",
      "lane-1",
      "--output",
      "/tmp/vm.png",
    ]);
    expect(screenshot.kind).toBe("execute");
    if (screenshot.kind !== "execute") return;
    expect(screenshot.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "macos_vm",
        action: "captureScreenshot",
        args: {
          laneId: "lane-1",
          outputPath: "/tmp/vm.png",
        },
      },
    });

    const click = buildCliPlan([
      "macos-vm",
      "click",
      "--lane",
      "lane-1",
      "120",
      "420",
    ]);
    expect(click.kind).toBe("execute");
    if (click.kind !== "execute") return;
    expect(click.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "macos_vm",
        action: "click",
        args: {
          laneId: "lane-1",
          x: 120,
          y: 420,
        },
      },
    });

    const select = buildCliPlan([
      "macos-vm",
      "select",
      "--lane",
      "lane-1",
      "--x",
      "120",
      "--y",
      "420",
    ]);
    expect(select.kind).toBe("execute");
    if (select.kind !== "execute") return;
    expect(select.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "macos_vm",
        action: "selectPoint",
        args: {
          laneId: "lane-1",
          x: 120,
          y: 420,
        },
      },
    });

    const type = buildCliPlan([
      "macos-vm",
      "type",
      "--lane",
      "lane-1",
      "--value",
      "hello",
    ]);
    expect(type.kind).toBe("execute");
    if (type.kind !== "execute") return;
    expect(type.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "macos_vm",
        action: "typeText",
        args: {
          laneId: "lane-1",
          text: "hello",
        },
      },
    });
  });

  it("terminal read and write map to terminal actions", () => {
    const read = buildCliPlan([
      "terminal",
      "read",
      "--chat-session",
      "chat-1",
      "--max-bytes",
      "500",
    ]);
    expect(read.kind).toBe("execute");
    if (read.kind !== "execute") return;
    expect(read.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "terminal",
        action: "read",
        args: { chatSessionId: "chat-1", maxBytes: 500 },
      },
    });

    const write = buildCliPlan([
      "terminal",
      "write",
      "--terminal",
      "term-1",
      "--data",
      "y\n",
    ]);
    expect(write.kind).toBe("execute");
    if (write.kind !== "execute") return;
    expect(write.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "terminal",
        action: "write",
        args: { terminalId: "term-1", data: "y\n" },
      },
    });
  });

  it("app-control logs and terminal write use the active App Control terminal", () => {
    const logs = buildCliPlan(["app-control", "logs", "--max-bytes", "1024"]);
    expect(logs.kind).toBe("execute");
    if (logs.kind !== "execute") return;
    expect(logs.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "readTerminal",
        args: { maxBytes: 1024 },
      },
    });

    const write = buildCliPlan([
      "app-control",
      "terminal",
      "write",
      "--data",
      "y\n",
    ]);
    expect(write.kind).toBe("execute");
    if (write.kind !== "execute") return;
    expect(write.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "writeTerminal",
        args: { data: "y\n" },
      },
    });
  });

  it("app-control connect, select, click, and type map to App Control actions", () => {
    const connect = buildCliPlan([
      "app-control",
      "connect",
      "--cdp-port",
      "9222",
      "--force",
    ]);
    expect(connect.kind).toBe("execute");
    if (connect.kind !== "execute") return;
    expect(connect.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "connect",
        args: { cdpPort: 9222, force: true },
      },
    });

    const positionalConnect = buildCliPlan(["app-control", "connect", "9333"]);
    expect(positionalConnect.kind).toBe("execute");
    if (positionalConnect.kind !== "execute") return;
    expect(positionalConnect.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "connect",
        args: { cdpPort: 9333 },
      },
    });

    const select = buildCliPlan([
      "app-control",
      "select",
      "--x",
      "120",
      "--y",
      "420",
    ]);
    expect(select.kind).toBe("execute");
    if (select.kind !== "execute") return;
    expect(select.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "selectPoint",
        args: { x: 120, y: 420 },
      },
    });

    const click = buildCliPlan(["app", "click", "120", "420"]);
    expect(click.kind).toBe("execute");
    if (click.kind !== "execute") return;
    expect(click.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "click",
        args: { x: 120, y: 420 },
      },
    });

    const type = buildCliPlan([
      "app-control",
      "type",
      "--value",
      "hello",
      "--text",
    ]);
    expect(type.kind).toBe("execute");
    if (type.kind !== "execute") return;
    expect(type.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "typeText",
        args: { text: "hello" },
      },
    });

    const scroll = buildCliPlan([
      "app-control",
      "scroll",
      "--x",
      "120",
      "--y",
      "420",
      "--delta-y",
      "600",
    ]);
    expect(scroll.kind).toBe("execute");
    if (scroll.kind !== "execute") return;
    expect(scroll.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "scroll",
        args: { x: 120, y: 420, deltaY: 600 },
      },
    });

    const attachTarget = buildCliPlan([
      "app-control",
      "attach-target",
      "--target",
      "target-1",
    ]);
    expect(attachTarget.kind).toBe("execute");
    if (attachTarget.kind !== "execute") return;
    expect(attachTarget.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "app_control",
        action: "attachToTarget",
        argsList: ["target-1"],
      },
    });
  });

  it("browser commands map to built-in browser actions", () => {
    const open = buildCliPlan([
      "browser",
      "open",
      "localhost:5173",
      "--new-tab",
    ]);
    expect(open.kind).toBe("execute");
    if (open.kind !== "execute") return;
    expect(open.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "navigate",
        args: { url: "localhost:5173", newTab: true, openPanel: true },
      },
    });

    const panel = buildCliPlan(["browser", "panel"]);
    expect(panel.kind).toBe("execute");
    if (panel.kind !== "execute") return;
    expect(panel.steps[0]?.params).toMatchObject({
      arguments: { domain: "built_in_browser", action: "showPanel", args: {} },
    });

    const panelWithUrl = buildCliPlan([
      "browser",
      "panel",
      "--url",
      "localhost:5173",
    ]);
    expect(panelWithUrl.kind).toBe("execute");
    if (panelWithUrl.kind !== "execute") return;
    expect(panelWithUrl.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "showPanel",
        args: { url: "localhost:5173" },
      },
    });

    const targetedOpen = buildCliPlan([
      "browser",
      "open",
      "https://example.com",
      "--tab",
      "tab-1",
    ]);
    expect(targetedOpen.kind).toBe("execute");
    if (targetedOpen.kind !== "execute") return;
    expect(targetedOpen.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "navigate",
        args: { url: "https://example.com", tabId: "tab-1", openPanel: true },
      },
    });

    const hiddenOpen = buildCliPlan([
      "browser",
      "open",
      "https://example.com",
      "--no-panel",
    ]);
    expect(hiddenOpen.kind).toBe("execute");
    if (hiddenOpen.kind !== "execute") return;
    expect(hiddenOpen.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "navigate",
        args: { url: "https://example.com", openPanel: false },
      },
    });

    const openWithGenericArg = buildCliPlan([
      "browser",
      "open",
      "https://example.com",
      "--arg",
      "openPanel=false",
    ]);
    expect(openWithGenericArg.kind).toBe("execute");
    if (openWithGenericArg.kind !== "execute") return;
    expect(openWithGenericArg.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "navigate",
        args: { url: "https://example.com", openPanel: false },
      },
    });

    const openFromGenericUrl = buildCliPlan([
      "browser",
      "open",
      "--arg",
      "url=https://example.com",
    ]);
    expect(openFromGenericUrl.kind).toBe("execute");
    if (openFromGenericUrl.kind !== "execute") return;
    expect(openFromGenericUrl.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "navigate",
        args: { url: "https://example.com", openPanel: true },
      },
    });

    const backgroundTab = buildCliPlan([
      "browser",
      "new-tab",
      "https://example.com",
      "--background",
    ]);
    expect(backgroundTab.kind).toBe("execute");
    if (backgroundTab.kind !== "execute") return;
    expect(backgroundTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "createTab",
        args: { url: "https://example.com", activate: false, openPanel: true },
      },
    });

    const switchTab = buildCliPlan(["browser", "switch", "--tab", "tab-1"]);
    expect(switchTab.kind).toBe("execute");
    if (switchTab.kind !== "execute") return;
    expect(switchTab.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "switchTab",
        args: { tabId: "tab-1", openPanel: true },
      },
    });

    const selectPoint = buildCliPlan([
      "browser",
      "select",
      "--x",
      "120",
      "--y",
      "420",
      "--no-screenshot",
    ]);
    expect(selectPoint.kind).toBe("execute");
    if (selectPoint.kind !== "execute") return;
    expect(selectPoint.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "built_in_browser",
        action: "selectPoint",
        args: { x: 120, y: 420, includeScreenshot: false },
      },
    });
  });

  it("update commands map to auto-update actions", () => {
    const status = buildCliPlan(["update", "status"]);
    expect(status.kind).toBe("execute");
    if (status.kind !== "execute") return;
    expect(status.steps[0]?.params).toMatchObject({
      arguments: { domain: "update", action: "getSnapshot", args: {} },
    });

    const check = buildCliPlan(["auto-update", "check"]);
    expect(check.kind).toBe("execute");
    if (check.kind !== "execute") return;
    expect(check.steps[0]?.params).toMatchObject({
      arguments: { domain: "update", action: "checkForUpdates", args: {} },
    });

    const install = buildCliPlan(["updates", "install"]);
    expect(install.kind).toBe("execute");
    if (install.kind !== "execute") return;
    expect(install.steps[0]?.params).toMatchObject({
      arguments: { domain: "update", action: "quitAndInstall", args: {} },
    });

    const dismiss = buildCliPlan(["update", "dismiss"]);
    expect(dismiss.kind).toBe("execute");
    if (dismiss.kind !== "execute") return;
    expect(dismiss.steps[0]?.params).toMatchObject({
      arguments: {
        domain: "update",
        action: "dismissInstalledNotice",
        args: {},
      },
    });

    const actions = buildCliPlan(["update", "actions"]);
    expect(actions.kind).toBe("execute");
    if (actions.kind !== "execute") return;
    expect(actions.steps[0]?.params).toMatchObject({
      name: "list_ade_actions",
      arguments: { domain: "update" },
    });
  });

  it("usage snapshot routes to the usage.getUsageSnapshot action with no args", () => {
    const plan = buildCliPlan(["usage", "snapshot"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage snapshot");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "usage", action: "getUsageSnapshot", args: {} },
    });

    const aliased = buildCliPlan(["quota", "snapshot"]);
    expect(aliased.kind).toBe("execute");
    if (aliased.kind !== "execute") return;
    expect(aliased.steps[0]?.params).toEqual(plan.steps[0]?.params);
  });

  it("usage refresh routes to the usage.forceRefresh action", () => {
    const plan = buildCliPlan(["usage", "refresh"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage refresh");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "usage", action: "forceRefresh", args: {} },
    });

    const polled = buildCliPlan(["usage", "poll"]);
    expect(polled.kind).toBe("execute");
    if (polled.kind !== "execute") return;
    expect(polled.steps[0]?.params).toEqual(plan.steps[0]?.params);
  });

  it("usage budget get routes to the budget.getConfig action", () => {
    const plan = buildCliPlan(["usage", "budget", "get"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage budget get");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "budget", action: "getConfig", args: {} },
    });
  });

  it("usage budget set --from-file parses the JSON body and forwards it as args", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-usage-budget-"));
    const budgetPath = path.join(root, "budget.json");
    const config = { caps: [{ provider: "claude", scope: "global", limitUsd: 25 }] };
    fs.writeFileSync(budgetPath, JSON.stringify(config));

    const plan = buildCliPlan(["usage", "budget", "set", "--from-file", budgetPath]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage budget update");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "budget", action: "updateConfig", args: config },
    });

    expect(() =>
      buildCliPlan(["usage", "budget", "set", "--text", "[1,2,3]"]),
    ).toThrow(/must be a JSON object/i);
    expect(() =>
      buildCliPlan(["usage", "budget", "set", "--text", "   \n  "]),
    ).toThrow(/non-empty JSON object/i);
    expect(() => buildCliPlan(["usage", "budget", "set"])).toThrow(
      /at least one field/i,
    );
    expect(() =>
      buildCliPlan(["usage", "budget", "set", "--text", "{}"]),
    ).toThrow(/at least one field/i);
  });

  it("usage budget check defaults scope to global and forwards --provider", () => {
    const plan = buildCliPlan(["usage", "budget", "check", "--provider", "claude"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage budget check");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "budget",
        action: "checkBudget",
        args: { scope: "global", scopeId: null, provider: "claude" },
      },
    });

    expect(() => buildCliPlan(["usage", "budget", "bogus"])).toThrow(
      /usage budget supports get, set, check, or cumulative/,
    );
  });

  it("usage budget cumulative routes with scope parameters", () => {
    const plan = buildCliPlan(["usage", "budget", "cumulative", "--scope", "global"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("usage budget cumulative");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "budget",
        action: "getCumulativeUsage",
        args: { scope: "global", scopeId: null, provider: null },
      },
    });

    const aliased = buildCliPlan([
      "quota",
      "budget",
      "totals",
      "--provider",
      "cursor",
    ]);
    expect(aliased.kind).toBe("execute");
    if (aliased.kind !== "execute") return;
    expect(aliased.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "budget",
        action: "getCumulativeUsage",
        args: { scope: "global", scopeId: null, provider: "cursor" },
      },
    });
  });

  it("usage command aliases resolve to usage help", () => {
    const direct = buildCliPlan(["usage", "--help"]);
    const quota = buildCliPlan(["quota", "--help"]);
    const helpQuota = buildCliPlan(["help", "quota"]);
    expect(direct.kind).toBe("help");
    expect(quota.kind).toBe("help");
    expect(helpQuota.kind).toBe("help");
    if (direct.kind !== "help" || quota.kind !== "help" || helpQuota.kind !== "help") return;
    expect(quota.text).toBe(direct.text);
    expect(helpQuota.text).toBe(direct.text);
  });

  it("parses ade history list with operation filters", () => {
    const plan = buildCliPlan([
      "history",
      "list",
      "--lane",
      "lane-1",
      "--kind",
      "push",
      "--status",
      "succeeded",
      "--limit",
      "25",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("history list");
    expect(plan.formatter).toBe("history-list");
    expect(plan.historyStatusFilter).toBe("succeeded");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "operation",
        action: "list",
        args: { laneId: "lane-1", kind: "push", status: "succeeded", limit: 25 },
      },
    });
  });

  it("parses ade history show by operation id", () => {
    const plan = buildCliPlan(["history", "show", "--id", "op-1"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("history show");
    expect(plan.historyOperationId).toBe("op-1");
    expect(plan.formatter).toBe("history-show");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "operation", action: "get", args: { operationId: "op-1" } },
    });
  });

  it("parses ade history commits for a lane", () => {
    const plan = buildCliPlan([
      "history",
      "commits",
      "--lane",
      "lane-1",
      "--limit",
      "12",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("history commits");
    expect(plan.formatter).toBe("history-commits");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "git",
        action: "listRecentCommits",
        args: { laneId: "lane-1", limit: 12 },
      },
    });
  });

  it("parses ade history export to a file", () => {
    const plan = buildCliPlan([
      "history",
      "export",
      "--lane",
      "lane-1",
      "--status",
      "failed",
      "--out",
      "/tmp/history.json",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("history export");
    expect(plan.writeResultPath).toBe("/tmp/history.json");
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "operation",
        action: "list",
        args: { laneId: "lane-1", status: "failed", limit: 1000 },
      },
    });
  });

  it("honors ade history export --limit", () => {
    const plan = buildCliPlan([
      "history",
      "export",
      "--lane",
      "lane-1",
      "--limit",
      "100",
    ]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: {
        domain: "operation",
        action: "list",
        args: { laneId: "lane-1", limit: 100 },
      },
    });
  });

  it("shows help for ade history", () => {
    const plan = buildCliPlan(["history", "--help"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("ade history list");
    expect(plan.text).toContain("ade history export");
  });

  it("attaches a rendered lane graph when the plan has the lanes visualizer", () => {
    const connection = {
      mode: "headless" as const,
      projectRoot: "/tmp/project",
      workspaceRoot: "/tmp/project",
      socketPath: "/tmp/project/.ade/ade.sock",
      request: async () => null,
      close: () => {},
    };
    const summarized = summarizeExecution({
      plan: {
        kind: "execute",
        label: "lanes list",
        steps: [],
        visualizer: "lanes",
      },
      connection,
      values: {
        result: {
          lanes: [
            { id: "main", name: "main", branchRef: "main" },
            {
              id: "child",
              name: "child",
              branchRef: "feature",
              parentLaneId: "main",
            },
          ],
        },
      },
    } as any);
    expect(summarized).toMatchObject({
      lanes: expect.any(Array),
    });
    expect((summarized as any).visual).toContain("\\- main (id: main) [main]");
    expect((summarized as any).visual).toContain(
      "\\- child (id: child) [feature]",
    );
  });
});
