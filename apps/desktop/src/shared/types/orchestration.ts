import type { AgentChatProvider } from "./chat";

export const ORCHESTRATION_MANIFEST_VERSION = 1;

export type OrchestrationPhaseId = "planning" | "developing" | "validating" | "wrapup";

export type OrchestrationRole = "lead" | "worker" | "validator";

export type OrchestrationAgentStatus =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed";

export type OrchestrationTaskStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "review"
  | "done"
  | "failed";

export type OrchestrationPhase = {
  id: OrchestrationPhaseId;
  title: string;
  status: "pending" | "active" | "done" | "skipped";
  startedAt?: string;
  completedAt?: string;
};

export type ModelSelection = {
  provider: AgentChatProvider;
  modelId: string;
  reasoningEffort?: string | null;
  fastMode?: boolean;
};

export type ModelRouting = {
  default?: ModelSelection;
  byRole?: Partial<Record<OrchestrationRole, ModelSelection>>;
  byTag?: Record<string, ModelSelection>;
  byRoleTag?: Record<string, ModelSelection>;
};

export type SpawnFingerprint = {
  provider: AgentChatProvider;
  modelId: string;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  resolvedAt: string;
  routingKey:
    | "byRoleTag"
    | "byTag"
    | "byRole"
    | "default"
    | "fallback"
    | "override";
};

export type AgentBudget = {
  maxTokens?: number;
  maxCostUsd?: number;
  maxWallClockMs?: number;
  maxTurns?: number;
  onExceeded?: "pause" | "interrupt" | "warn";
};

export type AgentUsageSnapshot = {
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  turns?: number;
  elapsedMs?: number;
};

export type OrchestrationAgent = {
  sessionId: string;
  role: OrchestrationRole;
  tag?: string;
  displayName?: string;
  goalSummary: string;
  status: OrchestrationAgentStatus;
  currentStepId?: string;
  cancellationRequested?: boolean;
  lastHeartbeatAt?: string;
  spawnedAt: string;
  spawnFingerprint?: SpawnFingerprint;
  budget?: AgentBudget;
  usage?: AgentUsageSnapshot;
};

export type ValidationConcern =
  | "reverify_changes"
  | "test_suite_truthfulness"
  | "surface_parity"
  | "pre_completion_gate"
  | "deep_maintainability"
  // Quality/test methodology concerns (the /quality dual-review + /test stewardship
  // run as a perspective-diverse validation panel; see SKILL.md §6).
  | "dual_review_correctness_security"
  | "dual_review_maintainability"
  | "test_stewardship"
  | "regression_pinning"
  | "custom";

/** Severity rank for a structured validation finding (mirrors /quality). */
export type ValidationFindingSeverity = "blocker" | "high" | "medium" | "low";

/**
 * A single structured finding emitted by a validator and rolled up by the
 * synthesis step. Carried inside `ValidationChecklistRun.findings` so the panel
 * can render a severity table and each Blocker/High can become a regression
 * test target. Authored via `recordValidationRun`.
 */
export type ValidationFinding = {
  id: string;
  severity: ValidationFindingSeverity;
  /** `file:line` or a short locus the finding lives at. */
  locus?: string;
  title: string;
  detail?: string;
  /** Smallest behavior-preserving fix, when the validator can name one. */
  fix?: string;
  behaviorPreserving?: boolean;
  /** Set when a Blocker/High has been pinned as a named regression test. */
  regressionTestTarget?: string;
};

export type ValidationEvidenceKind =
  | "plan_md_section"
  | "manifest_checklist"
  | "diff_summary"
  | "screenshot"
  | "test_log";

export type ValidationStep = {
  id: string;
  concern: ValidationConcern;
  scope: "per_worker" | "per_step" | "mission_exit";
  required: boolean;
  prompt: string;
  evidenceRequired: ValidationEvidenceKind[];
  appliesToTaskIds?: string[];
};

export type EvidenceRef =
  | {
      kind: "plan_md_section" | "artifact" | "screenshot" | "test_log";
      path: string;
      sha256?: string;
      range?: { startLine: number; endLine: number };
    }
  | {
      kind: "transcript_excerpt";
      sessionId: string;
      turnId: string;
      range?: { startCharOffset: number; endCharOffset: number };
    }
  | { kind: "external_url"; url: string };

