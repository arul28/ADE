import { z, type ZodType } from "zod";
import type { ExecutableTool } from "../ai/tools/executableTool";
import type { OrchestrationToolMap } from "../ai/tools/orchestrationTools";
import type { CtoOperatorToolMap } from "../ai/tools/ctoOperatorTools";
import type { CtoToolPack } from "../ai/tools/ctoToolPacks";

/**
 * Codex's dynamic tool wire shape and the two pure functions that build it.
 *
 * They live here rather than in `agentChatService` because nothing about them
 * needs the chat runtime: given a tool map and a set of loaded packs they are
 * a total function. Kept in their own module, a unit test for the defer rule
 * costs a zod import instead of the Cursor SDK pool, the Droid worker, the
 * model registry and the whole chat graph. Every service-side type below is
 * imported `type`-only for the same reason.
 */
export type CodexDynamicToolSpec = {
  namespace?: string | null;
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
};

function stripJsonSchemaMeta(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const record = { ...(schema as Record<string, unknown>) };
  delete record.$schema;
  return record;
}

export function jsonSchemaForExecutableTool(toolDefinition: ExecutableTool): unknown {
  try {
    return stripJsonSchemaMeta(z.toJSONSchema(toolDefinition.inputSchema as ZodType));
  } catch {
    return { type: "object", additionalProperties: true };
  }
}

/**
 * `deferLoading` asks Codex to keep a tool's definition out of the prompt
 * until the model reaches for it. It is opt-in per tool via the predicate:
 * with no predicate every spec is eager, which is the behavior every tool set
 * had before packs existed.
 */
export const buildCodexDynamicToolSpecs = (
  tools: OrchestrationToolMap,
  namespace: string,
  deferLoading?: (name: string, toolDefinition: ExecutableTool) => boolean,
): CodexDynamicToolSpec[] =>
  Object.entries(tools).map(([name, toolDefinition]) => ({
    namespace,
    name,
    description: toolDefinition.description,
    inputSchema: jsonSchemaForExecutableTool(toolDefinition),
    deferLoading: deferLoading?.(name, toolDefinition) ?? false,
  }));

/**
 * The CTO's Codex defer predicate: core-pack tools are never deferred, and an
 * extension pack stops being deferred once `loadCtoTools` has run for it.
 * A tool with no pack metadata (any non-CTO tool set) is never deferred.
 */
export const codexDeferCtoTool = (
  toolDefinition: ExecutableTool,
  loadedPacks: ReadonlySet<CtoToolPack>,
): boolean => {
  const packed = toolDefinition as Partial<CtoOperatorToolMap[string]>;
  if (typeof packed.pack !== "string") return false;
  if (packed.alwaysLoad === true) return false;
  return !loadedPacks.has(packed.pack);
};
