/**
 * Plugin-declared agent tools.
 *
 * A plugin declares tools in its manifest; this module turns those declarations
 * into the same `ExecutableTool` shape ADE's own orchestration and CTO tool sets
 * produce, so `agentChatService`'s existing per-runtime transports carry them
 * without knowing plugins exist. Calling one proxies to `plugin.invoke` on the
 * owning plugin, and the action's result IS the tool result.
 *
 * ## Why the declaration is read from disk on every build
 *
 * `HTTP_MCP_TOOL_SETS[…].buildTools()` is synchronous and runs at session start
 * (and again per Codex turn). There is no cache here on purpose: the tool list
 * has to follow install state, and "a disabled plugin's tools vanish from the
 * next listing" is exactly the property a cache would break. The read is a
 * registry file plus one `plugin.json` per installed plugin — cold-path fs work
 * on the order of a handful of small files.
 *
 * ## Attribution
 *
 * The plugin id is in the tool NAME (`plugin__<pluginId>__<tool>`), not merely
 * in a description the transcript may drop. An agent choosing the tool, a user
 * reading the transcript, and an approval prompt all name the same plugin, and
 * two plugins cannot collide on one word.
 *
 * ## Which project a call writes into
 *
 * Invocation goes through the machine-scoped invoker — the same one a tap from
 * the phone uses — so a plugin's writes land in whichever project it was last
 * active in. That is the existing single-`plugin`-domain limitation, not a new
 * one; routing an agent tool call to the CHAT's project would need the host to
 * expose a project-scoped invoker, which is a v2 problem it does not yet
 * express.
 *
 * ## Uninstall mid-flight
 *
 * The tool list is a snapshot; a turn can be in progress when the user removes
 * the plugin behind it. `execute` therefore re-checks install state at call
 * time and refuses with the catalog-derived sentence
 * (`gatedActionDomains.pluginNotInstalledMessage`) rather than letting the
 * invoker fail with a transport-shaped error the agent will read as a bug and
 * retry.
 */

import { z } from "zod";

import { requirePluginActionInvoker } from "../../../../../ade-cli/src/services/plugins/pluginInstallServiceRef";
import type {
  PluginManifestTool,
  PluginManifestToolInputNode,
} from "../../../shared/plugins/manifest";
import type { ExecutableTool } from "../ai/tools/executableTool";
import { pluginNotInstalledMessage } from "./gatedActionDomains";
import { readInstalledPluginsFromRegistry, resolvePluginsRoot } from "./pluginInstallService";

/**
 * The word an agent sees. Underscore-doubled because plugin ids are kebab-case
 * (`ade-linear`), so a single separator would be ambiguous with the id's own
 * hyphens — and MCP names are matched literally by allowlists and hooks.
 */
export const PLUGIN_TOOL_NAME_PREFIX = "plugin";

export function pluginAgentToolName(pluginId: string, toolName: string): string {
  return `${PLUGIN_TOOL_NAME_PREFIX}__${pluginId}__${toolName}`;
}

/**
 * The most plugin-authored text one tool call may put into the model's context.
 *
 * The action's result IS the tool result, so this is the one place a plugin
 * writes directly into a conversation the user is paying for. The only bound
 * above it was the child transport's 8 MiB frame ceiling, which is a protocol
 * limit, not a context budget: a chatty plugin could silently consume the
 * window and kill the turn on an overflow error that names nothing, and a
 * hostile one had the largest prompt-injection payload in the product. 64 KiB
 * is the panel budget — the other place a plugin's own text is rendered.
 */
export const PLUGIN_TOOL_RESULT_MAX_CHARS = 64 * 1024;

/**
 * Cut an over-long result and SAY SO, in the result itself.
 *
 * The truncation notice is for the model, not the log: an agent handed a
 * silently clipped JSON document will parse the fragment and act on it, while
 * one told the text was cut can ask for less or report the gap.
 */
function clampPluginToolResult(result: unknown, pluginId: string, toolName: string): unknown {
  const text = typeof result === "string" ? result : null;
  if (text !== null) {
    if (text.length <= PLUGIN_TOOL_RESULT_MAX_CHARS) return result;
    return `${text.slice(0, PLUGIN_TOOL_RESULT_MAX_CHARS)}\n\n[ADE truncated this result: ${pluginId}'s "${toolName}" returned more than ${PLUGIN_TOOL_RESULT_MAX_CHARS} characters.]`;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(result) ?? "";
  } catch {
    // Not serialisable, so it cannot be measured here — the runtime transports
    // fall back to `String(result)`, which is short by construction.
    return result;
  }
  if (encoded.length <= PLUGIN_TOOL_RESULT_MAX_CHARS) return result;
  return `${encoded.slice(0, PLUGIN_TOOL_RESULT_MAX_CHARS)}\n\n[ADE truncated this result: ${pluginId}'s "${toolName}" returned more than ${PLUGIN_TOOL_RESULT_MAX_CHARS} characters.]`;
}

export type PluginAgentToolDeclaration = {
  pluginId: string;
  /** For the tool description, so the agent reads a name a user would. */
  displayName: string;
  tool: PluginManifestTool;
};

/**
 * Every tool declared by an installed AND enabled plugin, in registry order.
 *
 * A plugin whose manifest will not parse contributes nothing: `manifest` is null
 * and it is skipped, the same way a broken manifest contributes no panels.
 */
