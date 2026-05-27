type ArtifactMetadataLike = Record<string, unknown> | null | undefined;

export const COMPUTER_USE_ARTIFACT_KINDS = [
  "screenshot",
  "browser_verification",
  "browser_trace",
  "video_recording",
  "console_logs",
] as const;

export type ComputerUseProofArtifactKind = (typeof COMPUTER_USE_ARTIFACT_KINDS)[number];

export type ReportArtifactKey =
  | "planning_document"
  | "research_summary"
  | "changed_files_summary"
  | "test_report"
  | "implementation_summary"
  | "validation_verdict"
  | "screenshot"
  | "browser_verification"
  | "browser_trace"
  | "video_recording"
  | "console_logs"
  | "risk_notes"
  | "pr_url"
  | "proposal_url"
  | "review_summary"
  | "final_outcome_summary"
  | "summary"
  | "link"
  | "note"
  | "patch"
  | "plan"
  | "implementation_pr"
  | "feature_branch";

const PROOF_ARTIFACT_KEYS = new Set<ComputerUseProofArtifactKind>(COMPUTER_USE_ARTIFACT_KINDS);

const REPORT_ARTIFACT_KEY_SET = new Set<ReportArtifactKey>([
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
  "summary",
  "link",
  "note",
  "patch",
  "plan",
  "implementation_pr",
  "feature_branch",
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

function canonicalizeProofArtifactKey(value: string | null | undefined): ComputerUseProofArtifactKind | null {
  const token = normalizeArtifactToken(value);
  if (!token) return null;
  if (token.includes("screenshot") || token.includes("screen_capture") || token === "screen_shot") {
    return "screenshot";
  }
  if (
    token.includes("browser_verification") ||
    token === "browser_check" ||
    token === "browser_verified" ||
    token.includes("playwright_verification") ||
    token === "web_verification"
  ) {
    return "browser_verification";
  }
  if (
    token.includes("browser_trace") ||
    token.includes("playwright_trace")
  ) {
    return "browser_trace";
  }
  if (token.includes("video_record") || token.includes("screen_record") || token === "video" || token.endsWith("_video")) {
    return "video_recording";
  }
  if (token.includes("console_logs") || token === "console_log" || token.includes("browser_console")) {
    return "console_logs";
  }
  return null;
}

export function normalizeComputerUseArtifactKind(
  value: string | null | undefined,
): ComputerUseProofArtifactKind | null {
  return canonicalizeProofArtifactKey(value);
}

function resolveReportArtifactAlias(value: string | null | undefined): ReportArtifactKey | null {
  const token = normalizeArtifactToken(value);
  if (!token) return null;
  const proofKey = canonicalizeProofArtifactKey(token);
  if (proofKey) return proofKey;
  if (token === "pull_request" || token === "pr" || token === "pr_link") return "implementation_pr";
  if (token === "test_results") return "test_report";
  if (token === "branch") return "feature_branch";
  if (REPORT_ARTIFACT_KEY_SET.has(token as ReportArtifactKey)) return token as ReportArtifactKey;
  return null;
}

export function isProofEvidenceRequirement(
  value: string | null | undefined,
): boolean {
  const key = resolveReportArtifactAlias(value);
  return key != null && PROOF_ARTIFACT_KEYS.has(key as ComputerUseProofArtifactKind);
}

export function resolveCloseoutRequirementKeyFromArtifact(args: {
  artifactType?: string | null;
  artifactKey?: string | null;
  kind?: string | null;
  metadata?: ArtifactMetadataLike;
}): ReportArtifactKey | null {
  const candidates = [
    args.artifactType,
    args.artifactKey,
    args.kind,
    ...metadataCandidates(args.metadata),
  ];
  for (const candidate of candidates) {
    const resolved = resolveReportArtifactAlias(candidate);
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
    const artifactKey = resolveReportArtifactAlias(candidate);
    if (artifactKey) return artifactKey;
  }
  const fallbackKey = `reported_artifact_${args.index + 1}`;
  const rawTitle = typeof args.title === "string" ? args.title.trim() : "";
  if (!rawTitle.length) return fallbackKey;
  return normalizeArtifactToken(rawTitle) || fallbackKey;
}
