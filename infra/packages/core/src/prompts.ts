import type { JobPayload, PromptTemplate } from "./types";

function asPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readConflictContext(params: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(params.conflictContext)) return params.conflictContext;
  return params;
}

function buildContextProvenanceBlock(job: JobPayload, params: Record<string, unknown>): string {
  const handoff = isRecord(params.__adeHandoff) ? params.__adeHandoff : {};
  const conflictContext = readConflictContext(params);
  const relevantFiles = Array.isArray(conflictContext.relevantFilesForConflict)
    ? conflictContext.relevantFilesForConflict
    : [];
  const fileContexts = Array.isArray(conflictContext.fileContexts) ? conflictContext.fileContexts : [];
  const warnings = Array.isArray(handoff.warnings) ? handoff.warnings : [];

  const provenance = {
    contextSource:
      typeof handoff.contextSource === "string" ? handoff.contextSource : isRecord(params.__adeContextRef) ? "mirror" : "inline",
    reasonCode: typeof handoff.reasonCode === "string" ? handoff.reasonCode : null,
    approxParamsBytes: Number.isFinite(Number(handoff.approxParamsBytes)) ? Number(handoff.approxParamsBytes) : null,
    manifestRefs: isRecord(handoff.manifestRefs) ? handoff.manifestRefs : null,
    staleness: isRecord(handoff.staleness) ? handoff.staleness : null,
    packVersion: isRecord(handoff.packVersion) ? handoff.packVersion : null,
    projectPackVersion: isRecord(handoff.projectPackVersion) ? handoff.projectPackVersion : null,
    conflictPackVersion: isRecord(handoff.conflictPackVersion) ? handoff.conflictPackVersion : null,
    selectedFileSetSummary: {
      relevantFilesForConflict: relevantFiles.length,
      fileContexts: fileContexts.length
    },
    missingRelevanceWarnings: Array.isArray(handoff.missingRelevanceWarnings) ? handoff.missingRelevanceWarnings : [],
    fileContextsMissing: Boolean(handoff.fileContextsMissing),
    warnings
  };

  return ["## Context Provenance", "```json", asPrettyJson(provenance), "```", ""].join("\n");
}

function buildConflictOutputTemplate(insufficientContext: boolean): string {
  return [
    "Return markdown with these exact top-level sections in this exact order:",
    "## ResolutionStrategy",
    "## RelevantEvidence",
    "## Scope",
    "## Patch",
    "## Confidence",
    "## Assumptions",
    "## Unknowns",
    "## InsufficientContext",
    "",
    "Rules:",
    "- Scope must only list files from relevantFilesForConflict.",
    "- Do not modify non-relevant files unless explicit override in params.",
    "- Patch must contain exactly one fenced `diff` block when InsufficientContext=false.",
    "- Patch must be empty when InsufficientContext=true.",
    "- Confidence must be one of: high | medium | low.",
    `- InsufficientContext must be ${insufficientContext ? "true" : "true or false based on evidence completeness"}.`
  ].join("\n");
}

export function buildPromptTemplate(job: JobPayload): PromptTemplate {
  if (job.type === "NarrativeGeneration") {
    const params = isRecord(job.params) ? job.params : {};
    const packBody = typeof params.packBody === "string" ? params.packBody : "";
    const projectContext = typeof params.projectContext === "string" ? params.projectContext : "";
    const projectContextMeta = isRecord(params.projectContextMeta) ? params.projectContextMeta : {};
    const { packBody: _packBody, ...rest } = params;
    return {
      expectedArtifactType: "narrative",
      system:
        "You are ADE's hosted narrative writer. Be concise, factual, and deterministic. Never invent file names, commands, risks, or validations.",
      user: [
        "Generate a lane narrative for this ADE lane context.",
        "Focus on what changed and why it matters for reviewers and future maintainers.",
        "",
        "Return markdown with sections:",
        "## Summary",
        "## Key Changes",
        "## Why This Matters",
        "## Risks",
        "## Suggested Next Steps",
        "",
        "Use project-level PRD and architecture assumptions when provided. If assumptions are missing, state that explicitly.",
        "",
        buildContextProvenanceBlock(job, params),
        "Lane Export (markdown):",
        packBody || "(packBody missing)",
        "",
        "Project Context (markdown):",
        projectContext || "(project context missing)",
        "",
        "Project Context Meta (JSON):",
        asPrettyJson(projectContextMeta),
        "",
        "Aux Context (JSON):",
        asPrettyJson(rest)
      ].join("\n")
    };
  }

  if (job.type === "DraftPrDescription") {
    const params = isRecord(job.params) ? job.params : {};
    const packBody = typeof params.packBody === "string" ? params.packBody : "";
    const { packBody: _packBody, ...rest } = params;
    return {
      expectedArtifactType: "pr-description",
      system:
        "You are ADE's PR drafting assistant. Return clear markdown that can be pasted into GitHub. Keep statements factual and tied to provided data.",
      user: [
        "Draft a PR description from this ADE project/lane context.",
        "",
        "Return markdown with sections:",
        "## Summary",
        "## What Changed",
        "## Validation",
        "## Risks",
        "## Assumptions",
        "",
        "When possible, explicitly reference relevant project docs (PRD and architecture docs) from the provided context.",
        "",
        buildContextProvenanceBlock(job, params),
        "Lane Export (markdown):",
        packBody || "(packBody missing)",
        "",
        "Aux Context (JSON):",
        asPrettyJson(rest)
      ].join("\n")
    };
  }

  const params = isRecord(job.params) ? job.params : {};
  const conflictContext = readConflictContext(params);
  const insufficientContext = Boolean(conflictContext.insufficientContext);
  const insufficientReasons = Array.isArray(conflictContext.insufficientReasons)
    ? conflictContext.insufficientReasons.map((value) => String(value))
    : [];

  return {
    expectedArtifactType: "diff",
    system:
      "You are ADE's conflict resolution assistant. Be deterministic and scope-limited. Never fabricate file content. Never output speculative patches when context is insufficient.",
    user: [
      "Generate a conflict resolution proposal from the provided conflict context.",
      "",
      buildConflictOutputTemplate(insufficientContext),
      "",
      buildContextProvenanceBlock(job, params),
      "",
      insufficientContext
        ? [
            "Context check indicates insufficient evidence for a safe patch.",
            "You must set `InsufficientContext` to `true` and provide specific data gaps.",
            "Data gaps:",
            ...insufficientReasons.map((reason) => `- ${reason}`)
          ].join("\n")
        : "If context is complete, provide one safe patch within the declared scope.",
      "",
      "Conflict Context JSON:",
      asPrettyJson(conflictContext),
      "",
      "Full Params JSON:",
      asPrettyJson(params)
    ].join("\n")
  };
}
