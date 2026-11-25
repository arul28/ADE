import { CTO_NEED_LINE_MAX, type CtoNeed } from "../../../shared/types/cto";
import type { PrChecksStatus, PrReviewStatus, PrState } from "../../../shared/types/prs";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";

/**
 * The CTO's stall judge: it notices a chat the CTO started that has stopped
 * moving, and wakes the CTO once about it.
 *
 * The CTO wakes on its own for a person's message, a child's finished turn and
 * a schedule. A child that sits on a permission prompt, an unanswered
 * question, a red PR, or just idle after its turn reaches nobody: its finished
 * turn woke the CTO once, and the CTO may have stayed quiet then. The judge
 * reads each child's state when it changes (chat events) and on a slow timer,
 * and when one has been stuck for a few minutes it sends the CTO a
 * "Stall nudge:" message naming what is stuck and the child's last words.
 *
 * Each stall is told once: its key is the child, what it waits on and when it
 * last moved, so the same stall is never told twice, and a child that moves
 * and stalls again is a new stall. Keys survive a restart. Nudges to one CTO
 * are at least `NUDGE_GAP_MS` apart; stalls due inside the gap ride the next
 * nudge together.
 */

/** A child blocked on a card (question or permission) this long is stuck. */
export const CTO_STALL_WAIT_MS = 2 * 60_000;
/** A child idle after its turn this long is stuck. */
export const CTO_STALL_IDLE_MS = 3 * 60_000;
/** A child mid-turn with no event this long is stuck (a hung turn). */
export const CTO_STALL_HUNG_MS = 20 * 60_000;
/** A stall that began longer ago than this is history, not a stall. */
export const CTO_STALL_MAX_AGE_MS = 24 * 60 * 60_000;
/** The least time between two nudges to the same CTO. */
export const CTO_STALL_NUDGE_GAP_MS = 5 * 60_000;
/** The most stalls one nudge names; the rest ride the next one. */
const NUDGE_MAX_STALLS = 5;
/** The slow backstop read, for state that changes with no event (a PR's checks). */
const BACKSTOP_MS = 2 * 60_000;
/** The backstop when no child could stall: nothing is due, so read rarely. */
const IDLE_BACKSTOP_MS = 15 * 60_000;
/**
 * Stalls are minutes long, so an event only needs a pass soon, not now: a
 * streaming child would otherwise cost a pass over every child each second.
 */
const OBSERVE_DEBOUNCE_MS = 30_000;
const NUDGED_KEYS_STATE_KEY = "cto:stall-nudges:v1";
const NEEDS_STATE_KEY = "cto:needs:v1";
/** When each CTO was last nudged, so the gap holds across a restart. */
const LAST_NUDGE_STATE_KEY = "cto:stall-last-nudge:v1";
const NUDGED_KEYS_CAP = 400;
const NEEDS_CAP = 50;
const LAST_WORDS_MAX = 280;

export type CtoStallKind =
  | "question"
  | "permission"
  | "pr_fixable"
  | "pr_ready"
  | "idle"
  | "hung";

/** What the judge reads about one child. Built by the chat service; pure data. */
export type CtoChildFacts = {
  sessionId: string;
  title: string;
  /** The chat's last output, ISO (its start when it has none yet). Moves whenever the child does, and only then. */
  lastActivityAt: string;
  /**
   * When the running (or accepted) turn began, ISO; null between turns. A turn
   * that starts after a long pause is a move even before it writes anything.
   */
  turnStartedAt: string | null;
  /**
   * When the child's last turn failed, ISO. A turn that fails before any
   * output (a rate limit) moves the child too: someone or something retried it.
   */
  lastTurnFailedAt: string | null;
  /** Archived or gone. A chat whose runtime stopped (a brain restart) is not ended: it resumes on send. */
  ended: boolean;
  turnActive: boolean;
  /** The child waits on a card. `pendingKind` says which kind, when the card is loaded here. */
  awaitingInput: boolean;
  pendingKind: "question" | "permission" | null;
  /** The card's question or permission, in one line. */
  pendingText: string | null;
  /**
   * The card on screen, by id: a different card is a new stall. Undefined when
   * not known (the chat is not loaded here, so its cards cannot be read).
   */
  pendingKey?: string | null;
  /** When ADE first saw this card, ISO. Only times the wait; never part of a key. */
  pendingSeenAt: string | null;
  /**
   * The child is quiet on purpose and is nobody's to chase: settled, snoozed,
   * archived, parked at a usage limit, waiting on its own background work, a
   * schedule or a PR watch.
   */
  quietOnPurpose: boolean;
  /** The open PR the child works on, when there is one. */
  pr: {
    number: number;
    state: PrState;
    mergeConflicts: boolean;
    checks: PrChecksStatus;
    behindBaseBy: number | null;
    review: PrReviewStatus;
  } | null;
  /** The child's last reply, when the judge needs it for the nudge. */
  lastWords: string | null;
};

