import { describe, expect, it } from "vitest";
import {
  PROOF_ARTIFACT_KINDS,
  isProofEvidenceRequirement,
  normalizeMissionArtifactType,
  normalizeProofArtifactKind,
  resolveCloseoutRequirementKeyFromArtifact,
  resolveOrchestratorArtifactUri,
  resolveReportArtifactKey,
  resolveReportArtifactKind,
  resolveReportArtifactMissionType,
} from "./proofArtifacts";

describe("PROOF_ARTIFACT_KINDS", () => {
  it("contains exactly the five canonical proof keys in canonical order", () => {
    expect(PROOF_ARTIFACT_KINDS).toEqual([
      "screenshot",
      "browser_verification",
      "browser_trace",
      "video_recording",
      "console_logs",
    ]);
  });
});

describe("normalizeProofArtifactKind", () => {
  it("returns null for null, undefined, non-string, or whitespace-only inputs", () => {
    expect(normalizeProofArtifactKind(null)).toBeNull();
    expect(normalizeProofArtifactKind(undefined)).toBeNull();
    expect(normalizeProofArtifactKind("")).toBeNull();
    expect(normalizeProofArtifactKind("   ")).toBeNull();
  });

  it("maps noisy screenshot aliases to 'screenshot'", () => {
    expect(normalizeProofArtifactKind("Screenshot")).toBe("screenshot");
    expect(normalizeProofArtifactKind("screen_capture")).toBe("screenshot");
    expect(normalizeProofArtifactKind("screen_shot")).toBe("screenshot");
    expect(normalizeProofArtifactKind("Full Screenshot of page")).toBe("screenshot");
  });

  it("maps browser verification aliases", () => {
    expect(normalizeProofArtifactKind("browser_verification")).toBe("browser_verification");
    expect(normalizeProofArtifactKind("verification")).toBe("browser_verification");
    expect(normalizeProofArtifactKind("browser_check")).toBe("browser_verification");
    expect(normalizeProofArtifactKind("verified by browser")).toBe("browser_verification");
  });

  it("maps browser trace aliases", () => {
    expect(normalizeProofArtifactKind("browser_trace")).toBe("browser_trace");
    expect(normalizeProofArtifactKind("trace")).toBe("browser_trace");
    expect(normalizeProofArtifactKind("playwright_trace")).toBe("browser_trace");
    expect(normalizeProofArtifactKind("Chromium trace")).toBe("browser_trace");
  });

  it("maps video recording aliases", () => {
    expect(normalizeProofArtifactKind("video")).toBe("video_recording");
    expect(normalizeProofArtifactKind("video_recording")).toBe("video_recording");
    expect(normalizeProofArtifactKind("screen_recording")).toBe("video_recording");
    expect(normalizeProofArtifactKind("Session Video Recording")).toBe("video_recording");
  });

  it("maps console log aliases", () => {
    expect(normalizeProofArtifactKind("console_logs")).toBe("console_logs");
    expect(normalizeProofArtifactKind("console")).toBe("console_logs");
    expect(normalizeProofArtifactKind("logs")).toBe("console_logs");
    expect(normalizeProofArtifactKind("Console Log output")).toBe("console_logs");
  });

  it("returns null for unrelated strings", () => {
    expect(normalizeProofArtifactKind("random")).toBeNull();
    expect(normalizeProofArtifactKind("pull_request")).toBeNull();
  });
});

describe("isProofEvidenceRequirement", () => {
  it("returns true for the five canonical proof keys", () => {
    expect(isProofEvidenceRequirement("screenshot")).toBe(true);
    expect(isProofEvidenceRequirement("browser_verification")).toBe(true);
    expect(isProofEvidenceRequirement("browser_trace")).toBe(true);
    expect(isProofEvidenceRequirement("video_recording")).toBe(true);
    expect(isProofEvidenceRequirement("console_logs")).toBe(true);
  });

  it("returns true for noisy aliases that resolve to a proof key", () => {
    expect(isProofEvidenceRequirement("Screen Capture")).toBe(true);
    expect(isProofEvidenceRequirement("playwright_trace")).toBe(true);
    expect(isProofEvidenceRequirement("screen_recording")).toBe(true);
    expect(isProofEvidenceRequirement("console")).toBe(true);
  });

  it("returns false for other valid closeout keys that aren't proof evidence", () => {
    expect(isProofEvidenceRequirement("planning_document")).toBe(false);
    expect(isProofEvidenceRequirement("test_report")).toBe(false);
    expect(isProofEvidenceRequirement("pr_url")).toBe(false);
    expect(isProofEvidenceRequirement("risk_notes")).toBe(false);
  });

  it("returns false for empty, null, and unrecognized values", () => {
    expect(isProofEvidenceRequirement(null)).toBe(false);
    expect(isProofEvidenceRequirement(undefined)).toBe(false);
    expect(isProofEvidenceRequirement("")).toBe(false);
    expect(isProofEvidenceRequirement("wat")).toBe(false);
  });
});