export type ValidationChecklistRun = {
  id: string;
  runBySessionId: string;
  status: "running" | "passed" | "failed";
  attachedEvidence?: EvidenceRef[];
  notes?: string;
  /** Structured findings for review-style concerns (dual_review_*). */
  findings?: ValidationFinding[];
  startedAt: string;
  endedAt?: string;
  supersedes?: string;
};

export type ValidationChecklistItem = {
  id: string;
  stepId: string;
  taskId?: string;
  runs: ValidationChecklistRun[];
  latestRunId: string;
};

export type ValidationStrategy = {
  steps: ValidationStep[];
  checklist: ValidationChecklistItem[];
};

export type OrchestrationTaskAttempt = {
  id: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  outcome:
    | "succeeded"
    | "failed"
    | "interrupted"
    | "cancelled"
    | "superseded";
  evidence?: EvidenceRef[];
  failureReason?: string;
};

export type OrchestrationTaskPriority = "low" | "normal" | "high" | "critical";
export type OrchestrationTaskComplexity =
  | "trivial"
  | "small"
  | "medium"
  | "large"
  | "spike";

export type OrchestrationTaskHumanOverride = {
  byUserId?: string;
  at: string;
  fromStatus: OrchestrationTaskStatus;
  toStatus: OrchestrationTaskStatus;
  reason?: string;
};

export type OrchestrationTask = {
  id: string;
  phaseId: OrchestrationPhaseId;
  title: string;
  description: string;
  status: OrchestrationTaskStatus;
  blockedBy?: string[];
  blocks?: string[];
  supersedes?: string[];
  supersededBy?: string[];
  relatedTaskIds?: string[];
  filesHint?: string[];
  tag?: string;
  labels?: string[];
  priority?: OrchestrationTaskPriority;
  estimatedComplexity?: OrchestrationTaskComplexity;
  assigneeSessionId?: string;
  claimedAt?: string;
  claimLeaseUntil?: string;
  attempts?: OrchestrationTaskAttempt[];
  currentAttemptId?: string;
  evidence?: EvidenceRef[];
  validationGate: { required: boolean; stepIds: string[] };
  humanOverride?: OrchestrationTaskHumanOverride;
};

export type OrchestrationAssetKind =
  | "html_spec"
  | "screenshot"
  | "test_log"
  | "doc";

export type OrchestrationAsset = {
  id: string;
  path: string;
  kind: OrchestrationAssetKind;
  version: number;
  approval?: "pending" | "approved" | "rejected";
  notes?: string;
};

export type DecisionLogEntry = {
  id: string;
  at: string;
  source: "user" | "lead" | "worker" | "validator";
  summary: string;
  refs?: { taskId?: string; stepId?: string; assetId?: string };
};

export type UserOverrideEntry = {
  id: string;
  at: string;
  scope: "session" | "phase" | "task" | "step";
  appliedToId?: string;
  instruction: string;
  affectedDefault?: string;
};

export type OrchestrationHistoryEntry = {
  etag: string;
  at: string;
  summary: string;
  patchKindSummary?: string;
};

// ---------------------------------------------------------------------------
// Planning state machine (lead-only, deterministic dev-loop sequence)
//
// The lead must walk this sequence before model-picks/approval are unlocked:
//   intake → round_functional → round_ui → round_extras → rounds_complete → ready
// Each transition is written ONLY through dedicated service methods (never raw
// manifestPatch — see patchPolicy LEAD_DENY_PATTERNS), so the sequence cannot be
// forged. Mirrors the /context intake + /plan three-round deliberation.
// ---------------------------------------------------------------------------

export type PlanningStage =
  | "intake"
  | "round_functional"
  | "round_ui"
  | "round_extras"
  | "rounds_complete"
  | "ready";

export type PlanningRoundKind = "functional" | "ui" | "extras";

