/**
 * The life of an ADE Cloud lane's computer after its launch: delete the lane
 * (and its computer), keep the lane on a fresh computer, a lane without a
 * computer, and a tier change or move that shows its steps like a launch.
 *
 * All of it is account-level: it acts on a computer of the account by its
 * ADE Cloud id, through this app's main process (`IPC.cloudLaneLifeCall`),
 * never through a project pin. A tier change runs in the main process so it
 * goes on with every window closed.
 */

import type { AdeCardPayload, AdeCardRow } from "./adeCard";
import { isAccountAnsweredPin, isAdeCloudTargetId } from "./adeCloud/binding";
import type { CloudTierId } from "./cloudTiers";
import type { CloudLaneWithoutComputer } from "./cloudLaneLaunch";
import { savedChatsMachineKey } from "./cloudSavedChats";
import { sameMachineKey } from "./machineAddress";
import type { ChatLaunchStageStatus } from "./types/chatLaunch";
import type { OpenProjectBinding } from "./types/core";

export type { CloudLaneWithoutComputer };

/** One lane on a computer as its work check read it (`ade cloud push-work --check`). */
export type CloudLaneWorkLane = {
  laneId: string;
  laneName: string;
  branchRef: string;
  primary: boolean;
  dirty: boolean;
  ahead: number;
  /** Files changed and not committed, when the lane's backup counted them; unset from the computer's own check. */
  files?: number;
  state: "clean" | "pushed" | "failed" | "unpushed";
};

/** A work lane's name for people: the primary lane is the "main checkout". */
export function cloudWorkLaneName(lane: Pick<CloudLaneWorkLane, "laneName" | "branchRef" | "primary">): string {
  if (lane.primary) return "main checkout";
  return lane.laneName || lane.branchRef;
}

/**
 * Whether a computer holds work that isn't on GitHub. `unpushed` is null when
 * the check couldn't run (an older computer, no answer): the caller then warns
 * as if there were.
 */
export type CloudLaneWorkState = {
  unpushed: boolean | null;
  /** The lanes with work only on the computer (uncommitted changes or unpushed commits). */
  unpushedLanes: CloudLaneWorkLane[];
  /** Why the check couldn't run, or null. */
  message: string | null;
  /**
   * How it was read: on the computer (`computer`, which wakes an asleep one),
   * or from the lane backups of an asleep computer saved at rest (`backups`,
   * no wake). Unset when the check couldn't run.
   */
  checkedBy?: "computer" | "backups";
};

/** What a person picked when they deleted a cloud lane. */
export type CloudLaneDeleteOptions = {
  /** Keep its saved chats on ADE Cloud. Off: they go with the lane. */
  keepChats?: boolean;
  /**
   * Delete only these saved chats of the computer, by chat id: the ones a
   * move carried to another machine. The rest stay readable from ADE Cloud.
   */
  onlyChats?: readonly string[];
};

export type CloudLaneDeleteResult = {
  ok: boolean;
  /** One plain line: what happened, or why not. */
  message: string;
  /** From the work check before the delete, when it ran; null when it was skipped or couldn't run. */
  unpushed: boolean | null;
  unpushedLanes: CloudLaneWorkLane[];
  /** Whether its saved chats are still on ADE Cloud: asked to keep them, or their delete failed. */
  chatsKept: boolean;
};

export type CloudLaneFreeResult = {
  ok: boolean;
  message: string;
  /** The lane, now without a computer. Null when it failed. */
  lane: CloudLaneWithoutComputer | null;
};

/** When a tier change starts: once the agent is idle, or now (the running turn stops). */
export type CloudLaneTierTiming = "idle" | "now";

/**
 * `resize`: the same kind of computer, a new size in place (it restarts).
 * `move`: to the other kind (standard ↔ full): a new computer gets the files.
 */
export type CloudLaneJobKind = "resize" | "move";

/**
 * The steps of a tier change. A resize runs save, resize, start, connect; a
 * move runs save, computer, copy, start, remove, connect: the old computer
 * goes once ADE on the new one has the lane, and Connect is last because the
 * lane says Online only when it passes.
 */
