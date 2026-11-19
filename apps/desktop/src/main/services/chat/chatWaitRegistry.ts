import { randomUUID } from "node:crypto";
import {
  chatWaitsOnUser,
  chatWaitTargetMatches,
  type ArmChatWaitArgs,
  type ChatWaiter,
  type ChatWaitForArgs,
  type ChatWaitForResult,
} from "../../../shared/chatWait";
import type { AgentChatMessageSessionArgs } from "../../../shared/types";
import { isMovedAwayChatError, type CrossMachineMoveLock } from "../../../shared/crossMachineMoveLock";
import type { Logger } from "../logging/logger";

/**
 * Event-driven chat waits.
 *
 * `waitFor` long-polls one chat; durable waiters (`armWait`) wake a caller, or
 * send a queued prompt, once other chats reach a state. Both re-check when a
 * chat emits an event (`signal`), with a slow timer only as a backstop for
 * state that changes without an event.
 */

const CHAT_WAITERS_STATE_KEY = "agent-chat:waiters:v1";
// Under the brain's default action timeout; the CLI loops over these.
const CHAT_WAIT_LONG_POLL_MAX_MS = 25_000;
const CHAT_WAIT_BACKSTOP_MS = 15_000;
const CHAT_WAIT_CHECK_DEBOUNCE_MS = 250;
const CHAT_WAIT_DEFAULT_TIMEOUT_MINUTES = 24 * 60;
// A wake held for a session that cannot take it yet is dropped this long after
// its wait's own deadline, so one that can never be delivered does not stay.
const CHAT_WAIT_UNDELIVERED_GRACE_MS = 60 * 60_000;

/**
 * Thrown by `messageSession` when nothing was delivered because the session
 * cannot take a wake yet (a tracked agent CLI mid-turn). The waiter stays
 * armed and is tried again.
 */
export class ChatWakeDeferredError extends Error {
  constructor(sessionId: string) {
    super(`Session '${sessionId}' cannot take a wake yet.`);
    this.name = "ChatWakeDeferredError";
  }
}

export function isChatWakeDeferredError(error: unknown): error is ChatWakeDeferredError {
  return error instanceof ChatWakeDeferredError;
}

/** Whether a wake held for a session that cannot take it is past saving (see `CHAT_WAIT_UNDELIVERED_GRACE_MS`). */
function pastUndeliveredGrace(expiresAt: string, nowMs: number): boolean {
  return Date.parse(expiresAt) + CHAT_WAIT_UNDELIVERED_GRACE_MS <= nowMs;
}

