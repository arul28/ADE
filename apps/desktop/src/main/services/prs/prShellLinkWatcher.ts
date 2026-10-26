import {
  mightTouchGhPr,
  readGhPrShellActions,
  shellToolCallCommand,
  shellToolResultText,
} from "../../../shared/ghPrShellCommands";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { setBounded } from "../../../shared/boundedMap";
import type { ShellPrLinkArgs, ShellPrLinkResult } from "./prService";

/** Tool calls waiting for their result, across all chats. Oldest drop first. */
const PENDING_CALLS_CAP = 256;
/** Commands already handled, so a re-delivered event links nothing twice. */
const HANDLED_CAP = 512;

export type PrShellLinkWatcherDeps = {
  logger: Logger;
  subscribeToEvents: (callback: (event: AgentChatEventEnvelope) => void) => () => void;
  linkShellPrAction: (args: ShellPrLinkArgs) => Promise<ShellPrLinkResult>;
};

/**
 * Links the PRs a chat's own shell commands create or merge (`gh pr create`,
 * `gh pr merge`) to that chat. An agent told to use `ade prs create` still
 * often runs `gh` directly; without this its PR reached the chat only through
 * the branch auto-map's guess at "up to three chats open at the time", and a
 * PR merged from the shell in a lane with another open PR settled nothing.
 *
 * Codex reports a shell run as one `command` event; Claude and the ACP
 * harnesses as a `tool_call` carrying the command and a later `tool_result`
 * carrying its output, matched here by item id. Every other event returns at
 * the first type check, so this costs nothing on text and reasoning deltas.
 */
export function createPrShellLinkWatcher(deps: PrShellLinkWatcherDeps) {
  const pendingCalls = new Map<string, string>();
  const handled = new Map<string, true>();

  const handle = (sessionId: string, itemId: string, command: string, output: string, exitCode: number | null) => {
    const key = `${sessionId}:${itemId}`;
    if (handled.has(key)) return;
    setBounded(handled, key, true, HANDLED_CAP);
    const actions = readGhPrShellActions({ command, output, exitCode });
    for (const action of actions) {
      void deps.linkShellPrAction({
        sessionId,
        kind: action.kind,
        repoOwner: action.owner,
        repoName: action.repo,
        prNumber: action.number,
      }).catch((error: unknown) => {
        deps.logger.warn("prs.shell_link_failed", {
          sessionId,
          kind: action.kind,
          prNumber: action.number,
          error: getErrorMessage(error),
        });
      });
    }
  };

  const onEvent = (envelope: AgentChatEventEnvelope): void => {
    const event = envelope.event;
    if (event.type === "command") {
      if (event.status === "running" || !mightTouchGhPr(event.command)) return;
      handle(envelope.sessionId, event.itemId, event.command, event.output ?? "", event.exitCode ?? null);
      return;
    }
    if (event.type === "tool_call") {
      const command = shellToolCallCommand(event.args);
      if (command && mightTouchGhPr(command)) {
        setBounded(pendingCalls, `${envelope.sessionId}:${event.itemId}`, command, PENDING_CALLS_CAP);
      }
      return;
    }
    if (event.type === "tool_result") {
      if (event.status === "running") return;
      const key = `${envelope.sessionId}:${event.itemId}`;
      const command = pendingCalls.get(key);
      if (!command) return;
      pendingCalls.delete(key);
      const structured = event.structured as { exitCode?: unknown; exit_code?: unknown } | null | undefined;
      const rawExit = structured && typeof structured === "object" ? (structured.exitCode ?? structured.exit_code) : undefined;
      const exitCode = typeof rawExit === "number" ? rawExit : event.status === "failed" ? 1 : null;
      const output = [shellToolResultText(event.result), shellToolResultText(event.structured)].filter(Boolean).join("\n");
      handle(envelope.sessionId, event.itemId, command, output, exitCode);
    }
  };

  let unsubscribe: (() => void) | null = null;
  return {
    start(): void {
      if (unsubscribe) return;
      unsubscribe = deps.subscribeToEvents((envelope) => {
        try {
          onEvent(envelope);
        } catch (error) {
          deps.logger.warn("prs.shell_link_event_failed", { error: getErrorMessage(error) });
        }
      });
    },
    dispose(): void {
      unsubscribe?.();
      unsubscribe = null;
      pendingCalls.clear();
      handled.clear();
    },
  };
}

export type PrShellLinkWatcher = ReturnType<typeof createPrShellLinkWatcher>;
