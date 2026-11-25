/**
 * An agent's size request (`cloud.tier_request`) and its answer: the card in
 * the agent's chat, the person's answer, what ADE tells the agent, and how
 * the change the person said yes to ended, told to the chat's own machine by
 * the layer that ran it (this app's main process, ADE Web's tab). The change
 * itself is a lane job (`cloudLaneLife.ts`).
 */

import type { AdeCardPayload, AdeCardRow } from "./adeCard";
import { isAccountAnsweredPin, isAdeCloudTargetId } from "./adeCloud/binding";
import type { CloudLaneJobSnapshot } from "./cloudLaneLife";
import { savedChatsMachineKey } from "./cloudSavedChats";
import type { CloudTierId } from "./cloudTiers";
import { sameMachineKey } from "./machineAddress";
import type { MachineProjectRef } from "./projectIdentity";
import type { OpenProjectBinding, RemoteOpenProjectBinding } from "./types/core";

/** The size request a change names (`CloudLaneChangeTierArgs`), trimmed; null for each one left out. */
export function cloudTierRequestIdsOf(
  raw: { requestId?: unknown; requestedByChat?: unknown } | null | undefined,
): { requestId: string | null; requestedByChat: string | null } {
  const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
  return { requestId: text(raw?.requestId), requestedByChat: text(raw?.requestedByChat) };
}

// ---------------------------------------------------------------------------
// An agent asks for a tier change
// ---------------------------------------------------------------------------

/** The card an agent's `cloud.tier_request` posts in its chat. A person confirms it; the agent never changes a tier. */
export const CLOUD_TIER_REQUEST_CARD_VARIANT = "cloud_tier_request";

/**
 * The card's buttons. The client answers `idle` and `now` with `changeTier`;
 * every answer, `dismiss` too, then goes to the chat's own machine
 * (`cloud.tier_request_answer`), which marks the card answered and tells the
 * agent. How the change ended goes there from the layer that runs it.
 */
export const CLOUD_TIER_REQUEST_ACTIONS = {
  idle: "cloud_tier_change_idle",
  now: "cloud_tier_change_now",
  dismiss: "cloud_tier_request_dismiss",
} as const;

export type CloudTierRequest = {
  requestId: string;
  instanceId: string;
  /** The computer's name (the lane's name). */
  computerName: string;
  fromSizeId: CloudTierId | null;
  toSizeId: CloudTierId;
  /** The new size's name ("Large"), as the card was built with it. */
  toLabel: string;
  /** The agent's reason, in its words. */
  reason: string;
  chatSessionId: string;
};

/** Row keys the card carries its request in, so a client reads it back without parsing text. */
const ROW = {
  computer: "tier_request_computer",
  size: "tier_request_size",
  toLabel: "tier_request_to_label",
  reason: "tier_request_reason",
  from: "tier_request_from",
} as const;

const TIER_REQUEST_CARD_PREFIX = "cloud-tier-request:";

/** The `cardId` of a request's card: the chat's machine reads the card back by it. */
export function cloudTierRequestCardId(requestId: string): string {
  return `${TIER_REQUEST_CARD_PREFIX}${requestId}`;
}

export function buildCloudTierRequestCard(request: CloudTierRequest, labels: { from: string | null; rate: string | null }): AdeCardPayload {
  const to = request.toLabel;
  const rows: AdeCardRow[] = [
    { key: ROW.computer, icon: "info", text: request.computerName, detail: request.instanceId },
    // Its text is for people; an older ADE reads the size id from its detail.
    { key: ROW.size, icon: "info", text: `To ${to}${labels.rate ? `, ${labels.rate}` : ""}`, detail: request.toSizeId },
    { key: ROW.toLabel, icon: "info", text: to, detail: null },
    ...(request.fromSizeId ? [{ key: ROW.from, icon: "info" as const, text: `Now ${labels.from ?? request.fromSizeId}`, detail: request.fromSizeId }] : []),
    { key: ROW.reason, icon: "info", text: request.reason, detail: null },
  ];
  return {
    cardId: cloudTierRequestCardId(request.requestId),
    variant: CLOUD_TIER_REQUEST_CARD_VARIANT,
    state: "live",
    title: `Change ${request.computerName} to ${to}?`,
    subtitle: "The agent asks. It changes nothing until you confirm.",
    rows,
    actions: [
      { id: CLOUD_TIER_REQUEST_ACTIONS.idle, label: "Change when the agent is idle", kind: "primary" },
      { id: CLOUD_TIER_REQUEST_ACTIONS.now, label: "Do it now", kind: "default" },
      { id: CLOUD_TIER_REQUEST_ACTIONS.dismiss, label: "Keep the size", kind: "default" },
    ],
    fallbackText: `The agent asks to change ${request.computerName} to ${to}: ${request.reason} Change it in ADE (Settings › ADE Cloud).`,
  };
}

