import type { OpenCodeEvent } from "@opencode/client";
import type { AgentChatEvent, PendingInputRequest } from "../../../shared/types/chat";
import {
  createOpenCodeTurnUsage,
  openCodeUsageTotals,
  recordOpenCodeStepFinish,
  type OpenCodeTurnUsage,
} from "./openCodeTurnUsage";

/**
 * Child sessions (subagents) of an OpenCode chat, and the asks they raise, as
 * ADE chat events.
 *
 * Pure bookkeeping over the state the chat runtime owns: every function takes
 * that state, updates it, and returns the events to emit. The runtime emits
 * them and owns everything with side effects (cards, persistence, replies).
 */

export type OpenCodeSubagent = {
  description: string;
  turnId: string;
  model: string | null;
  settled: boolean;
  usage: OpenCodeTurnUsage;
  /** Closing text of the child's latest text part: its result summary. */
  lastText: string | null;
};

/** A `subagent` call the parent made whose child session has not appeared yet. */
export type OpenCodeSubagentCall = { callId: string; description: string };

export type OpenCodeChildSessions = {
  parentSessionId: string;
  /** Child sessions of the chat's session, including nested ones. */
  subagents: Map<string, OpenCodeSubagent>;
  pendingSubagentCalls: OpenCodeSubagentCall[];
  /** The parent's `subagent` tool call that launched a child, when the turn saw it. */
  callForChild(childId: string): string | null;
};

type SubagentStatus = "completed" | "failed" | "stopped";

export type OpenCodePermissionAsk = Extract<OpenCodeEvent, { type: "permission.asked" }>["data"];

function usageFields(child: OpenCodeSubagent): { usage?: { totalTokens: number; costUsd?: number } } {
  const { totalTokens, costUsd } = openCodeUsageTotals(child.usage);
  if (totalTokens <= 0) return {};
  return { usage: { totalTokens, ...(costUsd > 0 ? { costUsd } : {}) } };
}

/** Remember a parent `subagent` call, so the child it launches carries its description. */
export function rememberOpenCodeSubagentCall(state: OpenCodeChildSessions, callId: string, input: unknown): void {
  const record = input && typeof input === "object" ? input as { description?: unknown; agent?: unknown } : {};
  const description = typeof record.description === "string" && record.description.trim()
    ? record.description.trim()
    : typeof record.agent === "string" ? `${record.agent} subagent` : "Subagent";
  state.pendingSubagentCalls.push({ callId, description });
}

/** Track a new child session. Null when it is already tracked. */
export function openCodeChildStarted(
  state: OpenCodeChildSessions,
  child: { sessionID: string; parentID?: string | null; agent?: string; model?: { providerID?: string; id?: string } | null },
  turnId: string,
): Extract<AgentChatEvent, { type: "subagent_started" }> | null {
  if (state.subagents.has(child.sessionID)) return null;
  const call = child.parentID === state.parentSessionId ? state.pendingSubagentCalls.shift() : undefined;
  const model = child.model?.providerID && child.model.id ? `${child.model.providerID}/${child.model.id}` : null;
  const description = call?.description ?? (child.agent ? `${child.agent} subagent` : "Subagent");
  state.subagents.set(child.sessionID, {
    description,
    turnId,
    model,
    settled: false,
    usage: createOpenCodeTurnUsage(),
    lastText: null,
  });
  return {
    type: "subagent_started",
    taskId: child.sessionID,
    parentToolUseId: call?.callId ?? null,
    description,
    turnId,
    ...(model ? { model } : {}),
  };
}

/** Settle a child once. Null when it is unknown or already settled. */
export function openCodeChildSettled(
  state: OpenCodeChildSessions,
  childId: string,
  status: SubagentStatus,
  summary: string,
): AgentChatEvent | null {
  const child = state.subagents.get(childId);
  if (!child || child.settled) return null;
  child.settled = true;
  return {
    type: "subagent_result",
    taskId: childId,
    parentToolUseId: state.callForChild(childId),
    status,
    summary,
    finalSummary: summary,
    ...usageFields(child),
    turnId: child.turnId,
  };
}