/** The /context-style codebase intake, recorded as gate-checked state. */
export type PlanningIntakeArtifact = {
  recordedAt: string;
  /** Monorepo/app/lib shape + primary languages. */
  projectShape: string;
  /** Test frameworks + globs, or "none detected". */
  testStack: string;
  /** docs/, mobile apps, SDKs, OpenAPI, etc. that may need lockstep updates. */
  ancillarySurfaces: string[];
  /** Where docs live / how they're organized. */
  docMap?: string;
  /** git log/diff summary of in-flight work, or "fresh lane". */
  inFlightWork: string;
  /** Detected typecheck/lint/test/build commands. */
  ciGates: string[];
};

/** One option offered in a planning round-question (mirrors a pending-input option). */
export type PlanningRoundOption = {
  id: string;
  label: string;
  description?: string;
  /** Markdown preview (e.g. an ASCII wireframe for the UI round). */
  preview?: string;
};

/**
 * A recorded deliberation round. Append-only; cascade mini-rounds set
 * `cascadedFrom` to the round they branched off. A round is only accepted by
 * the service once it carries a real user answer (`answeredAt` + a selection or
 * free-text), so the lead cannot self-author a stub.
 */
export type PlanningRoundRecord = {
  id: string;
  kind: PlanningRoundKind;
  askedAt: string;
  question: string;
  options?: PlanningRoundOption[];
  multiSelect?: boolean;
  selectedOptionIds?: string[];
  freeText?: string;
  /** The lead's locked outcome for the round (one-liner). */
  lockedSummary: string;
  /** Set when this is a cascade mini-round spawned by new mid-plan scope. */
  cascadedFrom?: string;
  answeredAt?: string;
};

export type PlanningState = {
  stage: PlanningStage;
  intake?: PlanningIntakeArtifact;
  rounds: PlanningRoundRecord[];
  overrides?: {
    /** Rounds the user explicitly waived (§1 user authority override). */
    skippedRounds?: PlanningRoundKind[];
    skipReason?: string;
  };
};

// ---------------------------------------------------------------------------
// PlanSpec — coverage index over plan.md + approval state.
//
// plan.md remains the single human-readable source of truth; this is a thin,
// machine-checkable index of which required sections the narrative covers, plus
// approval provenance. Replaces the old free-text approval summary + regex gate.
// ---------------------------------------------------------------------------

export type PlanSpecSectionId =
  | "goal"
  | "assumptions"
  | "in_scope"
  | "out_of_scope"
  | "alternatives"
  | "implementation_order"
  | "agent_plan"
  | "validation_plan"
  | "ui_decisions"
  | "coordination";

export type PlanSpecSection = {
  id: PlanSpecSectionId;
  required: boolean;
  /** The plan.md heading slug that covers this section, once present. */
  planSectionId?: string;
  status: "missing" | "drafted" | "locked";
  /** Escape hatch (e.g. UI on a backend-only run), with a reason. */
  notApplicable?: { reason: string };
};

export type PlanSpecApprovalState =
  | "drafting"
  | "ready"
  | "approved"
  | "changes_requested";

export type PlanSpec = {
  sections: PlanSpecSection[];
  approval: {
    state: PlanSpecApprovalState;
    requestedAt?: string;
    approvedAt?: string;
    approvedBySessionId?: string;
    /** sha256 of plan.md at approval — proves approved bytes == rendered bytes. */
    approvedPlanContentHash?: string;
    /** plan.md hash at the previous review, for the re-approval diff. */
    lastReviewedPlanContentHash?: string;
  };
};

export type OrchestrationManifest = {
  version: 1;
  schemaCompatibility?: { minReader: 1; maxKnown: 1 };
  runId: string;
  laneId: string;
  bundlePath: string;
  etag: string;
  serverGeneration: number;
  createdAt: string;
  updatedAt: string;
  title: string;
  goalSummary: string;
  currentPhase: OrchestrationPhaseId;
  phases: OrchestrationPhase[];
  agents: OrchestrationAgent[];
  tasks: OrchestrationTask[];
  validationStrategy: ValidationStrategy;
  modelRouting: ModelRouting;
  assets: OrchestrationAsset[];
  decisions: DecisionLogEntry[];
  userOverrides: UserOverrideEntry[];
  leadState: {
    lastSnapshotEtag?: string;
    lastSnapshotSeenAt?: string;
    planApprovedAt?: string;
    planApprovedBySessionId?: string;
    /** @deprecated Superseded by plan.md + planSpec; kept for legacy reads. */
    planApprovalSummary?: string;
    /** Deterministic planning sequence; see PlanningState. */
    planning?: PlanningState;
  };
  /** Coverage index over plan.md + approval state (replaces planApprovalSummary). */
  planSpec?: PlanSpec;
  history: OrchestrationHistoryEntry[];
  defaultBudget?: AgentBudget;

  // v2 reservations (present in schema; unused in v1):
  coordinatorSessionId?: string;
  peerRunIds?: string[];
  parentRunId?: string;
  forkedAtEtag?: string;
  forkReason?: string;
};

