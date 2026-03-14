import type { Logger } from "../logging/logger";

export interface CompactionFlushConfig {
  enabled?: boolean;
  reserveTokensFloor?: number;
  maxFlushTurnsPerSession?: number;
  flushPrompt?: string;
}

export type CompactionFlushHiddenMessage = {
  role: "system";
  content: string;
  hidden: true;
};

export type CompactionFlushTurnStatus = "flushed" | "budget_exceeded";

export type CompactionFlushContext = {
  sessionId: string;
  boundaryId: string;
  conversationTokenCount: number;
  maxTokens: number;
  appendHiddenMessage?: (message: CompactionFlushHiddenMessage) => void | Promise<void>;
  flushTurn?: (args: {
    sessionId: string;
    boundaryId: string;
    prompt: string;
  }) => Promise<{ status: CompactionFlushTurnStatus } | void>;
};

export type CompactionFlushResult = {
  injected: boolean;
  flushCount: number;
  reason:
    | "disabled"
    | "below-threshold"
    | "flush-handler-unavailable"
    | "already-flushed-boundary"
    | "max-flush-turns-reached"
    | "flushed"
    | "flush-failed"
    | "flush-budget-exceeded";
  proceedWithCompaction: true;
};

type NormalizedCompactionFlushConfig = Required<CompactionFlushConfig>;

type SessionFlushState = {
  flushCount: number;
  flushedBoundaries: Set<string>;
};

const DEFAULT_FLUSH_PROMPT = [
  "Before context compaction runs, review the conversation for durable discoveries worth preserving.",
  "Quality bar: would a developer joining this project find this useful on their first day? If not, skip it.",
  "Each memory should be a single actionable insight, not a paragraph of context. Lead with the rule or fact, then brief context for WHY.",
  "SAVE: non-obvious conventions, decisions with reasoning, pitfalls others would repeat, patterns that contradict expectations.",
  "DO NOT SAVE: file paths, session progress, task status, code that is already committed, raw error messages without lessons, anything discoverable via search or git log.",
  'If nothing qualifies — and often nothing will — respond with "NO_DISCOVERIES". Fewer high-quality memories are better than many low-quality ones.'
].join(" ");

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || Number(value) <= 0) return fallback;
  return Math.floor(Number(value));
}

function normalizeConfig(config: CompactionFlushConfig | undefined): NormalizedCompactionFlushConfig {
  const flushPrompt = typeof config?.flushPrompt === "string" && config.flushPrompt.trim().length > 0
    ? config.flushPrompt.trim()
    : DEFAULT_FLUSH_PROMPT;

  return {
    enabled: config?.enabled !== false,
    reserveTokensFloor: normalizePositiveInteger(config?.reserveTokensFloor, 40_000),
    maxFlushTurnsPerSession: normalizePositiveInteger(config?.maxFlushTurnsPerSession, 3),
    flushPrompt,
  };
}

function normalizeSessionId(value: string): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : "default-session";
}

function normalizeBoundaryId(value: string, conversationTokenCount: number): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : `boundary-${Math.max(0, Math.floor(conversationTokenCount))}`;
}

export type CompactionFlushService = ReturnType<typeof createCompactionFlushService>;

export function createCompactionFlushService(
  config?: CompactionFlushConfig,
  deps?: { logger?: Pick<Logger, "warn"> },
) {
  const logger = deps?.logger;
  const normalizedConfig = normalizeConfig(config);
  const sessionState = new Map<string, SessionFlushState>();

  function getOrCreateSessionState(sessionId: string): SessionFlushState {
    const existing = sessionState.get(sessionId);
    if (existing) return existing;
    const created: SessionFlushState = {
      flushCount: 0,
      flushedBoundaries: new Set<string>(),
    };
    sessionState.set(sessionId, created);
    return created;
  }

  async function beforeCompaction(args: CompactionFlushContext): Promise<CompactionFlushResult> {
    if (!normalizedConfig.enabled) {
      return {
        injected: false,
        flushCount: 0,
        reason: "disabled",
        proceedWithCompaction: true,
      };
    }

    const threshold = Math.max(0, Math.floor(args.maxTokens) - normalizedConfig.reserveTokensFloor);
    if (!Number.isFinite(args.conversationTokenCount) || args.conversationTokenCount < threshold) {
      return {
        injected: false,
        flushCount: 0,
        reason: "below-threshold",
        proceedWithCompaction: true,
      };
    }

    if (!args.flushTurn) {
      return {
        injected: false,
        flushCount: 0,
        reason: "flush-handler-unavailable",
        proceedWithCompaction: true,
      };
    }

    const sessionId = normalizeSessionId(args.sessionId);
    const boundaryId = normalizeBoundaryId(args.boundaryId, args.conversationTokenCount);
    const state = getOrCreateSessionState(sessionId);

    if (state.flushedBoundaries.has(boundaryId)) {
      return {
        injected: false,
        flushCount: state.flushCount,
        reason: "already-flushed-boundary",
        proceedWithCompaction: true,
      };
    }

    if (state.flushCount >= normalizedConfig.maxFlushTurnsPerSession) {
      return {
        injected: false,
        flushCount: state.flushCount,
        reason: "max-flush-turns-reached",
        proceedWithCompaction: true,
      };
    }

    state.flushedBoundaries.add(boundaryId);
    state.flushCount += 1;

    const hiddenMessage: CompactionFlushHiddenMessage = {
      role: "system",
      content: normalizedConfig.flushPrompt,
      hidden: true,
    };

    try {
      await args.appendHiddenMessage?.(hiddenMessage);
    } catch (error) {
      logger?.warn("memory.compaction_flush.hidden_message_failed", {
        sessionId,
        boundaryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const flushResult = await args.flushTurn({
        sessionId,
        boundaryId,
        prompt: normalizedConfig.flushPrompt,
      });

      return {
        injected: true,
        flushCount: state.flushCount,
        reason: flushResult?.status === "budget_exceeded" ? "flush-budget-exceeded" : "flushed",
        proceedWithCompaction: true,
      };
    } catch (error) {
      logger?.warn("memory.compaction_flush.flush_failed", {
        sessionId,
        boundaryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        injected: true,
        flushCount: state.flushCount,
        reason: "flush-failed",
        proceedWithCompaction: true,
      };
    }
  }

  function getConfig(): NormalizedCompactionFlushConfig {
    return { ...normalizedConfig };
  }

  function getSessionFlushCount(sessionId: string): number {
    return sessionState.get(normalizeSessionId(sessionId))?.flushCount ?? 0;
  }

  function clearSession(sessionId: string): void {
    sessionState.delete(normalizeSessionId(sessionId));
  }

  return {
    beforeCompaction,
    getConfig,
    getSessionFlushCount,
    clearSession,
  };
}
