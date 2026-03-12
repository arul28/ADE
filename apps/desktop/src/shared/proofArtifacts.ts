import type { MissionArtifactType, ValidationEvidenceRequirement } from "./types/missions";
import type { MissionCloseoutRequirementKey, OrchestratorArtifactKind } from "./types/orchestrator";

type ArtifactMetadataLike = Record<string, unknown> | null | undefined;

const PROOF_ARTIFACT_KEYS = new Set<MissionCloseoutRequirementKey>([
  "screenshot",
  "browser_verification",
  "browser_trace",
  "video_recording",
  "console_logs",
]);

export const COMPUTER_USE_ARTIFACT_KINDS = [
  "screenshot",
  "browser_verification",
  "browser_trace",
  "video_recording",
  "console_logs",
] as const;

const CLOSEOUT_ARTIFACT_KEY_SET = new Set<MissionCloseoutRequirementKey>([
  "planning_document",
  "research_summary",
  "changed_files_summary",
  "test_report",
  "implementation_summary",
  "validation_verdict",
  "screenshot",
  "browser_verification",
  "browser_trace",
  "video_recording",
  "console_logs",
  "risk_notes",
  "pr_url",
  "proposal_url",
  "review_summary",
  "final_outcome_summary",
]);

const MISSION_ARTIFACT_TYPE_SET = new Set<MissionArtifactType>([
  "summary",
  "pr",
  "link",
  "note",
  "patch",
  "plan",
  "test_report",
  "screenshot",
  "browser_verification",
  "browser_trace",
  "video_recording",
  "console_logs",
]);

