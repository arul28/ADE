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

export type ComputerUseArtifactListArgs = {
  owner?: ComputerUseArtifactOwner;
  ownerKind?: ComputerUseArtifactOwnerKind;
  ownerId?: string | null;
  kind?: ComputerUseArtifactKind | null;
  limit?: number;
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