export type ChatWaitRegistryDeps = {
  logger: Logger;
  db: { getJson: (key: string) => unknown; setJson: (key: string, value: unknown) => void } | null;
  /** The chat's summary (or a CLI session's turn status); null when it is gone. */
  readSummary: (sessionId: string) => Promise<Record<string, unknown> | null>;
  /** One line naming a target and where it is now, for the wake text. */
  describeTarget: (sessionId: string) => Promise<string>;
  sessionExists: (sessionId: string) => boolean;
  /**
   * Deliver a wake or a queued prompt. Throws `ChatWakeDeferredError` when
   * the session cannot take it yet; the waiter then stays armed.
   */
  messageSession: (args: AgentChatMessageSessionArgs) => Promise<unknown>;
  /**
   * Whether a wake or a queued prompt can ever reach this session: an agent
   * chat, or a tracked agent CLI. A wait that could never be delivered is
   * refused when it is armed, not lost when it fires.
   */
  canReceiveWake?: (sessionId: string) => boolean;
  /**
   * Whether this session cannot take a wake yet: a tracked agent CLI that is
   * mid-turn. Its waiter stays armed until the CLI's next turn boundary, so a
   * wake is never typed into a turn that is still running.
   */
  wakeDeferred?: (sessionId: string) => boolean;
  /**
   * Whether this session is a tracked agent CLI. A text queued for it
   * (`isQueuedCliTextWaiter`) waits only for `wakeDeferred`, the check an
   * immediate send makes (a turn running, a menu or question the CLI
   * reported), and never for the CLI's Work-row status: a hand ADE raised
   * over an idle prompt ("Waiting for input: …"), or a guessed "running" left
   * by recent output, held a queued text for good while the person's later
   * texts queued behind it.
   */
  isAgentCliSession?: (sessionId: string) => boolean;
  /**
   * Whether another live brain runs this chat. Waiters live in the shared
   * project database, so every brain on it loads them; only the brain that
   * runs the chat to be woken may fire one.
   */
  ownedByAnotherBrain: (sessionId: string) => boolean;
  /** Locked destinations keep their waiter pending for the return or resume-here choice. */
  getMovedAwayTarget?: (sessionId: string) => CrossMachineMoveLock | null;
  /**
   * Throws when another live brain runs the chat a new waiter would deliver
   * to. Only that brain can deliver it, and it reads waiters at startup only,
   * so a waiter armed here would never fire.
   */
  assertDeliverableHere: (sessionId: string) => void;
  /** Resolves once the chat service can read summaries (startup finished). */
  whenReady: () => Promise<void>;
  /**
   * Whether the chat service already tells `callerSessionId` itself when
   * `targetSessionId` waits on the user (its own subagent), so a waiter does
   * not say it a second time.
   */
  callerToldOfUserWait?: (targetSessionId: string, callerSessionId: string) => boolean;
  /**
   * Whether this brain is running `sessionId` now. A `send` wait is checked by
   * the brain that runs the chat it will send to, which need not be the one
   * that runs its caller; a message to a chat another machine owns would start
   * a second provider process here.
   */
  callerIsLiveHere?: (sessionId: string) => boolean;
};

/** After a CLI's turn ends, its prompt settles within a few seconds (`AGENT_CLI_READY_QUIET_MS` in `ptyService.ts`). */
const CLI_TURN_END_RECHECK_MS = [800, 2_500] as const;

/**
 * A text queued for a session to type when it is free: a send wait on that
 * session itself, for "idle" (`armQueuedAgentCliSend` in `agentChatService.ts`).
 */
export function isQueuedCliTextWaiter(waiter: ChatWaiter): waiter is ChatWaiter & { action: { kind: "send"; sessionId: string } } {
  return waiter.action.kind === "send"
    && waiter.waitFor === "idle"
    && waiter.targetSessionIds.length === 1
    && waiter.targetSessionIds[0] === waiter.action.sessionId;
}

function waiterMatched(waiter: ChatWaiter, results: Array<{ matches: boolean }>): boolean {
  if (waiter.matchedWhileDeferred === true) return true;
  return waiter.mode === "all"
    ? results.every((result) => result.matches)
    : results.some((result) => result.matches);
}

