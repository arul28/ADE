import { describe, expect, it } from "vitest";
import { buildPromptTemplate } from "../../../../../../infra/packages/core/src/prompts";

describe("buildPromptTemplate context provenance", () => {
  it("includes project context and assumptions in narrative prompts", () => {
    const prompt = buildPromptTemplate({
      projectId: "proj",
      userId: "user",
      jobId: "job",
      laneId: "lane-1",
      type: "NarrativeGeneration",
      params: {
        packBody: "lane export",
        projectContext: "docs/PRD.ade.md excerpt",
        projectContextMeta: {
          assumptions: {
            prdPreferred: true,
            architecturePreferred: true
          }
        },
        __adeHandoff: {
          contextSource: "mirror",
          manifestRefs: { project: "proj/project/manifest.json" }
        }
      },
      submittedAt: "2026-02-16T00:00:00.000Z"
    });

    expect(prompt.user).toContain("Project Context (markdown)");
    expect(prompt.user).toContain("docs/PRD.ade.md excerpt");
    expect(prompt.user).toContain("\"prdPreferred\": true");
  });

  it("includes handoff source metadata in conflict prompts", () => {
    const prompt = buildPromptTemplate({
      projectId: "proj",
      userId: "user",
      jobId: "job",
      laneId: "lane-1",
      type: "ProposeConflictResolution",
      params: {
        __adeHandoff: {
          contextSource: "mirror",
          reasonCode: "AUTO_MIRROR_JOBTYPE_CONFLICT",
          manifestRefs: { lane: "proj/lane-1/manifest.json" }
        },
        conflictContext: {
          relevantFilesForConflict: [{ path: "src/a.ts" }],
          fileContexts: [{ path: "src/a.ts" }]
        }
      },
      submittedAt: "2026-02-16T00:00:00.000Z"
    });

    expect(prompt.user).toContain("## Context Provenance");
    expect(prompt.user).toContain("AUTO_MIRROR_JOBTYPE_CONFLICT");
    expect(prompt.user).toContain("\"contextSource\": \"mirror\"");
    expect(prompt.user).toContain("\"relevantFilesForConflict\": 1");
    expect(prompt.user).toContain("Do not modify non-relevant files unless explicit override in params.");
  });

  it("enforces insufficient-context template instructions", () => {
    const prompt = buildPromptTemplate({
      projectId: "proj",
      userId: "user",
      jobId: "job",
      laneId: "lane-1",
      type: "ConflictResolution",
      params: {
        conflictContext: {
          insufficientContext: true,
          insufficientReasons: ["missing:file_contexts"]
        }
      },
      submittedAt: "2026-02-16T00:00:00.000Z"
    });

    expect(prompt.user).toContain("InsufficientContext");
    expect(prompt.user).toContain("Patch must be empty when InsufficientContext=true.");
    expect(prompt.user).toContain("missing:file_contexts");
  });
});
