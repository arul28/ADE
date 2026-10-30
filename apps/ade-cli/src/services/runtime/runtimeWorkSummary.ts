import type {
  RuntimeActivityCounts,
  RuntimeUpdateImpact,
} from "../../../../desktop/src/shared/types";
import { isTrackedAgentCliToolType } from "../../../../desktop/src/shared/types";
import { isChatToolType } from "../../../../desktop/src/shared/sessionSpawnNesting";
import type { AdeRuntime } from "../../bootstrap";

// What one ADE runtime is doing right now, read from memory: the activity a
// keep-awake or idle check needs, and what a restart for an update would stop.

/** Every terminal and CLI session whose process is still alive. */
function listLiveSessions(runtime: AdeRuntime) {
  return runtime.ptyService.list({ status: "running", limit: 500 });
}

/** Terminals and CLI sessions with work in them right now, not ones idling at a prompt. */
function listRunningWorkSessions(runtime: AdeRuntime) {
  return listLiveSessions(runtime)
    .filter(
      (session) =>
        session.runtimeState === "running"
        || session.runtimeState === "waiting-input",
    );
}

export function summarizeRuntimeActivity(runtime: AdeRuntime): RuntimeActivityCounts {
  const activeWorkSessions = listRunningWorkSessions(runtime);
  const activeAgentCliSessions = activeWorkSessions.filter(
    (session) => isTrackedAgentCliToolType(session.toolType) && session.runtimeState === "running",
  ).length;
  return {
    activeAgentTurns: runtime.agentChatService?.hasActiveWorkloads() ? 1 : 0,
    activeWorkSessions: activeWorkSessions.length,
    ...(activeAgentCliSessions > 0 ? { activeAgentCliSessions } : {}),
  };
}

/** The label a personal chat carries where a project chat names its project. */
const PERSONAL_CHATS_IMPACT_LABEL = "Personal chats";

/**
 * What a restart stops in one runtime: the chats mid-turn, by name, and every
 * live CLI session and terminal, by count. A restart closes a terminal whether
 * or not it printed lately, and a quiet command reads as idle after a few
 * seconds, so liveness is the honest count here, not recent output. `project`
 * is null for the personal-chat runtime, whose chats cannot be queued to
 * continue.
 */
export async function summarizeRuntimeUpdateImpact(
  runtime: AdeRuntime,
  project: { displayName: string; rootPath: string } | null,
): Promise<RuntimeUpdateImpact> {
  const live = await runtime.agentChatService?.listInterruptedChats();
  const chats = (live?.chats ?? []).map((chat) => ({
    sessionId: chat.sessionId,
    title: chat.title,
    projectName: project?.displayName ?? PERSONAL_CHATS_IMPACT_LABEL,
    projectRoot: project?.rootPath ?? null,
    ...(project ? {} : { resumable: false }),
    // What the restart does to it, by this machine's continue rule.
    ...(chat.continueHold !== undefined ? { continueHold: chat.continueHold } : {}),
  }));
  let cliSessions = 0;
  let terminals = 0;
  for (const session of listLiveSessions(runtime)) {
    // A chat row is already named above; counting it again would double it.
    if (isChatToolType(session.toolType)) continue;
    if (isTrackedAgentCliToolType(session.toolType)) cliSessions += 1;
    else terminals += 1;
  }
  return { chats, cliSessions, terminals };
}
