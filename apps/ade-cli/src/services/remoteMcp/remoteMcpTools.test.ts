import { describe, expect, it } from "vitest";
import { buildCliPlan } from "../../cli";
import { TYPED_TOOLS, type TypedTool } from "./remoteMcpTools";

/** One value for every input a tool declares, so each flag it can emit is emitted. */
function everyInput(tool: TypedTool): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(tool.properties)) {
    const spec = schema as { type?: string; enum?: unknown[]; minimum?: number };
    if (spec.enum?.length) input[name] = spec.enum[0];
    else if (spec.type === "integer") input[name] = spec.minimum ?? 1;
    else if (spec.type === "boolean") input[name] = true;
    else if (spec.type === "object") input[name] = { 1: "yes" };
    else input[name] = name === "provider" ? "codex" : name === "model" ? "openai/gpt-5.5" : `${name}-1`;
  }
  return input;
}

// The typed tools hand their argv to `ade`, on this computer or another one,
// so every flag they emit has to be one the CLI still accepts.
describe("ADE MCP typed tools", () => {
  it.each(TYPED_TOOLS.map((tool) => [tool.name, tool] as const))("%s builds argv the CLI accepts", (_name, tool) => {
    const built = tool.build(everyInput(tool));
    if (!("argv" in built)) throw new Error(`${tool.name} did not build: ${built.error}`);
    expect(() => buildCliPlan(built.argv)).not.toThrow();
  });
});
