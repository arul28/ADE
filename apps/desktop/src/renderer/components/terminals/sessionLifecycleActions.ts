import type {
  AutomationRuleDraft,
  AutomationRuleSummary,
  OpenProjectBinding,
  SessionSettleOverride,
  TerminalSessionSummary,
} from "../../../shared/types";
import { showToast } from "../app/toast/toastStore";
import {
  canonicalInputFromSummary,
  sessionNeedsYou,
} from "../../lib/terminalAttention";
import { CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE, cursorOwnsSessionName, isChatToolType } from "../../lib/sessions";
import {
  snoozeConfirmationLabel,
  snoozeDeadlineIso,
  type SnoozeDurationKey,
} from "../../lib/sessionSnooze";

/**
 * One place for every write the Work tab's menus make against a session: the
 * lifecycle writes (snooze/wake/settle/keep-active), the rename and spawn-kind
 * writes, and the auto-handoff rules the chat menu arms through the automations
 * surface. The sidebar row menu, the row context menu, the chat header snooze
 * affordance and the composer lifecycle pill all route through here, so none of
 * them can disagree about what an action does — or about the copy it confirms
 * with, which is why the toasts live here rather than at each call site.
 */

const UNDO_TOAST_MS = 5_000;

/** Rename either a chat or a terminal through its owning runtime binding. */
export async function renameSession(
  session: Pick<TerminalSessionSummary, "id" | "toolType" | "cursorCloudAgentId">,
  title: string,
  pin?: OpenProjectBinding | null,
): Promise<void> {
  if (cursorOwnsSessionName(session)) {
    throw new Error(CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE);
  }
  const input = { sessionId: session.id, title, manuallyNamed: true };
  if (isChatToolType(session.toolType)) {
    await (pin
      ? window.ade.agentChat.updateSession(input, pin)
      : window.ade.agentChat.updateSession(input));
    return;
  }
  await (pin
    ? window.ade.sessions.updateMeta(input, pin)
    : window.ade.sessions.updateMeta(input));
}

function reportFailure(action: string, sessionId: string, error: unknown): void {
  console.error(`[sessionLifecycle] ${action} failed`, { sessionId, error });
  showToast({
    title: `${action} failed`,
    message: error instanceof Error ? error.message : String(error),
    tone: "error",
  });
}

/**
 * Snooze one session and offer a 5s undo. The deadline is computed here (client
 * side) and handed over as a concrete ISO instant — expiry is derived from it
 * everywhere, so no scheduler is involved.
 */
export async function snoozeSessionForDuration(
  session: Pick<TerminalSessionSummary, "id">,
  key: SnoozeDurationKey,
  nowMs: number = Date.now(),
  pin?: OpenProjectBinding | null,
): Promise<void> {
  const untilIso = snoozeDeadlineIso(key, nowMs);
  try {
    await (pin
      ? window.ade.sessions.snoozeSession(session.id, untilIso, pin)
      : window.ade.sessions.snoozeSession(session.id, untilIso));
  } catch (error) {
    reportFailure("Snooze", session.id, error);
    return;
  }
  showToast({
    id: `session-snooze:${session.id}`,
    title: `Snoozed ${snoozeConfirmationLabel(key)}`,
    durationMs: UNDO_TOAST_MS,
    action: {
      label: "Undo",
      onClick: () => {
        const wake = pin
          ? window.ade.sessions.wakeSession(session.id, "manual", pin)
          : window.ade.sessions.wakeSession(session.id, "manual");
        void wake
          .catch((error: unknown) => reportFailure("Undo snooze", session.id, error));
      },
    },
  });
}

/** Wake a snoozed row right now (the user asked, so the reason is "manual"). */
export async function wakeSessionNow(
  session: Pick<TerminalSessionSummary, "id">,
  pin?: OpenProjectBinding | null,
): Promise<void> {
  try {
    await (pin
      ? window.ade.sessions.wakeSession(session.id, "manual", pin)
      : window.ade.sessions.wakeSession(session.id, "manual"));
  } catch (error) {
    reportFailure("Wake", session.id, error);
  }
}

/**
 * Pin a session's lifecycle. `"active"` is the keep-active pin that suppresses
 * a declared settle until real activity clears the override.
 */
export async function setSessionSettleOverride(
  session: Pick<TerminalSessionSummary, "id">,
  override: SessionSettleOverride,
  pin?: OpenProjectBinding | null,
): Promise<void> {
  try {
    await (pin
      ? window.ade.sessions.setSettleOverride(session.id, override, pin)
      : window.ade.sessions.setSettleOverride(session.id, override));
  } catch (error) {
    reportFailure(override === "active" ? "Keep active" : "Settle", session.id, error);
  }
}

/**
 * Settle one session through the binding-aware endpoint. Needs-you rows require
 * an explicit dismissal flag so resolving their attention and filing them away
 * remains one atomic lifecycle action.
 */
export async function settleSession(
  session: TerminalSessionSummary,
  pin?: OpenProjectBinding | null,
): Promise<void> {
  const options = sessionNeedsYou(canonicalInputFromSummary(session))
    ? { dismissPendingInput: true }
    : undefined;
  try {
    await (pin
      ? window.ade.sessions.settle(session.id, options, pin)
      : window.ade.sessions.settle(session.id, options));
  } catch (error) {
    reportFailure("Settle", session.id, error);
  }
}

/**
 * Lift a declared settle. Both the Work row menu and the chat header chip route
 * through here, so the branch can never drift apart — and a failed write is
 * reported instead of swallowed.
 */
export async function unsettleSession(
  session: Pick<TerminalSessionSummary, "id" | "settledAt">,
  pin?: OpenProjectBinding | null,
): Promise<void> {
  try {
    await (pin
      ? window.ade.sessions.unsettle(session.id, pin)
      : window.ade.sessions.unsettle(session.id));
  } catch (error) {
    reportFailure("Unsettle", session.id, error);
  }
}

