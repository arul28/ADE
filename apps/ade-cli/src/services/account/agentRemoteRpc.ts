/**
 * The pieces of the multi-project RPC server that serve the account's OTHER
 * machines' agents: which machine-level methods they may call, where a
 * child-creating request carries its parent, and how a `machines.call` names
 * its scope. Pure functions over request JSON; the handler keeps the state.
 * See docs/features/sync-and-multi-device/cross-machine-agents.md.
 */
import { REMOTE_CALLER_PARAM } from "../../../../desktop/src/shared/runtimeClientNames";
import type { MachineCallScope } from "./agentMachineBridge";
import { isRecord } from "./machineBridge";


export function omitRemoteCaller(
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!(REMOTE_CALLER_PARAM in params)) return params;
  const { [REMOTE_CALLER_PARAM]: _claim, ...rest } = params;
  return rest;
}

export function readMachineCallScope(value: unknown): MachineCallScope | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (kind === "personal" || kind === "machine") return { kind };
  if (kind === "repo" && typeof value.originUrl === "string" && value.originUrl.trim()) {
    return { kind, originUrl: value.originUrl.trim() };
  }
  if (kind === "project" && typeof value.selector === "string" && value.selector.trim()) {
    return { kind, selector: value.selector.trim() };
  }
  return null;
}

/** Machine-level methods an `AGENT_REMOTE_CLIENT_NAME` connection may call. */
export const AGENT_REMOTE_MACHINE_METHODS: ReadonlySet<string> = new Set([
  "ade/initialize",
  "ade/initialized",
  "ping",
  "runtime/info",
  "projects.list",
  "personalChats.call",
  "machines.deliverWake",
  "machines.cloneForAgent",
]);

/**
 * Where a request that starts a child chat carries the child's parent:
 * `chat.createSession` / `chat.launchHeadless` args, `chat.startLaunch` under
 * `chat.create`, and the `start_cli_session` tool's own arguments. Null for
 * every other request.
 */
export function childParentSlot(
  method: string,
  params: Record<string, unknown>,
): { read: () => string | null; write: (value: string) => Record<string, unknown> } | null {
  if (method !== "ade/actions/call" || !isRecord(params.arguments)) return null;
  const toolArgs = params.arguments;
  const readFrom = (record: Record<string, unknown> | null): string | null =>
    record && typeof record.orchestrationParentSessionId === "string"
      ? record.orchestrationParentSessionId.trim() || null
      : null;
  if (params.name === "start_cli_session") {
    return {
      read: () => readFrom(toolArgs),
      write: (value) => ({ ...params, arguments: { ...toolArgs, orchestrationParentSessionId: value } }),
    };
  }
  if (params.name !== "run_ade_action" || toolArgs.domain !== "chat" || !isRecord(toolArgs.args)) return null;
  const args = toolArgs.args;
  if (toolArgs.action === "createSession" || toolArgs.action === "launchHeadless") {
    return {
      read: () => readFrom(args),
      write: (value) => ({
        ...params,
        arguments: { ...toolArgs, args: { ...args, orchestrationParentSessionId: value } },
      }),
    };
  }
  if (toolArgs.action === "startLaunch" && isRecord(args.chat) && isRecord(args.chat.create)) {
    const chat = args.chat;
    const create = args.chat.create;
    return {
      read: () => readFrom(create),
      write: (value) => ({
        ...params,
        arguments: {
          ...toolArgs,
          args: { ...args, chat: { ...chat, create: { ...create, orchestrationParentSessionId: value } } },
        },
      }),
    };
  }
  return null;
}

/** The new chat's id in a create answer, wherever the action put it. */
export function createdChatSessionId(value: unknown): string | null {
  // `ade/actions/call` answers `{ structuredContent: { domain, action, result } }`;
  // older shapes put the envelope or the session at the top.
  const structured = isRecord(value) && isRecord(value.structuredContent) ? value.structuredContent : null;
  const candidates = [
    structured && isRecord(structured.result) ? structured.result : null,
    isRecord(value) && isRecord(value.result) ? value.result : null,
    structured,
    value,
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    for (const key of ["sessionId", "chatSessionId", "id"]) {
      const id = candidate[key];
      if (typeof id === "string" && id.trim()) return id.trim();
    }
  }
  return null;
}

/** Per-connection cap on foreign callers with their own project handler. */
export const MAX_FOREIGN_CALLER_HANDLERS = 64;
