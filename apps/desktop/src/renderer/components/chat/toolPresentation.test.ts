import { describe, expect, it } from "vitest";
import { describeToolIdentifier, replaceInternalToolNames } from "./toolPresentation";

describe("describeToolIdentifier", () => {
  it("returns a fallback for empty input", () => {
    expect(describeToolIdentifier("")).toEqual({ label: "Tool", secondaryLabel: null });
    expect(describeToolIdentifier("  ")).toEqual({ label: "Tool", secondaryLabel: null });
  });

  it("returns direct label overrides for known tools", () => {
    expect(describeToolIdentifier("Read")).toEqual({ label: "Read", secondaryLabel: null });
    expect(describeToolIdentifier("Grep")).toEqual({ label: "Search", secondaryLabel: null });
    expect(describeToolIdentifier("Bash")).toEqual({ label: "Shell", secondaryLabel: null });
    expect(describeToolIdentifier("exec_command")).toEqual({ label: "Shell", secondaryLabel: null });
    expect(describeToolIdentifier("apply_patch")).toEqual({ label: "Patch", secondaryLabel: null });
    expect(describeToolIdentifier("delegate_parallel")).toEqual({ label: "Delegate batch", secondaryLabel: null });
  });

  it("resolves dotted tool names with known namespace labels", () => {
    const result = describeToolIdentifier("functions.exec_command");
    expect(result.label).toBe("Shell");
    expect(result.secondaryLabel).toBe("Workspace");
  });

  it("resolves MCP-style tool names with double-underscore separators", () => {
    const result = describeToolIdentifier("mcp__context7__resolve_library_id");
    expect(result.label).toBe("Docs");
    expect(result.secondaryLabel).toBe("Resolve Library Id");
  });

  it("humanizes unknown snake_case tool parts", () => {
    const result = describeToolIdentifier("mcp__custom_server__do_something");
    expect(result.label).toBe("Custom Server");
    expect(result.secondaryLabel).toBe("Do Something");
  });

  it("uses known action labels from MCP tools", () => {
    const result = describeToolIdentifier("mcp__playwright__bash");
    expect(result.label).toBe("Shell");
    expect(result.secondaryLabel).toBe("Browser");
  });

  it("humanizes a plain unknown tool name", () => {
    const result = describeToolIdentifier("my_custom_tool");
    expect(result.label).toBe("My Custom Tool");
    expect(result.secondaryLabel).toBeNull();
  });

  it("applies TOKEN_LABELS for known abbreviations", () => {
    const result = describeToolIdentifier("mcp__custom__get_api_url");
    expect(result.secondaryLabel).toContain("API");
    expect(result.secondaryLabel).toContain("URL");
  });

  it("handles deeply nested MCP namespaces", () => {
    const result = describeToolIdentifier("mcp__pencil__batch_design");
    expect(result.label).toBe("Canvas");
    expect(result.secondaryLabel).toBe("Batch Design");
  });
});

describe("replaceInternalToolNames", () => {
  it("returns the original text for empty strings", () => {
    expect(replaceInternalToolNames("")).toBe("");
    expect(replaceInternalToolNames("  ")).toBe("  ");
  });

  it("replaces a single known tool name used as full text", () => {
    expect(replaceInternalToolNames("Read")).toBe("Read");
    expect(replaceInternalToolNames("Bash")).toBe("Shell");
    expect(replaceInternalToolNames("exec_command")).toBe("Shell");
  });

  it("replaces namespaced tool mentions inline", () => {
    const result = replaceInternalToolNames("I used functions.exec_command to check the path.");
    expect(result).toContain("Workspace Shell");
    expect(result).not.toContain("functions.exec_command");
  });

  it("replaces MCP tool mentions inline", () => {
    const result = replaceInternalToolNames("Called mcp__context7__resolve_library_id for docs.");
    expect(result).toContain("Docs");
    expect(result).not.toContain("mcp__context7__resolve_library_id");
  });

  it("replaces multiple tool mentions in the same text", () => {
    const result = replaceInternalToolNames("Running functions.exec_command then web.search for docs.");
    expect(result).not.toContain("functions.exec_command");
    expect(result).not.toContain("web.search");
  });

  it("does not replace non-matching plain tool references", () => {
    const input = "The Read tool was used.";
    // "Read" by itself in full text is replaced by TOOL_LABEL_OVERRIDES
    // But inline it is not a namespaced pattern, so it stays
    expect(replaceInternalToolNames(input)).toBe(input);
  });
});