/** A card from before the label row: its size row says "To Large, uses 4 hours an hour". */
function legacyToLabel(sizeText: string): string | null {
  return /^To (.+?)(?:,|$)/.exec(sizeText)?.[1]?.trim() || null;
}

/** The request a `cloud_tier_request` card carries, or null for any other card. */
export function cloudTierRequestOfCard(card: AdeCardPayload, chatSessionId: string): CloudTierRequest | null {
  if (card.variant !== CLOUD_TIER_REQUEST_CARD_VARIANT) return null;
  const requestId = card.cardId.startsWith(TIER_REQUEST_CARD_PREFIX) ? card.cardId.slice(TIER_REQUEST_CARD_PREFIX.length) : "";
  const row = (key: string) => card.rows?.find((entry) => entry.key === key) ?? null;
  const computer = row(ROW.computer);
  const size = row(ROW.size);
  if (!requestId || !computer?.detail || !size?.detail) return null;
  return {
    requestId,
    instanceId: computer.detail,
    computerName: computer.text,
    fromSizeId: (row(ROW.from)?.detail as CloudTierId | undefined) ?? null,
    toSizeId: size.detail as CloudTierId,
    toLabel: row(ROW.toLabel)?.text.trim() || legacyToLabel(size.text) || size.detail,
    reason: row(ROW.reason)?.text ?? "",
    chatSessionId,
  };
}

// ---------------------------------------------------------------------------
// The person's answer to a tier request, and how the change ended
// ---------------------------------------------------------------------------

/**
 * The person's answer: change it once the agent is idle, now, or keep the
 * size (`CLOUD_TIER_REQUEST_ACTIONS`).
 */
export type CloudTierRequestAnswer = "idle" | "now" | "dismiss";
/** How a change the person said yes to ended. */
export type CloudTierRequestOutcome = "online" | "failed" | "cancelled";

/**
 * `cloud.tier_request_answer`, on the chat's own machine: the person's answer
 * from their client, and how the change ended from the layer that ran it
 * (this app's main process, or ADE Web's tab for a size change it ran). That
 * machine reads the card from the chat itself.
 */
export type CloudTierRequestAnswerArgs = {
  chatSessionId: string;
  requestId: string;
  answer: CloudTierRequestAnswer;
  /** How the change the person said yes to ended; unset at the answer itself. */
  outcome?: CloudTierRequestOutcome | null;
  /** A failed change's reason. */
  error?: string | null;
};

export function isCloudTierRequestAnswer(value: unknown): value is CloudTierRequestAnswer {
  return value === "idle" || value === "now" || value === "dismiss";
}

export function isCloudTierRequestOutcome(value: unknown): value is CloudTierRequestOutcome {
  return value === "online" || value === "failed" || value === "cancelled";
}

/** How a job ended, as a request's outcome; null while it waits or runs. */
export function cloudTierRequestOutcomeOfJob(job: Pick<CloudLaneJobSnapshot, "phase">): CloudTierRequestOutcome | null {
  return job.phase === "online" || job.phase === "failed" || job.phase === "cancelled" ? job.phase : null;
}

/**
 * What tells the asking chat how its job ended (`cloud.tier_request_answer`),
 * or null while the job waits or runs: the one call this app's main process
 * and ADE Web's tab make.
 */
