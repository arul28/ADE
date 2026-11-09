import os from "node:os";
import { getErrorMessage } from "../../../../desktop/src/main/services/shared/utils";
import type { RemoteMcpConnectionSummary } from "../../../../desktop/src/shared/types/remoteMcp";
import { CHAT_HAS_NO_PROOF_YET } from "../../../../desktop/src/shared/proofProvenance";
import type { ChatDeletedInfo } from "../../cliChatLocate";
import { runAdeForRemote } from "./remoteMcpRunner";
import { nonEmptyString } from "./remoteMcpTools";
import {
  toolError,
  withMachineLabel,
  type RemoteMcpCallContext,
  type RemoteMcpMachineRouter,
  type RemoteMcpRosterMachine,
  type RemoteMcpToolResult,
} from "./remoteMcpForward";

/**
 * A chat id finds its chat. The chat tools need only `session`: when the
 * project the call ran in has no such chat, `ade chat locate` says where it is,
 * and the call runs again in that project here or goes to that computer, which
 * is remembered per connection for the next call. A chat no computer has
 * answers `state: "deleted"` or `state: "not_found"`, never a bare null.
 */

/** Tools that act on one chat by id: without `machine`, the chat's own computer answers. */
export const CHAT_ID_TOOL_NAMES: ReadonlySet<string> = new Set([
  "chat_read", "chat_status", "chat_wait", "chat_events", "chat_send", "chat_respond", "chat_interrupt", "chat_update", "proof_review",
]);
/** `ade chat locate` asks every computer at once, five seconds each. */
const CHAT_LOCATE_TIMEOUT_MS = 20_000;
const MAX_CHAT_HOMES = 500;
const CHAT_NOT_FOUND = "chat_not_found";

type ChatHome = { machineKey: string | null; projectId: string | null };

/** What `ade chat locate --json` says. */
type LocatedChat = {
  machine: { key: string | null; isThisMachine: boolean } | null;
  projectId: string | null;
  personal: boolean;
  deleted: ChatDeletedInfo | null;
  offline: string[];
  note: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The session a call names, when it is a chat-id tool asked about a chat (not `proof_review` of one proof). */
export function chatIdOf(name: string, input: Record<string, unknown>): string | null {
  return CHAT_ID_TOOL_NAMES.has(name) && !nonEmptyString(input.proof) ? nonEmptyString(input.session) : null;
}

function firstText(result: RemoteMcpToolResult): string {
  return result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text ?? "";
}

/**
 * `proof_review` of a chat its project has no proof for. In another project
 * that is also how a missing chat reads, so it counts as a miss until the
 * chat's own project gives it.
 */
function saysNoProofYet(tool: string, result: RemoteMcpToolResult): boolean {
  return tool === "proof_review" && result.isError === true && firstText(result).includes(CHAT_HAS_NO_PROOF_YET);
}

/** A chat tool's answer that says this project has no such chat. */
function isChatMiss(tool: string, result: RemoteMcpToolResult): boolean {
  const value = asRecord(asRecord(result.structuredContent).result);
  if (value.error === CHAT_NOT_FOUND) return true;
  if (result.isError) return /chat session '[^']*' was not found/i.test(firstText(result)) || saysNoProofYet(tool, result);
  if (tool === "chat_wait") return value.error === "session_not_found";
  // These answer `{ result: null }` (or a bare null) for a chat they do not have.
  return (tool === "chat_status" || tool === "chat_events")
    && (asRecord(result.structuredContent).result === null || ("result" in value && value.result === null));
}

/** What a chat call needs from the protocol. */
export type ChatCall = {
  connection: RemoteMcpConnectionSummary;
  name: string;
  params: Record<string, unknown>;
  /** The call's arguments without `machine`. */
  input: Record<string, unknown>;
  sessionId: string;
  context: RemoteMcpCallContext;
  only: RemoteMcpConnectionSummary["onlyMachine"] | null;
  /** Answers a refusal (logged as one). */
  refuse: (reason: string) => RemoteMcpToolResult;
};

