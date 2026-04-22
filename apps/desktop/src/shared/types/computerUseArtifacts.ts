export type ComputerUseArtifactKind =
  | "screenshot"
  | "video_recording"
  | "browser_trace"
  | "browser_verification"
  | "console_logs";

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

export type ComputerUseArtifactReviewState =
  | "pending"
  | "accepted"
  | "needs_more"
  | "dismissed";

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
  available: boolean;
  state?: "installed" | "missing";
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

export type ComputerUseOwnerSnapshot = {
  owner: ComputerUseArtifactOwner;
  backendStatus: ComputerUseBackendStatus;
  summary: string;
  activeBackend: {
    name: string;
    detail: string;
    source: "artifact" | "available";
  } | null;
  artifacts: ComputerUseArtifactView[];
  recentArtifacts: ComputerUseArtifactView[];
  activity: ComputerUseActivityItem[];
};

export type ComputerUseOwnerSnapshotArgs = {
  owner: ComputerUseArtifactOwner;
  limit?: number;
};

export type ComputerUseEventPayload = {
  type: "artifact-ingested" | "artifact-linked" | "artifact-reviewed";
  artifactId: string;
  at: string;
  owner?: ComputerUseArtifactOwner | null;
};