describe("normalizeMissionArtifactType", () => {
  it("passes through canonical mission artifact types", () => {
    expect(normalizeMissionArtifactType("summary")).toBe("summary");
    expect(normalizeMissionArtifactType("pr")).toBe("pr");
    expect(normalizeMissionArtifactType("link")).toBe("link");
    expect(normalizeMissionArtifactType("note")).toBe("note");
    expect(normalizeMissionArtifactType("patch")).toBe("patch");
    expect(normalizeMissionArtifactType("plan")).toBe("plan");
    expect(normalizeMissionArtifactType("test_report")).toBe("test_report");
    expect(normalizeMissionArtifactType("screenshot")).toBe("screenshot");
  });

  it("maps aliases to canonical mission artifact types", () => {
    expect(normalizeMissionArtifactType("pull_request")).toBe("pr");
    expect(normalizeMissionArtifactType("pr_link")).toBe("pr");
    expect(normalizeMissionArtifactType("planning_document")).toBe("plan");
    expect(normalizeMissionArtifactType("mission_plan")).toBe("plan");
    expect(normalizeMissionArtifactType("test_results")).toBe("test_report");
  });

  it("canonicalizes noisy proof aliases", () => {
    expect(normalizeMissionArtifactType("Screen Capture")).toBe("screenshot");
    expect(normalizeMissionArtifactType("playwright_trace")).toBe("browser_trace");
  });

  it("defaults to 'note' for unrecognized input", () => {
    expect(normalizeMissionArtifactType("")).toBe("note");
    expect(normalizeMissionArtifactType("totally-unknown")).toBe("note");
    expect(normalizeMissionArtifactType("checkpoint")).toBe("note");
  });
});

describe("resolveCloseoutRequirementKeyFromArtifact", () => {
  it("returns the direct closeout key for canonical artifactType", () => {
    expect(
      resolveCloseoutRequirementKeyFromArtifact({ artifactType: "planning_document" }),
    ).toBe("planning_document");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({ artifactType: "risk_notes" }),
    ).toBe("risk_notes");
  });

  it("prefers artifactType, then artifactKey, then kind, then metadata fields", () => {
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        artifactType: "planning_document",
        artifactKey: "test_report",
      }),
    ).toBe("planning_document");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        artifactType: null,
        artifactKey: "test_report",
      }),
    ).toBe("test_report");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        artifactType: null,
        artifactKey: null,
        kind: "screenshot",
      }),
    ).toBe("screenshot");
  });

  it("resolves from each metadata candidate field in order", () => {
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        metadata: { artifactKey: "browser_trace" },
      }),
    ).toBe("browser_trace");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        metadata: { requirementKey: "implementation_summary" },
      }),
    ).toBe("implementation_summary");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        metadata: { closeoutKey: "review_summary" },
      }),
    ).toBe("review_summary");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        metadata: { evidenceRequirement: "video_recording" },
      }),
    ).toBe("video_recording");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        metadata: { evidenceKey: "console_logs" },
      }),
    ).toBe("console_logs");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        metadata: { proofType: "screen_capture" },
      }),
    ).toBe("screenshot");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        metadata: { proofKind: "verification" },
      }),
    ).toBe("browser_verification");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        metadata: { artifactType: "pr_url" },
      }),
    ).toBe("pr_url");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        metadata: { type: "final_outcome_summary" },
      }),
    ).toBe("final_outcome_summary");
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        metadata: { title: "planning_document" },
      }),
    ).toBe("planning_document");
  });

  it("maps plan->planning_document and pr->pr_url aliases", () => {
    expect(resolveCloseoutRequirementKeyFromArtifact({ artifactType: "plan" })).toBe("planning_document");
    expect(resolveCloseoutRequirementKeyFromArtifact({ artifactType: "mission_plan" })).toBe("planning_document");
    expect(resolveCloseoutRequirementKeyFromArtifact({ artifactType: "pr" })).toBe("pr_url");
    expect(resolveCloseoutRequirementKeyFromArtifact({ artifactType: "pull_request" })).toBe("pr_url");
    expect(resolveCloseoutRequirementKeyFromArtifact({ artifactType: "test_results" })).toBe("test_report");
  });

  it("returns null when nothing resolves", () => {
    expect(resolveCloseoutRequirementKeyFromArtifact({})).toBeNull();
    expect(resolveCloseoutRequirementKeyFromArtifact({ artifactType: null, kind: null })).toBeNull();
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        artifactType: "not_a_real_key",
        metadata: { title: "also nonsense" },
      }),
    ).toBeNull();
  });

  it("ignores non-string metadata fields", () => {
    expect(
      resolveCloseoutRequirementKeyFromArtifact({
        metadata: { artifactKey: 42, requirementKey: "risk_notes" } as Record<string, unknown>,
      }),
    ).toBe("risk_notes");
  });
});