export type CloudLaneJobStageId = "save" | "resize" | "computer" | "copy" | "start" | "connect" | "remove";

export const CLOUD_LANE_JOB_STAGE_LABELS: Record<CloudLaneJobStageId, string> = {
  save: "Save work",
  resize: "Change size",
  computer: "Make computer",
  copy: "Copy lane",
  start: "Start ADE",
  connect: "Connect",
  remove: "Remove old computer",
};

export function cloudLaneJobStageIds(kind: CloudLaneJobKind): CloudLaneJobStageId[] {
  switch (kind) {
    case "resize":
      return ["save", "resize", "start", "connect"];
    case "move":
      return ["save", "computer", "copy", "start", "remove", "connect"];
  }
}

export type CloudLaneJobStage = {
  id: CloudLaneJobStageId;
  status: ChatLaunchStageStatus;
  detail: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

/** The save step's detail when it couldn't write the chats' saved copy (a stuck brain): the job goes on. */
export const CLOUD_LANE_SAVE_WARNING_DETAIL = "The chats' saved copy may be a few minutes old";

/**
 * `waiting`: for the agent to be idle. `running`: the steps. `online`: ADE on
 * the computer answers (the lane says Online only now). `failed`: a step
 * failed; Retry runs it again. `cancelled`: stopped before the size changed.
 */
export type CloudLaneJobPhase = "waiting" | "running" | "online" | "failed" | "cancelled";

export type CloudLaneJobSnapshot = {
  jobId: string;
  kind: CloudLaneJobKind;
  timing: CloudLaneTierTiming;
  /** The computer the lane is on now: the new one once a move made it. */
  instanceId: string;
  /** The computer the job started on. */
  fromInstanceId: string;
  /** The ADE machine key of `instanceId`, once known. */
  machineKey: string | null;
  laneId: string | null;
  /** The lane's name: the computer keeps (or a moved one gets) this name. */
  laneName: string;
  projectOrigin: string | null;
  fromSizeId: CloudTierId | null;
  toSizeId: CloudTierId;
  phase: CloudLaneJobPhase;
  stages: CloudLaneJobStage[];
  error: string | null;
  /** The agent's chat whose request card the person confirmed, or null. */
  requestedByChat: string | null;
  /** That request card's id, so the card matches this job and no later one. Absent on older records. */
  requestId?: string | null;
  /**
   * A resize that also grows the disk: the disk's new size in GB. Null (or
   * absent, from an older record) keeps the disk as it is.
   */
  diskGb?: number | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  /**
   * The person closed the job's card (a failure read, a finish seen). It
   * leaves every view; nothing about the computer changes. Absent on older records.
   */
  dismissedAt?: string | null;
};

/** The job still waits for the agent or runs its steps. */
export function cloudLaneJobIsLive(job: Pick<CloudLaneJobSnapshot, "phase">): boolean {
  return job.phase === "waiting" || job.phase === "running";
}

/**
 * A send to the lane's chats goes to the account's queue now, which holds it
 * until the change is done: a move from its making on (once it no longer
 * waits for the agent; the server's `HOLDING_STEPS` in
 * `account-directory/src/cloud/moves.ts`), a size change once its resize was
 * asked (before that its ADE still answers, and the restart would cut the
 * turn the message started).
 */
export function cloudLaneJobHoldsSends(job: CloudLaneJobSnapshot): boolean {
  if (job.phase !== "running") return false;
  if (job.kind === "move") return true;
  return job.stages.some((stage) => stage.id === "resize" && (stage.status === "done" || stage.status === "warning" || stage.status === "skipped"));
}

/** The calls `IPC.cloudLaneLifeCall` answers. */
export type CloudLaneLifeMethod =
  | "workState"
  | "deleteLane"
  | "freeLane"
  | "lanesWithoutComputer"
  | "forgetLaneWithoutComputer"
  | "changeTier"
  | "listJobs"
  | "retryJob"
  | "cancelJob"
  | "dismissJob";

export type CloudLaneLifeCallRequest<M extends CloudLaneLifeMethod = CloudLaneLifeMethod> = { method: M; args?: unknown };

/** What each `IPC.cloudLaneLifeCall` method answers. */
export type CloudLaneLifeResults = {
  workState: CloudLaneWorkState;
  deleteLane: CloudLaneDeleteResult;
  freeLane: CloudLaneFreeResult;
  lanesWithoutComputer: CloudLaneWithoutComputer[];
  forgetLaneWithoutComputer: { forgotten: boolean };
  changeTier: CloudLaneJobSnapshot;
  listJobs: CloudLaneJobSnapshot[];
  retryJob: CloudLaneJobSnapshot | null;
  cancelJob: CloudLaneJobSnapshot | null;
  dismissJob: CloudLaneJobSnapshot | null;
};

export type CloudLaneChangeTierArgs = {
  instanceId: string;
  sizeId: CloudTierId;
  timing: CloudLaneTierTiming;
  /**
   * A resize only: grow the disk to this many GB in the same step. A size
   * change never shrinks the disk, and keeps it as it is without this.
   */
  diskGb?: number | null;
  /** The request card the person confirmed, if any (`CloudTierRequest.requestId`). */
  requestId?: string | null;
  requestedByChat?: string | null;
  /**
   * That chat's runtime pin: the layer that runs the change tells the chat's
   * own machine how it ended (`cloud.tier_request_answer` with its outcome).
   */
  requestedByChatPin?: OpenProjectBinding | null;
};

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
  /** Waits with this instead of a timer (a test's clock): such a wait is woken, never cleared. */
  sleep?: ((ms: number) => Promise<void>) | null;
  /** A try that failed; `final` when no try follows. */
  onFailed: (error: unknown, info: { key: string; end: End; attempt: number; final: boolean }) => void;
}) {
  type Telling = { calls: CloudTierRequestTell<End>; trying: End | null; wake: (() => void) | null };
  const tellings = new Map<string, Telling>();

  const waitOrWake = (telling: Telling, ms: number): Promise<void> => new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      if (telling.wake === done) telling.wake = null;
      resolve();
    };
    telling.wake = done;
    if (options.sleep) void options.sleep(ms).then(done, done);
    else timer = setTimeout(done, ms);
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

