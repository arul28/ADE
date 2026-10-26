import { AdeError } from "./errors.js";
import type { AgentChatEventEnvelope } from "./types.js";

/** A host-side limit for the usage observed on one thread. */
export type ThreadBudget = {
  maxCostUsd?: number;
  maxTokens?: number;
};

/** Usage totals observed or recovered from a thread's durable transcript. */
export type ThreadUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** False when the SDK could not load part of the durable transcript. */
  complete?: boolean;
  contextWindow?: number;
  /** Present only when the provider reports a dollar cost. */
  costUsd?: number;
};

export function validateThreadBudget(value: ThreadBudget | undefined): ThreadBudget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdeError("invalid_option", "budget must be an object with maxCostUsd and/or maxTokens.");
  }
  const entries = Object.entries(value);
  if (!entries.length) {
    throw new AdeError("invalid_option", "budget must set maxCostUsd, maxTokens, or both.");
  }
  for (const [key, limit] of entries) {
    if (key !== "maxCostUsd" && key !== "maxTokens") {
      throw new AdeError("invalid_option", `budget.${key} is not supported.`);
    }
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
      throw new AdeError("invalid_option", `budget.${key} must be a finite, non-negative number.`);
    }
  }
  return { ...value };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type TurnUsage = { inputTokens: number; outputTokens: number; costUsd?: number };

/**
 * Aggregates usage envelopes. Sequence identity lets a history read and a live
 * event that overlap during resume count once. History is seeded before the
 * opened thread is returned, so later live events only add new usage.
 */
export class ThreadUsageAccumulator {
  private readonly seen = new Set<string>();
  private readonly byTurn = new Map<string, TurnUsage>();
  private completed = { inputTokens: 0, outputTokens: 0, costUsd: 0, hasProviderCost: false };
  private codexTotal: { inputTokens: number; outputTokens: number } | null = null;
  private contextWindow: number | undefined;

  observe(envelope: AgentChatEventEnvelope): void {
    const event = envelope.event as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    if (type !== "tokens" && type !== "context_usage" && type !== "codex_token_usage" && type !== "done") return;

    const identity = typeof envelope.sequence === "number"
      ? `${envelope.sessionId}:${envelope.sequence}`
      : `${envelope.sessionId}:${envelope.timestamp}:${JSON.stringify(event)}`;
    if (this.seen.has(identity)) return;
    this.seen.add(identity);
    if (this.seen.size > 20_000) this.seen.delete(this.seen.values().next().value!);

    const turnId = typeof event.turnId === "string" && event.turnId ? event.turnId : "unscoped";
    if (type === "tokens") {
      const current = this.byTurn.get(turnId) ?? { inputTokens: 0, outputTokens: 0 };
      current.inputTokens = finite(event.inputTokens ?? event.input);
      current.outputTokens = finite(event.outputTokens ?? event.output);
      this.byTurn.set(turnId, current);
      const contextWindow = finite(event.contextWindow);
      if (contextWindow) this.contextWindow = Math.max(this.contextWindow ?? 0, contextWindow);
      return;
    }

    if (type === "context_usage") {
      const usage = record(event.usage);
      const contextWindow = finite(usage?.maxTokens);
      if (contextWindow) this.contextWindow = Math.max(this.contextWindow ?? 0, contextWindow);
      return;
    }

    if (type === "codex_token_usage") {
      const usage = record(event.usage);
      const total = record(usage?.total);
      if (!total) return;
      this.codexTotal = {
        inputTokens: Math.max(this.codexTotal?.inputTokens ?? 0, finite(total.inputTokens)),
        outputTokens: Math.max(this.codexTotal?.outputTokens ?? 0, finite(total.outputTokens)),
      };
      const contextWindow = finite(usage?.modelContextWindow);
      if (contextWindow) this.contextWindow = Math.max(this.contextWindow ?? 0, contextWindow);
      return;
    }

    const current = this.byTurn.get(turnId) ?? { inputTokens: 0, outputTokens: 0 };
    const usage = record(event.usage);
    if (usage?.inputTokens !== undefined && usage.inputTokens !== null) current.inputTokens = finite(usage.inputTokens);
    if (usage?.outputTokens !== undefined && usage.outputTokens !== null) current.outputTokens = finite(usage.outputTokens);
    if (event.costSource === "provider") {
      const costUsd = typeof event.costUsd === "number" && Number.isFinite(event.costUsd) && event.costUsd >= 0
        ? event.costUsd
        : undefined;
      if (costUsd !== undefined) current.costUsd = costUsd;
    }
    const contextWindow = finite(usage?.contextWindow);
    if (contextWindow) this.contextWindow = Math.max(this.contextWindow ?? 0, contextWindow);
    this.byTurn.set(turnId, current);
    if (event.type === "done") {
      this.completed.inputTokens += current.inputTokens;
      this.completed.outputTokens += current.outputTokens;
      if (current.costUsd !== undefined) {
        this.completed.costUsd += current.costUsd;
        this.completed.hasProviderCost = true;
      }
      this.byTurn.delete(turnId);
    }
  }

  seed(envelopes: readonly AgentChatEventEnvelope[]): void {
    for (const envelope of envelopes) this.observe(envelope);
  }

  snapshot(): ThreadUsage {
    let inputTokens = this.completed.inputTokens;
    let outputTokens = this.completed.outputTokens;
    let costUsd = this.completed.costUsd;
    let hasProviderCost = this.completed.hasProviderCost;
    for (const turn of this.byTurn.values()) {
      inputTokens += turn.inputTokens;
      outputTokens += turn.outputTokens;
      if (turn.costUsd !== undefined) {
        costUsd += turn.costUsd;
        hasProviderCost = true;
      }
    }
    if (this.codexTotal) {
      inputTokens = Math.max(inputTokens, this.codexTotal.inputTokens);
      outputTokens = Math.max(outputTokens, this.codexTotal.outputTokens);
    }
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      ...(hasProviderCost ? { costUsd } : {}),
    };
  }
}

export function budgetExceeded(budget: ThreadBudget | undefined, usage: ThreadUsage): boolean {
  return Boolean(
    budget &&
      ((budget.maxTokens !== undefined && usage.totalTokens >= budget.maxTokens) ||
        (budget.maxCostUsd !== undefined && usage.costUsd !== undefined && usage.costUsd >= budget.maxCostUsd)),
  );
}
