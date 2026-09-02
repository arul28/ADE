import { describe, expect, it } from "vitest";

import {
  CLAUDE_READ_ONLY_TOOLS,
  claudeBuiltInIsReadOnly,
  claudeToolInputPaths,
  claudeToolNeedsApproval,
  normalizeToolNameForApproval,
} from "./claudeToolGate";
import { HOST_TOOL_APPROVAL_NAMES } from "../../../shared/__fixtures__/hostToolApprovalNames";

describe("normalizeToolNameForApproval", () => {
  it("collapses case and every run of punctuation to one underscore", () => {
    expect(normalizeToolNameForApproval("NotebookEdit")).toBe("notebookedit");
    expect(normalizeToolNameForApproval("notebook-edit")).toBe("notebook_edit");
    expect(normalizeToolNameForApproval("  Notebook Edit  ")).toBe("notebook_edit");
  });

  it("keeps an MCP tool's server prefix attached", () => {
    expect(normalizeToolNameForApproval("mcp__srv__read")).toBe("mcp_srv_read");
  });
});

describe("claudeBuiltInIsReadOnly", () => {
  // The one exemption from prompting under `fallback: "ask"`. It decides
  // whether an embedder gets an approval card for every single file read, so
  // it is worth being able to answer without booting the chat service.
  it("matches every member of the set, in any casing", () => {
    for (const tool of CLAUDE_READ_ONLY_TOOLS) {
      expect(claudeBuiltInIsReadOnly(tool)).toBe(true);
      expect(claudeBuiltInIsReadOnly(tool.toUpperCase())).toBe(true);
    }
  });

  it("refuses a name that merely contains one", () => {
    // Literal membership, never a substring: this is the bug the whole
    // permission-policy module replaced.
    expect(claudeBuiltInIsReadOnly("ReadTheDatabase")).toBe(false);
    expect(claudeBuiltInIsReadOnly("GrepAndDelete")).toBe(false);
  });

  it("never exempts a host MCP tool, however read-only it sounds", () => {
    // An MCP tool normalizes with its `mcp_<server>_` prefix intact, so it
    // cannot collide with a bare built-in name.
    expect(claudeBuiltInIsReadOnly("mcp__srv__read")).toBe(false);
    for (const tool of HOST_TOOL_APPROVAL_NAMES) {
      expect(claudeBuiltInIsReadOnly(tool)).toBe(false);
    }
  });

  it("holds Claude's mutating built-ins outside the set", () => {
    for (const tool of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Task"]) {
      expect(claudeBuiltInIsReadOnly(tool)).toBe(false);
    }
  });
});

describe("claudeToolInputPaths", () => {
  it("reads every accepted key and de-duplicates", () => {
    expect(claudeToolInputPaths({ file_path: "a.ts" })).toEqual(["a.ts"]);
    expect(claudeToolInputPaths({ filePath: "a.ts", path: "a.ts" })).toEqual(["a.ts"]);
    expect(claudeToolInputPaths({ notebook_path: "n.ipynb" })).toEqual(["n.ipynb"]);
    expect(claudeToolInputPaths({ notebookPath: "n.ipynb" })).toEqual(["n.ipynb"]);
  });

  it("reads a MultiEdit's per-edit paths", () => {
    expect(claudeToolInputPaths({
      edits: [{ file_path: "a.ts" }, { file_path: "b.ts" }, { file_path: "a.ts" }, null, "x"],
    })).toEqual(["a.ts", "b.ts"]);
  });

  it("returns nothing for a tool that names no path", () => {
    // `Bash` carries a command. An empty result is what makes containment fall
    // through to the tool rules and the fallback rather than judge a command by
    // a directory that cannot change.
    expect(claudeToolInputPaths({ command: "rm -rf /" })).toEqual([]);
    expect(claudeToolInputPaths({})).toEqual([]);
  });

  it("ignores non-strings and blank strings", () => {
    expect(claudeToolInputPaths({ file_path: 42, path: "   ", filePath: null })).toEqual([]);
  });
});

describe("claudeToolNeedsApproval", () => {
  // ADE's pre-policy heuristic, kept verbatim because it is the behavior of
  // every chat that supplies no permission policy.
  it("never prompts under bypassPermissions or plan", () => {
    for (const mode of ["bypassPermissions", "plan"]) {
      expect(claudeToolNeedsApproval("Write", { file_path: "a" }, mode)).toBe(false);
      expect(claudeToolNeedsApproval("Bash", { command: "ls" }, mode)).toBe(false);
    }
  });

  it("prompts only for Bash under acceptEdits", () => {
    expect(claudeToolNeedsApproval("Bash", {}, "acceptEdits")).toBe(true);
    expect(claudeToolNeedsApproval("Write", {}, "acceptEdits")).toBe(false);
    expect(claudeToolNeedsApproval("Edit", {}, "acceptEdits")).toBe(false);
  });

  it("prompts for the mutating built-ins under default", () => {
    for (const tool of ["Bash", "Write", "Edit", "NotebookEdit", "Agent"]) {
      expect(claudeToolNeedsApproval(tool, {}, "default")).toBe(true);
    }
  });

  it("never prompts for a read-only built-in in any mode", () => {
    for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan"]) {
      for (const tool of CLAUDE_READ_ONLY_TOOLS) {
        expect(claudeToolNeedsApproval(tool, {}, mode)).toBe(false);
      }
    }
  });

  // The imprecision that structured permission policies exist to replace,
  // pinned so a reader does not mistake it for a rule anyone should copy.
  it("is a substring test, which is why a policy replaces it", () => {
    expect(claudeToolNeedsApproval("mcp__srv__list_agents", {}, "default")).toBe(true);
    expect(claudeToolNeedsApproval("mcp__srv__delete_project", {}, "default")).toBe(false);
  });
});
