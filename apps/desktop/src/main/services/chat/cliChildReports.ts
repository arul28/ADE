import type {
  AgentChatMessageSessionArgs,
  AgentChatSpawnCompletion,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { TrackedCliTurnEndedEvent } from "../pty/cliTurnSignals";
import {
  cliChildResultStatus,
  cliChildRunKey,
  composeCliChildReport,
  type CliChildLineage,
  type TrackedCliRow,
} from "./cliChildSessions";
import { readChildPullRequestNumber } from "./ctoTurnContext";

/** One child completion for its parent: the card to close and the wake to send. */

/** How a wake names the CLI child: a subagent, or a chat that does not report back. */
function cliChildNoun(spawnKind: "subagent" | "peer"): string {
  return spawnKind === "subagent" ? "subagent CLI session" : "CLI session";
}
export type ChildCompletionDelivery = {
  parentSessionId: string;
  childSessionId: string;
  childTitle: string;
  /** Provider id the parent's card and CTO line name the child by. */
  childProvider: string;
  spawnKind: "subagent" | "peer";
  resultStatus: AgentChatSpawnCompletion["status"];
  summary: string;
  /** Carries `childTurnId`, the durable dedupe anchor in the parent transcript. */
  spawnCompletion: AgentChatSpawnCompletion;
  ctoPrNumber: number | null;
  /** CLI children need their existing inline spawn card closed in CTO threads. */
  emitCtoSubagentResult?: boolean;
  /** What the woken parent agent reads (subagents only). */
  wakeText: string;
  /**
   * Close the card and leave a quiet note instead of waking the parent. A
   * restart reconcile uses it: like the stale-run sweep, recovering a
   * child's end after the fact never starts a parent turn by itself.
   */
  routeQuietly?: boolean;
  onParentGone: (reason: string) => void;
  onDeliveryFailed: (lastError: unknown) => void;
  /** The parent has the completion (now, or already from an earlier try). */
  onDelivered?: () => void;
};

/**
 * Reports from a tracked CLI child (`ade new chat --mode cli --parent …`) to
 * the chat or CLI that started it: one after each finished turn, one when its
 * process ends, and none for a turn the child already reported itself. The
 * parent side (closing its card, waking it) is the chat service's
 * `deliverChildCompletionToParent`.
 */
export function createCliChildReports(deps: {
  logger: Pick<Logger, "info" | "warn">;
  /** The host is shutting down: nothing more reports. */
  isClosed: () => boolean;
  readTrackedCliRow: (sessionId: string) => { row: TrackedCliRow; lineage: CliChildLineage | null } | null;
  parentSessionReachableHere: (parentSessionId: string) => boolean;
  waitForResumeTargetBackfill: (sessionId: string) => Promise<unknown> | undefined;
  readProviderMessage: (row: TrackedCliRow, provider: string) => Promise<string | null>;
  readTerminalTail: (terminalId: string) => Promise<string | null>;
  childLabel: (row: TrackedCliRow, provider: string) => string;
  notifyParentOfSpawn: (sessionId: string, options: { resumed: boolean }) => void;
  deliverChildCompletionToParent: (delivery: ChildCompletionDelivery) => void;
}) {
  /**
   * The last finished-turn report each running CLI child gave its parent
   * (`reportCliChildTurnEnded`), and the children whose parent card that report
   * closed. In memory: a restart drops them, and the exit report then simply
   * speaks once more.
   */
  const cliChildTurnReports = new Map<string, { providerMessage: string | null; at: number }>();
  const cliChildCardsClosedByTurn = new Set<string>();
  /**
   * When each CLI child last sent its parent a report itself (`ade chat
   * message`, which the RPC stamps with `agentRelay`). Its guidance asks it to;
   * a turn it reported on is then closed quietly instead of waking the parent
   * a second time with ADE's copy.
   */
  const cliChildSelfReportedAt = new Map<string, number>();
  const noteCliChildSelfReport = (messageArgs: AgentChatMessageSessionArgs): void => {
    const relay = (messageArgs?.metadata as { agentRelay?: { fromSessionId?: unknown } } | undefined)?.agentRelay;
    const from = typeof relay?.fromSessionId === "string" ? relay.fromSessionId.trim() : "";
    const target = typeof messageArgs?.sessionId === "string" ? messageArgs.sessionId.trim() : "";
    if (!from || !target) return;
    if (deps.readTrackedCliRow(from)?.lineage?.parentSessionId === target) cliChildSelfReportedAt.set(from, Date.now());
  };

  /**
   * Close the parent's card for a CLI child whose PTY has ended, with the CLI's
   * own closing message (or its last terminal lines) as the report. A no-op
   * while the child still runs, for a CLI without a parent, and for a run the
   * parent already has — the run key is the persisted end time, so the live
   * exit and a post-restart reconcile of the same exit resolve to one delivery.
   */
  const reportCliChildEnded = async (terminalSessionId: string, trigger: "exit" | "reconcile"): Promise<void> => {
    if (deps.isClosed()) return;
    const tracked = deps.readTrackedCliRow(terminalSessionId);
    const lineage = tracked?.lineage;
    if (!tracked || !lineage) return;
    const { row } = tracked;
    const endStatus = cliChildResultStatus(row);
    if (!endStatus) return;
    if (!deps.parentSessionReachableHere(lineage.parentSessionId)) {
      deps.logger.info("agent_chat.cli_child_completion_parent_gone", {
        childSessionId: row.id,
        parentSessionId: lineage.parentSessionId,
        trigger,
      });
      return;
    }
    await deps.waitForResumeTargetBackfill(row.id);
    const refreshed = deps.readTrackedCliRow(row.id);
    const latestRow = refreshed?.lineage ? refreshed.row : row;
    const providerMessage = await deps.readProviderMessage(latestRow, lineage.provider);
    const terminalTail = await deps.readTerminalTail(row.id);
    // The host may have started tearing down while the tail was read (a
    // project close disposes its PTYs first); that is not the child's end.
    if (deps.isClosed()) return;
    // A terminal closed by hand (or cut off by a restart) after the CLI already
    // wrote its answer is a finished delegate, not a casualty — the same rule
    // the stale-run sweep applies to an ended chat that left a report. Without
    // a closing message it stays stopped. A non-zero exit is always failed.
    const resultStatus = endStatus === "stopped" && providerMessage ? "completed" : endStatus;
    const summary = composeCliChildReport({
      status: resultStatus,
      exitCode: row.exitCode ?? null,
      providerMessage,
      terminalTail,
    });
    // A CLI that finished its last turn (and already reported it) and then
    // exited has nothing new to say: the exit closes the card quietly instead
    // of waking the parent a second time with the same report.
    const lastTurnReport = cliChildTurnReports.get(row.id);
    cliChildTurnReports.delete(row.id);
    cliChildCardsClosedByTurn.delete(row.id);
    const repeatsTurnReport = resultStatus === "completed"
      && Boolean(providerMessage)
      && lastTurnReport?.providerMessage === providerMessage;
    const childTitle = deps.childLabel(row, lineage.provider);
    const spawnCompletion: AgentChatSpawnCompletion = {
      childSessionId: row.id,
      childTitle,
      spawnKind: lineage.spawnKind,
      childTurnId: cliChildRunKey(row),
      status: resultStatus,
      summary,
    };
    const outcome = resultStatus === "completed" ? "finished" : resultStatus === "failed" ? "failed" : "was stopped";
    deps.deliverChildCompletionToParent({
      parentSessionId: lineage.parentSessionId,
      childSessionId: row.id,
      childTitle,
      childProvider: lineage.provider,
      spawnKind: lineage.spawnKind,
      resultStatus,
      summary,
      spawnCompletion,
      ctoPrNumber: readChildPullRequestNumber(null, summary),
      emitCtoSubagentResult: true,
      routeQuietly: trigger === "reconcile" || repeatsTurnReport,
      wakeText: `Your ${cliChildNoun(lineage.spawnKind)} "${childTitle}" ${outcome} — ${summary}\n(Full terminal output: \`ade terminal read ${row.id}\`.)`,
      onParentGone: (reason) => {
        deps.logger.info("agent_chat.cli_child_completion_parent_gone", {
          childSessionId: row.id,
          parentSessionId: lineage.parentSessionId,
          reason,
        });
      },
      onDeliveryFailed: (lastError) => {
        deps.logger.warn("agent_chat.cli_child_completion_delivery_failed", {
          childSessionId: row.id,
          parentSessionId: lineage.parentSessionId,
          error: lastError instanceof Error ? lastError.message : String(lastError),
        });
      },
    });
  };

  /**
   * A tracked CLI child finished a turn and is back at its prompt. An agent CLI
   * is interactive and rarely exits on its own, so waiting for the PTY exit
   * meant a parent never heard back. Each finished turn is reported the way a
   * chat child's is: the parent's card closes with the CLI's own closing
   * message, and a subagent's parent is woken (a CLI parent at its next turn
   * boundary, never mid-turn). A turn that ended on a question for the person
   * (`needs-input`) is not finished work and reports nothing. The run key is
   * the turn's start, so a repeated signal for one turn delivers once.
   */
  const reportCliChildTurnEnded = async (event: TrackedCliTurnEndedEvent): Promise<void> => {
    if (deps.isClosed()) return;
    if (event.outcome === "needs-input") return;
    const resultStatus = event.outcome === "failed" ? "failed" as const : "completed" as const;
    const tracked = deps.readTrackedCliRow(event.sessionId);
    const lineage = tracked?.lineage;
    if (!tracked || !lineage) return;
    const { row } = tracked;
    // An ended CLI reports through its exit.
    if (row.status !== "running") return;
    if (!deps.parentSessionReachableHere(lineage.parentSessionId)) return;
    await deps.waitForResumeTargetBackfill(row.id);
    const latestRow = deps.readTrackedCliRow(row.id)?.row ?? row;
    const providerMessage = await deps.readProviderMessage(latestRow, lineage.provider);
    const terminalTail = await deps.readTerminalTail(row.id);
    if (deps.isClosed()) return;
    const summary = composeCliChildReport({ status: resultStatus, exitCode: null, providerMessage, terminalTail });
    const childTitle = deps.childLabel(row, lineage.provider);
    // No turn-start signal reopened the card a previous report closed (an
    // older pty surface): reopen it now so this report closes a live card.
    if (cliChildCardsClosedByTurn.delete(row.id)) {
      deps.notifyParentOfSpawn(row.id, { resumed: true });
    }
    const turnKey = event.turnStartedAt?.trim() || event.endedAt?.trim() || new Date().toISOString();
    // The child already reported this turn itself: close the card with ADE's
    // copy, but do not wake the parent twice.
    const turnStartMs = Date.parse(event.turnStartedAt ?? "")
      || cliChildTurnReports.get(row.id)?.at
      || Date.parse(row.startedAt)
      || 0;
    const selfReported = (cliChildSelfReportedAt.get(row.id) ?? -1) >= turnStartMs;
    cliChildSelfReportedAt.delete(row.id);
    const spawnCompletion: AgentChatSpawnCompletion = {
      childSessionId: row.id,
      childTitle,
      spawnKind: lineage.spawnKind,
      childTurnId: `cli-turn:${turnKey}`,
      status: resultStatus,
      summary,
    };
    cliChildTurnReports.set(row.id, { providerMessage, at: Date.now() });
    cliChildCardsClosedByTurn.add(row.id);
    deps.deliverChildCompletionToParent({
      parentSessionId: lineage.parentSessionId,
      childSessionId: row.id,
      childTitle,
      childProvider: lineage.provider,
      spawnKind: lineage.spawnKind,
      resultStatus,
      summary,
      spawnCompletion,
      ctoPrNumber: readChildPullRequestNumber(null, summary),
      emitCtoSubagentResult: true,
      routeQuietly: selfReported,
      wakeText: `Your ${cliChildNoun(lineage.spawnKind)} "${childTitle}" ${resultStatus === "failed" ? "ended a turn on an error" : "finished a turn"} — ${summary}\n`
        + `(It is still open at its prompt. Full terminal output: \`ade terminal read ${row.id}\`.)`,
      onParentGone: (reason) => {
        deps.logger.info("agent_chat.cli_child_turn_report_parent_gone", {
          childSessionId: row.id,
          parentSessionId: lineage.parentSessionId,
          reason,
        });
      },
      onDeliveryFailed: (lastError) => {
        deps.logger.warn("agent_chat.cli_child_turn_report_failed", {
          childSessionId: row.id,
          parentSessionId: lineage.parentSessionId,
          error: lastError instanceof Error ? lastError.message : String(lastError),
        });
      },
    });
  };

  /** A CLI child started its next turn: reopen the parent card its last report closed. */
  const reopenCliChildCardOnTurnStart = (sessionId: string): void => {
    if (deps.isClosed() || !cliChildCardsClosedByTurn.delete(sessionId)) return;
    try {
      deps.notifyParentOfSpawn(sessionId, { resumed: true });
    } catch (error) {
      deps.logger.warn("agent_chat.cli_child_turn_reopen_failed", {
        childSessionId: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return { noteCliChildSelfReport, reportCliChildEnded, reportCliChildTurnEnded, reopenCliChildCardOnTurnStart };
}