export function cloudTierRequestEndArgs(
  job: Pick<CloudLaneJobSnapshot, "phase" | "timing" | "error">,
  request: { requestId: string; chatSessionId: string },
): CloudTierRequestAnswerArgs | null {
  const outcome = cloudTierRequestOutcomeOfJob(job);
  if (!outcome) return null;
  return {
    chatSessionId: request.chatSessionId,
    requestId: request.requestId,
    answer: job.timing,
    outcome,
    error: outcome === "failed" ? job.error : null,
  };
}

/**
 * The machine to tell a size request's chat on when its pin alone doesn't
 * reach it now, or null to call through the pin as it is:
 * - a chat on the lane's own computer moved with the lane: it is on the new
 *   computer now, in the same folder;
 * - a pin that names no machine (`isAccountAnsweredPin`): a saved chat's
 *   stand-in names its machine by key (`cloud-saved:<key>`), and the ADE
 *   Cloud tab's names the account, so the chat is on the job's lane computer.
 *
 * `pinMachineKey` is the machine the pin's connection reaches as the caller
 * knows it (null when it knows none). Throws for a pin that names no machine
 * and gives no key to reach one by.
 */
export function cloudTierRequestChatMachineKey(input: {
  pin: OpenProjectBinding;
  pinMachineKey: string | null;
  job: Pick<CloudLaneJobSnapshot, "kind" | "machineKey">;
  /** The machine the job started on: a move's old computer. */
  fromMachineKey: string | null;
}): string | null {
  const { pin, job, fromMachineKey } = input;
  if (pin.kind !== "remote") return null;
  const pinKey = isAdeCloudTargetId(pin.targetId) ? job.machineKey : input.pinMachineKey ?? savedChatsMachineKey(pin.targetId);
  const movedWithLane = job.kind === "move" && job.machineKey != null && fromMachineKey != null
    && !sameMachineKey(job.machineKey, fromMachineKey) && sameMachineKey(pinKey, fromMachineKey);
  if (movedWithLane) return job.machineKey;
  if (!isAccountAnsweredPin(pin)) return null;
  if (!pinKey) throw new Error("ADE doesn't know which computer this chat is on, so it can't tell the agent.");
  return pinKey;
}

/**
 * The asking chat's project on the machine `cloudTierRequestChatMachineKey`
 * names, for `pickMachineProject`: the pin's project and folder, the
 * account's project the ADE Cloud tab's pin names, and the repository's
 * origin (the pin's, else the job's lane's). Main and ADE Web find the chat
 * there with this one reference.
 */
export function cloudTierRequestProjectRef(
  pin: RemoteOpenProjectBinding,
  job: Pick<CloudLaneJobSnapshot, "projectOrigin">,
): MachineProjectRef {
  return {
    projectId: pin.projectId,
    rootPath: pin.rootPath,
    accountProjectId: pin.projectId,
    originUrl: pin.gitOriginUrl ?? job.projectOrigin ?? null,
  };
}

/** One telling's calls. The newest `note` of a key gives them; each try reads them again. */
export type CloudTierRequestTell<End extends string = string> = {
  /** The end to tell now, or null while the change waits or runs (a Retry). */
  read: () => End | null;
  /** Tells the chat that end; throws when its machine can't take it now. */
  tell: (end: End) => Promise<void>;
  isTold: (end: End) => boolean;
  /** That end was told, and the change still ends so (a Retry that started meanwhile keeps its own end to tell). */
  markTold: (end: End) => void;
};

/**
 * Tells the chat whose size request started a change how it ended: the loop
 * this app's main process and ADE Web's tab share, each with its own reach
 * and retry schedule. One telling per key at a time; each try reads the end
 * again, so a change that runs again is told when it ends; a new end starts
 * its tries over; an end told stops it; and an end that comes while a try
 * waits wakes that wait, so it is told at once. A woken wait clears its timer.
 */
