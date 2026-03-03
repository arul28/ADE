// ---------------------------------------------------------------------------
// Pack / context types
// ---------------------------------------------------------------------------

import type { ProviderMode } from "./core";
import type { LaneType, LaneStatus } from "./lanes";
import type { ConflictStatusValue, ConflictRiskLevel } from "./conflicts";
import type { GitConflictState } from "./git";
import type { MissionStatus } from "./missions";
import type { MissionStepHandoff } from "./missions";

export type PackType = "project" | "lane" | "feature" | "conflict" | "plan" | "mission";

export type ContextExportLevel = "lite" | "standard" | "deep";

export type OrchestratorContextProfileId = "orchestrator_deterministic_v1" | "orchestrator_narrative_opt_in_v1";

export type OrchestratorContextDocsMode = "digest_refs" | "full_docs";

// Event metadata (standardized keys embedded into PackEvent.payload for selection/digests).
export type PackEventImportance = "low" | "medium" | "high";
export type PackEventCategory = "session" | "narrative" | "conflict" | "branch" | "pack";
export type PackEventEntityRef = { kind: string; id: string };

export type PackEventMetaV1 = {
  importance?: PackEventImportance;
  importanceScore?: number;
  category?: PackEventCategory;
  entityIds?: string[];
  entityRefs?: PackEventEntityRef[];
  actionType?: string;
  rationale?: string;
};

export type PackMergeReadiness = "ready" | "blocked" | "needs_sync" | "unknown";

export type PackDependencyStateV1 = {
  requiredMerges?: string[];
  blockedByLanes?: string[];
  mergeReadiness?: PackMergeReadiness;
};

export type PackConflictStateV1 = {
  status?: ConflictStatusValue;
  lastPredictedAt?: string | null;
  overlappingFileCount?: number;
  peerConflictCount?: number;
  unresolvedPairCount?: number;
  truncated?: boolean;
  strategy?: string;
  pairwisePairsComputed?: number;
  pairwisePairsTotal?: number;
  lastRecomputedAt?: string | null;
  predictionStale?: boolean | null;
  predictionAgeMs?: number | null;
  stalePolicy?: { ttlMs: number } | null;
  staleReason?: string | null;
  unresolvedResolutionState?: GitConflictState | null;
};

export type ContextHeaderV1 = {
  schema: "ade.context.v1";

  // Identity
  packKey: string;
  packType: PackType;
  exportLevel?: ContextExportLevel;

  // Contract diagnostics (optional; do not gate parsing on these).
  contractVersion?: number;
  projectId?: string | null;

  // Dependency graph + state (optional; consumers must be null-safe).
  graph?: import("../contextContract").PackGraphEnvelopeV1 | null;
  dependencyState?: PackDependencyStateV1 | null;
  conflictState?: PackConflictStateV1 | null;

  // Export-only omission hints for downstream consumers.
  omissions?: import("../contextContract").ExportOmissionV1[] | null;

  // Pack metadata (nullable for older packs / unknown state)
  laneId?: string | null;
  peerKey?: string | null;
  baseRef?: string | null;
  headSha?: string | null;

  deterministicUpdatedAt?: string | null;
  narrativeUpdatedAt?: string | null;

  versionId?: string | null;
  versionNumber?: number | null;
  contentHash?: string | null;

  providerMode?: ProviderMode;

  // Export-only metadata
  exportedAt?: string;
  approxTokens?: number;
  maxTokens?: number;

  // Gateway metadata (safe: never secrets)
  apiBaseUrl?: string | null;
  remoteProjectId?: string | null;
};

export type BranchStateSnapshotV1 = {
  baseRef: string | null;
  headRef: string | null;
  headSha: string | null;
  lastPackRefreshAt: string | null;
  isEditProtected: boolean | null;
  packStale: boolean | null;
  packStaleReason?: string | null;
};

export type LaneLineageV1 = {
  laneId: string;
  parentLaneId: string | null;
  baseLaneId: string | null;
  stackDepth: number;
};

export type LaneExportManifestV1 = {
  schema: "ade.manifest.lane.v1";
  projectId: string;
  laneId: string;
  laneName: string;
  laneType: LaneType;
  worktreePath: string;
  branchRef: string;
  baseRef: string;
  contextFingerprint?: string | null;
  contextVersion?: number | null;
  lastDocsRefreshAt?: string | null;
  docsStaleReason?: string | null;
  lineage: LaneLineageV1;
  mergeConstraints: {
    requiredMerges: string[];
    blockedByLanes: string[];
    mergeReadiness: PackMergeReadiness;
  };
  branchState: BranchStateSnapshotV1;
  conflicts: {
    activeConflictPackKeys: string[];
    unresolvedPairCount: number;
    lastConflictRefreshAt: string | null;
    lastConflictRefreshAgeMs: number | null;
    truncated?: boolean;
    strategy?: string;
    pairwisePairsComputed?: number;
    pairwisePairsTotal?: number;
    predictionStale?: boolean | null;
    predictionStalenessMs?: number | null;
    stalePolicy?: { ttlMs: number } | null;
    staleReason?: string | null;
    unresolvedResolutionState?: GitConflictState | null;
  };
  orchestratorSummary?: OrchestratorLaneSummaryV1 | null;
};

