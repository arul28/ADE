import { randomUUID } from "node:crypto";
import {
  buildTrackedCliLaunchCommand,
  isLaunchProfile,
  LAUNCH_PROFILE_TITLE,
  LAUNCH_PROFILE_TOOL_TYPE,
} from "../../../shared/cliLaunch";
import type {
  AgentChatLaunchCliArgs,
  AgentChatLaunchCliResult,
} from "../../../shared/types/chat";
import type { createLaneService } from "../lanes/laneService";
import type { createPtyService } from "../pty/ptyService";
import { resolveCodexComputerUseMcpConfig } from "../../utils/codexComputerUse";

type LaneServiceForCliLaunch = Pick<
  ReturnType<typeof createLaneService>,
  "getLaneWorktreePath" | "getLaneBaseAndBranch"
>;

type PtyServiceForCliLaunch = Pick<ReturnType<typeof createPtyService>, "create">;

type LoggerForCliLaunch = {
  info: (message: string, meta?: Record<string, unknown>) => void;
};

export type AgentChatCliLaunchDeps = {
  laneService: LaneServiceForCliLaunch;
  ptyService: PtyServiceForCliLaunch;
  logger?: LoggerForCliLaunch | null;
};

function resolveLaneWorktreePath(
  laneService: LaneServiceForCliLaunch,
  laneId: string,
): string {
  try {
    const worktreePath = laneService.getLaneWorktreePath(laneId);
    const trimmed = typeof worktreePath === "string" ? worktreePath.trim() : "";
    if (trimmed) return trimmed;
  } catch {
    // Fall through to the row snapshot below for imported/attached lane shapes.
  }

  try {
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const trimmed =
      typeof lane?.worktreePath === "string" ? lane.worktreePath.trim() : "";
    if (trimmed) return trimmed;
  } catch {
    // Surface one clear error below.
  }

  throw new Error(`Unable to resolve worktree path for lane '${laneId}'.`);
}

export async function launchAgentChatCli(
  arg: AgentChatLaunchCliArgs,
  deps: AgentChatCliLaunchDeps,
): Promise<AgentChatLaunchCliResult> {
  const laneId = typeof arg?.laneId === "string" ? arg.laneId.trim() : "";
  if (!laneId) throw new Error("agentChat.launchCli requires a laneId.");
  const provider = arg?.provider;
  if (!provider) throw new Error("agentChat.launchCli requires a provider.");
  // Validate at the runtime boundary: the renderer always passes a known CLI
  // provider, but the run_ade_action / IPC surfaces accept raw args. An unknown
  // provider would otherwise fall through to an OpenCode launch with an
  // undefined tool type/title (a silent misclassification or a cryptic DB error).
  // "shell" is a launch profile but not an agent provider, so reject it too.
  const providerKey = String(provider);
  if (!isLaunchProfile(providerKey) || providerKey === "shell") {
    throw new Error(`agentChat.launchCli: unsupported provider '${providerKey}'.`);
  }
  const kickoffPrompt =
    typeof arg?.kickoffPrompt === "string" ? arg.kickoffPrompt : "";
  if (!kickoffPrompt.trim().length) {
    throw new Error("agentChat.launchCli requires a kickoff prompt.");
  }

  const worktreePath = resolveLaneWorktreePath(deps.laneService, laneId);

  // The terminal session id is the Linear link key. For Claude, reuse it as
  // the CLI `--session-id` so resume stays consistent.
  const sessionId = randomUUID();
  const permissionMode = arg.permissionMode ?? "full-auto";

  const issues = Array.isArray(arg.linearIssues) ? arg.linearIssues : [];
  const attachedLinearIssueIds = issues
    .map((issue) => issue?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const launch = buildTrackedCliLaunchCommand({
    provider,
    permissionMode,
    orchestrationRole: arg.orchestrationRole ?? null,
    ...(provider === "claude" ? { sessionId } : {}),
    model: arg.model ?? null,
    reasoningEffort: arg.reasoningEffort ?? null,
    ...((provider === "codex" || provider === "claude" || provider === "opencode") && (arg.fastMode ?? arg.codexFastMode) !== undefined
      ? { fastMode: arg.fastMode ?? arg.codexFastMode }
      : {}),
    initialPrompt: kickoffPrompt,
    laneWorktreePath: worktreePath,
    ...(provider === "codex" ? { codexComputerUse: resolveCodexComputerUseMcpConfig() } : {}),
  });

  const result = await deps.ptyService.create({
    sessionId,
    allowNewSessionId: true,
    chatSessionId: sessionId,
    laneId,
    cols: 100,
    rows: 30,
    title: arg.title?.trim() || LAUNCH_PROFILE_TITLE[provider],
    tracked: true,
    toolType: LAUNCH_PROFILE_TOOL_TYPE[provider],
    startupCommand: launch.startupCommand,
    ...(issues.length ? { linearIssues: issues } : {}),
    ...(launch.command !== undefined ? { command: launch.command } : {}),
    ...(launch.args !== undefined ? { args: launch.args } : {}),
    ...(launch.initialInput !== undefined
      ? { initialInput: launch.initialInput }
      : {}),
    ...(launch.initialInputDelayMs !== undefined
      ? { initialInputDelayMs: launch.initialInputDelayMs }
      : {}),
    ...(launch.env ? { env: launch.env } : {}),
  });

  deps.logger?.info("agentChat.launchCli.created", {
    laneId,
    sessionId: result.sessionId,
    provider,
    attachedLinearIssueCount: attachedLinearIssueIds.length,
  });

  return {
    sessionId: result.sessionId,
    ptyId: result.ptyId,
    pid: result.pid,
    attachedLinearIssueIds,
  };
}
