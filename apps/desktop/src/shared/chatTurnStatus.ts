import { annotateSubagentTree } from "./chatSubagentTree";
import { resourceLinkCopyPaths } from "./claudeAgentSdkFields";
import type { AgentChatResourceLink } from "./types/chat";

export type ChatTurnStatusPhase = "running" | "blocked" | "idle";

export type ChatTurnStatusTool = {
  name: string;
  detail?: string;
};

export type ChatTurnStatusAsk = {
  title: string;
  description?: string;
  stranded: boolean;
};

export type ChatTurnStatusSubagent = {
  taskId: string;
  agentId?: string;
  parentAgentId?: string | null;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  background?: boolean;
  spawnDepth?: number;
  startTimestamp?: string;
  startedAt?: string;
  durationMs?: number;
  resourceLinks?: AgentChatResourceLink[];
};

export type ChatTurnStatusSnapshot = {
  sessionId: string;
  phase: ChatTurnStatusPhase;
  provider?: string;
  turnElapsedMs?: number | null;
  lastActivityMsAgo?: number | null;
  currentTool?: ChatTurnStatusTool | null;
  queuedMessageCount: number;
  ask?: ChatTurnStatusAsk | null;
  subagents: ChatTurnStatusSubagent[];
};

export type DeriveChatTurnStatusInput = {
  sessionId: string;
  provider?: string;
  sessionStatus?: string;
  currentTurnStartedAt?: string | null;
  lastActivityAt?: string | null;
  awaitingInput?: boolean;
  pendingTitle?: string | null;
  pendingDescription?: string | null;
  queuedMessageCount?: number;
  currentTool?: ChatTurnStatusTool | null;
  subagents?: ChatTurnStatusSubagent[];
  nowMs?: number;
};

export function chatTurnStatusExitCode(phase: ChatTurnStatusPhase): number {
  switch (phase) {
    case "running":
      return 0;
    case "idle":
      return 1;
    case "blocked":
      return 2;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

export function deriveChatTurnStatus(input: DeriveChatTurnStatusInput): ChatTurnStatusSnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const awaitingInput = input.awaitingInput === true;
  const turnStartedMs = parseTime(input.currentTurnStartedAt);
  const lastActivityMs = parseTime(input.lastActivityAt);
  const hasLiveTurn = input.sessionStatus === "active" || turnStartedMs != null;
  const phase: ChatTurnStatusPhase = awaitingInput
    ? "blocked"
    : hasLiveTurn
      ? "running"
      : "idle";
  const stranded = awaitingInput && (input.provider === "claude" || input.provider == null);
  return {
    sessionId: input.sessionId,
    phase,
    ...(input.provider ? { provider: input.provider } : {}),
    turnElapsedMs: turnStartedMs == null ? null : Math.max(0, nowMs - turnStartedMs),
    lastActivityMsAgo: lastActivityMs == null ? null : Math.max(0, nowMs - lastActivityMs),
    currentTool: input.currentTool ?? null,
    queuedMessageCount: Math.max(0, input.queuedMessageCount ?? 0),
    ask: awaitingInput
      ? {
          title: input.pendingTitle?.trim() || "awaiting input",
          ...(input.pendingDescription?.trim() ? { description: input.pendingDescription.trim() } : {}),
          stranded,
        }
      : null,
    subagents: input.subagents ?? [],
  };
}

const CHAT_TURN_STATUS_KEY_WIDTH = 11;

/**
 * One key/value row of the status header, `  key        value`. Exported so a
 * caller supplying `extraRows` renders in the same column as `tool`/`queued`/
 * `ask` without copying the width — a second copy of the constant is exactly
 * how the CLI's resume line drifted out of alignment.
 */
export function chatTurnStatusRow(key: string, text: string): string {
  return `  ${key.padEnd(CHAT_TURN_STATUS_KEY_WIDTH)}${text}`;
}

export function formatChatTurnStatus(
  status: ChatTurnStatusSnapshot,
  options?: {
    /**
     * Extra header rows (build them with `chatTurnStatusRow`), rendered inside
     * the key/value block rather than appended to the output. Anything printed
     * after the subagent tree reads as a subagent.
     */
    extraRows?: readonly string[];
  },
): string {
  const marker = status.phase === "running" ? "●" : status.phase === "blocked" ? "●" : "○";
  const phaseLabel = status.phase.toUpperCase();
  const headlineBits: string[] = [];
  if (status.phase === "running") {
    if (status.turnElapsedMs != null) headlineBits.push(`turn ${formatCompactDuration(status.turnElapsedMs)}`);
    if (status.lastActivityMsAgo != null) headlineBits.push(`last activity ${formatCompactDuration(status.lastActivityMsAgo)} ago`);
  } else if (status.phase === "blocked") {
    headlineBits.push(status.ask?.title?.trim() || "awaiting input");
    if (status.turnElapsedMs != null) headlineBits.push(formatCompactDuration(status.turnElapsedMs));
    else if (status.lastActivityMsAgo != null) headlineBits.push(formatCompactDuration(status.lastActivityMsAgo));
  } else if (status.lastActivityMsAgo != null) {
    headlineBits.push(`last turn ended ${formatCompactDuration(status.lastActivityMsAgo)} ago`);
  }
  const lines = [
    `${marker} ${phaseLabel.padEnd(9)} ${headlineBits.join(" · ")}`.trimEnd(),
  ];

  if (status.currentTool) {
    const detail = status.currentTool.detail?.trim();
    lines.push(chatTurnStatusRow("tool", `${status.currentTool.name}${detail ? ` · ${detail}` : ""}`));
  }
  if (status.queuedMessageCount > 0) {
    lines.push(chatTurnStatusRow(
      "queued",
      `${status.queuedMessageCount} message${status.queuedMessageCount === 1 ? "" : "s"} waiting`,
    ));
  }
  if (status.ask?.stranded) {
    lines.push("  ⚠ stranded — no deadline set (dialogExpiry: never)");
  }
  if (status.ask) {
    const askDetail = status.ask.description?.trim() || status.ask.title;
    lines.push(chatTurnStatusRow("ask", askDetail));
  }

  for (const row of options?.extraRows ?? []) lines.push(row);

  if (status.subagents.length) {
    lines.push("");
    const annotated = annotateSubagentTree(status.subagents);
    for (const { node, tree } of annotated) {
      const indent = tree.prefix;
      const name = node.description.trim() || node.agentId || node.taskId;
      const statusLabel = node.status === "running" ? "running" : node.status === "failed" ? "failed" : node.status === "stopped" ? "stopped" : "done";
      const duration = node.durationMs != null ? formatCompactDuration(node.durationMs) : "";
      const bg = node.background ? "● bg" : "";
      const fileCount = resourceLinkCopyPaths(node.resourceLinks ?? []).length;
      const files = fileCount > 0
        ? `▸ ${fileCount} file${fileCount === 1 ? "" : "s"} returned`
        : "";
      const columns = [indent + name, statusLabel, duration, bg, files].filter((part) => part.length > 0);
      lines.push(`  ${columns[0]!.padEnd(Math.max(28, columns[0]!.length))}  ${statusLabel.padEnd(8)}  ${duration.padStart(5)}  ${bg}  ${files}`.trimEnd());
    }
  }

  return lines.join("\n").trimEnd();
}

export function chatTurnStatusCopyPaths(status: ChatTurnStatusSnapshot): string[] {
  return resourceLinkCopyPaths(status.subagents.flatMap((subagent) => subagent.resourceLinks ?? []));
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatCompactDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}
