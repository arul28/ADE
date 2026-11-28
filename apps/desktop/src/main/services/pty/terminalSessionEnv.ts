/**
 * Env the PTY service adds to a lane's terminals, built the same way by every
 * process that runs terminals: the machine brain (`apps/ade-cli/src/bootstrap.ts`,
 * which runs them in production) and the desktop's in-process project runtime
 * (`main.ts`, tests and the opt-in desktop sync host).
 */
import type { createLaneService } from "../lanes/laneService";
import type { createPortAllocationService } from "../lanes/portAllocationService";
import type { createLaneProxyService } from "../lanes/laneProxyService";
import type { SessionLinearIssueLink } from "../../../shared/types";

type Logger = { warn: (event: string, data?: Record<string, unknown>) => void };

/**
 * The lane's dev-server ports and proxy hostname: `PORT`, `PORT_RANGE_START`,
 * `PORT_RANGE_END`, `HOSTNAME` and `PROXY_HOSTNAME`, so servers an agent starts
 * in one lane don't collide with another lane's.
 */
export function createLaneRuntimeEnvResolver(deps: {
  laneService: Pick<ReturnType<typeof createLaneService>, "list">;
  portAllocationService: Pick<ReturnType<typeof createPortAllocationService>, "getLease">;
  laneProxyService: Pick<ReturnType<typeof createLaneProxyService>, "getRoute" | "generateHostname">;
}): (laneId: string) => Promise<Record<string, string>> {
  return async (laneId) => {
    const lease = deps.portAllocationService.getLease(laneId);
    const lane = (await deps.laneService.list({ includeArchived: false, includeStatus: false })).find(
      (entry) => entry.id === laneId,
    );
    const hostname = deps.laneProxyService.getRoute(laneId)?.hostname
      ?? deps.laneProxyService.generateHostname(laneId, lane?.name);
    const portStart = lease?.rangeStart ?? 3000;
    const portEnd = lease?.rangeEnd ?? portStart;
    return {
      PORT: String(portStart),
      PORT_RANGE_START: String(portStart),
      PORT_RANGE_END: String(portEnd),
      HOSTNAME: hostname,
      PROXY_HOSTNAME: hostname,
    };
  };
}

/**
 * The per-session Linear issue context for a CLI terminal agent (the CLI
 * counterpart of `agentChatService.buildAgentRuntimeEnv` for SDK chats), so the
 * agent can read its attached issues without Linear credentials. Keyed by the
 * terminal's chat/session id; returns the env vars pointing at the context file.
 */
export function createSessionLinearEnvResolver(deps: {
  laneService: { listLinearIssuesForSession?: (args: { chatSessionId: string }) => SessionLinearIssueLink[] };
  contextDir: string;
  writeContextFile: (args: {
    contextDir: string;
    sessionId: string;
    links: SessionLinearIssueLink[];
    now: string;
  }) => { identifiers: string; filePath: string } | null;
  logger: Logger;
}): (args: { sessionId: string; chatSessionId: string | null }) => Record<string, string> | null {
  return ({ sessionId, chatSessionId }) => {
    const linkKey = (chatSessionId ?? sessionId).trim();
    if (!linkKey) return null;
    try {
      const links = deps.laneService.listLinearIssuesForSession?.({ chatSessionId: linkKey }) ?? [];
      const context = deps.writeContextFile({
        contextDir: deps.contextDir,
        sessionId: linkKey,
        links,
        now: new Date().toISOString(),
      });
      if (!context) return null;
      return {
        ADE_LINEAR_ISSUE_IDS: context.identifiers,
        ADE_LINEAR_CONTEXT_FILE: context.filePath,
      };
    } catch (error) {
      deps.logger.warn("pty.session_linear_env_failed", {
        sessionId,
        chatSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
}
