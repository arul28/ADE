export type MemorySweepTrigger = "manual" | "startup";

export type MemoryConsolidationTrigger = "manual" | "auto";

export type MemoryHealthScope = "project" | "agent" | "mission";

export type MemoryHealthTierCounts = {
  tier1: number;
  tier2: number;
  tier3: number;
  archived: number;
};

export type MemoryHealthScopeStats = {
  scope: MemoryHealthScope;
  current: number;
  max: number;
  counts: MemoryHealthTierCounts;
};

export type MemorySweepLogSummary = {
  sweepId: string;
  projectId: string;
  reason: MemorySweepTrigger;
  startedAt: string;
  completedAt: string;
  entriesDecayed: number;
  entriesDemoted: number;
  entriesPromoted: number;
  entriesArchived: number;
  entriesOrphaned: number;
  durationMs: number;
};

export type MemoryConsolidationLogSummary = {
  consolidationId: string;
  projectId: string;
  reason: MemoryConsolidationTrigger;
  startedAt: string;
  completedAt: string;
  clustersFound: number;
  entriesMerged: number;
  entriesCreated: number;
  tokensUsed: number;
  durationMs: number;
};

export type MemoryHealthStats = {
  scopes: MemoryHealthScopeStats[];
  lastSweep: MemorySweepLogSummary | null;
  lastConsolidation: MemoryConsolidationLogSummary | null;
};

export type MemoryLifecycleSweepResult = {
  sweepId: string;
  projectId: string;
  reason: MemorySweepTrigger;
  startedAt: string;
  completedAt: string;
  halfLifeDays: number;
  entriesDecayed: number;
  entriesDemoted: number;
  entriesPromoted: number;
  entriesArchived: number;
  entriesOrphaned: number;
  durationMs: number;
};

export type MemoryConsolidationResult = {
  consolidationId: string;
  projectId: string;
  reason: MemoryConsolidationTrigger;
  startedAt: string;
  completedAt: string;
  clustersFound: number;
  entriesMerged: number;
  entriesCreated: number;
  tokensUsed: number;
  durationMs: number;
};

export type MemorySweepStatusEventPayload =
  | {
      type: "memory-sweep-started";
      projectId: string;
      reason: MemorySweepTrigger;
      sweepId: string;
      startedAt: string;
    }
  | {
      type: "memory-sweep-completed";
      projectId: string;
      reason: MemorySweepTrigger;
      sweepId: string;
      startedAt: string;
      completedAt: string;
      result: MemoryLifecycleSweepResult;
    }
  | {
      type: "memory-sweep-failed";
      projectId: string;
      reason: MemorySweepTrigger;
      sweepId: string;
      startedAt: string;
      completedAt: string;
      durationMs: number;
      error: string;
    };

export type MemoryConsolidationStatusEventPayload =
  | {
      type: "memory-consolidation-started";
      projectId: string;
      reason: MemoryConsolidationTrigger;
      consolidationId: string;
      startedAt: string;
    }
  | {
      type: "memory-consolidation-completed";
      projectId: string;
      reason: MemoryConsolidationTrigger;
      consolidationId: string;
      startedAt: string;
      completedAt: string;
      result: MemoryConsolidationResult;
    }
  | {
      type: "memory-consolidation-failed";
      projectId: string;
      reason: MemoryConsolidationTrigger;
      consolidationId: string;
      startedAt: string;
      completedAt: string;
      durationMs: number;
      error: string;
    };