export type LaneCompletionSignal = "not-started" | "in-progress" | "review-ready" | "blocked";

export type OrchestratorLaneSummaryV1 = {
  laneId: string;
  completionSignal: LaneCompletionSignal;
  touchedFiles: string[];
  peerOverlaps: { peerId: string; files: string[]; risk: ConflictRiskLevel }[];
  suggestedMergeOrder: number | null;
  blockers: string[];
};

export type ProjectManifestLaneEntryV1 = {
  laneId: string;
  laneName: string;
  laneType: LaneType;
  branchRef: string;
  baseRef: string;
  worktreePath: string;
  isEditProtected: boolean;
  status: LaneStatus;
  lineage: LaneLineageV1;
  mergeConstraints: {
    requiredMerges: string[];
    blockedByLanes: string[];
    mergeReadiness: PackMergeReadiness;
  };
  branchState: BranchStateSnapshotV1;
  conflictState?: PackConflictStateV1 | null;
};

export type ProjectExportManifestV1 = {
  schema: "ade.manifest.project.v1";
  projectId: string;
  generatedAt: string;
  contextFingerprint?: string | null;
  contextVersion?: number | null;
  lastDocsRefreshAt?: string | null;
  docsStaleReason?: string | null;
  lanesTotal: number;
  lanesIncluded: number;
  lanesOmitted: number;
  lanes: ProjectManifestLaneEntryV1[];
  laneGraph?: {
    schema: "ade.laneGraph.v1";
    relations: import("../contextContract").PackRelation[];
  };
};

export type ConflictLineageV1 = {
  schema: "ade.conflictLineage.v1";
  laneId: string;
  peerKey: string;
  predictionAt: string | null;
  predictionAgeMs?: number | null;
  predictionStale?: boolean | null;
  staleReason?: string | null;
  lastRecomputedAt: string | null;
  truncated: boolean | null;
  strategy: string | null;
  pairwisePairsComputed: number | null;
  pairwisePairsTotal: number | null;
  stalePolicy: { ttlMs: number };
  openConflictSummaries: Array<{
    peerId: string | null;
    peerLabel: string;
    riskLevel: ConflictRiskLevel;
    fileCount: number;
    lastSeenAt: string | null;
    lastSeenAgeMs: number | null;
    riskSignals: string[];
  }>;
  unresolvedResolutionState?: GitConflictState | null;
};

export type PackExport = {
  packKey: string;
  packType: PackType;
  level: ContextExportLevel;
  header: ContextHeaderV1;
  content: string;
  approxTokens: number;
  maxTokens: number;
  truncated: boolean;
  warnings: string[];
  clipReason?: string | null;
  omittedSections?: string[] | null;
};

export type GetLaneExportArgs = { laneId: string; level: ContextExportLevel };
export type GetProjectExportArgs = { level: ContextExportLevel };
export type GetConflictExportArgs = { laneId: string; peerLaneId?: string | null; level: ContextExportLevel };
export type GetFeatureExportArgs = { featureKey: string; level: ContextExportLevel };
export type GetPlanExportArgs = { laneId: string; level: ContextExportLevel };
export type GetMissionExportArgs = { missionId: string; level: ContextExportLevel };

export type GetMissionPackArgs = { missionId: string };

export type RefreshMissionPackArgs = {
  missionId: string;
  reason: string;
  runId?: string | null;
};

export type OrchestratorContextPolicyProfile = {
  id: OrchestratorContextProfileId;
  includeNarrative: boolean;
  docsMode: OrchestratorContextDocsMode;
  laneExportLevel: ContextExportLevel;
  projectExportLevel: ContextExportLevel;
  maxDocBytes: number;
};

export type ListPackEventsSinceArgs = { packKey: string; sinceIso: string; limit?: number };

export type PackDeltaDigestArgs = {
  packKey: string;
  sinceVersionId?: string | null;
  sinceTimestamp?: string | null;
  minimumImportance?: PackEventImportance;
  limit?: number;
};

export type PackSectionChangeV1 = {
  sectionId: string;
  changeType: "added" | "removed" | "modified";
};

export type PackDeltaDigestV1 = {
  packKey: string;
  packType: PackType;
  since: {
    sinceVersionId: string | null;
    sinceTimestamp: string;
    baselineVersionId: string | null;
    baselineVersionNumber: number | null;
    baselineCreatedAt: string | null;
  };
  newVersion: PackHeadVersion;
  changedSections: PackSectionChangeV1[];
  highImpactEvents: PackEvent[];
  blockers: Array<{ kind: string; summary: string; entityIds?: string[] }>;
  conflicts: PackConflictStateV1 | null;
  decisionState: {
    recommendedExportLevel: ContextExportLevel;
    reasons: string[];
  };
  handoffSummary: string;
  clipReason?: string | null;
  omittedSections?: string[] | null;
};