export function createTierRequestTelling<End extends string = string>(options: {
  /** The waits between tries; after the last, the end is left untold. */
  retryMs: readonly number[];
  /** A try that failed; `final` when no try follows. */
  onFailed: (error: unknown, info: { key: string; end: End; attempt: number; final: boolean }) => void;
}) {
  type Telling = { calls: CloudTierRequestTell<End>; trying: End | null; wake: (() => void) | null };
  const tellings = new Map<string, Telling>();

  const waitOrWake = (telling: Telling, ms: number): Promise<void> => new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (telling.wake === done) telling.wake = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    telling.wake = done;
  });

  const run = async (key: string, telling: Telling): Promise<void> => {
    let attempt = 0;
    try {
      for (;;) {
        const end = telling.calls.read();
        if (end == null || telling.calls.isTold(end)) return;
        if (end !== telling.trying) {
          telling.trying = end;
          attempt = 0;
        }
        try {
          await telling.calls.tell(end);
          if (telling.calls.read() === end) telling.calls.markTold(end);
        } catch (error) {
          const wait = options.retryMs[attempt];
          options.onFailed(error, { key, end, attempt, final: wait == null });
          attempt += 1;
          if (wait == null) return;
          await waitOrWake(telling, wait);
        }
      }
    } finally {
      tellings.delete(key);
    }
  };

  return {
    /** A change published: its end is told unless it was. A telling of `key` that runs reads `calls` from now on. */
    note(key: string, calls: CloudTierRequestTell<End>): void {
      const current = tellings.get(key);
      if (current) {
        current.calls = calls;
        if (calls.read() !== current.trying) current.wake?.();
        return;
      }
      const end = calls.read();
      if (end == null || calls.isTold(end)) return;
      const telling: Telling = { calls, trying: null, wake: null };
      tellings.set(key, telling);
      void run(key, telling);
    },
  };
}

/**
 * Row keys the answered card carries: the answer, how the change ended, and
 * what ADE told the agent of it (so the chat's machine tells it once, from
 * the card itself, however often and from wherever it is reported).
 */
const ANSWER_ROW = { answer: "tier_request_answer", outcome: "tier_request_outcome", told: "tier_request_told" } as const;

/** What the card says the person answered, and how the change ended; null while it still asks. */
export function cloudTierRequestAnswerOfCard(card: AdeCardPayload): { answer: CloudTierRequestAnswer; outcome: CloudTierRequestOutcome | null } | null {
  if (card.variant !== CLOUD_TIER_REQUEST_CARD_VARIANT) return null;
  const answer = card.rows?.find((entry) => entry.key === ANSWER_ROW.answer)?.detail;
  if (!isCloudTierRequestAnswer(answer)) return null;
  const outcome = card.rows?.find((entry) => entry.key === ANSWER_ROW.outcome)?.detail;
  return { answer, outcome: isCloudTierRequestOutcome(outcome) ? outcome : null };
}

/** The key of one thing ADE tells the agent: an answer, or an answer and how its change ended. */
export function cloudTierRequestToldKey(answer: CloudTierRequestAnswer, outcome: CloudTierRequestOutcome | null | undefined): string {
  return `${answer}:${answer === "dismiss" ? "" : outcome ?? ""}`;
}

/** What ADE last told the card's agent (`cloudTierRequestToldKey`), or null. */
export function cloudTierRequestToldOfCard(card: AdeCardPayload): string | null {
  return card.rows?.find((entry) => entry.key === ANSWER_ROW.told)?.detail ?? null;
}

/**
 * What ADE tells the agent that asked, in ADE's words, never a message from
 * the person: `wake`, a host-authored wake now (it waits for a running turn
 * to end); `next_turn`, a note its next turn starts with and no turn of its
 * own. A yes is a note: a turn started then would hold up a change that waits
 * for the agent to be idle, and one that runs now stops the turn anyway.
 */
export type CloudTierRequestAgentMessage = { via: "wake" | "next_turn"; text: string };

