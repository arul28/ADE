export type MemorySweepTrigger = "manual" | "startup";

export type MemoryConsolidationTrigger = "manual" | "auto";

export type MemoryHealthScope = "project" | "agent" | "mission";

export type MemoryScope = "project" | "agent" | "mission";

export type MemoryStatus = "candidate" | "promoted" | "archived";

export type MemoryCategory =
  | "fact"
  | "preference"
  | "pattern"
  | "decision"
  | "gotcha"
  | "convention"
  | "episode"
  | "procedure"
  | "digest"
  | "handoff";

export type MemoryImportance = "low" | "medium" | "high";

export type MemoryEntryDto = {
  id: string;
  scope: MemoryScope;
  scopeOwnerId: string | null;
  tier: number;
  pinned: boolean;
  category: MemoryCategory;
  content: string;
  importance: MemoryImportance;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
  observationCount: number;
  status: MemoryStatus;
  confidence: number;
  embedded: boolean;
  sourceRunId: string | null;
  sourceType: string | null;
  sourceId: string | null;
};

export type EpisodicMemoryOutcome = "success" | "partial" | "failure";

export type EpisodicMemory = {
  id: string;
  sessionId?: string;
  missionId?: string;
  taskDescription: string;
  approachTaken: string;
  outcome: EpisodicMemoryOutcome;
  toolsUsed: string[];
  patternsDiscovered: string[];
  gotchas: string[];
  decisionsMade: string[];
  duration: number;
  createdAt: string;
};

export type ProceduralMemory = {
  id: string;
  trigger: string;
  procedure: string;
  confidence: number;
  successCount: number;
  failureCount: number;
  sourceEpisodeIds: string[];
  lastUsed: string | null;
  createdAt: string;
};

export type ProcedureListItem = {
  memory: MemoryEntryDto;
  procedural: ProceduralMemory;
  exportedSkillPath: string | null;
  exportedAt: string | null;
  supersededByMemoryId: string | null;
};

export type ProcedureDetail = ProcedureListItem & {
  sourceEpisodes: MemoryEntryDto[];
  confidenceHistory: Array<{
    id: string;
    confidence: number;
    outcome: "success" | "failure" | "observation" | "manual";
    reason: string | null;
    recordedAt: string;
  }>;
};

export type FileCluster = {
  label: string;
  files: string[];
  summary: string;
};

export type ChangeDigest = {
  fromSha: string;
  toSha: string;
  commitCount: number;
  commitSummaries: string[];
  diffstat: string;
  changedFiles: string[];
  fileClusters: FileCluster[];
};

export type SkillIndexKind = "skill" | "command" | "root_doc";

export type SkillIndexSource = "user" | "exported";

export type SkillIndexEntry = {
  id: string;
  path: string;
  kind: SkillIndexKind;
  source: SkillIndexSource;
  memoryId: string | null;
  contentHash: string;
  lastModifiedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeSyncStatus = {
  syncing: boolean;
  lastSeenHeadSha: string | null;
  currentHeadSha: string | null;
  diverged: boolean;
  lastDigestAt: string | null;
  lastDigestMemoryId: string | null;
  lastError: string | null;
};

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

export type MemorySearchMode = "lexical" | "hybrid";

export type MemoryEmbeddingModelState = "idle" | "loading" | "ready" | "unavailable";

export type MemoryEmbeddingModelStatus = {
  modelId: string;
  state: MemoryEmbeddingModelState;
  progress: number | null;
  loaded: number | null;
  total: number | null;
  file: string | null;
  error: string | null;
};

export type MemoryEmbeddingHealthStats = {
  entriesEmbedded: number;
  entriesTotal: number;
  queueDepth: number;
  processing: boolean;
  lastBatchProcessedAt: string | null;
  cacheEntries: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  model: MemoryEmbeddingModelStatus;
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
  embeddings: MemoryEmbeddingHealthStats;
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
