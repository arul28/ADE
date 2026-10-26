import type { Query as ClaudeQuery } from "@anthropic-ai/claude-agent-sdk";

import { stringOrNull } from "../../../shared/agentObservationNormalizers";
import {
  claudeMcpToolName,
  MCP_APP_SESSION_NOT_RUNNING,
  readMcpToolUiMeta,
  toMcpAppToolResult,
  type McpAppToolDescriptor,
} from "../../../shared/mcpApp";
import { withTimeout } from "../ai/utils";
import { sendClaudeControlRequest } from "./claudeSdkCompat";
import { mcpServerFingerprint } from "./mcpAppGrants";
import type { McpAppProviderLink } from "./mcpAppHost";

/**
 * A chat's live provider session as MCP Apps reach it (`shared/mcpApp.ts`,
 * `mcpAppHost.ts`), one builder per provider that can host an app.
 *
 * A link is a chat's LIVE provider session and nothing else: these two
 * builders read a runtime that already exists and never start one, so an app
 * in a chat that has stopped gets "not running" instead of waking its agent.
 *
 * Each takes only the parts of the runtime it reads, as plain shapes, so this
 * file knows nothing of how the chat service keeps a session.
 */

const MCP_APP_PROVIDER_TIMEOUT_MS = 60_000;

