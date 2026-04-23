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

  it("shell-escapes argv tokens after -- when building shell start commands", () => {
    const plan = buildCliPlan(["shell", "start", "--lane", "lane-1", "--", "cat", "file with spaces.txt", "literal&name"]);
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
      arguments: { domain: "automations", action: "get", args: { id: "rule-42" } },
    });

    const byFlag = buildCliPlan(["automations", "show", "--id", "rule-42"]);
    expect(byFlag.kind).toBe("execute");
    if (byFlag.kind !== "execute") return;
    expect(byFlag.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "automations", action: "get", args: { id: "rule-42" } },
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
      arguments: { domain: "automations", action: "deleteRule", args: { id: "rule-42" } },
    });
  });

  it("automations toggle requires --enabled true|false and coerces to boolean", () => {
    const enabled = buildCliPlan(["automations", "toggle", "rule-42", "--enabled", "true"]);
    expect(enabled.kind).toBe("execute");
    if (enabled.kind !== "execute") return;
    expect(enabled.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "automations", action: "toggleRule", args: { id: "rule-42", enabled: true } },
    });

    const disabled = buildCliPlan(["automations", "toggle", "rule-42", "--enabled", "false"]);
    expect(disabled.kind).toBe("execute");
    if (disabled.kind !== "execute") return;
    expect(disabled.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "automations", action: "toggleRule", args: { id: "rule-42", enabled: false } },
    });
  });

  it("automations toggle errors when --enabled is omitted", () => {
    expect(() => buildCliPlan(["automations", "toggle", "rule-42"])).toThrow(
      /--enabled <true\|false>/,
    );
  });

  it("automations run passes dryRun only when --dry-run is set", () => {
    const plain = buildCliPlan(["automations", "run", "rule-42"]);
    expect(plain.kind).toBe("execute");
    if (plain.kind !== "execute") return;
    expect(plain.steps[0]?.params).toEqual({
      name: "run_ade_action",
      arguments: { domain: "automations", action: "triggerManually", args: { id: "rule-42" } },
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
    const plan = buildCliPlan(["automations", "run", "rule-42", "--lane", "lane-7"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.steps[0]?.params).toMatchObject({
      arguments: { args: { id: "rule-42", laneId: "lane-7" } },
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