/** Mark a child blocked on an ask, or clear it (`reason` null). */
export function openCodeChildBlocked(
  state: OpenCodeChildSessions,
  childId: string,
  reason: string | null,
): AgentChatEvent | null {
  const child = state.subagents.get(childId);
  if (!child) return null;
  return {
    type: "subagent_progress",
    taskId: childId,
    parentToolUseId: state.callForChild(childId),
    description: child.description,
    summary: reason ? `Waiting for approval — ${reason}` : child.description,
    blockedReason: reason,
    turnId: child.turnId,
  };
}

/**
 * A tracked child's own stream: progress, usage, and its end. Asks and forms
 * are not handled here; the runtime routes them for parent and child alike.
 */
export function mapOpenCodeChildEvent(
  state: OpenCodeChildSessions,
  childId: string,
  child: OpenCodeSubagent,
  event: OpenCodeEvent,
): AgentChatEvent[] {
  const settle = (status: SubagentStatus, summary: string): AgentChatEvent[] => {
    const settled = openCodeChildSettled(state, childId, status, summary);
    return settled ? [settled] : [];
  };
  switch (event.type) {
    case "session.text.ended":
      child.lastText = event.data.text;
      return [];
    case "session.step.ended":
      recordOpenCodeStepFinish(child.usage, `step:${event.data.assistantMessageID}`, event.data, { describesContext: true });
      return [{
        type: "subagent_progress",
        taskId: childId,
        parentToolUseId: state.callForChild(childId),
        description: child.description,
        summary: child.description,
        ...usageFields(child),
        turnId: child.turnId,
      }];
    case "session.execution.started":
      // A finished child continued by id is running again.
      if (!child.settled) return [];
      child.settled = false;
      return [{
        type: "subagent_progress",
        taskId: childId,
        parentToolUseId: state.callForChild(childId),
        description: child.description,
        summary: child.description,
        turnId: child.turnId,
      }];
    case "session.execution.succeeded":
      return settle("completed", child.lastText?.trim() || child.description);
    case "session.execution.failed":
      return settle("failed", event.data.error?.message || "Subagent failed");
    case "session.execution.interrupted":
      return settle("stopped", "Subagent stopped");
    case "session.deleted": {
      const out = settle("stopped", "Subagent session deleted");
      state.subagents.delete(childId);
      return out;
    }
    default:
      return [];
  }
}

/**
 * An OpenCode permission ask as ADE's approval card. A child's ask is
 * attributed to its subagent, so the card and status read "Subagent X is
 * waiting", not an anonymous parent ask.
 */
export function buildOpenCodePermissionRequest(
  ask: OpenCodePermissionAsk,
  context: { child: OpenCodeSubagent | undefined; turnId: string | null },
): { itemId: string; category: "bash" | "write"; description: string; request: PendingInputRequest } {
  const action = ask.action.trim().toLowerCase();
  const resources = ask.resources ?? [];
  const plain = ask.message?.trim()
    || (resources.length ? `${action}: ${resources.join(", ")}` : action || "Approval required");
  const description = context.child ? `${context.child.description} · ${plain}` : plain;
  const itemId = ask.source?.id ?? ask.id;
  return {
    itemId,
    category: action === "shell" ? "bash" : "write",
    description,
    request: {
      requestId: ask.id,
      itemId,
      source: "opencode",
      kind: "approval",
      description,
      questions: [],
      allowsFreeform: false,
      blocking: true,
      canProceedWithoutAnswer: false,
      providerMetadata: {
        type: action,
        resources,
        metadata: ask.metadata ?? {},
        callId: ask.source?.id ?? null,
        childSessionId: context.child ? ask.sessionID : null,
      },
      turnId: context.turnId ?? undefined,
    },
  };
}