type McpServerObservation = {
  name: string;
  toolNames?: string[];
  success: boolean;
  error?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function claudeMcpAppLink(args: {
  /** What the chat's Claude CLI said it can do (`session.protocolCapabilities`). */
  protocolCapabilities: readonly string[] | null | undefined;
  /** The chat's runtime. Read again on every call: a query comes and goes between turns. */
  runtime: { query: ClaudeQuery | null; queryStartPromise: Promise<ClaudeQuery> | null };
  /** A bounded caller cache of provider-reported tools and failures. */
  onServerStatus?: (status: McpServerObservation) => void;
}): McpAppProviderLink | null {
  const { runtime } = args;
  // Reading a `ui://` resource is a capability the CLI has to advertise.
  if (!args.protocolCapabilities?.includes("mcp_read_resource_v1")) return null;
  // Between two turns ADE may be bringing this chat's query back up. That is
  // still the chat's own session: wait for the start already in flight, and
  // never begin one here.
  if (!runtime.query && !runtime.queryStartPromise) return null;
  const liveQuery = async (): Promise<ClaudeQuery> => {
    const query = runtime.query ?? (runtime.queryStartPromise ? await runtime.queryStartPromise.catch(() => null) : null);
    if (!query) throw new Error(MCP_APP_SESSION_NOT_RUNNING);
    return query;
  };
  return {
    provider: "claude",
    listTools: async () => {
      const query = await liveQuery();
      const servers = await withTimeout(query.mcpServerStatus(), MCP_APP_PROVIDER_TIMEOUT_MS, "Claude did not list its MCP tools in time.");
      for (const server of servers) {
        const error = server.error ?? (server.status === "failed" ? "MCP server failed" : null);
        args.onServerStatus?.({
          name: server.name,
          success: server.status === "connected" && error == null,
          ...(server.status === "connected" ? { toolNames: (server.tools ?? []).map((tool) => tool.name) } : {}),
          ...(error ? { error } : {}),
        });
      }
      return servers.flatMap((server): McpAppToolDescriptor[] => server.status !== "connected"
        ? []
        : (server.tools ?? []).map((tool) => ({
            server: server.name,
            serverFingerprint: mcpServerFingerprint(server.config),
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            readOnly: tool.annotations?.readOnly === true,
            ui: readMcpToolUiMeta(tool._meta),
          })));
    },
    readResource: async (server, uri) => {
      const query = await liveQuery();
      return withTimeout(query.readMcpResource(server, uri), MCP_APP_PROVIDER_TIMEOUT_MS, "Claude did not read the resource in time.");
    },
    callTool: async (server, tool, toolArgs) => {
      const query = await liveQuery();
      // `result_not_for_model` (Claude Code 2.1.301+; older CLIs ignore it):
      // the app gets the server's own content blocks, as Codex hands them,
      // not the copy reshaped for a model (images resized, text beside
      // structuredContent dropped). That content is unbounded and untrusted;
      // the host caps it (`MCP_APP_LIMITS.maxCallResultBytes`) and hands it
      // only to the server's own sandboxed app.
      const call = sendClaudeControlRequest(query, {
        subtype: "mcp_call",
        tool: claudeMcpToolName(server, tool),
        arguments: toolArgs,
        result_not_for_model: true,
      });
      // Without the channel an app's tool calls are refused, nothing else.
      if (!call) throw new Error("This version of Claude Code cannot run a tool for an app.");
      const reply = await withTimeout(
        call,
        MCP_APP_PROVIDER_TIMEOUT_MS,
        "Claude did not finish the tool call in time.",
      );
      return toMcpAppToolResult(reply?.response);
    },
  };
}

export function codexMcpAppLink(args: {
  threadId: string | null | undefined;
  /** The app-server process: a link is only for one that is still up. */
  process: { exitCode: number | null; killed: boolean };
  request: <T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number | null }) => Promise<T>;
  /** The definition this chat was given for a server, when it was given one. Read at list time. */
  serverConfig: (server: string) => unknown;
  /** A bounded caller cache of provider-reported tools and failures. */
  onServerStatus?: (status: McpServerObservation) => void;
}): McpAppProviderLink | null {
  const { threadId, request } = args;
  if (!threadId || args.process.exitCode !== null || args.process.killed) return null;
  const options = { timeoutMs: MCP_APP_PROVIDER_TIMEOUT_MS };
  return {
    provider: "codex",
    listTools: async () => {
      const tools: McpAppToolDescriptor[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const listed: { data?: unknown; nextCursor?: unknown } = await request(
          "mcpServerStatus/list",
          // Tools only: the list is read for annotations and `_meta`, and
          // Codex starts a second copy of each server to answer it.
          { threadId, limit: 100, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) },
          options,
        );
        for (const entry of Array.isArray(listed?.data) ? listed.data : []) {
          const server = asRecord(entry);
          const serverName = stringOrNull(server?.name);
          if (!serverName) continue;
          const serverTools = asRecord(server?.tools);
          const toolNames: string[] = [];
          for (const raw of Object.values(serverTools ?? {})) {
            const tool = asRecord(raw);
            const name = stringOrNull(tool?.name);
            if (!tool || !name) continue;
            toolNames.push(name);
            const annotations = asRecord(tool.annotations);
            const title = stringOrNull(tool.title) ?? stringOrNull(annotations?.title);
            const description = stringOrNull(tool.description);
            tools.push({
              server: serverName,
              // Codex does not report a server's definition. ADE knows it
              // only for a server this chat was given; any other server
              // (the registry's, the user's own config) has no fingerprint.
              serverFingerprint: mcpServerFingerprint(args.serverConfig(serverName)),
              name,
              ...(title ? { title } : {}),
              ...(description ? { description } : {}),
              ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
              readOnly: annotations?.readOnlyHint === true,
              ui: readMcpToolUiMeta(tool._meta),
            });
          }
          const status = stringOrNull(server?.status ?? server?.state);
          const errorRecord = asRecord(server?.error);
          const error = stringOrNull(errorRecord?.message ?? server?.error ?? server?.errorMessage ?? server?.message);
          const reportedError = error ?? (status && /(?:fail|error|closed|refused|timeout|unavailable)/i.test(status) ? status : null);
          args.onServerStatus?.({
            name: serverName,
            ...(serverTools ? { toolNames } : {}),
            success: reportedError == null,
            ...(reportedError ? { error: reportedError } : {}),
          });
        }
        cursor = stringOrNull(listed?.nextCursor);
        if (!cursor) break;
      }
      return tools;
    },
    readResource: (server, uri) => request("mcpServer/resource/read", { threadId, server, uri }, options),
    callTool: async (server, tool, toolArgs) =>
      toMcpAppToolResult(await request("mcpServer/tool/call", { threadId, server, tool, arguments: toolArgs }, options)),
  };
}