function normalizeArtifactToken(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function metadataCandidates(metadata: ArtifactMetadataLike): string[] {
  if (!metadata) return [];
  const fields = [
    "artifactKey",
    "requirementKey",
    "closeoutKey",
    "evidenceRequirement",
    "evidenceKey",
    "proofType",
    "proofKind",
    "artifactType",
    "type",
    "title",
  ];
  return fields
    .map((field) => metadata[field])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function canonicalizeProofArtifactKey(value: string | null | undefined): Extract<MissionArtifactType, "screenshot" | "browser_verification" | "browser_trace" | "video_recording" | "console_logs"> | null {
  const token = normalizeArtifactToken(value);
  if (!token) return null;
  if (
    token === "screenshot"
    || token === "screen_capture"
    || token === "screen_shot"
    || token.includes("screenshot")
    || token.includes("screen_capture")
  ) {
    return "screenshot";
  }
  if (
    token === "browser_verification"
    || token === "verification"
    || token === "browser_check"
    || token.includes("browser_verification")
    || token.includes("verification")
    || token.includes("verified")
  ) {
    return "browser_verification";
  }
  if (
    token === "browser_trace"
    || token === "trace"
    || token === "playwright_trace"
    || token.includes("browser_trace")
    || token.includes("playwright_trace")
    || token.endsWith("_trace")
  ) {
    return "browser_trace";
  }
  if (
    token === "video"
    || token === "video_recording"
    || token === "screen_recording"
    || token.includes("video_record")
    || token.includes("screen_record")
    || token.endsWith("_video")
  ) {
    return "video_recording";
  }
  if (
    token === "console_logs"
    || token === "console"
    || token === "logs"
    || token.includes("console_log")
    || token.includes("console")
  ) {
    return "console_logs";
  }
  return null;
}

export function normalizeComputerUseArtifactKind(
  value: string | null | undefined,
): Extract<MissionArtifactType, "screenshot" | "browser_verification" | "browser_trace" | "video_recording" | "console_logs"> | null {
  return canonicalizeProofArtifactKey(value);
}

function resolveMissionArtifactAlias(value: string | null | undefined): MissionArtifactType | null {
  const token = normalizeArtifactToken(value);
  if (!token) return null;
  const proofKey = canonicalizeProofArtifactKey(token);
  if (proofKey) return proofKey;
  if (token === "pull_request" || token === "pr_link") return "pr";
  if (token === "planning_document" || token === "mission_plan") return "plan";
  if (token === "test_results") return "test_report";
  if (MISSION_ARTIFACT_TYPE_SET.has(token as MissionArtifactType)) return token as MissionArtifactType;
  return null;
}

function resolveCloseoutAlias(value: string | null | undefined): MissionCloseoutRequirementKey | null {
  const token = normalizeArtifactToken(value);
  if (!token) return null;
  const proofKey = canonicalizeProofArtifactKey(token);
  if (proofKey) return proofKey;
  if (token === "plan" || token === "mission_plan") return "planning_document";
  if (token === "pr" || token === "pull_request") return "pr_url";
  if (token === "test_results") return "test_report";
  if (CLOSEOUT_ARTIFACT_KEY_SET.has(token as MissionCloseoutRequirementKey)) {
    return token as MissionCloseoutRequirementKey;
  }
  return null;
}

export function isProofEvidenceRequirement(
  value: MissionCloseoutRequirementKey | ValidationEvidenceRequirement | string | null | undefined,
): boolean {
  const key = resolveCloseoutAlias(value);
  return key != null && PROOF_ARTIFACT_KEYS.has(key);
}

export function normalizeMissionArtifactType(value: string): MissionArtifactType {
  return resolveMissionArtifactAlias(value) ?? "note";
}

export function resolveCloseoutRequirementKeyFromArtifact(args: {
  artifactType?: string | null;
  artifactKey?: string | null;
  kind?: string | null;
  metadata?: ArtifactMetadataLike;
}): MissionCloseoutRequirementKey | null {
  const candidates = [
    args.artifactType,
    args.artifactKey,
    args.kind,
    ...metadataCandidates(args.metadata),
  ];
  for (const candidate of candidates) {
    const resolved = resolveCloseoutAlias(candidate);
    if (resolved) return resolved;
  }
  return null;
}

export function resolveReportArtifactKey(args: {
  type?: string | null;
  title?: string | null;
  metadata?: ArtifactMetadataLike;
  index: number;
}): string {
  const candidates = [
    ...metadataCandidates(args.metadata),
    args.type,
    args.title,
  ];
  for (const candidate of candidates) {
    const proofKey = canonicalizeProofArtifactKey(candidate);
    if (proofKey) return proofKey;
    const missionType = resolveMissionArtifactAlias(candidate);
    if (missionType === "plan" || missionType === "summary" || missionType === "link" || missionType === "note" || missionType === "patch" || missionType === "pr" || missionType === "test_report") {
      return missionType === "pr" ? "implementation_pr" : missionType;
    }
    const closeoutKey = resolveCloseoutAlias(candidate);
    if (closeoutKey) return closeoutKey;
  }
  if (normalizeArtifactToken(args.type) === "branch") return "feature_branch";
  if (normalizeArtifactToken(args.type) === "pull_request") return "implementation_pr";
  const fallbackKey = `reported_artifact_${args.index + 1}`;
  const rawTitle = typeof args.title === "string" ? args.title.trim() : "";
  if (!rawTitle.length) return fallbackKey;
  return normalizeArtifactToken(rawTitle) || fallbackKey;
}

export function resolveReportArtifactMissionType(args: {
  type?: string | null;
  artifactKey?: string | null;
  metadata?: ArtifactMetadataLike;
}): MissionArtifactType | null {
  const candidates = [
    args.type,
    args.artifactKey,
    ...metadataCandidates(args.metadata),
  ];
  for (const candidate of candidates) {
    const missionType = resolveMissionArtifactAlias(candidate);
    if (missionType) return missionType;
  }
  return null;
}

export function resolveReportArtifactKind(args: {
  type?: string | null;
  artifactKey?: string | null;
  uri?: string | null;
  metadata?: ArtifactMetadataLike;
}): OrchestratorArtifactKind {
  const closeoutKey = resolveCloseoutRequirementKeyFromArtifact({
    artifactType: args.type,
    artifactKey: args.artifactKey,
    metadata: args.metadata,
  });
  if (closeoutKey === "screenshot") return "screenshot";
  if (closeoutKey === "video_recording") return "video";
  const rawType = normalizeArtifactToken(args.type);
  if (rawType === "branch") return "branch";
  if (rawType === "pr" || rawType === "pull_request") return "pr";
  if (rawType === "test_report" || rawType === "test_results") return "test_report";
  const uri = typeof args.uri === "string" ? args.uri.trim() : "";
  if (closeoutKey === "browser_trace" || closeoutKey === "browser_verification" || closeoutKey === "console_logs") {
    return uri.length > 0 ? "file" : "custom";
  }
  return uri.length > 0 ? "file" : "custom";
}

export function resolveOrchestratorArtifactUri(args: {
  kind: string;
  value: string;
  metadata?: ArtifactMetadataLike;
}): string | null {
  const value = args.value.trim();
  const metadataUri = typeof args.metadata?.uri === "string" ? args.metadata.uri.trim() : "";
  if (!value.length) return metadataUri.length > 0 ? metadataUri : null;
  if (
    args.kind === "file"
    || args.kind === "branch"
    || args.kind === "pr"
    || args.kind === "screenshot"
    || args.kind === "video"
  ) {
    return value;
  }
  return metadataUri.length > 0 ? metadataUri : null;
}