export type ManifestPatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

export type ManifestPatchKind =
  | "agent"
  | "task"
  | "phase"
  | "validationStrategy"
  | "modelRouting"
  | "assets"
  | "decisions"
  | "userOverrides"
  | "leadState"
  | "history"
  | "core"
  | "unknown";

export type ManifestSection =
  | "tasks"
  | "agents"
  | "validationStrategy"
  | "decisions"
  | "assets";

export type OrchestrationRunSummary = {
  runId: string;
  laneId: string;
  title: string;
  goalSummary: string;
  currentPhase: OrchestrationPhaseId;
  etag: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "suspended" | "completed";
  agentCount: number;
  taskCount: number;
};

export type OrchestrationPingKind = "queue" | "interrupt-replace" | "wake";

export type OrchestrationPingIntent =
  | "directive"
  | "status"
  | "diff_notice"
  | "cancellation"
  | "question";

export type OrchestrationCancellationDirective = {
  revert: boolean | "review";
  reason: string;
};

export type OrchestrationPingPayload = {
  kind: OrchestrationPingKind;
  intent: OrchestrationPingIntent;
  text: string;
  taskId?: string;
  cancellation?: OrchestrationCancellationDirective;
};

export type OrchestrationOrigin = {
  runId: string;
  fromSessionId: string;
  kind: OrchestrationPingKind;
  intent: OrchestrationPingIntent;
  taskId?: string;
};

export type OrchestrationEventPayload =
  | {
      runId: string;
      kind: "manifest";
      etag: string;
      patch?: ManifestPatchOp[];
      manifest?: OrchestrationManifest;
    }
  | {
      runId: string;
      kind: "plan";
      etag: string;
      planMd?: string;
      planPatch?: { from: string; to: string };
    }
  | {
      runId: string;
      kind: "asset";
      etag: string;
      asset?: OrchestrationAsset;
    }
  | {
      runId: string;
      kind: "heartbeat";
      etag: string;
      sessionId: string;
      lastHeartbeatAt: string;
    }
  | {
      runId: string;
      kind: "lifecycle";
      etag: string;
      status: "suspended" | "resumed" | "deleted";
    };

export type OrchestrationManifestPatchRequest = {
  runId: string;
  patches: ManifestPatchOp[];
  ifMatchEtag: string;
  actorSessionId?: string;
  actorRole?: OrchestrationRole;
  summary?: string;
};

export type OrchestrationManifestPatchResponse =
  | { ok: true; manifest: OrchestrationManifest; etag: string }
  | {
      ok: false;
      error: "etag_conflict";
      manifest: OrchestrationManifest;
      etag: string;
    }
  | {
      ok: false;
      error: "validation_failed" | "policy_denied" | "schema_error";
      message: string;
      manifest?: OrchestrationManifest;
      etag?: string;
    };

export type OrchestrationSpawnAgentRequest = {
  runId: string;
  role: "worker" | "validator";
  tag: string;
  goalSummary: string;
  stepId?: string;
  initialMessage: string;
  modelOverride?: ModelSelection;
};

export type OrchestrationAgentInjectRequest = {
  runId: string;
  fromSessionId: string;
  targetSessionId: string;
  payload: OrchestrationPingPayload;
};

export type OrchestrationClaimTaskRequest = {
  runId: string;
  taskId: string;
  sessionId: string;
  leaseMs: number;
};

export type OrchestrationReleaseTaskRequest = {
  runId: string;
  taskId: string;
  sessionId: string;
  status: OrchestrationTaskStatus;
};