export type PackHeadVersion = {
  packKey: string;
  packType: PackType;
  versionId: string | null;
  versionNumber: number | null;
  contentHash: string | null;
  updatedAt: string | null;
};

export type PackSummary = {
  packKey: string;
  packType: PackType;
  path: string;
  exists: boolean;
  deterministicUpdatedAt: string | null;
  narrativeUpdatedAt: string | null;
  lastHeadSha: string | null;
  versionId?: string | null;
  versionNumber?: number | null;
  contentHash?: string | null;
  metadata?: Record<string, unknown> | null;
  body: string;
};

export type PackVersionSummary = {
  id: string;
  packKey: string;
  packType: PackType;
  versionNumber: number;
  contentHash: string;
  createdAt: string;
};

export type PackVersion = PackVersionSummary & {
  renderedPath: string;
  body: string;
};

export type PackEvent = {
  id: string;
  packKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type Checkpoint = {
  id: string;
  laneId: string;
  sessionId: string | null;
  sha: string;
  diffStat: {
    insertions: number;
    deletions: number;
    filesChanged: number;
    files: string[];
  };
  packEventIds: string[];
  createdAt: string;
};

// --------------------------------
// Context Status & Inventory
// --------------------------------

export type ContextDocStatus = {
  id: "prd_ade" | "architecture_ade";
  label: string;
  preferredPath: string;
  exists: boolean;
  sizeBytes: number;
  updatedAt: string | null;
  fingerprint: string | null;
  staleReason: string | null;
  fallbackCount: number;
};

export type ContextDocGenerationWarning = {
  code: string;
  message: string;
  actionLabel?: string;
  actionPath?: string;
};

export type ContextStatus = {
  docs: ContextDocStatus[];
  canonicalDocsPresent: number;
  canonicalDocsScanned: number;
  canonicalDocsFingerprint: string;
  canonicalDocsUpdatedAt: string | null;
  projectExportFingerprint: string | null;
  projectExportUpdatedAt: string | null;
  contextManifestRefs: {
    project: string | null;
    packs: string | null;
    transcripts: string | null;
  };
  fallbackWrites: number;
  insufficientContextCount: number;
  warnings: ContextDocGenerationWarning[];
};

export type ContextInventoryPackEntry = {
  packKey: string;
  packType: PackType;
  laneId: string | null;
  deterministicUpdatedAt: string | null;
  narrativeUpdatedAt: string | null;
  lastHeadSha: string | null;
  versionId: string | null;
  versionNumber: number | null;
  contentHash: string | null;
};

export type ContextInventoryCheckpointEntry = {
  id: string;
  laneId: string;
  sessionId: string | null;
  createdAt: string;
  sha: string;
};

export type ContextInventorySessionDeltaEntry = {
  sessionId: string;
  laneId: string;
  startedAt: string;
  endedAt: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  computedAt: string | null;
};

export type ContextInventoryOrchestratorSummary = {
  activeRuns: number;
  runningSteps: number;
  runningAttempts: number;
  activeClaims: number;
  expiredClaims: number;
  snapshots: number;
  handoffs: number;
  timelineEvents: number;
  recentRunIds: string[];
  recentAttemptIds: string[];
};

export type ContextInventorySnapshot = {
  generatedAt: string;
  packs: {
    total: number;
    byType: Partial<Record<PackType, number>>;
    recent: ContextInventoryPackEntry[];
  };
  checkpoints: {
    total: number;
    recent: ContextInventoryCheckpointEntry[];
  };
  sessionTracking: {
    trackedSessions: number;
    untrackedSessions: number;
    runningSessions: number;
    recentDeltas: ContextInventorySessionDeltaEntry[];
  };
  missions: {
    total: number;
    byStatus: Partial<Record<MissionStatus, number>>;
    openInterventions: number;
    recentHandoffs: MissionStepHandoff[];
  };
  orchestrator: ContextInventoryOrchestratorSummary;
};

export type ContextDocProvider = "codex" | "claude";

export type ContextGenerateDocsArgs = {
  provider: ContextDocProvider;
  force?: boolean;
};

export type ContextPrepareDocGenArgs = {
  provider: ContextDocProvider;
  laneId: string;
};

export type ContextPrepareDocGenResult = {
  promptFilePath: string;
  outputPrdPath: string;
  outputArchPath: string;
  cwd: string;
  provider: ContextDocProvider;
};

export type ContextInstallGeneratedDocsArgs = {
  provider: ContextDocProvider;
  outputPrdPath: string;
  outputArchPath: string;
};

export type ContextGenerateDocsResult = {
  provider: ContextDocProvider;
  generatedAt: string;
  prdPath: string;
  architecturePath: string;
  usedFallbackPath: boolean;
  warnings: ContextDocGenerationWarning[];
  outputPreview: string;
};

export type ContextOpenDocArgs = {
  docId?: ContextDocStatus["id"];
  path?: string;
};
