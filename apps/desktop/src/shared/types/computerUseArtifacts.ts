import type { ExternalMcpConnectionState } from "./externalMcp";

export type ComputerUseArtifactKind =
  | "screenshot"
  | "video_recording"
  | "browser_trace"
  | "browser_verification"
  | "console_logs";

export type ComputerUseBackendStyle =
  | "external_mcp"
  | "external_cli"
  | "manual"
  | "local_fallback";

export type ComputerUseArtifactOwnerKind =
  | "lane"
  | "mission"
  | "orchestrator_run"
  | "orchestrator_step"
  | "orchestrator_attempt"
  | "chat_session"
  | "automation_run"
  | "github_pr"
  | "linear_issue";

export type ComputerUseArtifactLinkRelation =
  | "attached_to"
  | "produced_by"
  | "published_to";

export type ComputerUseBackendDescriptor = {
  style: ComputerUseBackendStyle;
  name: string;
  toolName?: string | null;
  command?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ComputerUseArtifactOwner = {
  kind: ComputerUseArtifactOwnerKind;
  id: string;
  relation?: ComputerUseArtifactLinkRelation;
  metadata?: Record<string, unknown> | null;
};

export type ComputerUseArtifactInput = {
  kind?: string | null;
  title?: string | null;
  description?: string | null;
  path?: string | null;
  uri?: string | null;
  text?: string | null;
  json?: unknown;
  mimeType?: string | null;
  rawType?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ComputerUseArtifactRecord = {
  id: string;
  kind: ComputerUseArtifactKind;
  backendStyle: ComputerUseBackendStyle;
  backendName: string;
  sourceToolName: string | null;
  originalType: string | null;
  title: string;
  description: string | null;
  uri: string;
  storageKind: "file" | "url";
  mimeType: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ComputerUseArtifactLink = {
  id: string;
  artifactId: string;
  ownerKind: ComputerUseArtifactOwnerKind;
  ownerId: string;
  relation: ComputerUseArtifactLinkRelation;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type ComputerUseArtifactIngestionRequest = {
  backend: ComputerUseBackendDescriptor;
  inputs: ComputerUseArtifactInput[];
  owners?: ComputerUseArtifactOwner[];
};

export type ComputerUseArtifactIngestionResult = {
  artifacts: ComputerUseArtifactRecord[];
  links: ComputerUseArtifactLink[];
};

export type ComputerUsePolicyMode = "off" | "auto" | "enabled";

export type ComputerUsePolicy = {
  mode: ComputerUsePolicyMode;
  allowLocalFallback: boolean;
  retainArtifacts: boolean;
  preferredBackend: string | null;
};

export type ComputerUseArtifactReviewState =
  | "pending"
  | "accepted"
  | "needs_more"
  | "dismissed";

export type GhostDoctorProcessHealth = {
  state: "healthy" | "stale" | "unknown";
  processCount: number | null;
  detail: string;
};

export type ComputerUseArtifactWorkflowState =
  | "evidence_only"
  | "promoted"
  | "published"
  | "dismissed";

export type ComputerUseArtifactView = ComputerUseArtifactRecord & {
  links: ComputerUseArtifactLink[];
  reviewState: ComputerUseArtifactReviewState;
  workflowState: ComputerUseArtifactWorkflowState;
  reviewNote: string | null;
};

export type ComputerUseArtifactListArgs = {
  artifactId?: string | null;
  owner?: ComputerUseArtifactOwner;
  ownerKind?: ComputerUseArtifactOwnerKind;
  ownerId?: string | null;
  kind?: ComputerUseArtifactKind | null;
  limit?: number;
};

export type ComputerUseArtifactRouteArgs = {
  artifactId: string;
  owner: ComputerUseArtifactOwner;
};

export type ComputerUseArtifactReviewArgs = {
  artifactId: string;
  reviewState?: ComputerUseArtifactReviewState | null;
  workflowState?: ComputerUseArtifactWorkflowState | null;
  reviewNote?: string | null;
};

export type ComputerUseExternalBackendStatus = {
  name: string;
  style: Extract<ComputerUseBackendStyle, "external_mcp" | "external_cli">;
  available: boolean;
  state?: ExternalMcpConnectionState | "installed" | "missing";
  detail: string;
  supportedKinds: ComputerUseArtifactKind[];
};

export type ComputerUseBackendStatus = {
  backends: ComputerUseExternalBackendStatus[];
  localFallback: {
    available: boolean;
    detail: string;
    supportedKinds: ComputerUseArtifactKind[];
  };
};

export type ComputerUseCapabilityMatrixRow = {
  kind: ComputerUseArtifactKind;
  externalBackends: string[];
  localFallbackAvailable: boolean;
};

export type ComputerUseSettingsSnapshot = {
  backendStatus: ComputerUseBackendStatus;
  preferredBackend: string | null;
  capabilityMatrix: ComputerUseCapabilityMatrixRow[];
  ghostOsCheck: {
    repoUrl: string;
    cliInstalled: boolean;
    setupState: "ready" | "needs_setup" | "not_installed" | "unknown";
    adeConfigured: boolean;
    adeConnected: boolean;
    processHealth?: GhostDoctorProcessHealth;
    summary: string;
    details: string[];
  };
  guidance: {
    overview: string;
    ghostOs: string;
    agentBrowser: string;
    fallback: string;
  };
};

export type ComputerUseActivityItem = {
  id: string;
  at: string;
  kind:
    | "artifact_ingested"
    | "linked"
    | "reviewed"
    | "proof_missing"
    | "backend_tool_used"
    | "backend_connected"
    | "backend_available"
    | "backend_unavailable";
  title: string;
  detail: string;
  artifactId?: string | null;
  backendName?: string | null;
  severity: "info" | "warning" | "success";
};

export type ComputerUseProofCoverage = {
  requiredKinds: ComputerUseArtifactKind[];
  presentKinds: ComputerUseArtifactKind[];
  missingKinds: ComputerUseArtifactKind[];
};

export type ComputerUseOwnerSnapshot = {
  owner: ComputerUseArtifactOwner;
  policy: ComputerUsePolicy | null;
  backendStatus: ComputerUseBackendStatus;
  summary: string;
  activeBackend: {
    name: string;
    style: ComputerUseBackendStyle;
    detail: string;
    source: "artifact" | "policy" | "available";
  } | null;
  artifacts: ComputerUseArtifactView[];
  recentArtifacts: ComputerUseArtifactView[];
  activity: ComputerUseActivityItem[];
  proofCoverage: ComputerUseProofCoverage;
  usingLocalFallback: boolean;
};

export type ComputerUseOwnerSnapshotArgs = {
  owner: ComputerUseArtifactOwner;
  policy?: ComputerUsePolicy | null;
  requiredKinds?: ComputerUseArtifactKind[];
  limit?: number;
};

export type ComputerUseEventPayload = {
  type: "artifact-ingested" | "artifact-linked" | "artifact-reviewed";
  artifactId: string;
  at: string;
  owner?: ComputerUseArtifactOwner | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeComputerUsePolicy(value: unknown, fallback: Partial<ComputerUsePolicy> = {}): ComputerUsePolicy {
  const record = isRecord(value) ? value : {};
  const mode = record.mode === "off" || record.mode === "enabled" ? record.mode : "auto";
  const allowLocalFallback = typeof record.allowLocalFallback === "boolean"
    ? record.allowLocalFallback
    : fallback.allowLocalFallback ?? true;
  const retainArtifacts = typeof record.retainArtifacts === "boolean"
    ? record.retainArtifacts
    : fallback.retainArtifacts ?? true;
  return {
    mode: (fallback.mode === "off" || fallback.mode === "enabled" ? fallback.mode : mode) ?? "auto",
    allowLocalFallback,
    retainArtifacts,
    preferredBackend: toOptionalString(record.preferredBackend) ?? fallback.preferredBackend ?? null,
  };
}

export function createDefaultComputerUsePolicy(overrides: Partial<ComputerUsePolicy> = {}): ComputerUsePolicy {
  return normalizeComputerUsePolicy(overrides, {
    mode: overrides.mode ?? "auto",
    allowLocalFallback: overrides.allowLocalFallback ?? true,
    retainArtifacts: overrides.retainArtifacts ?? true,
    preferredBackend: overrides.preferredBackend ?? null,
  });
}

export function isComputerUseModeEnabled(mode: ComputerUsePolicyMode | null | undefined): boolean {
  return mode === "auto" || mode === "enabled";
}
