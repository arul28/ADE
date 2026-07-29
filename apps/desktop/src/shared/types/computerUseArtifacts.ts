export type ComputerUseArtifactKind =
  | "screenshot"
  | "video_recording"
  | "browser_trace"
  | "browser_verification"
  | "console_logs";

export type ComputerUseArtifactOwnerKind =
  | "lane"
  | "chat_session"
  | "automation_run"
  | "github_pr"
  | "linear_issue";

export type ComputerUseArtifactLinkRelation =
  | "attached_to"
  | "produced_by"
  | "published_to";

export type ComputerUseBackendStyle =
  | "external_cli"
  | "manual"
  | "local_fallback";

export type ComputerUseBackendDescriptor = {
  name: string;
  style?: ComputerUseBackendStyle | null;
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
  /**
   * Lane the capture belongs to, resolved at ingest from the owning chat
   * session. Null for artifacts captured before the column existed, or for
   * captures with no lane-bound owner. Deleting a lane deletes its artifacts.
   *
   * Optional on the wire: a paired phone or web client can be talking to a host
   * that predates the column, and an absent value means "unknown", not "none".
   */
  laneId?: string | null;
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
  /**
   * Absolute directory the caller's relative `input.path` values are relative
   * to. Agents run inside lane worktrees, not the project root, so without this
   * a relative path resolves against the wrong tree and the capture is lost.
   */
  callerRoot?: string | null;
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

/**
 * Whether the bytes behind an artifact record can actually be shown.
 *
 * `unimported` is the historic failure mode: ingest persisted a raw relative
 * path instead of copying the file into `.ade/artifacts`, so the record exists
 * but never had bytes to serve. Kept as a distinct state from `missing_file` so
 * the UI can say what happened rather than "preview unavailable".
 */
export type ComputerUseArtifactAvailability =
  | "available"
  | "missing_file"
  | "unimported";

export type ComputerUseArtifactView = ComputerUseArtifactRecord & {
  links: ComputerUseArtifactLink[];
  reviewState: ComputerUseArtifactReviewState;
  workflowState: ComputerUseArtifactWorkflowState;
  reviewNote: string | null;
  /**
   * Absent when the payload came from a host that predates availability
   * reporting; treat that as `"available"` and let the preview read decide.
   */
  availability?: ComputerUseArtifactAvailability;
};

export type ComputerUseArtifactListArgs = {
  artifactId?: string | null;
  owner?: ComputerUseArtifactOwner;
  ownerKind?: ComputerUseArtifactOwnerKind;
  ownerId?: string | null;
  kind?: ComputerUseArtifactKind | null;
  limit?: number;
};

export type ComputerUseArtifactDeleteArgs = {
  artifactId?: string | null;
  artifactIds?: string[] | null;
};

export type ComputerUseArtifactDeleteOutcome = {
  artifactId: string;
  title: string;
  /** True when a file was actually unlinked from `.ade/artifacts`. */
  fileRemoved: boolean;
  /** Absolute path of the removed file, when one was resolvable. */
  path: string | null;
  freedBytes: number;
};

export type ComputerUseArtifactDeleteResult = {
  deleted: ComputerUseArtifactDeleteOutcome[];
  /** Ids with no matching row — delete is idempotent, these are not failures. */
  missing: string[];
  failed: Array<{ artifactId: string; reason: string }>;
  freedBytes: number;
};

export type ComputerUseArtifactBrokenRecord = {
  artifactId: string;
  title: string;
  kind: ComputerUseArtifactKind;
  uri: string;
  createdAt: string;
  /** Why the artifact cannot be rendered. */
  reason: "missing_file" | "outside_artifact_store";
  /** Lane the capture was recorded in, when known. */
  laneId: string | null;
  /** Absolute path this record still resolves to inside a surviving worktree. */
  recoverablePath: string | null;
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
    state?: "present" | "missing" | "blocked_by_capability";
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
  type: "artifact-ingested" | "artifact-linked" | "artifact-reviewed" | "artifact-deleted";
  artifactId: string;
  at: string;
  owner?: ComputerUseArtifactOwner | null;
};
