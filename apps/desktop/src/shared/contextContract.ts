// Stable, marker-based sections used by packs and exports.
// These strings are part of the public contract: do not change without bumping the contract version.
export const ADE_INTENT_START = "<!-- ADE_INTENT_START -->";
export const ADE_INTENT_END = "<!-- ADE_INTENT_END -->";
export const ADE_TODOS_START = "<!-- ADE_TODOS_START -->";
export const ADE_TODOS_END = "<!-- ADE_TODOS_END -->";
export const ADE_NARRATIVE_START = "<!-- ADE_NARRATIVE_START -->";
export const ADE_NARRATIVE_END = "<!-- ADE_NARRATIVE_END -->";
export const ADE_TASK_SPEC_START = "<!-- ADE_TASK_SPEC_START -->";
export const ADE_TASK_SPEC_END = "<!-- ADE_TASK_SPEC_END -->";

// Machine-readable header schema embedded in packs/exports as a JSON fence.
export const CONTEXT_HEADER_SCHEMA_V1 = "ade.context.v1" as const;

export const ADE_CONFLICT_EXTERNAL_RUN_SCHEMA_V1 = "ade.conflictExternalRun.v1" as const;

// Contract version is an advisory monotonic counter for backward-compatible additions.
// Consumers should not gate on this value; use it only for diagnostics and feature flags.
export const CONTEXT_CONTRACT_VERSION = 4 as const;

// -----------------------------
// Graph + Export Omission Types
// -----------------------------

export type PackRelationType =
  | "depends_on"
  | "parent_of"
  | "blocked_by"
  | "blocks"
  | "shares_base"
  | "merges_into";

export type PackRelation = {
  relationType: PackRelationType;

  // Target references (prefer these over inference when available)
  targetPackKey: string;
  targetPackType?: string | null;
  targetLaneId?: string | null;
  targetPeerKey?: string | null;
  targetBranch?: string | null;
  targetHeadCommit?: string | null;
  targetVersionId?: string | null;

  // Optional hints for humans/agents (never required for correctness)
  rationale?: string | null;
};

export type PackGraphEnvelopeV1 = {
  schema: "ade.packGraph.v1";
  relations: PackRelation[];
};

export type ExportOmissionReason =
  | "omitted_by_level"
  | "truncated_section"
  | "budget_clipped"
  | "data_unavailable";

export type ExportOmissionV1 = {
  sectionId: string;
  reason: ExportOmissionReason;
  detail?: string | null;
  // Suggested follow-up action for consumers (not enforced).
  recommendedLevel?: "lite" | "standard" | "deep" | null;
};