/** The person's sentence on the card and the agent's message, for one answer and how its change ended. */
function tierRequestWords(
  request: CloudTierRequest,
  input: { answer: CloudTierRequestAnswer; outcome: CloudTierRequestOutcome | null; error: string | null },
): { sentence: string; agent: CloudTierRequestAgentMessage } {
  const { computerName: name, toLabel: to } = request;
  const why = input.error ? `: ${input.error.replace(/\.$/, "")}` : "";
  if (input.answer === "dismiss") {
    return {
      sentence: `You kept ${name} at its size.`,
      agent: { via: "wake", text: `The person kept ${name} at its size: they said no to your request to change it to ${to}. Don't ask again for this. Carry on at this size, or tell them what you can't do without ${to}.` },
    };
  }
  switch (input.outcome) {
    case "online":
      return {
        sentence: `${name} is on ${to} now.`,
        agent: { via: "wake", text: `The person said yes to your request: ${name} now runs at ${to}. ADE changed the lane's computer for it; your files and this chat stayed. Carry on with the work that needed it.` },
      };
    case "failed":
      return {
        sentence: `The change to ${to} stopped${why}.`,
        agent: { via: "wake", text: `The person said yes to your request, but the change of ${name} to ${to} stopped${why}. It keeps its size for now. The person can retry it from this chat; carry on at this size or wait for them.` },
      };
    case "cancelled":
      return {
        sentence: `You cancelled the change. ${name} kept its size.`,
        agent: { via: "wake", text: `The person cancelled the change of ${name} to ${to}, so it keeps its size. Carry on at this size, or tell them what you can't do without ${to}.` },
      };
    default: {
      const now = input.answer === "now";
      return {
        sentence: now ? `You said yes. ADE changes it to ${to} now.` : `You said yes. ADE changes it to ${to} once the agent is idle.`,
        // True after the change too, when the agent reads it later.
        agent: { via: "next_turn", text: `The person said yes to your request to change ${name} to ${to}. ADE changes it ${now ? "at once (ADE stops the running turn for it)" : "once you are idle"}; the lane's computer restarts for it, and your files and this chat stay. ADE tells you in this chat when the change is done.` },
      };
    }
  }
}

function answerInput(input: { answer: CloudTierRequestAnswer; outcome?: CloudTierRequestOutcome | null; error?: string | null }) {
  return { answer: input.answer, outcome: input.answer === "dismiss" ? null : input.outcome ?? null, error: input.error?.trim() || null };
}

/** What ADE tells the agent of one answer, and of how the change it said yes to ended. */
export function cloudTierRequestAgentMessage(
  request: CloudTierRequest,
  input: { answer: CloudTierRequestAnswer; outcome?: CloudTierRequestOutcome | null; error?: string | null },
): CloudTierRequestAgentMessage {
  return tierRequestWords(request, answerInput(input)).agent;
}

/**
 * The card once the person answered (and again once the change ended): no
 * buttons, the answer in its subtitle and rows, so every surface (another
 * window, ADE Web, the phone's fallback text) shows the same answer. `told`
 * is what ADE told the agent (`cloudTierRequestToldKey`); null keeps none.
 */
export function buildCloudTierRequestAnsweredCard(
  card: AdeCardPayload,
  request: CloudTierRequest,
  input: { answer: CloudTierRequestAnswer; outcome?: CloudTierRequestOutcome | null; error?: string | null; told: string | null },
): AdeCardPayload {
  const { answer, outcome, error } = answerInput(input);
  const { sentence } = tierRequestWords(request, { answer, outcome, error });
  const rows = (card.rows ?? []).filter((entry) => entry.key !== ANSWER_ROW.answer && entry.key !== ANSWER_ROW.outcome && entry.key !== ANSWER_ROW.told);
  rows.push({ key: ANSWER_ROW.answer, icon: "info", text: sentence, detail: answer });
  if (outcome) rows.push({ key: ANSWER_ROW.outcome, icon: outcome === "online" ? "pass" : outcome === "failed" ? "fail" : "skipped", text: sentence, detail: outcome });
  if (input.told) rows.push({ key: ANSWER_ROW.told, icon: "info", text: "Told the agent", detail: input.told });
  return {
    ...card,
    state: "terminal",
    subtitle: sentence,
    rows,
    actions: [],
    fallbackText: `The agent asked to change ${request.computerName} to ${request.toLabel}. ${sentence}`,
  };
}
