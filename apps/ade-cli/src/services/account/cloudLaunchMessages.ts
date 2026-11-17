/**
 * The messages a person sent to a server launch while its chat didn't exist
 * yet (the server keeps them). Once the chat started with the first one, the
 * cloud computer claims each of the others, sends it once, and reports it.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CloudApiError } from "../../../../desktop/src/shared/cloudApiClient";
import type { CloudBootLaunchDeps } from "./cloudBootLaunch";

type MessageDeps = Pick<CloudBootLaunchDeps, "launchId" | "logger" | "stateFile" | "api" | "sendChatMessage" | "waitForChatIdle" | "typeIntoCli">;
/** The chat the queued messages go to; `cli`: a restored CLI, so each one is typed at its prompt. */
type MessageTarget = { sessionId: string; kind?: "cli" };

/**
 * Which messages this computer claimed and sent, so a restart never sends one
 * twice. `launchId` names the journal's owner: a launch id, or
 * `CHAT_QUEUE_JOURNAL_KEY` for the queue of existing chats.
 */
export type MessageJournal = { launchId: string; claims: Record<string, string>; attempted: string[]; sent: string[] };

/** The journal key of the queue of existing chats (`cloudChatMessageQueue.ts`). */
export const CHAT_QUEUE_JOURNAL_KEY = "chat-queue";

/** A delivery that couldn't finish (the server didn't answer) is tried this many times, with a backoff; a later boot tries again. */
const DELIVERY_ATTEMPTS = 6;
const DELIVERY_FIRST_DELAY_MS = 2_000;

/** The 4xx answers a report is sent again after (a token on its way, a timeout, a busy server). */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([401, 408, 429]);

/** The server's own no (any other 4xx): final, so sending the report again changes nothing. */
export function isFinalRefusal(error: unknown): boolean {
  return error instanceof CloudApiError && error.status >= 400 && error.status < 500 && !RETRYABLE_STATUSES.has(error.status);
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function readMessageJournal(file: string, key: string, logger: MessageDeps["logger"]): MessageJournal {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MessageJournal>;
    if (parsed.launchId === key && parsed.claims && Array.isArray(parsed.sent)) {
      return { launchId: key, claims: parsed.claims, attempted: Array.isArray(parsed.attempted) ? parsed.attempted : [], sent: parsed.sent };
    }
  } catch (error) {
    // None yet is nothing claimed. Unreadable is too, but say so.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("cloud_boot_launch.message_journal_unreadable", { launchId: key, error: errorText(error) });
  }
  return { launchId: key, claims: {}, attempted: [], sent: [] };
}

