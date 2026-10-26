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

export type ChatWaitRegistryDeps = {
  logger: Logger;
  db: { getJson: (key: string) => unknown; setJson: (key: string, value: unknown) => void } | null;
  /** The chat's summary (or a CLI session's turn status); null when it is gone. */
  readSummary: (sessionId: string) => Promise<Record<string, unknown> | null>;
  /** One line naming a target and where it is now, for the wake text. */
  describeTarget: (sessionId: string) => Promise<string>;
  sessionExists: (sessionId: string) => boolean;
  messageSession: (args: AgentChatMessageSessionArgs) => Promise<unknown>;
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
      const results = await Promise.all(waiter.targetSessionIds.map((target) => readTarget(target, waiter)));
      const matched = waiter.mode === "all"
        ? results.every((result) => result.matches)
        : results.some((result) => result.matches);
      if (matched) due.push({ waiter, outcome: "matched" });
      else if (Date.parse(waiter.expiresAt) <= nowMs) due.push({ waiter, outcome: "expired" });
      else {
        const userWaits = waiter.targetSessionIds.flatMap((target, index) => {
          const itemId = results[index]?.userWaitItemId;
          return itemId == null ? [] : [{ target, itemId }];
        });
        const notice = userWaits.length ? collectUserWaitNotice(waiter, userWaits) : null;
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
      for (const { waiter, outcome } of firing) {
        try {
          await fire(waiter, outcome);
          logger.info("agent_chat.wait_fired", { waiterId: waiter.id, outcome, action: waiter.action.kind });
        } catch (error) {
          if (isMovedAwayChatError(error)) {
            if (!waiters.some((candidate) => candidate.id === waiter.id)) {
              waiters.push(waiter);
              persist();
              syncBackstop();
              scheduleCheck();
            }
            continue;
          }
          logger.warn("agent_chat.wait_fire_failed", {
            waiterId: waiter.id,
            error: error instanceof Error ? error.message : String(error),
          });
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

  return {
    /** A chat emitted an event: wake its long-polls and re-check waiters on it. */
    signal(sessionId: string): void {
      const waiting = listeners.get(sessionId);
      if (waiting?.size) {
        // After the event lands, so a re-read sees the new state.
        setTimeout(() => {
          for (const listener of [...waiting]) listener();
        }, 0);
      }
      if (waiters.some((waiter) => waiter.targetSessionIds.includes(sessionId))) scheduleCheck();
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
      backstop = null;
      checkTimer = null;
    },
  };
}

export type ChatWaitRegistry = ReturnType<typeof createChatWaitRegistry>;
