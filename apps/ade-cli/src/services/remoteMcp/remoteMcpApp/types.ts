/** The result shapes the views read, as `remoteMcpTools.ts` and `remoteMcpProtocol.ts` document them. */
import type { ChatInboxItem, ChatInboxQuestion } from "../../../cliChatInbox";
import type { AgentChatTranscriptEntry } from "../../../../../desktop/src/shared/types/chat";
import type { BranchDiffChanges, DiffChanges, FileChange, FilePatch } from "../../../../../desktop/src/shared/types/git";
import type { LaneStatus, LaneSummary } from "../../../../../desktop/src/shared/types/lanes";
import type { PrCheck, PrDetail, PrSummary } from "../../../../../desktop/src/shared/types/prs";
import type { ProviderColorPair } from "../../../../../desktop/src/shared/providerColors";
import type { UsageLimitsAccount, UsageLimitsReport } from "../../../../../desktop/src/shared/usageLimitsReport";

export type {
  AgentChatTranscriptEntry, BranchDiffChanges, ChatInboxQuestion, DiffChanges, FileChange, FilePatch, PrDetail,
  UsageLimitsAccount, UsageLimitsReport,
};

export type Json = Record<string, unknown>;

/** What `remoteMcpApps.ts` writes into `<script id="ade-app-data">`. */
export type AppBootData = {
  /** `PROVIDER_COLOR_TABLE.usage` and `.usageFallback` (desktop/src/shared/providerColors.ts). */
  providerColors: Record<string, ProviderColorPair>;
  providerColorFallback: readonly ProviderColorPair[];
  /** Provider id → the name a person reads. */
  providerLabels: Record<string, string>;
};

type ProjectRef = { id: string; name: string; path?: string };
export type MachineRef = { key: string; name: string };
/** A typed tool's structuredContent; `machine` when another computer answered. */
export type Envelope = { project: ProjectRef | null; result: unknown; next?: string; machine?: MachineRef; view?: string };
/** `machine: "all"`: one row per computer; `result` is that computer's Envelope. */
export type FanOutRow = { machine: MachineRef; ok: boolean; result?: Envelope; error?: string };
export type MachineRow = {
  name: string; key: string; online: boolean | null; included: boolean; serving: boolean; supported: boolean; isThisMachine: boolean;
};
export type ChatRow = {
  sessionId: string; laneId?: string | null; title?: string | null; provider?: string; model?: string | null;
  status?: string; lastActivityAt?: string | null; currentTurnStartedAt?: string | null; lastOutputPreview?: string | null;
};
export type PrRow = Pick<PrSummary, "githubPrNumber" | "githubUrl" | "title" | "state" | "checksStatus" | "reviewStatus" | "updatedAt" | "createdAt">;
export type LaneRow = Pick<LaneSummary, "id" | "name" | "laneType" | "baseRef" | "branchRef" | "archivedAt"> & { status?: Partial<LaneStatus> };
/** `pr_get_checks` (adeRpcServer.ts): each check as `mapCheckToSummary` writes it. */
export type CheckRow = Pick<PrCheck, "name" | "status" | "conclusion"> & { url: string | null };
export type ChecksResult = {
  prId: string;
  checksStatus: string;
  checksCounts: { passing: number; failing: number; pending: number; total: number };
  checks: CheckRow[];
};
export type TranscriptRead = { sessionId: string; entries: AgentChatTranscriptEntry[]; truncated: boolean; totalEntries: number };
export type InboxItem = Omit<ChatInboxItem, "respond"> & { project?: { id: string; name: string } };
export type RespondResult = { sessionId: string | null; requestId: string | null; decision: string | null; kind?: string; title?: string; link: string | null };
export type SendResult = { sessionId: string | null; delivery: string | null; routedAction: string | null; link: string | null };
export type StartResult = {
  sessionId: string | null; laneId: string | null; lane: string | null; title: string | null; phase: string | null; error?: string; link: string | null;
};

export type ToolResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
export type HostContext = {
  theme?: string;
  styles?: { variables?: Record<string, unknown>; css?: { fonts?: unknown } };
  containerDimensions?: { height?: unknown; maxHeight?: unknown };
  toolInfo?: { tool?: { name?: unknown } };
};
export type RpcMessage = {
  jsonrpc?: unknown; id?: number | string | null; method?: unknown; params?: Json; result?: unknown; error?: { message?: string };
};
/** The project and computer a view's own calls go to. */
export type Scope = { projectId: string | null; projectName: string | null; projectPath: string | null; machineKey: string | null; machineName: string | null };
export type Shown = { tool: string | null; args: Json; result: ToolResult | null; title: string | null };