export type CtoChildStall = {
  childSessionId: string;
  title: string;
  kind: CtoStallKind;
  /** What is stuck, as the nudge says it. */
  what: string;
  /** When the stuck state began, ms. */
  sinceMs: number;
  /** Same stall, same key; a child that moved has a new one. */
  stateKey: string;
  lastWords: string | null;
};

/** What a child could mend itself on its PR, or null when it has nothing to mend. */
export function fixablePrProblem(pr: NonNullable<CtoChildFacts["pr"]>): string | null {
  if (pr.state !== "open" && pr.state !== "draft") return null;
  if (pr.mergeConflicts) return `PR #${pr.number} has merge conflicts`;
  // A draft's red checks are stale by design: it waits on a look, not a fix.
  if (pr.checks === "failing" && pr.state === "open") return `PR #${pr.number} has failing checks`;
  if (pr.review === "changes_requested") return `a review on PR #${pr.number} asked for changes`;
  if ((pr.behindBaseBy ?? 0) > 0) return `PR #${pr.number} is behind its base branch`;
  return null;
}

/** An open PR with nothing left for the child: green or no checks, no conflict, nothing requested. */
function prReady(pr: NonNullable<CtoChildFacts["pr"]>): boolean {
  return pr.state === "open"
    && !pr.mergeConflicts
    && (pr.checks === "passing" || pr.checks === "none")
    && pr.review !== "changes_requested";
}

function latestMs(...times: Array<string | null | undefined>): number {
  let latest = Number.NaN;
  for (const time of times) {
    const ms = time ? Date.parse(time) : Number.NaN;
    if (Number.isFinite(ms) && !(ms <= latest)) latest = ms;
  }
  return latest;
}