export type OrchestrationRecordValidationRunRequest = {
  runId: string;
  taskId: string;
  stepId: string;
  sessionId: string;
  status: ValidationChecklistRun["status"];
  notes?: string;
  attachedEvidence?: EvidenceRef[];
  /** Structured findings for review-style concerns; rolled up into the panel's severity table. The service assigns ids. */
  findings?: (Omit<ValidationFinding, "id"> & { id?: string })[];
  startedAt?: string;
  endedAt?: string;
};

export type OrchestrationPlanAppendRequest = {
  runId: string;
  section: string;
  body: string;
  pinId?: string;
};

export type OrchestrationPlanWriteRequest = {
  runId: string;
  nextPlanMd: string;
  ifMatchEtag: string;
};

export type OrchestrationAssetRegisterRequest = {
  runId: string;
  relPath: string;
  kind: OrchestrationAssetKind;
  version?: number;
  approval?: "pending" | "approved" | "rejected";
};

export type OrchestrationBundleReadResponse = {
  manifest: OrchestrationManifest;
  planMd: string;
  etag: string;
};

export type OrchestrationManifestSectionReadResponse = {
  section: ManifestSection;
  data: unknown;
  etag: string;
};

export type OrchestrationRunCreateRequest = {
  laneId: string;
  leadSessionId: string;
  bundleRoot: string;
  title?: string;
  goalSummary?: string;
};

export type OrchestrationRunCreateResponse = {
  runId: string;
  manifest: OrchestrationManifest;
  etag: string;
};

export type OrchestrationModelSelectionMetadata = {
  role: OrchestrationRole;
  tag: string;
  /** Short description of what this agent will work on. */
  workDescription?: string | null;
  /** Files this agent is most likely to touch (briefing context for model choice). */
  filesHint?: string[];
  /** Tags/tasks this agent runs after (briefing context). */
  dependsOn?: string[];
  suggested?: ModelSelection;
  /** Optional snapshot of available models — server-provided when needed. */
  availableModels?: unknown;
};

/**
 * Anchor describing what the user selected when annotating the plan panel.
 * Carried in the composer attachment tray and shipped on the next send to
 * the lead. Pure ephemeral — not persisted to the manifest in v1 (see §10.7).
 */
export type OrchestrationAnnotationAnchorKind =
  | "text"        // arbitrary text selection inside the plan panel
  | "image"       // screenshot / PNG asset
  | "iframe"      // sandboxed HTML spec iframe
  | "mermaid"     // mermaid diagram SVG
  | "spec"        // the whole spec card (anchored by asset id)
  | "section";    // a plan.md section heading

export type OrchestrationAnnotationAnchor = {
  kind: OrchestrationAnnotationAnchorKind;
  /** Stable id for the anchored entity. Asset id for specs/images, section id for sections, ad-hoc for text. */
  id?: string;
  /** Short snippet of the anchored content so the lead sees what was annotated. */
  preview: string;
  /** Optional URL/path to the underlying asset. */
  href?: string;
  /** Optional plan section id (slug-hash) when the selection lives inside plan.md. */
  sectionId?: string;
};

export type OrchestrationContextItem = {
  type: "orchestration_annotation";
  runId: string;
  anchor: OrchestrationAnnotationAnchor;
  /** The exact text/excerpt the user selected. Empty for image-only anchors. */
  selectionExcerpt: string;
  /** Free-form user comment. May be empty if the user just wants to anchor. */
  comment: string;
  /** ISO-8601 timestamp the annotation was captured. */
  capturedAt: string;
};

/**
 * Custom event dispatched on `window` when a user submits an annotation popover.
 * Listener lives in {@link AgentChatPane.tsx} parallel to the
 * `ade:agent-chat:add-builtin-browser-context` listener.
 */
export const ORCHESTRATION_ANNOTATION_EVENT = "ade:agent-chat:add-plan-annotation";

export type OrchestrationAnnotationEventDetail = {
  /** Target chat session — only the matching pane will merge the item. */
  sessionId: string;
  item: OrchestrationContextItem;
};

export const ORCHESTRATION_SPAWN_BRIEF_REQUIRED_SECTIONS = [
  "## TASK",
  "## FILES",
  "## DEPENDENCIES",
  "## GATES",
  "## PEERS",
  "## SUCCESS",
] as const;

export const ORCHESTRATION_EVENT_CHANNEL = "ade.orchestration.event";
