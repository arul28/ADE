import type { AgentChatSession, AgentChatSessionSummary } from "../../../shared/types";
import type { AgentChatApi } from "./agentChatApi";

/**
 * Shared pieces of the bound chat adapters (a machine's personal chats, a
 * guest's shared lane): each implements part of the project chat API and
 * refuses the rest with a clear message, never with a project call.
 */

/**
 * What a bound adapter implements: a subset of the project chat API,
 * signature for signature (one level deep, so `codex.*` can be partial too).
 */
export type PartialAgentChatApi = {
  [K in keyof AgentChatApi]?: AgentChatApi[K] extends (...args: never[]) => unknown
    ? AgentChatApi[K]
    : Partial<AgentChatApi[K]>;
};

/** The pane reads `created.id`; bound backends answer with a summary. */
export function sessionFromSummary(summary: AgentChatSessionSummary): AgentChatSession {
  return { ...summary, id: summary.sessionId } as unknown as AgentChatSession;
}

/** A call that always refuses: "<name> is not available <where>." */
export function boundChatRefusal(name: string, where: string) {
  return async () => {
    throw new Error(`${name} is not available ${where}.`);
  };
}

/**
 * Methods no bound backend has (fork, rewind, recovery, lane naming, usage,
 * parallel launch, Codex goals). The pane hides the controls that call them;
 * these answer any path that still reaches one.
 */
export function boundChatRefusals(where: string) {
  const refuse = (name: string) => boundChatRefusal(name, where);
  return {
    // Best-effort pre-start of a CLI-backed model; a bound backend starts the provider on the first send.
    warmupModel: async () => undefined,
    handoff: refuse("Handoff"),
    rewindFiles: refuse("Rewind"),
    recoverContinuity: refuse("Transcript recovery"),
    recoverCodexTurn: refuse("Codex turn recovery"),
    generateAutoLaneIdentity: refuse("Lane naming"),
    getContextUsage: refuse("/context"),
    getClaudeUsage: refuse("/usage"),
    parallelLaunchState: { get: refuse("Parallel launch"), set: refuse("Parallel launch") },
    codex: {
      getGoal: async () => null,
      setGoal: refuse("Codex goals"),
      clearGoal: refuse("Codex goals"),
      setGoalStatus: refuse("Codex goals"),
      resetMemory: refuse("Codex memory reset"),
      terminateBackgroundTerminal: refuse("Stopping a Codex background terminal"),
    },
  };
}
