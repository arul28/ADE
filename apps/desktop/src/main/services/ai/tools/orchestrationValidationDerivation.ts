/**
 * Derives a suggested set of validation steps from the recorded codebase
 * intake — the bridge that turns the /quality dual-review + /test stewardship
 * ideology into concrete `validationStrategy.steps`. The lead reviews/edits the
 * suggestions and writes them via manifestPatch; this only guarantees the right
 * concerns are *considered* and seeds codebase-specific prompt text.
 */

import type {
  OrchestrationManifest,
  ValidationStep,
} from "../../../../shared/types/orchestration";

export function deriveSuggestedValidationSteps(
  manifest: OrchestrationManifest,
): ValidationStep[] {
  const intake = manifest.leadState.planning?.intake;
  const testStack = intake?.testStack ?? "";
  const hasTests = Boolean(testStack) && !/^\s*(none|no tests|n\/?a)\b/i.test(testStack);
  const surfaces = intake?.ancillarySurfaces ?? [];
  const ciGates = intake?.ciGates ?? [];

  const steps: ValidationStep[] = [];
  let counter = 0;
  const nextId = () => `VS-${++counter}`;

  // Always: per-worker self-review of the final state of touched files.
  steps.push({
    id: nextId(),
    concern: "reverify_changes",
    scope: "per_worker",
    required: true,
    prompt:
      "Re-read the final state of every file you touched. Walk error paths (empty/nil/malformed input, upstream failure, cancellation) and edge cases for this change type. Grep for callers/tests/types referencing changed or removed symbols. Fix what you find; report what you checked and what you deliberately left alone.",
    evidenceRequired: ["plan_md_section", "diff_summary"],
  });

  // The /quality dual-review, run as the lean perspective-diverse panel.
  steps.push({
    id: nextId(),
    concern: "dual_review_correctness_security",
    scope: "mission_exit",
    required: true,
    prompt:
      "Review the whole diff for correctness + security: bugs, broken existing features (trace cross-app/IPC side effects), unhandled error branches, and the security surface (secrets, permission/allowlist gaps, data-integrity). Emit structured findings (severity · file:line · fix). Default to honest severity; do not pad.",
    evidenceRequired: ["plan_md_section", "diff_summary"],
  });
  steps.push({
    id: nextId(),
    concern: "dual_review_maintainability",
    scope: "mission_exit",
    required: true,
    prompt:
      "Review the diff for maintainability: structural simplification, dead code, spaghetti conditionals, unnecessary optionality/casts, and feature logic leaking into shared/canonical layers. Emit structured findings with the smallest behavior-preserving fix for each.",
    evidenceRequired: ["plan_md_section"],
  });

  if (hasTests) {
    steps.push({
      id: nextId(),
      concern: "test_stewardship",
      scope: "mission_exit",
      required: true,
      prompt:
        `Leave the suite more truthful and smaller, not just larger (tests: ${testStack}). PRUNE dead/skip/anti-pattern tests, CONSOLIDATE fragmented files for one feature, ADD only tests that prove the new public contracts (hard caps; no render-only tests). Run the affected shards.`,
      evidenceRequired: ["test_log"],
    });
    steps.push({
      id: nextId(),
      concern: "regression_pinning",
      scope: "mission_exit",
      required: true,
      prompt:
        "Turn every Blocker/High from the dual-review into a named regression test that fails on the bug and passes once fixed. A finding is not handled until a test pins it.",
      evidenceRequired: ["test_log"],
    });
  }

  if (surfaces.length) {
    steps.push({
      id: nextId(),
      concern: "surface_parity",
      scope: "mission_exit",
      required: true,
      prompt:
        `Keep cross-cutting surfaces in lockstep with the change: ${surfaces.join(", ")}. Update each (docs, mobile/SDK/CLI/TUI, specs) or explain why it is unaffected. If this run is tied to a Linear issue, keep it in lockstep too (move its state, comment progress) via the ade-linear CLI, and register that update as a linear_issue asset.`,
      evidenceRequired: ["plan_md_section"],
    });
  }

  if (ciGates.length) {
    steps.push({
      id: nextId(),
      concern: "pre_completion_gate",
      scope: "mission_exit",
      required: true,
      prompt:
        `Run the standard pre-completion checks before declaring the run complete: ${ciGates.join("; ")}. Push / open-a-PR / remote review are allowed ONLY when this run's approved plan called for them; otherwise leave the branch for a separate user-driven step. When a PR is in scope, register it as a pr_link asset with its number + url.`,
      evidenceRequired: ["test_log"],
    });
  }

  return steps;
}
