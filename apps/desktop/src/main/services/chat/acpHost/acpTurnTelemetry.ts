/**
 * Usage and telemetry accounting for one ACP session.
 *
 * The translator turns standard `session/update` notifications into rows. This
 * module owns everything that is about cost and occupancy rather than rows:
 * context samples, per-request usage, the provider's turn totals, the model
 * that answered, subagent usage, compaction (reported or inferred), and the
 * fields ADE stamps on the turn's `done` event.
 *
 * ## The semantics every figure follows
 *
 * - `done.usage` token fields are the TURN TOTAL, summed over every model
 *   request in the turn. `inputTokens` is uncached input; cache reads and
 *   writes are their own fields (see `AcpUsageSample`).
 * - `done.usage.contextTokens` is the latest context sample of the turn: the
 *   agent's own `usage_update.used`, or the input side of the last request for
 *   an agent that reports per-request usage instead (Grok).
 * - `costUsd` is only ever the provider's own billing figure, so `costSource`
 *   is always `provider`. List-price math belongs to ADE's usage service.
 * - `usageConfidence` is set only when the totals are not `measured`: read back
 *   from a local ledger or summed from per-request counts (`derived`), or taken
 *   from the prompt result of a dialect whose ledger could not be read
 *   (`estimated`, because Copilot answers `/compact` with the previous turn's
 *   usage verbatim).
 * - `subagentUsage` is helper agents' usage the ledger reported. It is usage,
 *   not work the user watched, so it never becomes a subagent event (which
 *   would draw a card).
 * - A served model that is not the model ADE asked for rides `done.servedModel`
 *   (the chat service logs `agent_chat.served_model_mismatch` for it) and is
 *   told to the user in one `system_notice` per served model. The shared
 *   `isServedModelMismatch` decides: another spelling, a build or effort
 *   variant (`grok-4.7-build` for `grok-4.7`), or a router pick (`auto`) is
 *   the same model. Copilot on a plan that includes only Auto serves its own
 *   pick whatever ADE asks for.
 *
 * ## Inferred compaction
 *
 * Qwen, Kimi, and Copilot report context size but never report a compaction.
 * When a sample falls by more than 40% AND by more than 20k tokens against the
 * previous sample in the same session, with the same window size and no model
 * switch in between, the host publishes one `context_compact` marked
 * `detection: "inferred"`. A provider-reported compaction resets the baseline,
 * so the drop that follows it is never inferred as a second one, and no drop
 * is inferred while a provider compaction is still open. The reverse
 * holds too: when a drop already produced an inferred compaction during a
 * turn, the Copilot ledger's compaction row for that turn confirms it and is
 * not published again, so the session's compaction count rises once.
 */

import type {
  AgentChatDoneSubagentUsage,
  AgentChatEvent,
  AgentChatUsageAccount,
} from "../../../../shared/types";
import type { Logger } from "../../logging/logger";
import { getErrorMessage } from "../../shared/utils";
import { liveContextUsageEvent } from "../liveContextUsageEvent";
import { isServedModelMismatch } from "../servedModelMismatch";
import { acpContextBreakdown, addTokenCounts, hasTokenCounts, tokenSplitFields } from "./acpTelemetryReaders";
import {
  assertNever,
  type AcpLocalTurnUsage,
  type AcpProviderId,
  type AcpSubagentUsage,
  type AcpTelemetrySignal,
  type AcpUsageSample,
} from "./acpHostTypes";

type DoneEvent = Extract<AgentChatEvent, { type: "done" }>;
type SubagentResultEvent = Extract<AgentChatEvent, { type: "subagent_result" }>;

/** The `done` fields the ACP host owns. The chat service spreads them in. */
export type AcpDoneTelemetry = Pick<
  DoneEvent,
  "usage" | "costUsd" | "costSource" | "servedModel" | "account" | "planUsage" | "subagentUsage" | "usageConfidence"
>;

/** An inferred compaction needs a drop larger than this share of the previous sample. */
export const ACP_INFERRED_COMPACTION_MIN_DROP_RATIO = 0.4;
/** ...and larger than this many tokens. Both thresholds must be crossed. */
export const ACP_INFERRED_COMPACTION_MIN_DROP_TOKENS = 20_000;