/** Drop a row's "woke" marker once the user has actually looked at it. */
export function clearSessionWokeMarker(
  sessionId: string,
  pin?: OpenProjectBinding | null,
): void {
  const clear = window.ade.sessions?.clearWokeMarker;
  if (!clear) return;
  void (pin ? clear(sessionId, pin) : clear(sessionId))
    .catch((error: unknown) => {
      console.error("[sessionLifecycle] clearWokeMarker failed", { sessionId, error });
    });
}

/**
 * Auto-handoff rules ride the EXISTING automations surface: there is no chat
 * -menu IPC channel. `saveDraft` upserts by rule id, `list` reads them back and
 * `deleteRule` removes them, so the Work menu can add, edit and remove one
 * without the Automations tab ever being open.
 */
export function automationRulesReadable(): boolean {
  return typeof window.ade?.automations?.list === "function";
}

export async function listAutomationRules(): Promise<AutomationRuleSummary[]> {
  const list = window.ade?.automations?.list;
  if (!list) return [];
  try {
    return await list();
  } catch (error) {
    console.error("[sessionLifecycle] automations.list failed", error);
    return [];
  }
}

/**
 * Writes one rule per selected condition and deletes the ones the user turned
 * off. Writes run FIRST: `saveDraft` upserts by id, so the worst a partial
 * write can leave behind is the old rule next to the new one, whereas deleting
 * first and then throwing on the second draft leaves the user with the rules
 * they had removed and only half of what they asked for. Resolves `false` when
 * anything failed — including a delete — so the caller keeps the modal open on
 * the user's input.
 */
export async function saveAutoHandoffRules(args: {
  drafts: readonly AutomationRuleDraft[];
  staleRuleIds: readonly string[];
  sessionId: string;
}): Promise<boolean> {
  const automations = window.ade?.automations;
  if (!automations?.saveDraft) {
    reportFailure("Auto handoff", args.sessionId, new Error("Automations are unavailable in this window."));
    return false;
  }
  try {
    for (const draft of args.drafts) {
      await automations.saveDraft({ draft });
    }
    // A delete that failed for anything other than "already gone" leaves the
    // rule the user just turned off still ARMED, so its result decides the
    // outcome instead of being discarded under a "saved" toast.
    const { failure } = await deleteAutomationRules(args.staleRuleIds);
    if (failure) {
      reportFailure(
        "Auto handoff",
        args.sessionId,
        new Error("The conditions you turned off could not be removed, so they are still armed."),
      );
      return false;
    }
    showToast({
      id: `auto-handoff:${args.sessionId}`,
      title: args.drafts.length ? "Auto handoff saved" : "Auto handoff removed",
      message: args.drafts.length
        ? `${args.drafts.length} condition${args.drafts.length === 1 ? "" : "s"} armed.`
        : undefined,
    });
    return true;
  } catch (error) {
    reportFailure("Auto handoff", args.sessionId, error);
    return false;
  }
}

/**
 * Deletes rules by id and says nothing about it — no toast, no error report.
 * Missing ids are not an error: "Remove auto handoff" must succeed even when
 * one of the conditions was already retired by a one-shot run.
 *
 * Returns the first real failure so the caller decides how to phrase it.
 * `attempted` is false when there was nothing to delete (or no automations
 * surface at all), which is what keeps the toasting wrapper from announcing a
 * removal that never happened.
 */
export async function deleteAutomationRules(
  ruleIds: readonly string[],
): Promise<{ attempted: boolean; failure: unknown }> {
  const deleteRule = window.ade?.automations?.deleteRule;
  if (!deleteRule || ruleIds.length === 0) return { attempted: false, failure: null };
  let failure: unknown = null;
  for (const id of ruleIds) {
    try {
      await deleteRule({ id });
    } catch (error) {
      // `deleteRule` throws for an id that is not in the local config. A rule
      // this menu armed can retire itself (one-shot, or `maxRuns` reached), so
      // "already gone" is the success case, not a failure to report.
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) continue;
      failure = failure ?? error;
    }
  }
  return { attempted: true, failure };
}

/**
 * `deleteAutomationRules` plus the user-facing half: a confirmation toast, or
 * the error report. This is the "Remove auto handoff" menu item.
 *
 * Split from the core rather than gated by a `silent` flag, because the flag
 * suppressed the toast AND the error report together — so `saveAutoHandoffRules`,
 * which folds a failed sweep into its own message, had to ask for silence to get
 * the one behaviour it wanted, and one call site's needs were spelled as a
 * negation of the other's.
 */
export async function removeAutomationRules(ruleIds: readonly string[]): Promise<boolean> {
  const { attempted, failure } = await deleteAutomationRules(ruleIds);
  if (failure) {
    reportFailure("Remove auto handoff", ruleIds[0] ?? "", failure);
    return false;
  }
  if (attempted) {
    showToast({ id: `auto-handoff-remove:${ruleIds[0]}`, title: "Auto handoff removed" });
  }
  return true;
}

export async function setChatSpawnKind(
  session: Pick<TerminalSessionSummary, "id">,
  spawnKind: "subagent" | "peer",
  pin?: OpenProjectBinding | null,
): Promise<void> {
  const action = spawnKind === "peer" ? "Take over" : "Promote to subagent";
  try {
    await (pin
      ? window.ade.agentChat.updateSession({ sessionId: session.id, spawnKind }, pin)
      : window.ade.agentChat.updateSession({ sessionId: session.id, spawnKind }));
  } catch (error) {
    reportFailure(action, session.id, error);
  }
}