describe("resolveReportArtifactKey", () => {
  it("prioritizes a canonical proof key from metadata", () => {
    expect(
      resolveReportArtifactKey({
        type: "pr",
        title: "some title",
        metadata: { proofKind: "screen_capture" },
        index: 0,
      }),
    ).toBe("screenshot");
  });

  it("returns a mission artifact type when one resolves", () => {
    expect(resolveReportArtifactKey({ type: "plan", index: 0 })).toBe("plan");
    expect(resolveReportArtifactKey({ type: "summary", index: 0 })).toBe("summary");
    expect(resolveReportArtifactKey({ type: "link", index: 0 })).toBe("link");
    expect(resolveReportArtifactKey({ type: "note", index: 0 })).toBe("note");
    expect(resolveReportArtifactKey({ type: "patch", index: 0 })).toBe("patch");
    expect(resolveReportArtifactKey({ type: "test_report", index: 0 })).toBe("test_report");
  });

  it("maps mission type 'pr' to 'implementation_pr'", () => {
    expect(resolveReportArtifactKey({ type: "pr", index: 0 })).toBe("implementation_pr");
    expect(resolveReportArtifactKey({ type: "pull_request", index: 0 })).toBe("implementation_pr");
  });

  it("falls back to a closeout key when mission type doesn't match one of the explicit ones", () => {
    expect(resolveReportArtifactKey({ type: "risk_notes", index: 0 })).toBe("risk_notes");
    expect(resolveReportArtifactKey({ type: "review_summary", index: 0 })).toBe("review_summary");
  });

  it("maps bare type 'branch' to 'feature_branch'", () => {
    expect(resolveReportArtifactKey({ type: "branch", index: 0 })).toBe("feature_branch");
  });

  it("produces reported_artifact_{index+1} fallback when nothing else resolves and no title", () => {
    expect(resolveReportArtifactKey({ type: "unknown-thing", index: 0 })).toBe("reported_artifact_1");
    expect(resolveReportArtifactKey({ type: null, index: 4 })).toBe("reported_artifact_5");
  });

  it("normalizes a non-matching title into snake-case as last resort", () => {
    expect(resolveReportArtifactKey({ type: null, title: "My Cool Artifact!!", index: 0 })).toBe("my_cool_artifact");
  });

  it("falls back to reported_artifact_{index+1} when title is only punctuation", () => {
    expect(resolveReportArtifactKey({ type: null, title: "!!!", index: 2 })).toBe("reported_artifact_3");
  });
});

describe("resolveReportArtifactMissionType", () => {
  it("returns a mission alias for a canonical type", () => {
    expect(resolveReportArtifactMissionType({ type: "plan" })).toBe("plan");
    expect(resolveReportArtifactMissionType({ type: "pr" })).toBe("pr");
  });

  it("resolves via aliases", () => {
    expect(resolveReportArtifactMissionType({ type: "pull_request" })).toBe("pr");
    expect(resolveReportArtifactMissionType({ type: "planning_document" })).toBe("plan");
    expect(resolveReportArtifactMissionType({ type: "test_results" })).toBe("test_report");
    expect(resolveReportArtifactMissionType({ type: "Screen Capture" })).toBe("screenshot");
  });

  it("prefers type, then artifactKey, then metadata candidates", () => {
    expect(
      resolveReportArtifactMissionType({ type: "plan", artifactKey: "note" }),
    ).toBe("plan");
    expect(
      resolveReportArtifactMissionType({ type: null, artifactKey: "note" }),
    ).toBe("note");
    expect(
      resolveReportArtifactMissionType({
        type: null,
        artifactKey: null,
        metadata: { proofKind: "playwright_trace" },
      }),
    ).toBe("browser_trace");
  });

  it("returns null when nothing matches", () => {
    expect(resolveReportArtifactMissionType({ type: "unknown" })).toBeNull();
    expect(resolveReportArtifactMissionType({})).toBeNull();
    // 'implementation_summary' is a closeout key but not a mission alias
    expect(resolveReportArtifactMissionType({ type: "implementation_summary" })).toBeNull();
  });
});