export function listPluginAgentToolDeclarations(
  options: { pluginsRoot?: string; env?: NodeJS.ProcessEnv } = {},
): PluginAgentToolDeclaration[] {
  const root = options.pluginsRoot?.trim() || resolvePluginsRoot(options.env ?? process.env);
  const declarations: PluginAgentToolDeclaration[] = [];
  for (const plugin of readInstalledPluginsFromRegistry(root)) {
    if (!plugin.record.enabled || !plugin.manifest) continue;
    for (const tool of plugin.manifest.tools) {
      declarations.push({
        pluginId: plugin.record.pluginId,
        displayName: plugin.manifest.displayName,
        tool,
      });
    }
  }
  return declarations;
}

/**
 * One declared property as Zod.
 *
 * Total over the manifest's closed union, so there is no "unsupported, pass it
 * through" branch: every runtime sees the same constraint, and a schema this
 * function could not express would have been refused at parse time instead.
 */
function zodForToolInputNode(node: PluginManifestToolInputNode): z.ZodTypeAny {
  const described = (schema: z.ZodTypeAny): z.ZodTypeAny =>
    node.description ? schema.describe(node.description) : schema;
  switch (node.type) {
    case "string":
      return described(
        node.enum?.length
          // `z.enum` needs a non-empty tuple; the parser guarantees at least one.
          ? z.enum(node.enum as [string, ...string[]])
          : z.string(),
      );
    case "number":
      return described(z.number());
    case "integer":
      return described(z.number().int());
    case "boolean":
      return described(z.boolean());
    case "array":
      return described(z.array(zodForToolInputNode(node.items)));
    case "object":
      return described(zodForToolInputObject(node.properties, node.required));
  }
}

function zodForToolInputObject(
  properties: Record<string, PluginManifestToolInputNode>,
  required: readonly string[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, node] of Object.entries(properties)) {
    const schema = zodForToolInputNode(node);
    shape[name] = required.includes(name) ? schema : schema.optional();
  }
  // Unknown keys are STRIPPED, not rejected: a model that adds a stray argument
  // should not have the whole call fail on a validation message it cannot act
  // on, and the plugin never sees a key it did not declare.
  return z.object(shape);
}

/** The Zod schema for one declared tool's arguments. */
export function zodForPluginTool(tool: PluginManifestTool): z.ZodObject<Record<string, z.ZodTypeAny>> {
  return zodForToolInputObject(tool.input.properties, tool.input.required);
}

/**
 * The refusal for a plugin that is no longer installed or enabled.
 *
 * Same shape as the gated-action-domain denial, and for the same reason: the
 * agent must read "this machine does not have that plugin", not a transport
 * error. Falls back to the plugin id when no catalog can name it — a registered
 * fact, rather than advice invented to fill the gap.
 */
function pluginGoneMessage(pluginId: string, displayName: string): string {
  return pluginNotInstalledMessage(pluginId)
    ?? `This machine no longer has ${displayName || pluginId} — the ${pluginId} plugin was removed or disabled.`;
}

export type PluginAgentToolMapDeps = {
  /** Injected by tests; production reads the machine's plugin registry. */
  listDeclarations?: () => PluginAgentToolDeclaration[];
  /** Injected by tests; production resolves the host's late-bound invoker. */
  invoke?: (args: { pluginId: string; action: string; args?: Record<string, unknown> }) => Promise<unknown>;
  /** Whether the plugin is installed and enabled RIGHT NOW. */
  isLive?: (pluginId: string) => boolean;
};

/**
 * The tool map for one session, or null when no enabled plugin declares a tool.
 *
 * Null rather than `{}` so `ensureHttpMcpServer` skips the lease entirely: a
 * machine with no plugin tools should not start an HTTP MCP server, advertise an
 * empty one to four runtimes, or spend a Codex namespace on nothing.
 */
export function createPluginAgentToolMap(
  deps: PluginAgentToolMapDeps = {},
): Record<string, ExecutableTool> | null {
  const listDeclarations = deps.listDeclarations ?? (() => listPluginAgentToolDeclarations());
  const declarations = listDeclarations();
  if (!declarations.length) return null;
  const isLive = deps.isLive
    ?? ((pluginId: string) => listDeclarations().some((entry) => entry.pluginId === pluginId));
  const tools: Record<string, ExecutableTool> = {};
  for (const { pluginId, displayName, tool } of declarations) {
    const name = pluginAgentToolName(pluginId, tool.name);
    // Registry order decides: a duplicate can only come from two plugins whose
    // ids collide, which the installer already prevents.
    if (tools[name]) continue;
    tools[name] = {
      // The owning plugin is named in the sentence as well as the word, because
      // some runtimes surface the description and not the server it came from.
      description: `${tool.description} (provided by the ${displayName} plugin)`,
      inputSchema: zodForPluginTool(tool),
      execute: async (args: unknown) => {
        if (!isLive(pluginId)) throw new Error(pluginGoneMessage(pluginId, displayName));
        const invoke = deps.invoke ?? requirePluginActionInvoker();
        const result = await invoke({
          pluginId,
          action: tool.action,
          args: (args ?? {}) as Record<string, unknown>,
        });
        return clampPluginToolResult(result, pluginId, tool.name);
      },
    };
  }
  return Object.keys(tools).length ? tools : null;
}