export type AcpTurnTelemetry = {
  /** Id of the running turn, or `null` between turns. */
  readonly turnId: string | null;
  /** True once the running turn produced a context sample. */
  readonly turnHasContextSample: boolean;
  beginTurn(turnId: string): void;
  /** Forget the turn. Session-scoped state (baseline, model, windows) survives. */
  endTurn(): void;
  /** Fold one context occupancy sample. Returns an inferred compaction, if any. */
  noteContextSample(sample: { used: number; size: number }): AgentChatEvent[];
  /** Fold one provider signal. Returns the chat events it produces. */
  noteSignal(signal: AcpTelemetrySignal): AgentChatEvent[];
  /** Build the turn's `done` telemetry and any events that only exist at turn end. */
  finishTurn(args: {
    promptUsage: AcpUsageSample | null;
    local: AcpLocalTurnUsage | null;
  }): { done: AcpDoneTelemetry; events: AgentChatEvent[] };
};

export type CreateAcpTurnTelemetryArgs = {
  providerId: AcpProviderId;
  inferCompaction: boolean;
  /**
   * True when the dialect reads a local usage ledger. A turn whose ledger read
   * came back empty then falls back to the prompt result as `estimated`.
   */
  hasLocalUsage?: boolean;
  /**
   * The model ADE asked the agent to run, already in the agent's plain model
   * naming. `servedModel` is only reported when the model that answered
   * differs from it. A later `model_catalog` signal replaces it.
   */
  requestedModelId?: string | null;
  /**
   * Turns a served model id into the agent's plain naming (the dialect's
   * `modelIdFromAgent`) before it is compared with the requested model.
   */
  modelIdFromAgent?: (raw: string) => string;
  /** Provider name for the served-model notice. */
  providerLabel?: string;
  /** Extra line for the served-model notice. See `AcpDialect.servedModelMismatchNote`. */
  servedModelMismatchNote?: string;
  /** Read once per session, lazily, at the first turn end. */
  readAccount: () => AgentChatUsageAccount;
  logger?: Pick<Logger, "warn">;
};

type TurnState = {
  requestCount: number;
  requestTotals: AcpUsageSample;
  turnUsage: AcpUsageSample | null;
  context: { used: number; size: number | null } | null;
  /** Inferred compactions published during this turn. */
  inferredCompactions: number;
};

function freshTurnState(): TurnState {
  return { requestCount: 0, requestTotals: {}, turnUsage: null, context: null, inferredCompactions: 0 };
}

/** Subagent usage in the chat event shape. `totalTokens` includes the cache. */
function subagentResultUsage(usage: AcpSubagentUsage): NonNullable<SubagentResultEvent["usage"]> {
  const derivedTotal = hasTokenCounts(usage)
    ? (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0)
    : undefined;
  const totalTokens = usage.totalTokens ?? derivedTotal;
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(usage.toolUses !== undefined ? { toolUses: usage.toolUses } : {}),
    ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    ...tokenSplitFields(usage),
  };
}

