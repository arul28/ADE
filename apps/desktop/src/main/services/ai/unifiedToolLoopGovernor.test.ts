import { describe, expect, it, vi } from "vitest";
import { createUnifiedToolLoopGovernor, wrapToolsWithUnifiedLoopGovernor } from "./unifiedToolLoopGovernor";

describe("unifiedToolLoopGovernor", () => {
  const makeGovernor = () => createUnifiedToolLoopGovernor({
    cwd: "/repo",
    modelDescriptor: {
      authTypes: ["local"],
      harnessProfile: "guarded",
    },
    permissionMode: "edit",
  });

  it("suppresses exact duplicate low-value discovery tool calls", async () => {
    const governor = makeGovernor();
    const execute = vi.fn(async () => ({ entries: [{ name: "app", type: "directory" }], count: 1, truncated: false }));
    const tools = wrapToolsWithUnifiedLoopGovernor({
      listDir: {
        description: "stub",
        inputSchema: {},
        execute,
      } as any,
    }, governor);

    const listDir = tools.listDir as any;
    await listDir.execute({ path: "/repo/src", recursive: false });
    await listDir.execute({ path: "/repo/src", recursive: false });
    const suppressed = await listDir.execute({ path: "/repo/src", recursive: false });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(suppressed.suppressed).toBe(true);
    expect(suppressed.message).toContain("Suppressed duplicate listDir call");
  });

  it("suppresses near-duplicate glob families for equivalent source extensions", () => {
    const governor = makeGovernor();

    expect(governor.noteToolCall("glob", { path: "/repo", pattern: "**/*.ts" }).suppressed).toBe(false);
    expect(governor.noteToolCall("glob", { path: "/repo", pattern: "**/*.tsx" }).suppressed).toBe(false);
    expect(governor.noteToolCall("glob", { path: "/repo", pattern: "**/*.js" }).suppressed).toBe(false);

    const suppressed = governor.noteToolCall("glob", { path: "/repo", pattern: "**/*.jsx" });
    expect(suppressed.suppressed).toBe(true);
    expect(suppressed.reason).toBe("same_family");
  });

  it("scores concrete candidate discovery and file inspection as progress", () => {
    const governor = makeGovernor();

    const discovery = governor.recordStep({
      toolCalls: [{ toolName: "findRoutingFiles", input: {} }],
      toolResults: [{
        toolName: "findRoutingFiles",
        output: { routingFiles: ["/repo/src/app/page.tsx", "/repo/src/app/about/page.tsx"] },
      }],
    });

    expect(discovery.progress).toBe("progress");
    expect(discovery.score).toBeGreaterThanOrEqual(2);
    expect(discovery.candidateFiles).toContain("src/app/page.tsx");

    const inspection = governor.recordStep({
      toolCalls: [{ toolName: "readFile", input: { file_path: "/repo/src/app/about/page.tsx" } }],
      toolResults: [],
    });

    expect(inspection.progress).toBe("progress");
    expect(inspection.reasons.join(" ")).toContain("opened src/app/about/page.tsx");
  });

  it("scores repeated broad discovery as non-progress", () => {
    const governor = makeGovernor();

    const summary = governor.recordStep({
      toolCalls: [{ toolName: "listDir", input: { path: "/repo", recursive: true } }],
      toolResults: [{ toolName: "listDir", output: { entries: [], count: 0, truncated: false } }],
    });

    expect(summary.progress).toBe("non_progress");
    expect(summary.score).toBeLessThan(0);
    expect(summary.reasons.join(" ")).toContain("broad recursive directory enumeration");
  });

  it("clamps to narrower tools and forces readFile after repeated low-value steps", () => {
    const governor = makeGovernor();
    const allToolNames = [
      "readFile",
      "grep",
      "glob",
      "listDir",
      "findRoutingFiles",
      "findPageComponents",
      "findAppEntryPoints",
      "summarizeFrontendStructure",
      "editFile",
      "writeFile",
      "askUser",
      "bash",
    ];

    governor.recordStep({
      toolCalls: [{ toolName: "findRoutingFiles", input: {} }],
      toolResults: [{
        toolName: "findRoutingFiles",
        output: { routingFiles: ["/repo/src/app/about/page.tsx"] },
      }],
    });

    governor.recordStep({
      toolCalls: [{ toolName: "glob", input: { path: "/repo", pattern: "**/*.ts" } }],
      toolResults: [{ toolName: "glob", output: { files: [], count: 0 } }],
    });
    governor.recordStep({
      toolCalls: [{ toolName: "glob", input: { path: "/repo", pattern: "**/*.tsx" } }],
      toolResults: [{ toolName: "glob", output: { files: [], count: 0 } }],
    });

    const policy = governor.buildStepPolicy(allToolNames);
    expect(policy.activeTools).toContain("readFile");
    expect(policy.activeTools).not.toContain("glob");
    expect(policy.activeTools).not.toContain("listDir");
    expect(policy.activeTools).not.toContain("grep");
    expect(policy.toolChoice).toEqual({ type: "tool", toolName: "readFile" });
    expect(policy.hiddenSteer).toContain("already searched broadly");
  });
});