export function writeMessageJournal(file: string, journal: MessageJournal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(journal), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** A send the chat refused because a turn runs (Codex's `turn_in_flight`). */
function isTurnInFlight(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "turn_in_flight";
}

/** One queued message, as both queues list it. Its `text` is the owner's: never in a log. */
export type OrderedMessage = { messageId: string; seq: number; state: string; text: string };

/** How one queue claims, reports and sends (a launch's messages, or an existing chat's). */
export type MessageChannel<M extends OrderedMessage> = {
  journal: MessageJournal;
  saveJournal: () => void;
  claim: (messageId: string, claimId: string) => Promise<void>;
  report: (messageId: string, claimId: string, state: "delivered" | "failed", error?: string) => Promise<void>;
  /** Waits until the chat's running turn is over; false when it still runs at the wait's limit. */
  waitIdle?: () => Promise<boolean>;
  /**
   * Runs after the claim and before the idle wait (a provider sign-in wait).
   * `stop` ends this round and keeps the claim; `failed` reports the message failed.
   */
  beforeSend?: (message: M, claimId: string) => Promise<{ kind: "go" } | { kind: "stop" } | { kind: "failed"; error: string }>;
  send: (message: M) => Promise<void>;
  logger: MessageDeps["logger"];
  /** Names the queue in log lines; never chat text. */
  logMeta: Record<string, unknown>;
};

/**
 * Sends one chat's queued messages, in order, each once: the claim is
 * written here before it is asked for, the send carries a client send id,
 * and a message this computer claimed but can't tell it sent (a restart
 * mid-send) is reported failed, never sent again. True only when nothing is
 * left to send.
 */
export async function deliverInOrder<M extends OrderedMessage>(messages: readonly M[], channel: MessageChannel<M>): Promise<boolean> {
  const { journal, logger, logMeta } = channel;
  let done = true;
  // A report that didn't land leaves the message `sending` on the server: not done, so it is
  // reported again (the journal says what to report). The server's own no is final.
  const finish = async (messageId: string, claimId: string, state: "delivered" | "failed", error?: string) => {
    await channel.report(messageId, claimId, state, error).catch((reportError: unknown) => {
      const final = isFinalRefusal(reportError);
      logger.warn("cloud_boot_launch.message_report_failed", { ...logMeta, final, error: errorText(reportError) });
      if (!final) done = false;
    });
  };
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    const mine = journal.claims[message.messageId];
    if ((message.state === "sending" || message.state === "waiting_for_sign_in") && mine) {
      // Claimed here before: sent (say so), maybe sent (never again), or a claim whose answer was lost (send it now).
      if (journal.sent.includes(message.messageId)) {
        await finish(message.messageId, mine, "delivered");
        continue;
      }
      if (journal.attempted.includes(message.messageId)) {
        await finish(message.messageId, mine, "failed", "ADE couldn't confirm this message reached the chat. Send it again if it isn't there.");
        continue;
      }
    } else if (message.state !== "queued") {
      continue;
    }
    // A claim is written here before it is asked for, so a claim whose answer was lost is asked again with the same id.
    const claimId = mine ?? randomBytes(18).toString("base64url");
    journal.claims[message.messageId] = claimId;
    channel.saveJournal();
    const claimed = await channel.claim(message.messageId, claimId).then(() => "claimed" as const, (error: unknown) => {
      const final = isFinalRefusal(error);
      logger.warn("cloud_boot_launch.message_claim_failed", { ...logMeta, final, error: errorText(error) });
      return final ? "refused" as const : "retry" as const;
    });
    // The server's no (sent or claimed elsewhere): not this computer's to send.
    if (claimed === "refused") continue;
    // A claim that didn't get through: stop here, so no later message goes before this one.
    if (claimed === "retry") {
      done = false;
      break;
    }
    if (channel.beforeSend) {
      const before = await channel.beforeSend(message, claimId);
      if (before.kind === "stop") {
        done = false;
        break;
      }
      if (before.kind === "failed") {
        await finish(message.messageId, claimId, "failed", before.error.slice(0, 300));
        continue;
      }
    }
    // Only to an idle chat, and before the attempt is written: a restart during
    // the wait finds the message claimed but not tried, so it is sent then.
    // A turn still running at the wait's limit: this round stops, the claim stays.
    if (channel.waitIdle && !(await channel.waitIdle())) {
      logger.warn("cloud_boot_launch.message_waits_for_turn", logMeta);
      done = false;
      break;
    }
    journal.attempted.push(message.messageId);
    channel.saveJournal();
    try {
      await channel.send(message);
    } catch (error) {
      // Refused for a running turn (Codex): not sent, so not an attempt; a later round sends it.
      if (isTurnInFlight(error)) {
        journal.attempted = journal.attempted.filter((id) => id !== message.messageId);
        channel.saveJournal();
        done = false;
        break;
      }
      await finish(message.messageId, claimId, "failed", `ADE couldn't send this message to the chat: ${errorText(error)}`.slice(0, 300));
      continue;
    }
    journal.sent.push(message.messageId);
    channel.saveJournal();
    await finish(message.messageId, claimId, "delivered");
  }
  return done;
}

/**
 * Sends the messages the person sent while the launch's chat didn't exist
 * (`deliverInOrder`). The first message started the chat, so it is not one
 * of them. True only when the queue was read and nothing is left to send.
 */
export async function deliverQueuedMessages(deps: MessageDeps, projectId: string, target: MessageTarget): Promise<boolean> {
  const { launchId, logger } = deps;
  const { sessionId } = target;
  const api = deps.api();
  const cli = target.kind === "cli";
  // Nothing to read or send with (no account session yet): the messages are still owed.
  if (!api || (cli ? !deps.typeIntoCli : !deps.sendChatMessage)) return false;
  const sendChatMessage = deps.sendChatMessage;
  const typeIntoCli = deps.typeIntoCli;
  const listed = await api.launchMessages(launchId).catch((error: unknown) => {
    logger.warn("cloud_boot_launch.messages_read_failed", { launchId, error: errorText(error) });
    return null;
  });
  if (!listed) return false;
  const file = `${deps.stateFile}.messages.json`;
  const journal = readMessageJournal(file, launchId, logger);
  const waitForChatIdle = deps.waitForChatIdle;
  return await deliverInOrder(listed.messages.filter((message) => message.seq > 1), {
    journal,
    saveJournal: () => writeMessageJournal(file, journal),
    claim: async (messageId, claimId) => {
      await api.claimLaunchMessage(launchId, messageId, claimId);
    },
    report: async (messageId, claimId, state, error) => {
      await api.reportLaunchMessage(launchId, messageId, { claimId, state, sessionId, ...(error ? { error } : {}) });
    },
    // A CLI holds a message for a running turn itself (`holdUntilFree`).
    ...(waitForChatIdle && !cli ? { waitIdle: () => waitForChatIdle(projectId, sessionId) } : {}),
    send: async (message) => {
      const clientSendId = `launch-message-${launchId}-${message.messageId}`;
      if (cli && typeIntoCli) {
        const outcome = await typeIntoCli(projectId, sessionId, { text: message.text, clientMessageId: clientSendId });
        if (outcome === "ended") throw new Error("The CLI has ended, so ADE couldn't type this message.");
        // Another runtime runs the CLI now: not typed, so a later round types it.
        if (outcome === "deferred") throw Object.assign(new Error("The CLI is busy."), { code: "turn_in_flight" });
        return;
      }
      await sendChatMessage!(projectId, sessionId, { text: message.text, clientSendId });
    },
    logger,
    logMeta: { launchId },
  });
}

/** `deliverQueuedMessages`, tried again with a backoff until nothing is left; false when it still couldn't finish. */
export async function deliverQueuedMessagesWithRetry(
  deps: MessageDeps,
  projectId: string,
  target: MessageTarget,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    if (await deliverQueuedMessages(deps, projectId, target)) return true;
    if (attempt >= DELIVERY_ATTEMPTS) {
      deps.logger.warn("cloud_boot_launch.messages_owed", { launchId: deps.launchId, attempts: attempt });
      return false;
    }
    await sleep(DELIVERY_FIRST_DELAY_MS * 2 ** (attempt - 1));
  }
}
