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

type MessageDeps = Pick<CloudBootLaunchDeps, "launchId" | "logger" | "stateFile" | "api" | "sendChatMessage" | "waitForChatIdle">;

/** Which messages this computer claimed and sent (`<state file>.messages.json`), so a restart never sends one twice. */
type MessageJournal = { launchId: string; claims: Record<string, string>; attempted: string[]; sent: string[] };

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

function readJournal(file: string, launchId: string, logger: MessageDeps["logger"]): MessageJournal {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MessageJournal>;
    if (parsed.launchId === launchId && parsed.claims && Array.isArray(parsed.sent)) {
      return { launchId, claims: parsed.claims, attempted: Array.isArray(parsed.attempted) ? parsed.attempted : [], sent: parsed.sent };
    }
  } catch (error) {
    // None yet is nothing claimed. Unreadable is too, but say so.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("cloud_boot_launch.message_journal_unreadable", { launchId, error: errorText(error) });
  }
  return { launchId, claims: {}, attempted: [], sent: [] };
}

function writeJournal(file: string, journal: MessageJournal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(journal));
  fs.renameSync(temp, file);
}

/** A send the chat refused because a turn runs (Codex's `turn_in_flight`). */
function isTurnInFlight(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "turn_in_flight";
}

/**
 * Sends the messages the person sent while the chat didn't exist, in order,
 * each once: the claim is written here before it is asked for, the send
 * carries a client send id, and a message this computer claimed but can't
 * tell it sent (a restart mid-send) is reported failed, never sent again.
 * True only when the queue was read and nothing is left to send.
 */
export async function deliverQueuedMessages(deps: MessageDeps, projectId: string, sessionId: string): Promise<boolean> {
  const { launchId, logger } = deps;
  const api = deps.api();
  // Nothing to read or send with (no account session yet): the messages are still owed.
  if (!api || !deps.sendChatMessage) return false;
  const listed = await api.launchMessages(launchId).catch((error: unknown) => {
    logger.warn("cloud_boot_launch.messages_read_failed", { launchId, error: errorText(error) });
    return null;
  });
  if (!listed) return false;
  const file = `${deps.stateFile}.messages.json`;
  const journal = readJournal(file, launchId, logger);
  let done = true;
  // A report that didn't land leaves the message `sending` on the server: not done, so it is
  // reported again (the journal says what to report). The server's own no is final.
  const finish = async (messageId: string, claimId: string, state: "delivered" | "failed", error?: string) => {
    await api.reportLaunchMessage(launchId, messageId, { claimId, state, sessionId, ...(error ? { error } : {}) }).catch((reportError: unknown) => {
      const final = isFinalRefusal(reportError);
      logger.warn("cloud_boot_launch.message_report_failed", { launchId, final, error: errorText(reportError) });
      if (!final) done = false;
    });
  };
  for (const message of [...listed.messages].sort((a, b) => a.seq - b.seq)) {
    if (message.seq <= 1) continue;
    const mine = journal.claims[message.messageId];
    if (message.state === "sending" && mine) {
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
    writeJournal(file, journal);
    const claimed = await api.claimLaunchMessage(launchId, message.messageId, claimId).then(() => "claimed" as const, (error: unknown) => {
      const final = isFinalRefusal(error);
      logger.warn("cloud_boot_launch.message_claim_failed", { launchId, final, error: errorText(error) });
      return final ? "refused" as const : "retry" as const;
    });
    // The server's no (sent or claimed elsewhere): not this computer's to send.
    if (claimed === "refused") continue;
    // A claim that didn't get through: stop here, so no later message goes before this one.
    if (claimed === "retry") {
      done = false;
      break;
    }
    // Only to an idle chat, and before the attempt is written: a restart during
    // the wait finds the message claimed but not tried, so it is sent then.
    // A turn still running at the wait's limit: this round stops, the claim stays.
    if (deps.waitForChatIdle && !(await deps.waitForChatIdle(projectId, sessionId))) {
      logger.warn("cloud_boot_launch.message_waits_for_turn", { launchId });
      done = false;
      break;
    }
    journal.attempted.push(message.messageId);
    writeJournal(file, journal);
    try {
      await deps.sendChatMessage(projectId, sessionId, { text: message.text, clientSendId: `launch-message-${launchId}-${message.messageId}` });
    } catch (error) {
      // Refused for a running turn (Codex): not sent, so not an attempt; a later round sends it.
      if (isTurnInFlight(error)) {
        journal.attempted = journal.attempted.filter((id) => id !== message.messageId);
        writeJournal(file, journal);
        done = false;
        break;
      }
      await finish(message.messageId, claimId, "failed", `ADE couldn't send this message to the chat: ${errorText(error)}`.slice(0, 300));
      continue;
    }
    journal.sent.push(message.messageId);
    writeJournal(file, journal);
    await finish(message.messageId, claimId, "delivered");
  }
  return done;
}

/** `deliverQueuedMessages`, tried again with a backoff until nothing is left; false when it still couldn't finish. */
export async function deliverQueuedMessagesWithRetry(
  deps: MessageDeps,
  projectId: string,
  sessionId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    if (await deliverQueuedMessages(deps, projectId, sessionId)) return true;
    if (attempt >= DELIVERY_ATTEMPTS) {
      deps.logger.warn("cloud_boot_launch.messages_owed", { launchId: deps.launchId, attempts: attempt });
      return false;
    }
    await sleep(DELIVERY_FIRST_DELAY_MS * 2 ** (attempt - 1));
  }
}
