import { annotateSubagentTree } from "./chatSubagentTree";
import { resourceLinkCopyPaths } from "./claudeAgentSdkFields";
import { modelMentionEffortLabel } from "./modelMentions";
import { usesCodexNamedEffortLabels } from "./modelRegistry";
import type {
  AgentChatPendingSettingAfterBackground,
  AgentChatReasoningEffortChange,
  AgentChatResourceLink,
  AgentChatRuntimeOwnerRef,
} from "./types/chat";
import type { CliSessionFacts } from "./cliChildSession";

/**
 * `waiting`: no turn is running, but background work the chat started (a
 * backgrounded subagent, shell or workflow) is still running and reports back
 * into the chat when it ends. Not done, and nothing is asked of you, so it
 * shares `running`'s exit code: a caller polling for "finished" keeps waiting.
 */
export type ChatTurnStatusPhase = "running" | "blocked" | "waiting" | "idle";

export type ChatTurnStatusTool = {
  name: string;
  detail?: string;
};

export type ChatTurnStatusAsk = {
  title: string;
  description?: string;
  stranded: boolean;
  /**
   * Only the user can answer this card (a real-input lease, a consent, a
   * secret). An agent cannot answer or decline it: wait, or tell the user.
   */
  userOnly?: boolean;
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
  /**
   * The provider account the chat runs on (`ade chat create --instance` takes
   * it). Claude and Codex only, the providers with several logins.
   */
  instanceId?: string;
  turnElapsedMs?: number | null;
  lastActivityMsAgo?: number | null;
  currentTool?: ChatTurnStatusTool | null;
  queuedMessageCount: number;
  ask?: ChatTurnStatusAsk | null;
  subagents: ChatTurnStatusSubagent[];
  /** Live background jobs the chat waits on (monitors excluded); drives the `waiting` phase. */
  backgroundWorkCount?: number;
  /** Setting changes held until that background work ends (see the session summary field). */
  pendingSettingsAfterBackground?: AgentChatPendingSettingAfterBackground[];
  /** The picked effort the running work has not picked up yet (see the session summary field). */
  reasoningEffortChange?: AgentChatReasoningEffortChange;
  /** Present when the id names a tracked CLI terminal rather than a chat. */
  cliSession?: CliSessionFacts;
  /**
   * Another live brain runs this chat. The answering brain cannot see that
   * turn, so it reports the chat busy rather than idle: an "idle" here is what
   * let a caller send into a running chat and start a second process for it.
   */
  ownedElsewhere?: AgentChatRuntimeOwnerRef;
};

export type DeriveChatTurnStatusInput = {
  sessionId: string;
  provider?: string;
  instanceId?: string | null;
  sessionStatus?: string;
  currentTurnStartedAt?: string | null;
  lastActivityAt?: string | null;
  awaitingInput?: boolean;
  pendingTitle?: string | null;
  pendingDescription?: string | null;
  pendingUserOnly?: boolean;
  queuedMessageCount?: number;
  currentTool?: ChatTurnStatusTool | null;
  subagents?: ChatTurnStatusSubagent[];
  /** Live background work somebody waits on (the summary's working count; monitors excluded). */
  backgroundWorkCount?: number;
  pendingSettingsAfterBackground?: AgentChatPendingSettingAfterBackground[];
  reasoningEffortChange?: AgentChatReasoningEffortChange | null;
  ownedElsewhere?: AgentChatRuntimeOwnerRef | null;
  nowMs?: number;
};