describe("resolveReportArtifactKind", () => {
  it("returns 'screenshot' when the closeout key resolves to screenshot", () => {
    expect(resolveReportArtifactKind({ type: "screenshot" })).toBe("screenshot");
    expect(resolveReportArtifactKind({ type: null, artifactKey: "screen_capture" })).toBe("screenshot");
  });

  it("returns 'video' for video_recording closeouts", () => {
    expect(resolveReportArtifactKind({ type: "video_recording" })).toBe("video");
    expect(resolveReportArtifactKind({ type: null, artifactKey: "screen_recording" })).toBe("video");
  });

  it("returns 'branch' for bare type 'branch'", () => {
    expect(resolveReportArtifactKind({ type: "branch" })).toBe("branch");
  });

  it("returns 'pr' for bare type 'pr' or 'pull_request'", () => {
    expect(resolveReportArtifactKind({ type: "pr" })).toBe("pr");
    expect(resolveReportArtifactKind({ type: "pull_request" })).toBe("pr");
  });

  it("returns 'test_report' for test_report / test_results", () => {
    expect(resolveReportArtifactKind({ type: "test_report" })).toBe("test_report");
    expect(resolveReportArtifactKind({ type: "test_results" })).toBe("test_report");
  });

  it("returns 'file' for browser_trace/browser_verification/console_logs when a uri is present, else 'custom'", () => {
    expect(
      resolveReportArtifactKind({ type: "browser_trace", uri: "file:///tmp/trace.zip" }),
    ).toBe("file");
    expect(resolveReportArtifactKind({ type: "browser_trace", uri: null })).toBe("custom");

    expect(
      resolveReportArtifactKind({ type: "browser_verification", uri: "https://example.com/report" }),
    ).toBe("file");
    expect(resolveReportArtifactKind({ type: "browser_verification" })).toBe("custom");

    expect(
      resolveReportArtifactKind({ type: "console_logs", uri: "file:///tmp/console.log" }),
    ).toBe("file");
    expect(resolveReportArtifactKind({ type: "console_logs", uri: "   " })).toBe("custom");
  });

  it("returns 'file' when uri is present and falls through to the default branch, else 'custom'", () => {
    expect(resolveReportArtifactKind({ type: "note", uri: "file:///tmp/foo.txt" })).toBe("file");
    expect(resolveReportArtifactKind({ type: "note" })).toBe("custom");
    expect(resolveReportArtifactKind({ type: null })).toBe("custom");
    expect(resolveReportArtifactKind({ type: null, uri: "" })).toBe("custom");
  });
});

describe("resolveOrchestratorArtifactUri", () => {
  it("returns the trimmed value for file/branch/pr/screenshot/video kinds", () => {
    expect(resolveOrchestratorArtifactUri({ kind: "file", value: "file:///tmp/a" })).toBe("file:///tmp/a");
    expect(resolveOrchestratorArtifactUri({ kind: "branch", value: "feature/x" })).toBe("feature/x");
    expect(resolveOrchestratorArtifactUri({ kind: "pr", value: "https://github.com/owner/repo/pull/1" })).toBe(
      "https://github.com/owner/repo/pull/1",
    );
    expect(resolveOrchestratorArtifactUri({ kind: "screenshot", value: "file:///tmp/s.png" })).toBe(
      "file:///tmp/s.png",
    );
    expect(resolveOrchestratorArtifactUri({ kind: "video", value: "file:///tmp/v.mp4" })).toBe("file:///tmp/v.mp4");
  });

  it("falls back to metadata.uri when value is empty/whitespace", () => {
    expect(
      resolveOrchestratorArtifactUri({
        kind: "file",
        value: "   ",
        metadata: { uri: "file:///fallback" },
      }),
    ).toBe("file:///fallback");
  });

  it("returns null when value is empty and metadata.uri is missing or empty", () => {
    expect(resolveOrchestratorArtifactUri({ kind: "file", value: "" })).toBeNull();
    expect(
      resolveOrchestratorArtifactUri({ kind: "file", value: "", metadata: { uri: "   " } }),
    ).toBeNull();
    expect(
      resolveOrchestratorArtifactUri({ kind: "file", value: "", metadata: { uri: 5 } as Record<string, unknown> }),
    ).toBeNull();
  });

  it("returns metadata.uri for non-uri-bearing kinds like 'custom' or 'test_report'", () => {
    expect(
      resolveOrchestratorArtifactUri({
        kind: "custom",
        value: "some-identifier",
        metadata: { uri: "file:///from-meta" },
      }),
    ).toBe("file:///from-meta");
    expect(
      resolveOrchestratorArtifactUri({ kind: "custom", value: "some-identifier" }),
    ).toBeNull();
    expect(
      resolveOrchestratorArtifactUri({
        kind: "test_report",
        value: "tests",
        metadata: { uri: "file:///report.html" },
      }),
    ).toBe("file:///report.html");
    expect(resolveOrchestratorArtifactUri({ kind: "test_report", value: "tests" })).toBeNull();
  });
});
