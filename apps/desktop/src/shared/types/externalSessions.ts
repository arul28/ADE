export type ExternalSessionProvider = "claude" | "codex" | "cursor" | "droid" | "opencode";

export interface ExternalSessionCapabilities {
  resumeInPlace: boolean;
  resumeInDifferentCwd: boolean;
  fork: boolean;
  forkIntoDifferentCwd: boolean;
  importToChat: boolean;
}

export interface ExternalSessionSummary {
  provider: ExternalSessionProvider;
  id: string;
  cwd: string | null;
  title: string | null;
  preview: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount: number | null;
  alreadyImported: boolean;
  importedSessionRef?: { kind: "chat" | "cli"; sessionId: string } | null;
  possiblyActive: boolean;
  cwdMatchesRequestedLane: boolean | null;
  capabilities: ExternalSessionCapabilities;
}

export interface ExternalSessionListArgs {
  providers?: ExternalSessionProvider[];
  laneId?: string | null;
  cwd?: string | null;
  scope?: "project" | "all";
  limit?: number;
}

export interface ExternalSessionImportArgs {
  provider: ExternalSessionProvider;
  sessionId: string;
  laneId: string;
  target: "cli" | "chat";
  mode: "resume" | "fork";
  model?: string;
  permissionMode?: string;
}

export type ExternalSessionImportResult =
  | { kind: "cli"; sessionId: string; ptyId: string; laneId: string }
  | { kind: "chat"; chatSessionId: string; laneId: string };