// ---------------------------------------------------------------------------
// A delete or free the person said yes to, in the agent's chat
// ---------------------------------------------------------------------------

/**
 * One card in the agent's chat for a lane delete, a free or a saved copy's
 * delete the person approved on its card: "Deleting Stall Repro…", then its
 * outcome. The verb's result also goes to the command that asked. The
 * generic `ade_card` draws it (`KNOWN_ADE_CARD_VARIANTS`): live while it
 * runs, one quiet line when done, amber with the reason when it failed.
 */
export const CLOUD_LANE_ACTION_CARD_VARIANT = "cloud_lane_action";

export function buildCloudLaneActionCard(input: {
  cardId: string;
  state: "live" | "terminal";
  title: string;
  /** The outcome's sentence; null while it runs. */
  detail?: string | null;
  failed?: boolean;
}): AdeCardPayload {
  const detail = input.detail?.trim() || null;
  return {
    cardId: input.cardId,
    variant: CLOUD_LANE_ACTION_CARD_VARIANT,
    state: input.state,
    title: input.title,
    // A failure's reason is its amber row; a subtitle too would say it twice.
    subtitle: input.failed ? null : detail,
    rows: detail ? [{ key: "cloud_lane_action_outcome", icon: input.failed ? "fail" : input.state === "live" ? "running" : "pass", text: detail, tone: input.failed ? "warning" : "neutral" }] : [],
    fallbackText: detail ? `${input.title}. ${detail}` : input.title,
  };
}

// ---------------------------------------------------------------------------
// A new computer waits for the person to approve it joining the account
// ---------------------------------------------------------------------------

/** How long a new computer waits for the person's approval: as long as the account keeps a sign-in code (DEVICE_CODE_TTL_SECONDS). */
export const CLOUD_JOIN_APPROVAL_WAIT_MS = 10 * 60_000;

