import { describe, expect, it } from "vitest";
import { buildCliPlan, formatOutput, parseCliArgs, renderLaneGraph, summarizeExecution, unwrapToolResult } from "./cli";

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
    expect(parsed.command).toEqual(["actions", "run", "git.stageFile", "--arg", "laneId=lane-1"]);
  });

  it("preserves command-local value flags that overlap global flags", () => {
    const parsed = parseCliArgs(["files", "write", "src/index.ts", "--text", "hello"]);
    expect(parsed.options.text).toBe(false);
    expect(parsed.command).toEqual(["files", "write", "src/index.ts", "--text", "hello"]);

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
  });

  it("builds a generic ADE action invocation", () => {
    const plan = buildCliPlan(["actions", "run", "git.stageFile", "--arg", "laneId=lane-1", "--arg", "path=src/index.ts"]);
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

  it("builds nested generic ADE action args", () => {
    const plan = buildCliPlan([
      "actions",
      "run",
      "git.status",
      "--arg",
      "filters.clean=false",
      "--arg-json",
      "metadata.tags=[\"review\"]",
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

  it("rejects prototype-sensitive generic ADE action arg paths", () => {
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    for (const arg of ["__proto__.polluted=true", "safe.__proto__.polluted=true", "constructor.prototype.polluted=true"]) {
      expect(() => buildCliPlan(["actions", "run", "git.status", "--arg", arg])).toThrow(/not allowed/);
    }

    expect(() => buildCliPlan(["actions", "run", "git.status", "--arg-json", "prototype.polluted=true"])).toThrow(/not allowed/);
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
      name: "pr_start_issue_resolution",
      arguments: {
        prId: "pr-1",
        scope: "both",
        modelId: "gpt-5.4",
      },
    });
  });

  it("validates required arguments before service execution", () => {
    expect(() => buildCliPlan(["lanes", "create"])).toThrow(/name is required/);
    expect(() => buildCliPlan(["lanes", "child", "--name", "child"])).toThrow(/parent lane is required/);
    expect(() => buildCliPlan(["diff", "file", "--lane", "main"])).toThrow(/path is required/);
    expect(() => buildCliPlan(["files", "write", "src/index.ts"])).toThrow(/--text, --from-file, or --stdin/);
    expect(() => buildCliPlan(["chat", "send", "hello"])).toThrow(/message text is required/);
    expect(() => buildCliPlan(["agent", "spawn", "--prompt", "fix it"])).toThrow(/laneId is required/);
    expect(() => buildCliPlan(["tests", "run", "--lane", "main"])).toThrow(/--suite <id> or --command/);
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
    expect(escapeHatch).toMatchObject({ domain: "git", action: "getStatus", result: { clean: true } });
  });

  it("turns ADE action failure envelopes into CLI tool errors", () => {
    expect(() => unwrapToolResult({
      ok: false,
      error: {
        code: -32011,
        message: "Action 'git.nonexistent_action' is not callable.",
      },
    })).toThrow(/not callable/);
  });

  it("renders richer doctor text", () => {
    const output = formatOutput({
      ok: true,
      cliVersion: "0.0.0",
      mode: "headless",
      projectRoot: "/tmp/project",
      workspaceRoot: "/tmp/project",
      project: { projectInitialized: true },
      desktop: { socketAvailable: false, socketPath: "/tmp/project/.ade/ade.sock" },
      actions: { rpcActionCount: 10, actionCount: 42 },
      git: { message: "Git repository detected on main." },
      github: { message: "GitHub remote detected and a local auth mechanism is available." },
      linear: { message: "Linear credentials are present locally." },
      providers: { message: "AI provider configuration or provider CLI availability was detected locally." },
      computerUse: { message: "Local macOS computer-use fallback commands are available." },
      path: { message: "ade is available on PATH." },
      recommendation: "Using live ADE desktop state.",
      recommendations: [],
    }, {
      projectRoot: null,
      workspaceRoot: null,
      role: "agent",
      headless: false,
      requireSocket: false,
      pretty: true,
      text: true,
      timeoutMs: 1000,
    }, "doctor");

    expect(output).toContain("ADE doctor");
    expect(output).toContain("cli version");
    expect(output).toContain("service actions");
    expect(output).toContain("Git repository detected");
  });

  it("renders a compact lane graph", () => {
    const graph = renderLaneGraph({
      lanes: [
        { id: "main", name: "main", branchRef: "main" },
        { id: "child", name: "child", branchRef: "feature", parentLaneId: "main" },
        { id: "sibling", name: "sibling", branchRef: "feature-2", parentLaneId: "main" },
      ],
    });

    expect(graph).toContain("ADE lanes");
    expect(graph).toContain("\\- main [main]");
    expect(graph).toContain("|- child [feature]");
    expect(graph).toContain("\\- sibling [feature-2]");
  });

  it("accepts --option=value syntax equivalently to --option value", () => {
    const spaced = parseCliArgs(["--project-root", "/tmp/project", "--role", "cto", "lanes", "list"]);
    const joined = parseCliArgs(["--project-root=/tmp/project", "--role=cto", "lanes", "list"]);
    expect(joined.options.projectRoot).toBe(spaced.options.projectRoot);
    expect(joined.options.role).toBe("cto");
    expect(joined.command).toEqual(["lanes", "list"]);
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

  it("renders an empty lane graph placeholder when no lanes are returned", () => {
    expect(renderLaneGraph({ lanes: [] })).toBe("ADE lanes\n(no lanes)");
    expect(renderLaneGraph(null)).toBe("ADE lanes\n(no lanes)");
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
      plan: { kind: "execute", label: "lanes list", steps: [], visualizer: "lanes" },
      connection,
      values: {
        result: {
          lanes: [
            { id: "main", name: "main", branchRef: "main" },
            { id: "child", name: "child", branchRef: "feature", parentLaneId: "main" },
          ],
        },
      },
    } as any);
    expect(summarized).toMatchObject({
      lanes: expect.any(Array),
    });
    expect((summarized as any).visual).toContain("\\- main [main]");
    expect((summarized as any).visual).toContain("\\- child [feature]");
  });
});
