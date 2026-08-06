import { describe, expect, it } from "vitest";
import { droidDisabledToolIdsForCategories, droidMcpToolsToDisable } from "./droidSdkProtocol";
import { ORCHESTRATION_LEAD_DENIED_DROID_TOOL_CATEGORIES } from "../../../shared/orchestrationRuntimePolicy";

// Shape mirrors Droid's `session.listTools()` result. Ids are build-specific
// (`edit_file`, `apply-patch-cli`, `create-cli`, …), which is exactly why the
// deny is expressed as categories and resolved against the live tool list.
const DROID_TOOLS = [
  { id: "view_file", llmId: "Read", category: "read" },
  { id: "grep_tool", llmId: "Grep", category: "read" },
  { id: "edit_file", llmId: "edit_file", category: "edit" },
  { id: "apply_patch", llmId: "apply_patch", category: "edit" },
  { id: "apply-patch-cli", llmId: "ApplyPatch", category: "edit" },
  { id: "create-cli", llmId: "Create", category: "edit" },
  { id: "execute_terminal_command", llmId: "Execute", category: "execute" },
  { id: "task-cli", llmId: "Task", category: "execute" },
  { id: "todo_write", llmId: "TodoWrite", category: "other" },
];

describe("droidDisabledToolIdsForCategories", () => {
  it("selects every Droid-native edit and execute tool for an orchestrator lead", () => {
    const disabled = droidDisabledToolIdsForCategories(
      DROID_TOOLS,
      ORCHESTRATION_LEAD_DENIED_DROID_TOOL_CATEGORIES,
    );
    expect(disabled).toEqual([
      "edit_file",
      "apply_patch",
      "apply-patch-cli",
      "create-cli",
      "execute_terminal_command",
      "task-cli",
    ]);
    // Reads survive so the lead can still plan.
    expect(disabled).not.toContain("view_file");
    expect(disabled).not.toContain("grep_tool");
    // Every tool Droid classifies as edit/execute is covered — no id list to
    // drift out of date when Droid renames or adds one.
    for (const tool of DROID_TOOLS) {
      if (tool.category === "edit" || tool.category === "execute") {
        expect(disabled).toContain(tool.id);
      }
    }
  });

  it("disables nothing when no category is denied", () => {
    expect(droidDisabledToolIdsForCategories(DROID_TOOLS, [])).toEqual([]);
  });

  it("ignores malformed entries rather than emitting empty tool ids", () => {
    expect(droidDisabledToolIdsForCategories(
      [{ id: "", category: "edit" }, { category: "edit" }, { id: "edit_file", category: "edit" }],
      ["edit"],
    )).toEqual(["edit_file"]);
  });
});

describe("droidMcpToolsToDisable", () => {
  it("disables enabled user MCP tools while retaining ADE's leased server", () => {
    expect(droidMcpToolsToDisable([
      { serverName: "ade-orchestration", name: "spawn_agent", isEnabled: true },
      { serverName: "filesystem", name: "write_file", isEnabled: true },
      { serverName: "filesystem", name: "read_file", isEnabled: false },
      { serverName: "linear", name: "search", isEnabled: true },
    ], ["ade-orchestration"])).toEqual([
      { serverName: "filesystem", toolName: "write_file" },
      { serverName: "linear", toolName: "search" },
    ]);
  });

  it("ignores malformed entries and fails closed for unknown MCP state", () => {
    expect(droidMcpToolsToDisable([
      { serverName: "", name: "write_file", isEnabled: true },
      { serverName: "filesystem", name: "", isEnabled: true },
      { serverName: "filesystem", name: "write_file", isEnabled: false },
      { serverName: "filesystem", name: "unknown_state" },
    ], [])).toEqual([
      { serverName: "filesystem", toolName: "unknown_state" },
    ]);
  });
});