/** The child's last move, ISO: its last output, the start of the turn it runs now, or its last failed turn, whichever is latest. */
export function ctoChildMovedAt(facts: Pick<CtoChildFacts, "lastActivityAt" | "turnStartedAt" | "lastTurnFailedAt">): string {
  const ms = latestMs(facts.lastActivityAt, facts.turnStartedAt, facts.lastTurnFailedAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : facts.lastActivityAt;
}

/**
 * A need holds while it is newer than the child's last move, and, when it was
 * set on a card, while that card is still the one on screen (an answered card
 * may not move the child's output before its next one).
 */
export function ctoNeedIsLive(
  need: { setAt: string; pendingKey?: string | null },
  child: { movedAt: string | null | undefined; pendingKey?: string | null },
): boolean {
  const setMs = Date.parse(need.setAt);
  if (!Number.isFinite(setMs)) return false;
  if (need.pendingKey && child.pendingKey !== undefined && child.pendingKey !== need.pendingKey) return false;
  const movedMs = child.movedAt ? Date.parse(child.movedAt) : Number.NaN;
  return !Number.isFinite(movedMs) || movedMs <= setMs;
}

/**
 * When this child's current state began and when it would count as stuck,
 * ms. One clock for the judge and its "look again at" time. Null for a child
 * that cannot stall (ended, quiet on purpose, or with no readable time).
 */
function stallClock(facts: CtoChildFacts): { movedAt: string; movedMs: number; sinceMs: number; dueMs: number } | null {
  if (facts.ended || facts.quietOnPurpose) return null;
  const movedAt = ctoChildMovedAt(facts);
  const movedMs = Date.parse(movedAt);
  if (!Number.isFinite(movedMs)) return null;
  if (facts.awaitingInput) {
    // A card that came up with no output since (an answer, then the next
    // approval) waits from when it was first seen, not from the last output.
    const sinceMs = latestMs(movedAt, facts.pendingSeenAt);
    return { movedAt, movedMs, sinceMs, dueMs: sinceMs + CTO_STALL_WAIT_MS };
  }
  return { movedAt, movedMs, sinceMs: movedMs, dueMs: movedMs + (facts.turnActive ? CTO_STALL_HUNG_MS : CTO_STALL_IDLE_MS) };
}

/**
 * Is this child stuck, and on what? Null when it is moving, quiet on purpose,
 * not stuck long enough yet, or stuck so long ago it is history.
 *
 * `need` is the CTO's own "waiting on you" line for this child: once the CTO
 * handed the stall to the person, it is not told about it again.
 */
export function judgeCtoChildStall(
  facts: CtoChildFacts,
  nowMs: number,
  need: { setAt: string; pendingKey?: string | null } | null = null,
): CtoChildStall | null {
  const clock = stallClock(facts);
  if (!clock) return null;
  const { movedAt, movedMs, sinceMs, dueMs } = clock;
  if (nowMs - movedMs > CTO_STALL_MAX_AGE_MS) return null;
  if (need && ctoNeedIsLive(need, { movedAt, pendingKey: facts.pendingKey })) return null;
  if (nowMs < dueMs) return null;
  const stall = (kind: CtoStallKind, what: string, keyPart: string): CtoChildStall => ({
    childSessionId: facts.sessionId,
    title: facts.title,
    kind,
    what,
    sinceMs,
    // Built from persisted values only, so a restart reads the same key.
    stateKey: `${facts.sessionId}:${keyPart}:${movedAt}`,
    lastWords: facts.lastWords,
  });

  if (facts.awaitingInput) {
    const pending = facts.pendingText?.trim();
    const detail = pending ? `: ${pending}` : "";
    // The key names the card, not its kind: the kind is only known once the
    // chat is loaded here, and loading it must not make the same card new.
    const keyPart = `card:${facts.pendingKey ?? ""}`;
    if (facts.pendingKind === "permission") return stall("permission", `waiting on a permission prompt${detail}`, keyPart);
    if (facts.pendingKind === "question") return stall("question", `waiting on an answer${detail}`, keyPart);
    return stall("question", "waiting on a question or permission prompt", keyPart);
  }
  if (facts.turnActive) {
    return stall("hung", `mid-turn with no output for ${Math.floor((nowMs - movedMs) / 60_000)} min`, "hung");
  }
  const problem = facts.pr ? fixablePrProblem(facts.pr) : null;
  if (problem && facts.pr) return stall("pr_fixable", `idle while ${problem}`, `pr_fixable:${problem}`);
  if (facts.pr && prReady(facts.pr)) {
    return stall("pr_ready", `idle with PR #${facts.pr.number} ready to merge or test`, `pr_ready:${facts.pr.number}`);
  }
  return stall("idle", "idle since its last turn", "idle");
}

/** When a child that is not stuck yet could be, ms; null when it cannot stall. */
export function ctoChildStallDueMs(facts: CtoChildFacts): number | null {
  return stallClock(facts)?.dueMs ?? null;
}

function minutesAgo(sinceMs: number, nowMs: number): string {
  const minutes = Math.max(1, Math.floor((nowMs - sinceMs) / 60_000));
  return minutes >= 120 ? `${Math.floor(minutes / 60)} h` : `${minutes} min`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Cut a need line to one line under the cap. Empty when nothing is left. */
export function normalizeCtoNeedLine(line: string): string {
  return oneLine(line, CTO_NEED_LINE_MAX);
}

/** The wake text. It opens with "Stall nudge:" so the doctrine and the person can tell it apart. */
export function formatCtoStallNudge(stalls: readonly CtoChildStall[], nowMs: number): string {
  const lines = stalls.map((item) => {
    const words = item.lastWords?.trim() ? ` Last message: "${oneLine(item.lastWords, LAST_WORDS_MAX)}"` : "";
    return `- "${item.title}" (${item.childSessionId}) is ${item.what}, for ${minutesAgo(item.sinceMs, nowMs)}.${words}`;
  });
  return [
    stalls.length === 1 ? "Stall nudge: a chat you started is stuck." : `Stall nudge: ${stalls.length} chats you started are stuck.`,
    ...lines,
    "",
    "Fix what is not the person's call by steering the chat (failing checks, conflicts, a branch behind its base, a question you can answer from what the person already said). "
      + "If it needs the person, setNeed it with one line. Otherwise stay quiet.",
  ].join("\n");
}

type KvDb = { getJson: (key: string) => unknown; setJson: (key: string, value: unknown) => void };

type StoredNeed = {
  childSessionId: string;
  line: string;
  setAt: string;
  ctoSessionId: string;
  /** The card on screen when the need was set; answering it ends the need. */
  pendingKey?: string | null;
  /** The child's title and lane when the need was set: shown while its chat cannot be read. */
  childTitle?: string;
  laneId?: string | null;
};

export type CtoStallJudgeDeps = {
  logger?: Pick<Logger, "info" | "warn"> | null;
  db: KvDb | null;
  /** The CTO session ids this service runs. Usually one. Throws when they cannot be listed. */
  listCtoSessionIds: () => Promise<string[]>;
  /**
   * The children of a CTO session this service runs, as the judge reads them.
   * Throws when the children cannot be listed, so a first run keeps its baseline.
   */
  readChildren: (ctoSessionId: string) => Promise<CtoChildFacts[]>;
  /**
   * What a need row reads about its child. Null only when the chat is gone;
   * a read that fails throws, and the need is kept until a read succeeds.
   */
  readNeedChild: (childSessionId: string) => Promise<CtoNeedChild | null>;
  /** The CTO is busy (mid-turn, or blocked on the person): a nudge waits. */
  ctoBusy: (ctoSessionId: string) => boolean;
  /** Wake the CTO with the nudge text. */
  wakeCto: (ctoSessionId: string, text: string) => Promise<void>;
  /** The CTO that owns this chat, when the chat is a CTO child here; cheap and synchronous. */
  ctoParentOf: (sessionId: string) => string | null;
  /** This chat is a CTO thread; cheap and synchronous. */
  isCtoSession: (sessionId: string) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/**
 * What a need row reads about its child. `movedAt` is its last move
 * (`ctoChildMovedAt`); `pendingKey` its card on screen, undefined when unknown.
 */
export type CtoNeedChild = {
  title: string;
  laneId: string | null;
  movedAt: string | null;
  ended: boolean;
  pendingKey?: string | null;
};

export type CtoStallJudge = {
  start: () => void;
  dispose: () => void;
  /** A chat event happened on this session. Cheap: checks run debounced. */
  observe: (sessionId: string) => void;
  /** Run one pass now. Tests and the backstop use it. */
  checkNow: () => Promise<void>;
  setNeed: (args: {
    ctoSessionId: string;
    childSessionId: string;
    line: string | null;
    /** The child's card on screen now, if any. */
    pendingKey?: string | null;
    /** Shown while the child's chat cannot be read. */
    childTitle?: string;
    laneId?: string | null;
  }) => { set: boolean; line: string | null };
  /** The live needs of one CTO, oldest first. Reads only the children that have one. */
  listNeeds: (ctoSessionId: string) => Promise<CtoNeed[]>;
};

export function createCtoStallJudge(deps: CtoStallJudgeDeps): CtoStallJudge {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  });
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const readNudged = (): string[] | null => {
    const raw = deps.db?.getJson(NUDGED_KEYS_STATE_KEY);
    return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === "string") : null;
  };
  // Null until the first pass: with no stored keys at all (a first run after
  // an upgrade), that pass records what is stuck now without telling anyone,
  // so a CTO with a day of idle children is not woken about all of them.
  const storedKeys = readNudged();
  const nudged = new Set<string>(storedKeys ?? []);
  let baselinePending = storedKeys === null;
  const saveNudged = () => {
    while (nudged.size > NUDGED_KEYS_CAP) {
      const [oldest] = nudged;
      if (oldest === undefined) break;
      nudged.delete(oldest);
    }
    try {
      deps.db?.setJson(NUDGED_KEYS_STATE_KEY, [...nudged]);
    } catch (error) {
      deps.logger?.warn("cto.stall_judge.save_failed", { error: getErrorMessage(error) });
    }
  };

  const readNeeds = (): StoredNeed[] => {
    const raw = deps.db?.getJson(NEEDS_STATE_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is StoredNeed => {
      if (!item || typeof item !== "object") return false;
      const need = item as Partial<StoredNeed>;
      return typeof need.childSessionId === "string"
        && typeof need.line === "string"
        && typeof need.setAt === "string"
        && typeof need.ctoSessionId === "string";
    });
  };
  let needs: StoredNeed[] = readNeeds();
  const saveNeeds = () => {
    needs = needs.slice(-NEEDS_CAP);
    try {
      deps.db?.setJson(NEEDS_STATE_KEY, needs);
    } catch (error) {
      deps.logger?.warn("cto.stall_judge.needs_save_failed", { error: getErrorMessage(error) });
    }
  };
  const needFor = (childSessionId: string): StoredNeed | undefined =>
    needs.find((need) => need.childSessionId === childSessionId);

  const lastNudgeAt = new Map<string, number>();
  const storedLastNudge = deps.db?.getJson(LAST_NUDGE_STATE_KEY);
  if (storedLastNudge && typeof storedLastNudge === "object" && !Array.isArray(storedLastNudge)) {
    for (const [ctoSessionId, at] of Object.entries(storedLastNudge as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) lastNudgeAt.set(ctoSessionId, at);
    }
  }
  const noteNudged = (ctoSessionId: string, at: number) => {
    lastNudgeAt.set(ctoSessionId, at);
    try {
      deps.db?.setJson(LAST_NUDGE_STATE_KEY, Object.fromEntries(lastNudgeAt));
    } catch (error) {
      deps.logger?.warn("cto.stall_judge.save_failed", { error: getErrorMessage(error) });
    }
  };
  let timer: unknown = null;
  let dueAt = 0;
  let running = false;
  let rerun = false;
  let disposed = false;
  let started = false;

  const schedule = (delayMs: number) => {
    if (disposed || !started) return;
    const at = now() + Math.max(0, delayMs);
    if (timer != null) {
      if (dueAt <= at) return;
      clearTimer(timer);
    }
    dueAt = at;
    timer = setTimer(() => {
      timer = null;
      dueAt = 0;
      void checkNow();
    }, Math.max(0, delayMs));
  };

  const checkCto = async (ctoSessionId: string, nowMs: number): Promise<number | null> => {
    const children = await deps.readChildren(ctoSessionId);
    // A need for a child that moved, ended or is gone is dropped here, so the
    // card and the store agree without a client having to be open. Each need
    // reads its own child: `readChildren` leaves out a child it could not read
    // or that has been quiet for a day, and neither ends the need.
    const dropped = new Set<StoredNeed>();
    for (const need of needs) {
      if (need.ctoSessionId !== ctoSessionId) continue;
      let child: CtoNeedChild | null;
      try {
        child = await deps.readNeedChild(need.childSessionId);
      } catch (error) {
        deps.logger?.warn("cto.stall_judge.need_read_failed", { childSessionId: need.childSessionId, error: getErrorMessage(error) });
        continue;
      }
      if (!child || child.ended || !ctoNeedIsLive(need, child)) dropped.add(need);
    }
    if (dropped.size) {
      needs = needs.filter((need) => !dropped.has(need));
      saveNeeds();
    }

    const due: CtoChildStall[] = [];
    let nextCheckMs: number | null = null;
    const noteNext = (ms: number) => {
      if (ms > nowMs && (nextCheckMs === null || ms < nextCheckMs)) nextCheckMs = ms;
    };
    for (const child of children) {
      const stall = judgeCtoChildStall(child, nowMs, needFor(child.sessionId) ?? null);
      if (!stall) {
        // Not stuck yet: look again when it could be.
        const dueMs = ctoChildStallDueMs(child);
        if (dueMs !== null) noteNext(dueMs + 1_000);
        continue;
      }
      if (nudged.has(stall.stateKey)) continue;
      if (baselinePending) {
        nudged.add(stall.stateKey);
        continue;
      }
      due.push(stall);
    }
    if (!due.length) return nextCheckMs;
    if (deps.ctoBusy(ctoSessionId)) return nowMs + 30_000;
    const last = lastNudgeAt.get(ctoSessionId) ?? 0;
    if (nowMs - last < CTO_STALL_NUDGE_GAP_MS) return last + CTO_STALL_NUDGE_GAP_MS;

    due.sort((left, right) => left.sinceMs - right.sinceMs);
    const told = due.slice(0, NUDGE_MAX_STALLS);
    // Recorded before the send: a send that fails is not retried into a
    // second copy of the same nudge. The child's next move makes a new key.
    for (const item of told) nudged.add(item.stateKey);
    saveNudged();
    noteNudged(ctoSessionId, nowMs);
    try {
      await deps.wakeCto(ctoSessionId, formatCtoStallNudge(told, nowMs));
      deps.logger?.info("cto.stall_judge.nudged", {
        ctoSessionId,
        stalls: told.map((item) => ({ childSessionId: item.childSessionId, kind: item.kind })),
      });
    } catch (error) {
      deps.logger?.warn("cto.stall_judge.nudge_failed", {
        ctoSessionId,
        error: getErrorMessage(error),
      });
    }
    return due.length > told.length ? nowMs + CTO_STALL_NUDGE_GAP_MS : nextCheckMs;
  };

  const checkNow = async (): Promise<void> => {
    if (disposed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    let next: number | null = null;
    try {
      const nowMs = now();
      // The first-run baseline holds only once every CTO was read: a pass
      // that could not see some children must not end it, or the next pass
      // would tell the CTO about a day of old stalls.
      let allRead = true;
      let ctoSessionIds: string[] = [];
      try {
        ctoSessionIds = await deps.listCtoSessionIds();
      } catch (error) {
        allRead = false;
        deps.logger?.warn("cto.stall_judge.check_failed", { error: getErrorMessage(error) });
      }
      for (const ctoSessionId of ctoSessionIds) {
        const at = await checkCto(ctoSessionId, nowMs).catch((error: unknown) => {
          allRead = false;
          deps.logger?.warn("cto.stall_judge.check_failed", {
            ctoSessionId,
            error: getErrorMessage(error),
          });
          return null;
        });
        if (at !== null && (next === null || at < next)) next = at;
      }
      if (baselinePending && allRead) {
        baselinePending = false;
        saveNudged();
      }
    } finally {
      running = false;
    }
    if (rerun) {
      rerun = false;
      schedule(OBSERVE_DEBOUNCE_MS);
      return;
    }
    const nowMs = now();
    schedule(next === null ? IDLE_BACKSTOP_MS : Math.min(BACKSTOP_MS, Math.max(1_000, next - nowMs)));
  };

  return {
    start: () => {
      if (started || disposed) return;
      started = true;
      schedule(15_000);
    },
    dispose: () => {
      disposed = true;
      if (timer != null) clearTimer(timer);
      timer = null;
    },
    observe: (sessionId) => {
      if (!started || disposed) return;
      // A child's move can make or clear a stall; the CTO's own turn ending
      // can free a nudge that waited on it. Every other chat is not ours.
      if (!deps.ctoParentOf(sessionId) && !deps.isCtoSession(sessionId)) return;
      schedule(OBSERVE_DEBOUNCE_MS);
    },
    checkNow,
    setNeed: ({ ctoSessionId, childSessionId, line, pendingKey, childTitle, laneId }) => {
      const text = line == null ? "" : normalizeCtoNeedLine(line);
      const had = needs.some((need) => need.childSessionId === childSessionId);
      needs = needs.filter((need) => need.childSessionId !== childSessionId);
      if (text) {
        needs.push({
          childSessionId,
          line: text,
          setAt: new Date(now()).toISOString(),
          ctoSessionId,
          ...(pendingKey ? { pendingKey } : {}),
          ...(childTitle ? { childTitle } : {}),
          ...(laneId ? { laneId } : {}),
        });
      }
      if (text || had) saveNeeds();
      return { set: Boolean(text), line: text || null };
    },
    listNeeds: async (ctoSessionId) => {
      const out: CtoNeed[] = [];
      for (const need of needs) {
        if (need.ctoSessionId !== ctoSessionId) continue;
        let child: CtoNeedChild | null;
        try {
          child = await deps.readNeedChild(need.childSessionId);
        } catch (error) {
          // Not gone, just unread: the line stays, as the judge keeps it.
          deps.logger?.warn("cto.stall_judge.need_read_failed", { childSessionId: need.childSessionId, error: getErrorMessage(error) });
          out.push({
            childSessionId: need.childSessionId,
            childTitle: need.childTitle ?? "",
            laneId: need.laneId ?? null,
            line: need.line,
            setAt: need.setAt,
          });
          continue;
        }
        if (!child || child.ended || !ctoNeedIsLive(need, child)) continue;
        out.push({
          childSessionId: need.childSessionId,
          childTitle: child.title,
          laneId: child.laneId,
          line: need.line,
          setAt: need.setAt,
        });
      }
      return out;
    },
  };
}
