/**
 * Plan quality gates for the orchestration lead.
 *
 * Pure functions that assess whether a plan summary covers the minimum
 * required sections before requesting user approval. Extracted from
 * `orchestrationTools.ts` to keep tool definitions focused on I/O wiring.
 */

export type OrchestrationPlanQualityMissing = {
  id: string;
  label: string;
  message: string;
};

type PlanQualityRequirement = OrchestrationPlanQualityMissing & {
  patterns: RegExp[];
};

const PLAN_QUALITY_REQUIREMENTS: PlanQualityRequirement[] = [
  {
    id: "out_of_scope",
    label: "Out of scope / non-goals",
    message: "Add a clear out-of-scope or non-goals section.",
    patterns: [
      /out[-\s]?of[-\s]?scope/i,
      /non[-\s]?goals?/i,
      /not doing/i,
      /excluded/i,
      /deferred/i,
    ],
  },
  {
    id: "implementation_order",
    label: "Implementation order",
    message: "Add the planned implementation order, dependencies, or phase sequence.",
    patterns: [
      /implementation order/i,
      /execution order/i,
      /planned order/i,
      /work order/i,
      /sequence/i,
      /phases?/i,
      /dependencies?/i,
      /\bfirst\b/i,
      /\bthen\b/i,
      /\bafter\b/i,
      /\bparallel\b/i,
    ],
  },
  {
    id: "agent_plan",
    label: "Agent plan",
    message: "Add which workers/validators to spawn and what each owns.",
    patterns: [
      /agent plan/i,
      /workers?/i,
      /validators?/i,
      /spawn/i,
      /assignee/i,
      /owner/i,
      /tags?/i,
      /role\/tag/i,
      /model routing/i,
      /model picks?/i,
    ],
  },
  {
    id: "validation_plan",
    label: "Validation / proof plan",
    message: "Add concrete validation, proof, or evidence expectations.",
    patterns: [
      /validation/i,
      /validate/i,
      /verify/i,
      /test/i,
      /typecheck/i,
      /lint/i,
      /build/i,
      /smoke/i,
      /proof/i,
      /evidence/i,
      /gates?/i,
      /checks?/i,
    ],
  },
  {
    id: "ui_impact",
    label: "UI decisions or N/A",
    message: "Add UI/user-facing decisions, or explicitly say UI is not applicable.",
    patterns: [
      /\bui\b/i,
      /\bux\b/i,
      /user[-\s]?facing/i,
      /interface/i,
      /screen/i,
      /view/i,
      /visual/i,
      /accessibility/i,
      /not applicable/i,
      /\bn\/a\b/i,
      /no ui/i,
      /non[-\s]?ui/i,
      /backend[-\s]?only/i,
      /cli[-\s]?only/i,
    ],
  },
  {
    id: "coordination_log",
    label: "Coordination / live log",
    message: "Add how plan.md and the manifest stay updated as agents work.",
    patterns: [
      /coordination/i,
      /plan\.md/i,
      /manifest/i,
      /status update/i,
      /progress update/i,
      /live update/i,
      /planAppend/i,
      /messageAgent/i,
      /report back/i,
      /stuck/i,
      /handoff/i,
      /sync(?:ed)?/i,
    ],
  },
  {
    id: "alternatives",
    label: "Alternatives / tradeoffs",
    message: "Add alternatives, options, or tradeoffs considered for major choices.",
    patterns: [
      /alternatives?/i,
      /options?/i,
      /trade[-\s]?offs?/i,
      /considered/i,
      /approach/i,
      /rejected/i,
      /decision/i,
    ],
  },
];

export function assessOrchestrationPlanQuality(planSummary: string): {
  ok: boolean;
  missing: OrchestrationPlanQualityMissing[];
} {
  const text = planSummary.trim();
  const missing = PLAN_QUALITY_REQUIREMENTS
    .filter((requirement) => !requirement.patterns.some((pattern) => pattern.test(text)))
    .map(({ id, label, message }) => ({ id, label, message }));
  return { ok: missing.length === 0, missing };
}
