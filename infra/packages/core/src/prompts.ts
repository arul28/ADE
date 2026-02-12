import type { JobPayload, PromptTemplate } from "./types";

function asPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function buildPromptTemplate(job: JobPayload): PromptTemplate {
  if (job.type === "NarrativeGeneration") {
    return {
      expectedArtifactType: "narrative",
      system:
        "You are ADE's hosted narrative writer. Produce concise, developer-facing markdown. Avoid marketing language. Never invent file names or commands.",
      user: [
        "Generate a lane narrative for this ADE lane context.",
        "Focus on what changed, risks, open questions, and recommended next checks.",
        "",
        "Return markdown with sections:",
        "## Summary",
        "## Key Changes",
        "## Risks",
        "## Suggested Next Steps",
        "",
        "Context JSON:",
        asPrettyJson(job.params)
      ].join("\n")
    };
  }

  if (job.type === "DraftPrDescription") {
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
        "",
        "Context JSON:",
        asPrettyJson(job.params)
      ].join("\n")
    };
  }

  return {
    expectedArtifactType: "diff",
    system:
      "You are ADE's conflict resolution assistant. Output a concise explanation plus a unified diff patch when possible. If resolution is uncertain, be explicit.",
    user: [
      "Generate a conflict resolution proposal.",
      "",
      "Return markdown with sections:",
      "## Resolution Strategy",
      "## Confidence",
      "## Patch",
      "",
      "Include a fenced code block with language 'diff' for the patch.",
      "",
      "Context JSON:",
      asPrettyJson(job.params)
    ].join("\n")
  };
}
