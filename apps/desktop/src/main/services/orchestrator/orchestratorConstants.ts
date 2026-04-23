// ---------------------------------------------------------------------------
// Runtime constants moved out of shared/types (pure types only there).
// ---------------------------------------------------------------------------

import type {
  RoleIsolationRule,
  RecoveryLoopPolicy,
  ContextViewPolicy,
  OrchestratorContextView,
  IntegrationPrPolicy,
  PrDepth,
  WorkerSandboxConfig,
} from "../../../shared/types";

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

/** Safe-by-default worker permission fallbacks when project/mission config omits provider settings. */
export const DEFAULT_CLAUDE_PERMISSION_MODE = "acceptEdits";
export const DEFAULT_CODEX_APPROVAL_MODE = "auto-edit";
export const DEFAULT_CODEX_SANDBOX_PERMISSIONS = "workspace-write";

/**
 * Default sandbox configuration for API-model workers.
 * Based on the Claude sandbox rules in .claude/hooks/sandbox.py,
 * filtered to universal patterns (no project-specific integration rules).
 * CLI-wrapped models (Claude, Codex) skip this — they have native sandboxing.
 */
export const DEFAULT_WORKER_SANDBOX_CONFIG: WorkerSandboxConfig = {
  blockedCommands: [
    "\\brm\\s+-rf\\s+/",
    "\\brm\\s+-rf\\s+~",
    "\\bsudo\\b",
    "\\bchmod\\s+777\\b",
    "\\bcurl\\b.*\\|\\s*sh",
    "\\bwget\\b.*\\|\\s*sh",
    "\\beval\\b",
    ">\\s*/etc/",
    ">\\s*/usr/",
    ">\\s*/var/",
    "\\bmkfs\\b",
    "\\bdd\\b\\s+if=",
    "\\bshutdown\\b",
    "\\breboot\\b",
    ":\\(\\)\\{",
    "\\breg(?:\\.exe)?\\s+(add|delete|import|load|unload|copy|save|restore)\\b",
    "\\bdiskpart(?:\\.exe)?\\b",
    "\\bformat(?:\\.exe)?\\s+[a-z]:",
    "\\bbcdedit(?:\\.exe)?\\b",
    "\\btakeown(?:\\.exe)?\\b",
    ">\\s*[^\\n\\r]*[/\\\\]windows[/\\\\]system32\\b",
    ">\\s*[^\\n\\r]*[/\\\\]windows[/\\\\]syswow64\\b",
  ],
  safeCommands: [
    "^pnpm(\\.cmd)?\\s",
    "^npm(\\.cmd)?\\s",
    "^yarn(\\.cmd)?\\s",
    "^npx(\\.cmd)?\\s",
    "^git(\\.exe)?\\s+status\\b",
    "^git(\\.exe)?\\s+diff\\b",
    "^git(\\.exe)?\\s+log\\b",
    "^git(\\.exe)?\\s+show\\b",
    "^git(\\.exe)?\\s+branch\\s*$",
    "^git(\\.exe)?\\s+ls-files\\b",
    "^ls\\s",
    "^ls$",
    "^pwd\\b",
    "^echo\\s",
    "^date\\b",
    "^node(\\.exe)?\\s",
    "^tsx(\\.cmd)?\\s",
    "^vitest(\\.cmd)?\\s",
    "^jest(\\.cmd)?\\s",
    "^eslint(\\.cmd)?\\s",
    "^prettier(\\.cmd)?\\s",
    "^tsc(\\.cmd)?\\b",
    "^lsof\\s",
    "^ps\\s",
  ],
  protectedFiles: [
    "\\.env$",
    "\\.env\\.",
    "secrets?\\.json$",
    "credentials\\.json$",
    "\\.pem$",
    "\\.key$",
    "/\\.git/",
  ],
  allowedPaths: ["./"],
  blockByDefault: false,
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
