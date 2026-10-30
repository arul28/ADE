import {
  mightTouchGhPr,
  readGhPrBodyEdits,
  readGhPrShellActions,
  shellToolCallCommand,
  shellToolResultText,
} from "../../../shared/ghPrShellCommands";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { setBounded } from "../../../shared/boundedMap";
import type { ShellPrLinkArgs, ShellPrLinkResult } from "./prService";
import type { ShellPrBodyRepairArgs, ShellPrBodyRepairResult } from "./prShellBodyRepair";
import type { PublishableArtifact } from "./prBodyProofStaging";

/** Tool calls waiting for their result, across all chats. Oldest drop first. */
const PENDING_CALLS_CAP = 256;
/** Commands already handled, so a re-delivered event links nothing twice. */
const HANDLED_CAP = 512;

export type PrShellLinkWatcherDeps = {
  logger: Logger;
  subscribeToEvents: (callback: (event: AgentChatEventEnvelope) => void) => () => void;
  linkShellPrAction: (args: ShellPrLinkArgs) => Promise<ShellPrLinkResult>;
  /** Puts back the footer and cited proof a `gh` write of the PR's text left out. */
  repairShellPrBody: (args: ShellPrBodyRepairRequest) => Promise<ShellPrBodyRepairResult>;
};

/** What the watcher knows about a PR whose text a chat's command wrote. */
export type ShellPrBodyRepairRequest = Omit<ShellPrBodyRepairArgs, "listOwnedProof" | "linkProofToPr">;

/**
 * The watcher's `repairShellPrBody` for one project: the PR service does the
 * repair, the proof broker answers which cited proof the chat or lane owns
 * and records the PR on what went up. The desktop and the brain both use it.
 */
export function shellPrBodyRepairVia(deps: {
  prService: { repairShellPrBody: (args: ShellPrBodyRepairArgs) => Promise<ShellPrBodyRepairResult> };
  proof: {
    findProofForOwners: (args: { ids: string[]; owners: Array<{ kind: "chat_session" | "lane"; id: string }> }) => PublishableArtifact[];
    linkArtifactsToPullRequest: (args: { artifactIds: string[]; prUrl: string }) => unknown;
  };
}): (args: ShellPrBodyRepairRequest) => Promise<ShellPrBodyRepairResult> {
  return (args) => deps.prService.repairShellPrBody({
    ...args,
    listOwnedProof: (query) => deps.proof.findProofForOwners(query),
    linkProofToPr: (link) => {
      deps.proof.linkArtifactsToPullRequest(link);
    },
  });
}

/**
 * Links the PRs a chat's own shell commands create or merge (`gh pr create`,
 * `gh pr merge`) to that chat, and repairs the text of a PR the chat wrote
 * with `gh pr create` or `gh pr edit --body`. An agent told to use `ade prs create` still
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
  /** Keys whose link work is out; a repeat of the same event waits for it. */
  const inFlightKeys = new Set<string>();

  const handle = (sessionId: string, itemId: string, command: string, output: string, exitCode: number | null) => {
    const key = `${sessionId}:${itemId}`;
    if (handled.has(key) || inFlightKeys.has(key)) return;
    const actions = readGhPrShellActions({ command, output, exitCode });
    const bodies = [
      ...actions.filter((action) => action.kind === "create"),
      ...readGhPrBodyEdits({ command, exitCode }),
    ];
    if (actions.length === 0 && bodies.length === 0) {
      setBounded(handled, key, true, HANDLED_CAP);
      return;
    }
    inFlightKeys.add(key);
    void Promise.allSettled(actions.map((action) => deps.linkShellPrAction({
      sessionId,
      kind: action.kind,
      repoOwner: action.owner,
      repoName: action.repo,
      prNumber: action.number,
    }))).then((results) => {
      let retry = false;
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          retry = true;
          const action = actions[index]!;
          deps.logger.warn("prs.shell_link_failed", {
            sessionId,
            kind: action.kind,
            prNumber: action.number,
            error: getErrorMessage(result.reason),
          });
          continue;
        }
        // A GitHub read that failed is transient: a later delivered result for
        // this item should try again. Every other skip is a decision about the
        // PR itself and would skip again.
        if (result.value?.status === "skipped" && result.value.reason === "github_unreadable") retry = true;
      }
      // Only a settled event is marked handled; see the note above.
      if (!retry) setBounded(handled, key, true, HANDLED_CAP);
      // After the links, so a new PR already has its row. A repair of text
      // that needs none changes nothing, so a retried event may run it again.
      for (const body of bodies) {
        void deps.repairShellPrBody({
          sessionId,
          repoOwner: body.owner,
          repoName: body.repo,
          prNumber: body.number,
        }).catch((error) => {
          deps.logger.warn("prs.shell_body_repair_failed", { sessionId, prNumber: body.number, error: getErrorMessage(error) });
        });
      }
    }).finally(() => {
      inFlightKeys.delete(key);
    });
  };

  const onEvent = (envelope: AgentChatEventEnvelope): void => {
    const event = envelope.event;
    if (event.type === "command") {
      if (event.status === "running" || !mightTouchGhPr(event.command)) return;
      // A failed command may carry no exit code; `readGhPrShellActions` reads a
      // missing code as success, so hand it a failing one like the tool_result
      // branch does.
      const exitCode = event.status === "failed" ? (event.exitCode ?? 1) : (event.exitCode ?? null);
      handle(envelope.sessionId, event.itemId, event.command, event.output ?? "", exitCode);
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