export function createChatRouter(deps: {
  callTool: (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>) => Promise<RemoteMcpToolResult>;
  forwardTo: (call: ChatCall, input: Record<string, unknown>, machine: RemoteMcpRosterMachine) => Promise<RemoteMcpToolResult>;
  machines: RemoteMcpMachineRouter;
  onlineMachinesSentence: () => Promise<string>;
  onlyMachineRefusal: (only: NonNullable<RemoteMcpConnectionSummary["onlyMachine"]>) => string;
  warn?: (event: string, data?: Record<string, unknown>) => void;
}) {
  /** Connection and chat id → where it answered, so the next call goes straight there. */
  const chatHomes = new Map<string, ChatHome>();
  const rememberChatHome = (key: string, home: ChatHome): void => {
    chatHomes.delete(key);
    chatHomes.set(key, home);
    // Oldest first: a long-lived brain keeps the most recent few hundred.
    while (chatHomes.size > MAX_CHAT_HOMES) chatHomes.delete(chatHomes.keys().next().value!);
  };

  /** Where `sessionId` is (`ade chat locate`); null when the lookup itself failed. */
  const locateChat = async (call: ChatCall, onlyThisMachine: boolean): Promise<LocatedChat | null> => {
    try {
      const run = await runAdeForRemote({
        argv: ["chat", "locate", call.sessionId, ...(onlyThisMachine ? ["--this-machine"] : []), "--json"],
        cwd: os.homedir(),
        timeoutMs: CHAT_LOCATE_TIMEOUT_MS,
        connectionId: call.connection.id,
        connectionLabel: call.connection.label,
        role: "agent",
      });
      // Exit 1 is "not found", and its JSON still says what is known (deleted, offline).
      if (run.exitCode !== 0 && run.exitCode !== 1) return null;
      const located = asRecord(JSON.parse(run.stdout));
      const machine = asRecord(located.machine);
      return {
        machine: located.machine ? { key: nonEmptyString(machine.key), isThisMachine: machine.isThisMachine === true } : null,
        projectId: nonEmptyString(asRecord(located.project).projectId),
        personal: located.personal === true,
        deleted: located.deleted ? located.deleted as ChatDeletedInfo : null,
        offline: Array.isArray(located.offline) ? located.offline.filter((entry): entry is string => typeof entry === "string") : [],
        note: nonEmptyString(located.note),
      };
    } catch (error) {
      // The call still answers as "not found here"; the log says why no computer was asked.
      deps.warn?.("remote_mcp.chat_locate_failed", { error: getErrorMessage(error) });
      return null;
    }
  };

  /** The answer for a chat no computer that answered has: deleted, or not found, never a bare null. */
  const chatMissAnswer = (call: ChatCall, first: RemoteMcpToolResult, located: LocatedChat | null): RemoteMcpToolResult => {
    const { name, sessionId } = call;
    if (located?.deleted) {
      const { deletedAt, reopenable, title, machineName, projectId, projectName } = located.deleted;
      return {
        content: [{
          type: "text",
          text: `Chat ${sessionId} was deleted at ${deletedAt}, on ${machineName}. `
            + (reopenable === false
              ? "Its conversation is gone."
              : `Reopen it with the ade tool: args ["chat","deleted","reopen","${sessionId}"], project "${projectId ?? ""}"`
                + `${machineName === "this machine" ? "" : `, machine "${machineName}"`}.`),
        }],
        structuredContent: {
          view: name,
          result: { sessionId, state: "deleted", deletedAt, reopenable, title, machine: machineName, project: { id: projectId, name: projectName } },
        },
        isError: true,
      };
    }
    if (located?.personal) return toolError(`Chat ${sessionId} is a personal chat, outside any project, so these tools can't reach it.`);
    // "No such chat yet" is chat_wait's own answer: a chat from chat_start appears once its lane is set up.
    if (name === "chat_wait") return first;
    const unasked = [
      located?.offline.length ? `offline, not asked: ${located.offline.join(", ")}` : null,
      located?.note ?? null,
    ].filter(Boolean).join("; ");
    return {
      content: [{ type: "text", text: `No chat ${sessionId} on any computer that answered${unasked ? ` (${unasked})` : ""}. chat_list shows a project's chats.` }],
      structuredContent: { view: name, result: { sessionId, state: "not_found", error: CHAT_NOT_FOUND } },
      isError: true,
    };
  };

  /**
   * After a miss, with the chat located on this computer: run again in its own
   * project, whose answer is the truth even when it is "nothing yet" (a chat
   * with no proof). Null when the chat is not on this computer.
   */
  const answerHere = async (
    call: ChatCall,
    first: RemoteMcpToolResult,
    located: LocatedChat | null,
  ): Promise<{ result: RemoteMcpToolResult; projectId: string | null } | null> => {
    if (!located?.machine?.isThisMachine) return null;
    if (located.projectId && located.projectId !== nonEmptyString(call.input.project)) {
      const retried = await deps.callTool(call.connection, { ...call.params, arguments: { ...call.input, project: located.projectId } });
      return { result: retried, projectId: located.projectId };
    }
    return { result: first, projectId: null };
  };

  /** A chat call that may reach only this computer: a call forwarded here, or one that named this computer. */
  const callHere = async (call: ChatCall): Promise<RemoteMcpToolResult> => {
    const first = await deps.callTool(call.connection, call.params);
    if (!isChatMiss(call.name, first)) return first;
    const located = await locateChat(call, true);
    const here = await answerHere(call, first, located);
    // Located here, and the tool still finds nothing: never a bare null.
    if (!here || (isChatMiss(call.name, here.result) && !saysNoProofYet(call.name, here.result))) return chatMissAnswer(call, first, located);
    return here.result;
  };

  /** A chat id and no computer: the chat's own project and computer answer. */
  const callAnywhere = async (call: ChatCall, self: { key: string; name: string }): Promise<RemoteMcpToolResult> => {
    const { connection, name, input, only } = call;
    const labeled = (result: RemoteMcpToolResult) => (call.context.accountMount ? withMachineLabel(result, self) : result);
    // A forwarded call went its one hop: only this computer's projects are left to try.
    if (call.context.via) return labeled(await callHere(call));
    const projectGiven = nonEmptyString(input.project);
    const withProject = (projectId: string | null) => (projectId && !projectGiven ? { ...input, project: projectId } : input);
    // Remembered per connection: one app's lookups never steer another's.
    const homeKey = `${connection.id}:${call.sessionId}`;
    const home = chatHomes.get(homeKey);
    if (home && (!only || home.machineKey === null || only.machineKey === home.machineKey)) {
      if (home.machineKey === null) {
        const result = await deps.callTool(connection, { ...call.params, arguments: withProject(home.projectId) });
        // proof_review's "no proof yet" is an answer only when the chat's own project gave it,
        // not a project the call named that the chat is not in.
        const ranInHome = !projectGiven || projectGiven === home.projectId;
        if (!isChatMiss(name, result) || (ranInHome && saysNoProofYet(name, result))) return labeled(result);
      } else {
        const remembered = await deps.machines.resolve(home.machineKey);
        if (remembered.kind === "remote" && !deps.machines.unavailableReason(remembered.machine)) {
          const result = await deps.forwardTo(call, withProject(home.projectId), remembered.machine);
          if (!isChatMiss(name, result)) return result;
        }
      }
      chatHomes.delete(homeKey);
    }
    const first = await deps.callTool(connection, call.params);
    if (!isChatMiss(name, first)) return labeled(first);
    const located = await locateChat(call, false);
    const here = await answerHere(call, first, located);
    if (here) {
      // Remembered even when its answer was "nothing yet": the next call skips the lookup.
      if (here.projectId) rememberChatHome(homeKey, { machineKey: null, projectId: here.projectId });
      const missed = isChatMiss(name, here.result) && !saysNoProofYet(name, here.result);
      return labeled(missed ? chatMissAnswer(call, here.result, located) : here.result);
    }
    const key = located?.machine?.key;
    if (key) {
      const resolved = await deps.machines.resolve(key);
      if (resolved.kind === "remote") {
        if (only && only.machineKey !== key) return call.refuse(`This chat is on ${resolved.machine.name}. ${deps.onlyMachineRefusal(only)}`);
        const reason = deps.machines.unavailableReason(resolved.machine);
        if (reason) return call.refuse(`This chat is on ${resolved.machine.name}. ${reason} ${await deps.onlineMachinesSentence()}`);
        rememberChatHome(homeKey, { machineKey: key, projectId: located?.projectId ?? null });
        return await deps.forwardTo(call, withProject(located?.projectId ?? null), resolved.machine);
      }
    }
    return labeled(chatMissAnswer(call, first, located));
  };

  return { callHere, callAnywhere };
}