export function createChatWaitRegistry(deps: ChatWaitRegistryDeps) {
  const { logger } = deps;
  const listeners = new Map<string, Set<() => void>>();
  let waiters: ChatWaiter[] = (() => {
    try {
      const raw = deps.db?.getJson(CHAT_WAITERS_STATE_KEY);
      return Array.isArray(raw) ? (raw as ChatWaiter[]).filter((entry) => entry && typeof entry.id === "string") : [];
    } catch {
      return [];
    }
  })();
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let checking = false;
  let recheck = false;
  let backstop: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  const turnEndTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Queued CLI texts taken out of the queue to be typed, not yet typed or put back, by CLI. */
  const cliTextsInFlight = new Map<string, number>();

  const persist = (): void => {
    try {
      deps.db?.setJson(CHAT_WAITERS_STATE_KEY, waiters);
    } catch (error) {
      logger.warn("agent_chat.waiters_persist_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const syncBackstop = (): void => {
    if (waiters.length === 0) {
      if (backstop) clearInterval(backstop);
      backstop = null;
      return;
    }
    if (backstop || disposed) return;
    backstop = setInterval(scheduleCheck, CHAT_WAIT_BACKSTOP_MS);
    backstop.unref?.();
  };

  const fire = async (waiter: ChatWaiter, outcome: "matched" | "expired"): Promise<void> => {
    if (waiter.action.kind === "send") {
      if (outcome === "expired") {
        logger.info("agent_chat.wait_send_expired", { waiterId: waiter.id, sessionId: waiter.action.sessionId });
        return;
      }
      await deps.messageSession({
        sessionId: waiter.action.sessionId,
        kind: "wake",
        text: waiter.action.text,
        ...(waiter.action.metadata ? { metadata: waiter.action.metadata } : {}),
      });
      return;
    }
    if (!waiter.callerSessionId) return;
    const lines = await Promise.all(waiter.targetSessionIds.map(deps.describeTarget));
    const verb = waiter.mode === "all" ? "All the chats you were waiting on" : "A chat you were waiting on";
    const header = outcome === "matched"
      ? `${verb} reached "${waiter.waitFor}":`
      : `Your wait (for ${waiter.mode} to reach "${waiter.waitFor}") timed out. Where they are now:`;
    await deps.messageSession({
      sessionId: waiter.callerSessionId,
      kind: "wake",
      text: [header, ...lines, "", "Read a chat with `ade chat read <id>` before acting on it."].join("\n"),
      // ADE wrote this, not the user: it must not clear the chat's "Needs you".
      metadata: { hostContinuation: { reason: "chat_wait" } },
    });
  };

  /**
   * Whether a target is at the state, and the card id when it waits on the
   * user instead. A read that throws is "not yet", never a match.
   */
  const readTarget = async (
    target: string,
    waiter: ChatWaiter,
  ): Promise<{ matches: boolean; userWaitItemId: string | null }> => {
    try {
      const summary = await deps.readSummary(target);
      if (summary) {
        const matches = chatWaitTargetMatches(summary, waiter.waitFor);
        // `pendingInputUserOnly` is only ever set together with a non-empty
        // `pendingInputItemId` (the summary builder resolves the card by id
        // first), so this key names one card and not "every later card".
        const userWaitItemId = !matches && chatWaitsOnUser(summary, waiter.waitFor)
          ? (typeof summary.pendingInputItemId === "string" ? summary.pendingInputItemId : "")
          : null;
        return { matches, userWaitItemId };
      }
      // No summary for a chat that still exists is a read not ready yet. A
      // deleted one is as finished as it will ever be — idle or terminal —
      // but never "active" or "awaiting input".
      if (deps.sessionExists(target)) return { matches: false, userWaitItemId: null };
      return { matches: waiter.waitFor === "idle" || waiter.waitFor === "terminal", userWaitItemId: null };
    } catch {
      return { matches: false, userWaitItemId: null };
    }
  };

  type UserWaitNotice = { waiter: ChatWaiter; untold: Array<{ target: string; itemId: string }> };

  /**
   * A target of a waiter waits on the user: remember the card so it is reported
   * once, and return what still has to be said. Without this a coordinator
   * slept on a peer until the wait's own deadline, a day later, and a peer
   * never wakes its parent itself.
   *
   * A wait that wakes its caller and a wait that queues a send both tell their
   * caller; only a send wait's caller has to be running here, because the wait
   * is checked by the brain that runs the send's target.
   */
  const collectUserWaitNotice = (
    waiter: ChatWaiter,
    userWaits: Array<{ target: string; itemId: string }>,
  ): UserWaitNotice | null => {
    const callerSessionId = waiter.callerSessionId;
    if (!callerSessionId) return null;
    if (waiter.action.kind === "send" && deps.callerIsLiveHere && !deps.callerIsLiveHere(callerSessionId)) {
      // Not recorded: if the caller ever runs here, the next check tells it.
      return null;
    }
    const noticed = new Set(Array.isArray(waiter.userWaitsNoticed) ? waiter.userWaitsNoticed : []);
    const fresh = userWaits.filter(({ target, itemId }) => !noticed.has(`${target}:${itemId}`));
    if (fresh.length === 0) return null;
    for (const { target, itemId } of fresh) noticed.add(`${target}:${itemId}`);
    // Recorded before delivery, as a fire is: a failed message is not retried
    // every check.
    waiter.userWaitsNoticed = [...noticed].slice(-64);
    persist();
    const untold = fresh.filter(({ target }) => !deps.callerToldOfUserWait?.(target, callerSessionId));
    return untold.length === 0 ? null : { waiter, untold };
  };

  /** Tell the caller of `notice` once per card. The waiter stays armed. */
  const deliverUserWaitNotice = async ({ waiter, untold }: UserWaitNotice): Promise<void> => {
    const callerSessionId = waiter.callerSessionId;
    if (!callerSessionId) return;
    try {
      const lines = await Promise.all(untold.map(({ target }) => deps.describeTarget(target)));
      const queuedSend = waiter.action.kind === "send";
      await deps.messageSession({
        sessionId: callerSessionId,
        kind: "wake",
        text: [
          `${untold.length === 1 ? "A chat" : "Chats"} you are waiting on (for "${waiter.waitFor}") now ${untold.length === 1 ? "waits" : "wait"} on the user:`,
          ...lines,
          "",
          "Only the user can answer that card; an agent cannot.",
          queuedSend
            ? "The prompt you queued is sent when they answer and that chat moves on; this wait stays armed until then."
            : "Your wait stays armed and fires when it is answered and the chat moves on.",
          "Do not start another chat for the same work. Tell the user if it is urgent.",
        ].join("\n"),
        // ADE wrote this, not the user: it must not clear the chat's "Needs you".
        metadata: { hostContinuation: { reason: "chat_wait" } },
      });
    } catch (error: unknown) {
      if (isChatWakeDeferredError(error)) {
        // Nothing reached the caller: forget these cards so a later check tells it.
        const untoldKeys = new Set(untold.map(({ target, itemId }) => `${target}:${itemId}`));
        waiter.userWaitsNoticed = (waiter.userWaitsNoticed ?? []).filter((key) => !untoldKeys.has(key));
        persist();
        return;
      }
      logger.warn("agent_chat.wait_user_notice_failed", {
        waiterId: waiter.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const checkOnce = async (): Promise<void> => {
    if (waiters.length === 0) return;
    const nowMs = Date.now();
    const due: Array<{ waiter: ChatWaiter; outcome: "matched" | "expired" }> = [];
    const notices: UserWaitNotice[] = [];
    for (const waiter of [...waiters]) {
      const deliverTo = waiter.action.kind === "send" ? waiter.action.sessionId : waiter.callerSessionId;
      if (deliverTo && deps.getMovedAwayTarget?.(deliverTo)) continue;
      if (deliverTo && deps.ownedByAnotherBrain(deliverTo)) continue;
      // A text queued for a tracked agent CLI is always due (see
      // `isAgentCliSession`): only `wakeDeferred` below holds it.
      const cliText = isQueuedCliTextWaiter(waiter) && deps.isAgentCliSession?.(waiter.action.sessionId) === true;
      const results = cliText
        ? []
        : await Promise.all(waiter.targetSessionIds.map((target) => readTarget(target, waiter)));
      const matched = cliText || waiterMatched(waiter, results);
      const expired = Date.parse(waiter.expiresAt) <= nowMs;
      const deferred = Boolean(deliverTo && deps.wakeDeferred?.(deliverTo));
      if (deferred && (matched || expired)) {
        if (matched && !cliText && !waiter.matchedWhileDeferred) {
          waiter.matchedWhileDeferred = true;
          persist();
        }
        // Held for the session's next turn boundary, within a grace past the
        // wait's own deadline; after that it can never be delivered.
        if (pastUndeliveredGrace(waiter.expiresAt, nowMs)) {
          waiters = waiters.filter((candidate) => candidate.id !== waiter.id);
          persist();
          syncBackstop();
          logger.warn("agent_chat.wait_undeliverable_dropped", { waiterId: waiter.id, sessionId: deliverTo });
        }
        continue;
      }
      if (matched) due.push({ waiter, outcome: "matched" });
      else if (expired) due.push({ waiter, outcome: "expired" });
      else {
        const userWaits = waiter.targetSessionIds.flatMap((target, index) => {
          const itemId = results[index]?.userWaitItemId;
          return itemId == null ? [] : [{ target, itemId }];
        });
        // A caller that cannot take a message yet is told at a later check;
        // nothing is recorded until then.
        const callerDeferred = Boolean(waiter.callerSessionId && deps.wakeDeferred?.(waiter.callerSessionId));
        const notice = userWaits.length && !callerDeferred ? collectUserWaitNotice(waiter, userWaits) : null;
        if (notice) notices.push(notice);
      }
    }
    // A wait cancelled while the targets were read does not fire.
    const live = new Set(waiters.map((waiter) => waiter.id));
    const firing = due.filter((entry) => live.has(entry.waiter.id));
    if (firing.length > 0) {
      const firingIds = new Set(firing.map((entry) => entry.waiter.id));
      // Removed before delivery: a waiter fires once even if delivery throws.
      waiters = waiters.filter((waiter) => !firingIds.has(waiter.id));
      persist();
      syncBackstop();
      // Queued texts of this pass stay ahead of a new text until each is
      // delivered or back in the queue (`hasCliTextsInFlight`).
      const cliTextTo = (waiter: ChatWaiter): string | null =>
        isQueuedCliTextWaiter(waiter) ? waiter.action.sessionId : null;
      const releaseInFlight = (waiter: ChatWaiter): void => {
        const cli = cliTextTo(waiter);
        if (!cli) return;
        const left = (cliTextsInFlight.get(cli) ?? 1) - 1;
        if (left > 0) cliTextsInFlight.set(cli, left);
        else cliTextsInFlight.delete(cli);
      };
      for (const { waiter } of firing) {
        const cli = cliTextTo(waiter);
        if (cli) cliTextsInFlight.set(cli, (cliTextsInFlight.get(cli) ?? 0) + 1);
      }
      /** CLIs that refused a queued text in this pass: their later texts wait too, in order. */
      const heldCliTexts = new Set<string>();
      const requeue = (waiter: ChatWaiter): void => {
        if (waiters.some((candidate) => candidate.id === waiter.id)) return;
        // In the order it was armed, so a held text stays ahead of a later one.
        const at = waiters.findIndex((candidate) => candidate.createdAt > waiter.createdAt);
        if (at < 0) waiters.push(waiter);
        else waiters.splice(at, 0, waiter);
        persist();
        syncBackstop();
        scheduleCheck();
      };
      for (const { waiter, outcome } of firing) {
        const cli = cliTextTo(waiter);
        try {
          if (cli && heldCliTexts.has(cli)) {
            requeue(waiter);
            continue;
          }
          await fire(waiter, outcome);
          logger.info("agent_chat.wait_fired", { waiterId: waiter.id, outcome, action: waiter.action.kind });
        } catch (error) {
          if (isMovedAwayChatError(error) || isChatWakeDeferredError(error)) {
            if (isChatWakeDeferredError(error)) {
              if (pastUndeliveredGrace(waiter.expiresAt, Date.now())) {
                logger.warn("agent_chat.wait_undeliverable_dropped", { waiterId: waiter.id, outcome });
                continue;
              }
              logger.info("agent_chat.wait_fire_deferred", { waiterId: waiter.id, outcome });
              if (outcome === "matched") waiter.matchedWhileDeferred = true;
              if (cli) heldCliTexts.add(cli);
            }
            requeue(waiter);
            continue;
          }
          logger.warn("agent_chat.wait_fire_failed", {
            waiterId: waiter.id,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          releaseInFlight(waiter);
        }
      }
    }
    // After the fires, so a wake is never held behind a chat that is slow to
    // take a message. A wait cancelled while the targets were being read does
    // not speak either.
    for (const notice of notices) {
      if (!waiters.some((waiter) => waiter.id === notice.waiter.id)) continue;
      await deliverUserWaitNotice(notice);
    }
  };

  /** One check at a time: a check asked for while one runs runs after it. */
  const runCheck = async (): Promise<void> => {
    if (checking) {
      recheck = true;
      return;
    }
    checking = true;
    try {
      await checkOnce();
    } catch (error) {
      logger.warn("agent_chat.wait_check_failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      checking = false;
    }
    if (recheck) {
      recheck = false;
      scheduleCheck();
    }
  };

  function scheduleCheck(): void {
    if (checkTimer || disposed) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      void runCheck();
    }, CHAT_WAIT_CHECK_DEBOUNCE_MS);
    checkTimer.unref?.();
  }

  /** A chat emitted an event: wake its long-polls and re-check waiters on it. */
  const signal = (sessionId: string): void => {
    const waiting = listeners.get(sessionId);
    if (waiting?.size) {
      // After the event lands, so a re-read sees the new state.
      setTimeout(() => {
        for (const listener of [...waiting]) listener();
      }, 0);
    }
    if (waiters.some((waiter) => waiter.targetSessionIds.includes(sessionId))) scheduleCheck();
  };

  return {
    signal,

    /**
     * A tracked agent CLI's turn ended, so it may take what is held for it:
     * re-check the waiters on it and those that deliver to it (a wake for it,
     * a text queued for it) now, and again once its prompt has settled, the
     * moment `wakeDeferred` can first say no. Otherwise only the backstop
     * looks again, up to 15 s later.
     */
    signalCliTurnEnded(sessionId: string): void {
      const recheck = () => {
        signal(sessionId);
        if (waiters.some((waiter) =>
          waiter.callerSessionId === sessionId
          || (waiter.action.kind === "send" && waiter.action.sessionId === sessionId))) scheduleCheck();
      };
      recheck();
      for (const delayMs of CLI_TURN_END_RECHECK_MS) {
        const timer = setTimeout(() => {
          turnEndTimers.delete(timer);
          if (!disposed) recheck();
        }, delayMs);
        timer.unref?.();
        turnEndTimers.add(timer);
      }
    },

    /** Resolve once `sessionId`'s summary matches, the budget runs out, or it is gone. */
    async waitFor({ sessionId, waitFor: target = "idle", timeoutMs, stopWhenUserWaits }: ChatWaitForArgs): Promise<ChatWaitForResult> {
      const id = sessionId.trim();
      const budget = Math.max(0, Math.min(CHAT_WAIT_LONG_POLL_MAX_MS, Math.floor(timeoutMs ?? CHAT_WAIT_LONG_POLL_MAX_MS)));
      const deadline = Date.now() + budget;
      for (;;) {
        const summary = await deps.readSummary(id);
        if (!summary) return { matched: false, missing: true, summary: null };
        if (chatWaitTargetMatches(summary, target)) return { matched: true, summary };
        if (stopWhenUserWaits === true && chatWaitsOnUser(summary, target)) {
          return { matched: false, waitingOnUser: true, summary };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { matched: false, summary };
        await new Promise<void>((resolve) => {
          const set = listeners.get(id) ?? new Set<() => void>();
          listeners.set(id, set);
          const done = () => {
            clearTimeout(timer);
            set.delete(done);
            if (set.size === 0) listeners.delete(id);
            resolve();
          };
          const timer = setTimeout(done, Math.min(remaining, CHAT_WAIT_BACKSTOP_MS));
          set.add(done);
        });
      }
    },

    /**
     * Arm a durable wait: wake the caller (or send a queued prompt to another
     * chat) once all — or any — of the targets reach the state. Survives brain
     * restarts and fires once.
     */
    async arm(args: ArmChatWaitArgs): Promise<ChatWaiter> {
      const targets = [...new Set((args.targetSessionIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))];
      if (targets.length === 0) throw new Error("Name at least one chat to wait on.");
      for (const target of targets) {
        if (!deps.sessionExists(target)) throw new Error(`No chat or terminal '${target}' in this project.`);
        // A plain shell has no state to wait on; refuse it rather than hang.
        if ((await deps.readSummary(target).catch(() => ({}))) === null) {
          throw new Error(`'${target}' is not a chat or an agent CLI session, so it has nothing to wait for.`);
        }
      }
      const sendTo = args.sendToSessionId?.trim() || null;
      const text = args.text?.trim() || "";
      const caller = args.callerSessionId?.trim() || null;
      if (sendTo && !text) throw new Error("A prompt is required to send once the wait is over.");
      if (!sendTo && !caller) throw new Error("A wait needs a chat to wake (run it from a chat, or pass the caller).");
      if (deps.canReceiveWake) {
        if (sendTo && !deps.canReceiveWake(sendTo)) {
          throw new Error(`'${sendTo}' is not an agent chat or an agent CLI session in this project, so a prompt cannot be sent to it.`);
        }
        if (!sendTo && caller && !deps.canReceiveWake(caller)) {
          throw new Error(
            `'${caller}' cannot be woken: it is not an agent chat or an agent CLI session in this project. `
              + "Check on the chats with `ade chat status <id>` instead.",
          );
        }
      }
      deps.assertDeliverableHere((sendTo ?? caller)!);
      const minutes = Number.isFinite(args.timeoutMinutes) && (args.timeoutMinutes ?? 0) > 0
        ? Math.floor(args.timeoutMinutes!)
        : CHAT_WAIT_DEFAULT_TIMEOUT_MINUTES;
      const now = Date.now();
      const waiter: ChatWaiter = {
        id: randomUUID(),
        callerSessionId: caller,
        targetSessionIds: targets,
        mode: args.mode === "any" ? "any" : "all",
        waitFor: args.waitFor ?? "idle",
        action: sendTo
          ? {
            kind: "send",
            sessionId: sendTo,
            text,
            ...(args.sendMetadata && typeof args.sendMetadata === "object" ? { metadata: args.sendMetadata } : {}),
          }
          : { kind: "wake" },
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + minutes * 60_000).toISOString(),
      };
      waiters = [...waiters, waiter];
      persist();
      syncBackstop();
      scheduleCheck();
      return waiter;
    },

    /**
     * Whether queued texts for this CLI are being typed now. They are out of
     * the queue (`list` does not show them), but a new text still goes behind them.
     */
    hasCliTextsInFlight(sessionId: string): boolean {
      return (cliTextsInFlight.get(sessionId) ?? 0) > 0;
    },

    async list(args: { sessionId?: string } = {}): Promise<ChatWaiter[]> {
      const id = args.sessionId?.trim();
      return id
        ? waiters.filter((waiter) =>
          waiter.callerSessionId === id
          || waiter.targetSessionIds.includes(id)
          || (waiter.action.kind === "send" && waiter.action.sessionId === id))
        : [...waiters];
    },

    async cancel({ waiterId }: { waiterId: string }): Promise<{ cancelled: boolean }> {
      const before = waiters.length;
      waiters = waiters.filter((waiter) => waiter.id !== waiterId);
      if (waiters.length === before) return { cancelled: false };
      persist();
      syncBackstop();
      return { cancelled: true };
    },

    /** Waiters armed before a restart resume watching once the service is ready. */
    start(): void {
      if (waiters.length === 0) return;
      syncBackstop();
      void deps.whenReady().then(scheduleCheck).catch(() => {});
    },

    dispose(): void {
      disposed = true;
      if (backstop) clearInterval(backstop);
      if (checkTimer) clearTimeout(checkTimer);
      for (const timer of turnEndTimers) clearTimeout(timer);
      turnEndTimers.clear();
      backstop = null;
      checkTimer = null;
    },
  };
}

export type ChatWaitRegistry = ReturnType<typeof createChatWaitRegistry>;