export function chatTurnStatusExitCode(phase: ChatTurnStatusPhase): number {
  switch (phase) {
    // `waiting` is not finished: same code as running, so existing pollers
    // that loop until "not running" do not stop early.
    case "running":
    case "waiting":
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
  const ownedElsewhere = input.ownedElsewhere ?? null;
  // This brain cannot see another brain's turn, its asks included.
  const awaitingInput = ownedElsewhere == null && input.awaitingInput === true;
  const turnStartedMs = parseTime(input.currentTurnStartedAt);
  const lastActivityMs = parseTime(input.lastActivityAt);
  const hasLiveTurn = input.sessionStatus === "active" || turnStartedMs != null || ownedElsewhere != null;
  const backgroundWorkCount = Math.max(0, Math.trunc(input.backgroundWorkCount ?? 0));
  const phase: ChatTurnStatusPhase = awaitingInput
    ? "blocked"
    : hasLiveTurn
      ? "running"
      : backgroundWorkCount > 0
        ? "waiting"
        : "idle";
  const stranded = awaitingInput && (input.provider === "claude" || input.provider == null);
  return {
    sessionId: input.sessionId,
    phase,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.instanceId?.trim() ? { instanceId: input.instanceId.trim() } : {}),
    turnElapsedMs: turnStartedMs == null ? null : Math.max(0, nowMs - turnStartedMs),
    lastActivityMsAgo: lastActivityMs == null ? null : Math.max(0, nowMs - lastActivityMs),
    currentTool: input.currentTool ?? null,
    queuedMessageCount: Math.max(0, input.queuedMessageCount ?? 0),
    ask: awaitingInput
      ? {
          title: input.pendingTitle?.trim() || "awaiting input",
          ...(input.pendingDescription?.trim() ? { description: input.pendingDescription.trim() } : {}),
          stranded,
          ...(input.pendingUserOnly ? { userOnly: true } : {}),
        }
      : null,
    subagents: input.subagents ?? [],
    ...(backgroundWorkCount > 0 ? { backgroundWorkCount } : {}),
    ...(input.pendingSettingsAfterBackground?.length
      ? { pendingSettingsAfterBackground: input.pendingSettingsAfterBackground }
      : {}),
    ...(input.reasoningEffortChange ? { reasoningEffortChange: input.reasoningEffortChange } : {}),
    ...(ownedElsewhere ? { ownedElsewhere } : {}),
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
  const marker = status.phase === "running" || status.phase === "blocked"
    ? "●"
    : status.phase === "waiting" ? "◐" : "○";
  const owner = status.ownedElsewhere;
  const phaseLabel = owner && status.phase === "running" ? "BUSY" : status.phase.toUpperCase();
  const headlineBits: string[] = [];
  if (owner && status.phase === "running") {
    headlineBits.push(`runs under another ADE brain (pid ${owner.pid}${owner.socketPath ? `, socket ${owner.socketPath}` : ""})`);
  } else if (status.phase === "running") {
    if (status.turnElapsedMs != null) headlineBits.push(`turn ${formatCompactDuration(status.turnElapsedMs)}`);
    if (status.lastActivityMsAgo != null) headlineBits.push(`last activity ${formatCompactDuration(status.lastActivityMsAgo)} ago`);
  } else if (status.phase === "blocked") {
    headlineBits.push(status.ask?.title?.trim() || "awaiting input");
    if (status.turnElapsedMs != null) headlineBits.push(formatCompactDuration(status.turnElapsedMs));
    else if (status.lastActivityMsAgo != null) headlineBits.push(formatCompactDuration(status.lastActivityMsAgo));
  } else if (status.phase === "waiting") {
    const count = Math.max(1, status.backgroundWorkCount ?? 1);
    headlineBits.push(`on ${count} background job${count === 1 ? "" : "s"}`);
    if (status.lastActivityMsAgo != null) headlineBits.push(`last activity ${formatCompactDuration(status.lastActivityMsAgo)} ago`);
  } else if (status.lastActivityMsAgo != null) {
    headlineBits.push(`last turn ended ${formatCompactDuration(status.lastActivityMsAgo)} ago`);
  }
  const lines = [
    `${marker} ${phaseLabel.padEnd(9)} ${headlineBits.join(" · ")}`.trimEnd(),
  ];

  if (status.instanceId) {
    lines.push(chatTurnStatusRow("account", `${status.provider ?? "provider"} ${status.instanceId}`));
  }
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
  if (status.reasoningEffortChange) {
    lines.push(chatTurnStatusRow("effort", reasoningEffortChangeLabel(status.reasoningEffortChange)));
  }
  const heldSettings = settingsHeldBesideEffortChange(status.pendingSettingsAfterBackground, status.reasoningEffortChange);
  if (heldSettings.length) {
    lines.push(chatTurnStatusRow("pending", pendingSettingsAfterBackgroundLabel(heldSettings)));
  }
  if (status.ask?.stranded) {
    lines.push("  ⚠ stranded — no deadline set (dialogExpiry: never)");
  }
  if (status.ask) {
    const askDetail = status.ask.description?.trim() || status.ask.title;
    lines.push(chatTurnStatusRow("ask", askDetail));
    if (status.ask.userOnly) {
      lines.push("  only the user can answer this; an agent cannot. Wait for them, or tell them.");
    }
  }

  if (status.cliSession) {
    const cli = status.cliSession;
    const exit = cli.status === "running"
      ? "running"
      : `${cli.status}${cli.exitCode != null ? ` · exit ${cli.exitCode}` : ""}`;
    lines.push(chatTurnStatusRow("cli", `${cli.provider ?? cli.toolType ?? "terminal"} · ${exit}`));
    if (cli.parentSessionId) {
      lines.push(chatTurnStatusRow("parent", `${cli.parentSessionId}${cli.spawnKind ? ` (${cli.spawnKind})` : ""}`));
    }
    lines.push(chatTurnStatusRow("output", cli.readHint));
  }

  if (owner) {
    lines.push(chatTurnStatusRow(
      "owner",
      owner.socketPath
        ? `this brain cannot see its turn; ask the owner: ade --socket "${owner.socketPath}" chat status ${status.sessionId}`
        : "this brain cannot see its turn; ask the brain that owns it",
    ));
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

const PENDING_SETTING_LABEL: Record<AgentChatPendingSettingAfterBackground, string> = {
  reasoningEffort: "effort",
  fastMode: "fast mode",
};

/** The desktop chip's short label: "Effort pending", "Fast mode pending", "Settings pending". */
export function pendingSettingsAfterBackgroundShortLabel(
  settings: readonly AgentChatPendingSettingAfterBackground[],
): string {
  if (settings.length !== 1) return "Settings pending";
  const name = PENDING_SETTING_LABEL[settings[0]!] ?? "Setting";
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)} pending`;
}

/** "effort change applies after background work" — shared by the CLI and the desktop chip tooltip. */
export function pendingSettingsAfterBackgroundLabel(
  settings: readonly AgentChatPendingSettingAfterBackground[],
): string {
  const names = settings.map((setting) => PENDING_SETTING_LABEL[setting] ?? setting);
  const joined = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "setting";
  return `${joined} change${names.length > 1 ? "s apply" : " applies"} after background work`;
}

/**
 * The held settings a surface still names on its own. When the host sends
 * `reasoningEffortChange`, effort has its own chip and is dropped here; a host
 * that predates that field only lists it, so it stays.
 */
export function settingsHeldBesideEffortChange(
  settings: readonly AgentChatPendingSettingAfterBackground[] | null | undefined,
  effortChange: AgentChatReasoningEffortChange | null | undefined,
): AgentChatPendingSettingAfterBackground[] {
  return (settings ?? []).filter((setting) => setting !== "reasoningEffort" || effortChange == null);
}

/** The picker's name for an effort: the named GPT models call `low` "Light". */
function effortChangeName(effort: string | null, modelId: string | null | undefined): string {
  if (effort === "low" && usesCodexNamedEffortLabels(modelId)) return "Light";
  return modelMentionEffortLabel(effort);
}

function effortChangeWhen(change: AgentChatReasoningEffortChange): string {
  return change.appliesAfter === "background" ? "after background work" : "next turn";
}

/**
 * "High now · Medium next turn": the desktop and TUI chip label. `modelId`
 * names the chat's model so levels read as its picker does.
 */
export function reasoningEffortChangeLabel(change: AgentChatReasoningEffortChange, modelId?: string | null): string {
  return `${effortChangeName(change.current, modelId)} now · ${effortChangeName(change.next, modelId)} ${effortChangeWhen(change)}`;
}

/** "High → Medium": the narrow label for mobile. */
export function reasoningEffortChangeShortLabel(change: AgentChatReasoningEffortChange, modelId?: string | null): string {
  return `${effortChangeName(change.current, modelId)} → ${effortChangeName(change.next, modelId)}`;
}

/** The chip tooltip: why the running work keeps the old effort. */
export function reasoningEffortChangeTooltip(change: AgentChatReasoningEffortChange, modelId?: string | null): string {
  const current = effortChangeName(change.current, modelId);
  const next = effortChangeName(change.next, modelId);
  return change.appliesAfter === "background"
    ? `The agent still runs at ${current}. ${next} starts once the background work ends: applying it now would restart the agent and stop that work.`
    : `This turn keeps running at ${current}, steered messages included. The next turn starts at ${next}.`;
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