export function createAcpTurnTelemetry(args: CreateAcpTurnTelemetryArgs): AcpTurnTelemetry {
  const { providerId } = args;
  let turnId: string | null = null;
  let turn = freshTurnState();

  // Session-scoped. A new ACP session gets a new tracker, which is the reset.
  let baseline: { used: number; size: number | null } | null = null;
  let requestedModelId: string | null = args.requestedModelId?.trim() || null;
  // The model ADE asked for. Agent reports move `requestedModelId`; this one
  // stays, so a model the agent swapped in on its own still counts as a
  // mismatch.
  const adeRequestedModelId = requestedModelId;
  const mismatchesReported = new Set<string>();
  let agentModelId: string | null = null;
  const contextWindows = new Map<string, number>();
  let openCompactionId: string | null = null;
  let compactionSeq = 0;
  let account: AgentChatUsageAccount | null = null;
  let finishFailureLogged = false;

  const withTurn = <T extends object>(event: T): T => (turnId ? { ...event, turnId } : event);

  const windowForCurrentModel = (): number | null =>
    (requestedModelId ? contextWindows.get(requestedModelId) : undefined)
    ?? (agentModelId ? contextWindows.get(agentModelId) : undefined)
    ?? null;

  const noteModel = (kind: "requested" | "agent", modelId: string): void => {
    const previous = kind === "requested" ? requestedModelId : agentModelId;
    // A different model means a different tokenizer and window. The next
    // sample is a new baseline, not evidence of a compaction.
    if (previous && previous !== modelId) baseline = null;
    if (kind === "requested") requestedModelId = modelId;
    else agentModelId = modelId;
  };

  const recordContext = (used: number, size: number | null): AgentChatEvent[] => {
    const events: AgentChatEvent[] = [];
    const previous = baseline;
    // While the provider's own compaction is open, its `completed` report is
    // the compaction; a drop seen before it lands is not a second one.
    if (args.inferCompaction && openCompactionId === null && previous && size !== null && previous.size === size) {
      const drop = previous.used - used;
      if (
        drop > ACP_INFERRED_COMPACTION_MIN_DROP_TOKENS
        && drop > previous.used * ACP_INFERRED_COMPACTION_MIN_DROP_RATIO
      ) {
        compactionSeq += 1;
        turn.inferredCompactions += 1;
        events.push(withTurn({
          type: "context_compact" as const,
          trigger: "auto" as const,
          state: "completed" as const,
          detection: "inferred" as const,
          provider: providerId,
          preTokens: previous.used,
          postTokens: used,
          tokensRemoved: drop,
          compactionId: `${providerId}-inferred-${compactionSeq}`,
        }));
      }
    }
    baseline = { used, size };
    turn.context = { used, size };
    return events;
  };

  const compactionEvent = (signal: Extract<AcpTelemetrySignal, { kind: "compaction" }>): AgentChatEvent[] => {
    let compactionId = signal.compactionId ?? null;
    if (signal.state === "started") {
      if (!compactionId) {
        compactionSeq += 1;
        compactionId = `${providerId}-compact-${compactionSeq}`;
      }
      openCompactionId = compactionId;
    } else {
      if (!compactionId && openCompactionId) compactionId = openCompactionId;
      if (!compactionId) {
        compactionSeq += 1;
        compactionId = `${providerId}-compact-${compactionSeq}`;
      }
      openCompactionId = null;
      if (signal.state === "completed") {
        // The history was replaced. The post-compaction figure is the turn's
        // context now, and it starts a fresh baseline so the drop that follows
        // is not inferred as a second compaction.
        const size = baseline?.size ?? turn.context?.size ?? windowForCurrentModel();
        baseline = null;
        if (signal.postTokens !== undefined) turn.context = { used: signal.postTokens, size };
      }
    }
    const tokensRemoved = signal.preTokens !== undefined && signal.postTokens !== undefined
      ? Math.max(0, signal.preTokens - signal.postTokens)
      : undefined;
    return [withTurn({
      type: "context_compact" as const,
      trigger: "auto" as const,
      state: signal.state,
      detection: "provider" as const,
      provider: providerId,
      compactionId,
      ...(signal.preTokens !== undefined ? { preTokens: signal.preTokens } : {}),
      ...(signal.postTokens !== undefined ? { postTokens: signal.postTokens } : {}),
      ...(tokensRemoved !== undefined ? { tokensRemoved } : {}),
      ...(signal.failReason ? { failReason: signal.failReason } : {}),
    })];
  };

  const noteSignal = (signal: AcpTelemetrySignal): AgentChatEvent[] => {
    switch (signal.kind) {
      case "request_usage": {
        turn.requestCount += 1;
        addTokenCounts(turn.requestTotals, signal.usage);
        const used = signal.usage.contextUsedTokens;
        if (used === undefined) return [];
        const size = signal.usage.contextWindowTokens ?? windowForCurrentModel();
        const events = recordContext(used, size);
        if (size) {
          events.push(liveContextUsageEvent({ used, max: size, breakdown: acpContextBreakdown(signal.usage), turnId }));
        }
        return events;
      }
      case "turn_usage":
        turn.turnUsage = signal.usage;
        return [];
      case "model_catalog":
        for (const [modelId, size] of Object.entries(signal.contextWindows)) {
          if (Number.isFinite(size) && size > 0) contextWindows.set(modelId, size);
        }
        if (signal.currentModelId) noteModel("requested", signal.currentModelId);
        return [];
      case "current_model":
        noteModel("agent", signal.modelId);
        return [];
      case "subagent_started":
        return [withTurn({
          type: "subagent_started" as const,
          taskId: signal.agentId,
          agentId: signal.agentId,
          description: signal.description ?? signal.agentType ?? "Subagent",
          taskType: "subagent" as const,
          ...(signal.agentType ? { agentType: signal.agentType } : {}),
          ...(signal.model ? { model: signal.model } : {}),
        })];
      case "subagent_finished":
        return [withTurn({
          type: "subagent_result" as const,
          taskId: signal.agentId,
          agentId: signal.agentId,
          status: signal.status,
          summary: signal.summary ?? "",
          ...(signal.summary ? { finalSummary: signal.summary } : {}),
          taskType: "subagent" as const,
          ...(signal.model ? { model: signal.model } : {}),
          usage: subagentResultUsage(signal.usage),
        })];
      case "compaction":
        return compactionEvent(signal);
      default:
        return assertNever(signal, "acp telemetry signal");
    }
  };

  const readAccountOnce = (): AgentChatUsageAccount => {
    if (account) return account;
    try {
      account = args.readAccount();
    } catch {
      account = { provider: providerId, kind: "unknown" };
    }
    return account;
  };

  /** True when a model other than the one ADE asked for at launch answered. */
  const differsFromAdeRequest = (served: string): boolean =>
    isServedModelMismatch(adeRequestedModelId, args.modelIdFromAgent ? args.modelIdFromAgent(served) : served);

  /**
   * A model ADE did not ask for answered the turn. Tell the user once per
   * served model: the chat header names the model the user picked, so without
   * this line the transcript would claim a model that never ran. The chat
   * service logs the mismatch from `done.servedModel`.
   */
  const servedModelMismatch = (served: string): AgentChatEvent[] => {
    const requested = adeRequestedModelId;
    if (!requested || !differsFromAdeRequest(served) || mismatchesReported.has(served)) return [];
    mismatchesReported.add(served);
    const label = args.providerLabel ?? providerId;
    return [withTurn({
      type: "system_notice" as const,
      noticeKind: "warning" as const,
      severity: "warning" as const,
      message: `${label} answered with ${served}, not ${requested}.`,
      ...(args.servedModelMismatchNote ? { detail: args.servedModelMismatchNote } : {}),
    })];
  };

  const buildTurnEnd: AcpTurnTelemetry["finishTurn"] = ({ promptUsage, local }) => {
    // Totals, in order of trust: the provider's own turn report, the local
    // ledger read back after the turn, the prompt result, and last the sum of
    // the per-request reports. The ledger outranks the prompt result because
    // it is the provider's own per-request record: Copilot answers a slash
    // command such as `/compact` with the PREVIOUS turn's usage verbatim
    // (verified live on 1.0.88), while its ledger holds the real rows.
    let totals: AcpUsageSample | null = null;
    let usageConfidence: AcpDoneTelemetry["usageConfidence"];
    if (hasTokenCounts(turn.turnUsage)) totals = turn.turnUsage;
    else if (hasTokenCounts(local?.usage)) {
      totals = local.usage;
      usageConfidence = "derived";
    } else if (hasTokenCounts(promptUsage)) {
      totals = promptUsage;
      // The ledger exists but gave nothing back, so the prompt result cannot
      // be checked against it, and Copilot's can be the previous turn's.
      if (args.hasLocalUsage) usageConfidence = "estimated";
    } else if (turn.requestCount > 0 && hasTokenCounts(turn.requestTotals)) {
      totals = turn.requestTotals;
      usageConfidence = "derived";
    }

    const requestCount = turn.turnUsage?.requestCount
      ?? promptUsage?.requestCount
      ?? local?.requestCount
      ?? (turn.requestCount > 0 ? turn.requestCount : undefined);
    const contextWindow = turn.context?.size ?? windowForCurrentModel() ?? promptUsage?.contextWindowTokens ?? null;

    const usage: NonNullable<DoneEvent["usage"]> = {
      ...(totals?.inputTokens !== undefined ? { inputTokens: totals.inputTokens } : {}),
      ...(totals?.outputTokens !== undefined ? { outputTokens: totals.outputTokens } : {}),
      ...(totals?.cacheReadTokens !== undefined ? { cacheReadTokens: totals.cacheReadTokens } : {}),
      ...(totals?.cacheWriteTokens !== undefined ? { cacheCreationTokens: totals.cacheWriteTokens } : {}),
      ...(totals?.reasoningTokens !== undefined ? { reasoningTokens: totals.reasoningTokens } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(turn.context ? { contextTokens: turn.context.used } : {}),
      ...(requestCount !== undefined ? { requestCount } : {}),
    };

    const costUsd = turn.turnUsage?.costUsd ?? promptUsage?.costUsd;
    const served = local?.servedModel
      ?? turn.turnUsage?.servedModel
      ?? promptUsage?.servedModel
      ?? agentModelId
      ?? null;
    // `servedModel` refines the request. Echoing the model the agent was asked
    // for adds nothing, so it stays out. A model ADE did not ask for always
    // rides it, also when the agent's own catalog named it as current, so the
    // chat service sees every mismatch.
    const servedModel = served && (served !== requestedModelId || differsFromAdeRequest(served)) ? served : null;
    const mismatchEvents = served ? servedModelMismatch(served) : [];
    const planUsage = local?.planUsage?.filter((entry) => Number.isFinite(entry.amount)) ?? [];
    // Helper agents' usage rides on `done`, not on a subagent event: a ledger
    // row is usage, and an event would draw a card next to the tool call that
    // already shows the work.
    const subagentUsage: AgentChatDoneSubagentUsage[] = (local?.subagents ?? []).map((subagent) => ({
      agentId: subagent.agentId,
      ...(subagent.label ? { label: subagent.label } : {}),
      ...(subagent.model ? { model: subagent.model } : {}),
      ...(subagent.parentToolCallId ? { parentToolUseId: subagent.parentToolCallId } : {}),
      ...tokenSplitFields(subagent.usage),
      usageConfidence: "derived" as const,
    }));

    const done: AcpDoneTelemetry = {
      ...(Object.keys(usage).length ? { usage } : {}),
      ...(costUsd !== undefined ? { costUsd, costSource: "provider" as const } : {}),
      ...(servedModel ? { servedModel } : {}),
      account: local?.account ?? readAccountOnce(),
      ...(planUsage.length ? { planUsage } : {}),
      ...(subagentUsage.length ? { subagentUsage } : {}),
      ...(usageConfidence ? { usageConfidence } : {}),
    };

    // A drop this turn already published an inferred compaction for the same
    // summary request; the ledger row confirms it rather than adding one.
    const events: AgentChatEvent[] = [
      ...(local?.compactions ?? [])
        .slice(turn.inferredCompactions)
        .flatMap((compaction) => compactionEvent({ kind: "compaction", state: "completed", ...compaction })),
      ...mismatchEvents,
    ];

    return { done, events };
  };

  const finishTurn: AcpTurnTelemetry["finishTurn"] = (input) => {
    try {
      return buildTurnEnd(input);
    } catch (error) {
      // Telemetry never fails a turn. The turn ends with a plain `done`.
      if (!finishFailureLogged) {
        finishFailureLogged = true;
        args.logger?.warn("agent_chat.acp_turn_telemetry_failed", {
          provider: providerId,
          error: getErrorMessage(error),
        });
      }
      return { done: {}, events: [] };
    }
  };

  return {
    get turnId() {
      return turnId;
    },
    get turnHasContextSample() {
      return turn.context !== null;
    },
    beginTurn: (nextTurnId: string) => {
      turnId = nextTurnId;
      turn = freshTurnState();
    },
    endTurn: () => {
      turnId = null;
      turn = freshTurnState();
    },
    noteContextSample: ({ used, size }) => recordContext(used, size),
    noteSignal,
    finishTurn,
  };
}