/** "10 minutes": the wait in the card, its text and the error when nobody approved. */
export function cloudJoinApprovalWaitText(): string {
  const minutes = Math.round(CLOUD_JOIN_APPROVAL_WAIT_MS / 60_000);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** A resize that keeps the size and grows only the disk (the Android pane's Grow the disk). */
export function cloudLaneJobGrowsDiskOnly(job: CloudLaneJobSnapshot): job is CloudLaneJobSnapshot & { diskGb: number } {
  return job.kind === "resize" && job.fromSizeId === job.toSizeId && typeof job.diskGb === "number" && job.diskGb > 0;
}

// ---------------------------------------------------------------------------
// The account's ADE Cloud lanes, one list (`cloud.lanes`, `ade cloud lanes`)
// ---------------------------------------------------------------------------

/** Why a lane's computer is gone: a saved chat's `computer.reason`, or a kept lane's (`inactive` is the old 30-day rule). */
export type CloudComputerFate = "you" | "freed" | "idle" | "plan" | "automation" | "project" | "launch" | "other" | "inactive";

/** A kept lane's server reason as the fate people read. */
export const CLOUD_KEPT_LANE_FATE: Record<CloudLaneWithoutComputer["reason"], CloudComputerFate> = {
  freed: "freed",
  idle_cleanup: "idle",
  plan_limit: "plan",
  inactive: "inactive",
};

/** What happened to a lane's computer, in one sentence; `when` is " on Nov 18" or "". */
export function cloudComputerFateSentence(fate: CloudComputerFate | null | undefined, when: string): string {
  switch (fate) {
    case "you":
      return `You deleted its computer${when}.`;
    case "freed":
      return `You freed its computer${when}.`;
    case "idle":
      return `ADE deleted its computer${when} because it wasn't used.`;
    case "plan":
      return `ADE deleted its computer${when} to fit your plan.`;
    case "inactive":
      return `ADE deleted its computer${when} after 30 days without use.`;
    case "automation":
      return `Its automation finished${when}, and ADE deleted its computer.`;
    case "project":
      return `Its project's computers were deleted${when}.`;
    case "launch":
      return `Its launch didn't finish, so ADE deleted its computer${when}.`;
    default:
      return `Its computer was deleted${when}.`;
  }
}

/**
 * Where a lane is: on a computer (`awake`, `asleep`, `starting`, `stopping`,
 * `deleting`, `error`), or `computer_deleted`: the lane and its chats stay,
 * and the next message makes a new computer on its branch.
 */
export type CloudLaneEntryState = "awake" | "asleep" | "starting" | "stopping" | "deleting" | "error" | "computer_deleted";

export type CloudLaneEntry = {
  laneId: string;
  name: string;
  /** The branch, as the lane's computer or its kept record named it; null when ADE never learned it. */
  branch: string | null;
  /** `github.com/owner/repo`, or null. */
  projectOrigin: string | null;
  state: CloudLaneEntryState;
  /** The computer the lane lives on; null when it was deleted. */
  computer: {
    instanceId: string;
    machineKey: string | null;
    name: string | null;
    sizeLabel: string;
    hoursRate: number | null;
    lastUsedAt: string | null;
    /** The idle cleanup's planned delete (ISO); "Keep it" (`ade cloud lanes keep`) stops it. */
    deletesAt: string | null;
    diskGb: number | null;
  } | null;
  /** Why and when its computer went, for `computer_deleted`; `sentence` is the one line people read. */
  deleted: { at: string | null; fate: CloudComputerFate; sentence: string } | null;
  /** Saved chats of this lane on ADE Cloud (the account's newest, so a large account may count fewer). */
  chats: number;
  /** Its newest lane backup: the work not on GitHub that ADE saved at rest. */
  backup: { commits: number; files: number; savedAt: string; bytes: number } | null;
  /** The account machine keys its saved chats and backups are kept under (a delete clears them). */
  machineKeys: string[];
  /** Opens the lane in ADE on any device (`ade://` and `https://ade-app.dev/open/lane`). */
  link: string;
};

export type CloudLanesAnswer = {
  lanes: CloudLaneEntry[];
  /** Parts ADE couldn't read (the computers, the kept lanes, the chats, the backups), each as a sentence. */
  unread: string[];
  /** A filter picked these (a project, --deleted, --stale): an empty list means none matched. */
  filtered?: boolean;
};
