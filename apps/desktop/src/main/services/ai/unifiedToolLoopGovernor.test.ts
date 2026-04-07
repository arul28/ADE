import { describe, expect, it } from "vitest";
import { createUnifiedToolLoopGovernor } from "./unifiedToolLoopGovernor";

function makeGovernor(args?: {
  permissionMode?: "plan" | "edit" | "full-auto";
  harnessProfile?: "guarded" | "read_only" | "verified";
  initialTodoItems?: Array<{ id?: string; description?: string; status?: "pending" | "in_progress" | "completed" }>;
}) {
  return createUnifiedToolLoopGovernor({
    cwd: "/repo",
    modelDescriptor: {
      authTypes: ["local"],
      harnessProfile: args?.harnessProfile ?? "guarded",
    },
    permissionMode: args?.permissionMode ?? "edit",
    initialTodoItems: args?.initialTodoItems,
  });
}

const ALL_TOOL_NAMES = [
  "readFile",
  "grep",
  "glob",
  "listDir",
  "findRoutingFiles",
  "findPageComponents",
  "findAppEntryPoints",
  "summarizeFrontendStructure",
  "TodoWrite",
  "TodoRead",
  "askUser",
  "exitPlanMode",
  "editFile",
  "writeFile",
];

describe("unifiedToolLoopGovernor", () => {
  it("blocks the third identical readFile call in plan mode without suggesting a random candidate file", () => {
    const governor = makeGovernor({ permissionMode: "plan" });
    const input = {
      file_path: "/repo/apps/web/src/app/pages/HomePage.tsx",
      offset: 136,
      limit: 50,
    };

    expect(governor.evaluateToolCall("readFile", input).decision).toBe("allow");
    expect(governor.evaluateToolCall("readFile", input).decision).toBe("allow");

    const decision = governor.evaluateToolCall("readFile", input);
    expect(decision.decision).toBe("stop_tools");
    expect(decision.reason).toContain("repeated identical readFile call 3 times");
    expect(governor.buildBlockedToolSummary()).toContain("TodoWrite plan");
    expect(governor.buildBlockedToolSummary()).not.toContain("DownloadPage.tsx");
  });

  it("points explicit plan mode toward planning tools after the first concrete inspection", () => {
    const governor = makeGovernor({ permissionMode: "plan" });

    governor.recordStep({
      toolCalls: [{
        toolName: "readFile",
        input: { file_path: "/repo/apps/web/src/app/SiteRoutes.tsx" },
      }],
      toolResults: [{
        toolName: "readFile",
        output: {
          path: "/repo/apps/web/src/app/SiteRoutes.tsx",
          content: "export function SiteRoutes() {}",
        },
      }],
    });

    const policy = governor.buildStepPolicy(ALL_TOOL_NAMES);
    expect(policy.activeTools).toEqual(expect.arrayContaining([
      "readFile",
      "TodoWrite",
      "TodoRead",
      "askUser",
      "exitPlanMode",
    ]));
    expect(policy.activeTools).not.toContain("summarizeFrontendStructure");
    expect(policy.activeTools).not.toContain("findRoutingFiles");
    expect(policy.activeTools).not.toContain("findPageComponents");
    expect(policy.activeTools).not.toContain("findAppEntryPoints");
  });

  it("keeps edit tools available after a concrete inspection in edit mode while dropping broad frontend discovery tools", () => {
    const governor = makeGovernor({ permissionMode: "edit" });

    governor.recordStep({
      toolCalls: [{
        toolName: "readFile",
        input: { file_path: "/repo/apps/web/src/app/SiteRoutes.tsx" },
      }],
      toolResults: [{
        toolName: "readFile",
        output: {
          path: "/repo/apps/web/src/app/SiteRoutes.tsx",
          content: "export function SiteRoutes() {}",
        },
      }],
    });

    const policy = governor.buildStepPolicy(ALL_TOOL_NAMES);
    expect(policy.activeTools).toEqual(expect.arrayContaining([
      "readFile",
      "editFile",
      "writeFile",
      "TodoWrite",
    ]));
    expect(policy.activeTools).not.toContain("summarizeFrontendStructure");
    expect(policy.activeTools).not.toContain("findRoutingFiles");
  });

  it("uses exitPlanMode guidance once a meaningful plan already exists in plan mode", () => {
    const governor = makeGovernor({
      permissionMode: "plan",
      initialTodoItems: [
        { id: "1", description: "Inspect routing", status: "completed" },
        { id: "2", description: "Add the blank test page", status: "in_progress" },
      ],
    });

    expect(governor.evaluateToolCall("grep", { path: "/repo", pattern: "Route" }).decision).toBe("allow");
    expect(governor.evaluateToolCall("grep", { path: "/repo", pattern: "Route" }).decision).toBe("allow");
    expect(governor.evaluateToolCall("grep", { path: "/repo", pattern: "Route" }).decision).toBe("stop_tools");

    expect(governor.buildBlockedToolSummary()).toContain("exitPlanMode");
  });
});
