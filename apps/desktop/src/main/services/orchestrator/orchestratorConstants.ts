// ---------------------------------------------------------------------------
// Runtime constants moved out of shared/types (pure types only there).
// ---------------------------------------------------------------------------

import type {
  OrchestratorTaskStatus,
  RoleIsolationRule,
  RecoveryLoopPolicy,
  ContextViewPolicy,
  OrchestratorContextView,
  IntegrationPrPolicy,
  PrDepth,
} from "../../../shared/types";

/** Map legacy step statuses to task statuses for backward-compatible reads */
export const LEGACY_STEP_TO_TASK_STATUS: Record<string, OrchestratorTaskStatus> = {
  pending: "pending",
  ready: "ready",
  running: "running",
  succeeded: "done",
  failed: "blocked",
  blocked: "blocked",
  skipped: "done",
  superseded: "done",
  canceled: "canceled",
};

/**
 * The default set of role isolation rules.
 * Source: Anthropic sub-agent docs recommend strict role boundaries
 * to prevent context contamination between implementers and reviewers.
 */
export const DEFAULT_ROLE_ISOLATION_RULES: RoleIsolationRule[] = [
  {
    mutuallyExclusive: ["implementation", "code_review"],
    enforcement: "auto_correct",
    reason: "Implementers must not review their own code."
  },
  {
    mutuallyExclusive: ["implementation", "test_review"],
    enforcement: "auto_correct",
    reason: "Implementers must not review their own test results."
  },
  {
    mutuallyExclusive: ["testing", "test_review"],
    enforcement: "auto_correct",
    reason: "Test authors must not review their own test results."
  },
  {
    mutuallyExclusive: ["code_review", "implementation"],
    enforcement: "auto_correct",
    reason: "Reviewers must not implement code they reviewed."
  }
];

export const DEFAULT_RECOVERY_LOOP_POLICY: RecoveryLoopPolicy = {
  enabled: true,
  maxIterations: 3,
  onExhaustion: "intervention",
  minConfidenceDelta: 0.1,
  escalateAfterStagnant: 2
};

export const DEFAULT_CONTEXT_VIEW_POLICIES: Record<OrchestratorContextView, ContextViewPolicy> = {
  implementation: {
    view: "implementation",
    readOnly: false,
    includeScratchContext: true,
    includeArtifacts: true,
    includeCheckResults: true,
    includeHandoffSummaries: true,
    diffMode: "full"
  },
  review: {
    view: "review",
    readOnly: true,
    includeScratchContext: false,
    includeArtifacts: true,
    includeCheckResults: true,
    includeHandoffSummaries: true,
    diffMode: "full"
  },
  test_review: {
    view: "test_review",
    readOnly: true,
    includeScratchContext: false,
    includeArtifacts: true,
    includeCheckResults: true,
    includeHandoffSummaries: true,
    diffMode: "summary"
  }
};

export const DEFAULT_INTEGRATION_PR_POLICY: IntegrationPrPolicy = {
  enabled: false,
  createIntegrationLane: true,
  prDepth: "resolve-conflicts" as PrDepth,
  draft: true
};

/**
 * Maps known slash commands to their prompt translations.
 * This ensures slash commands work correctly when invoked
 * by the orchestrator via Claude CLI -p flag.
 */
export const SLASH_COMMAND_TRANSLATIONS: Record<string, { prompt: string; interactive: boolean }> = {
  "/automate": {
    prompt: "Run the /automate skill. This means: analyze the current project state, identify work that needs to be done based on the mission context, and execute it autonomously using agent teams. Use the Skill tool to invoke the 'automate' skill if available, otherwise carry out the automation workflow directly.",
    interactive: false
  },
  "/finalize": {
    prompt: "Run the /finalize skill. This means: perform end-of-cycle documentation audit - scan the codebase, verify docs are up to date, update the implementation plan, and run local checks. Use the Skill tool to invoke the 'finalize' skill if available, otherwise carry out the finalization workflow directly.",
    interactive: false
  }
};
