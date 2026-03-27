import { describe, expect, it } from "vitest";
import { getToolMeta } from "./chatToolAppearance";

describe("getToolMeta", () => {
  it("returns direct matches for known tool names", () => {
    const readMeta = getToolMeta("Read");
    expect(readMeta.label).toBe("Read");
    expect(readMeta.category).toBe("read");
    expect(readMeta.sourceTone).toBe("info");

    const bashMeta = getToolMeta("Bash");
    expect(bashMeta.label).toBe("Shell");
    expect(bashMeta.category).toBe("exec");
    expect(bashMeta.sourceTone).toBe("warning");
  });

  it("returns correct metadata for write tools", () => {
    const writeMeta = getToolMeta("Write");
    expect(writeMeta.label).toBe("Write");
    expect(writeMeta.category).toBe("write");
    expect(writeMeta.sourceTone).toBe("success");

    const editMeta = getToolMeta("Edit");
    expect(editMeta.label).toBe("Edit");
    expect(editMeta.category).toBe("write");
  });

  it("returns correct metadata for plan tools", () => {
    const todoMeta = getToolMeta("TodoWrite");
    expect(todoMeta.label).toBe("Plan");
    expect(todoMeta.category).toBe("plan");
  });

  it("returns correct metadata for codex tools", () => {
    const execMeta = getToolMeta("exec_command");
    expect(execMeta.label).toBe("Shell");
    expect(execMeta.category).toBe("codex");

    const patchMeta = getToolMeta("apply_patch");
    expect(patchMeta.label).toBe("Patch");
    expect(patchMeta.category).toBe("codex");
  });

  it("resolves dotted tool names by extracting the action part", () => {
    const meta = getToolMeta("functions.exec_command");
    expect(meta.label).toBe("Shell");
    expect(meta.category).toBe("codex");
  });

  it("resolves MCP-style double-underscore tool names by extracting the action", () => {
    const meta = getToolMeta("mcp__custom__bash");
    expect(meta.label).toBe("Shell");
    expect(meta.category).toBe("exec");
  });

  it("returns a fallback for completely unknown tools", () => {
    const meta = getToolMeta("totally_unknown_tool");
    expect(meta.label).toBeTruthy();
    expect(meta.category).toBe("meta");
    expect(meta.sourceTone).toBe("muted");
  });

  it("extracts file path targets via getTarget for read tools", () => {
    const readMeta = getToolMeta("Read");
    expect(readMeta.getTarget).toBeDefined();
    expect(readMeta.getTarget!({ file_path: "/Users/admin/foo.ts" })).toBe("/Users/admin/foo.ts");
    expect(readMeta.getTarget!({ path: "/Users/admin/bar.ts" })).toBe("/Users/admin/bar.ts");
  });

  it("extracts command targets for shell tools", () => {
    const bashMeta = getToolMeta("Bash");
    expect(bashMeta.getTarget).toBeDefined();
    expect(bashMeta.getTarget!({ command: "npm test" })).toBe("npm test");
  });

  it("extracts query targets for search tools", () => {
    const searchMeta = getToolMeta("Grep");
    expect(searchMeta.getTarget).toBeDefined();
    expect(searchMeta.getTarget!({ pattern: "TODO" })).toBe("TODO");
  });

  it("extracts task count for delegate_parallel", () => {
    const meta = getToolMeta("delegate_parallel");
    expect(meta.getTarget).toBeDefined();
    expect(meta.getTarget!({ tasks: [1, 2, 3] })).toBe("3 task(s)");
    expect(meta.getTarget!({ tasks: [] })).toBe("0 task(s)");
    expect(meta.getTarget!({})).toBe("0 task(s)");
  });

  it("returns null or empty for getTarget when args are missing", () => {
    const readMeta = getToolMeta("Read");
    const result = readMeta.getTarget!({});
    expect(result).toBeFalsy();
  });

  it("returns meta tools for orchestrator actions", () => {
    const spawnMeta = getToolMeta("spawn_worker");
    expect(spawnMeta.label).toBe("Spawn");
    expect(spawnMeta.category).toBe("meta");

    const messageMeta = getToolMeta("message_worker");
    expect(messageMeta.label).toBe("Message");

    const broadcastMeta = getToolMeta("broadcast");
    expect(broadcastMeta.label).toBe("Broadcast");
  });
});
