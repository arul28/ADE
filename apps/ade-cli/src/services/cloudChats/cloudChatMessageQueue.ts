/**
 * Messages a person sent to an EXISTING chat on this ADE Cloud computer
 * while the computer slept (`POST /cloud/chats/:m/:c/messages`). The server
 * keeps them; this brain claims each one, sends it once, and reports it.
 *
 * A drain runs at brain start, when the computer wakes from a sleep
 * (`cloudKeepAwake` `onWoke`), and when the server runs
 * `ade cloud messages drain --json` after it woke the computer. No timer: a
 * round that could not finish waits for the next of these.
 *
 * Each chat's messages go in order, one at a time, and only to an idle chat.
 * Chats go side by side, at most `CHAT_PARALLEL` at once. A chat whose
 * provider is not signed in here waits for the person's sign-in, which the
 * message shows (`waiting_for_sign_in` + `signIn`), as a launch does.
 * The journal (`<ADE_HOME>/cloud/chat-messages.json`) makes a restart safe:
 * a message is never sent twice (`deliverInOrder`).
 *
 * A message for an agent CLI is typed at the CLI's prompt through the same
 * path the Work input box uses (`typeIntoAgentCliWhenFree`): typed now when
 * the prompt is free, else held on this brain and typed at the CLI's next
 * free prompt. A sleep keeps the CLI's process, so it still runs after a
 * wake; after a cold restart the process is gone and the message fails.
 */

import path from "node:path";
import {
  cloudChatMessageSettingsOf,
  type CloudChatMessageAttachment,
  type CloudChatMessageSettings,
  type CloudComputerQueuedMessage,
} from "../../../../account-directory/src/cloud/contract";
import type { CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import {
  CHAT_QUEUE_JOURNAL_KEY,
  deliverInOrder,
  readMessageJournal,
  writeMessageJournal,
} from "../account/cloudLaunchMessages";
import { SIGN_IN_WAIT_MS, waitForSignIn, type SignInWaitDeps } from "../account/cloudLaunchSignInWait";
import { saveCloudFiles, withAttachmentPaths, type SavedCloudFile } from "./cloudAttachmentFiles";

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

/** Chats whose messages go side by side. */
const CHAT_PARALLEL = 4;
/** A round that left messages runs again after these waits (then the next wake drains). */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 5 * 60_000] as const;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type CloudChatQueueDeps = {
  instanceId: string;
  /** `<ADE_HOME>`: the journal is `<ADE_HOME>/cloud/chat-messages.json`. */
  adeHome: string;
  logger: Logger;
  api: () => Promise<CloudApiClient | null>;
  /**
   * The project on this computer that holds the chat: the message's own
   * project id when this brain knows it, else the project whose chats include
   * it. Null when no project here has the chat.
   */
  locateChat: (message: CloudComputerQueuedMessage) => Promise<{ projectId: string; rootPath: string } | null>;
  /** The chat's provider here; null when the chat is gone. */
  chatProvider: (projectId: string, sessionId: string) => Promise<string | null>;
  /** Resolves when the chat has no running turn (an event wait, never a poll); false at the wait's limit. */
  waitForChatIdle: (projectId: string, sessionId: string) => Promise<boolean>;
  sendChatMessage: (projectId: string, sessionId: string, message: { text: string; clientSendId: string; attachments?: QueuedFile[] }) => Promise<void>;
  /**
   * Applies the model and the settings picked with a message to the chat
   * (its `updateSession`) before the message goes. Chats only: a CLI ignores
   * them. Left out, nothing is applied.
   */
  applyChatSettings?: (projectId: string, sessionId: string, settings: CloudChatMessageSettings & { modelId?: string | null }) => Promise<void>;
  /** `cli`: a tracked agent CLI whose process runs here; `cli_ended`: its process is gone; else a chat. */
  sessionKind?: (projectId: string, sessionId: string) => Promise<"chat" | "cli" | "cli_ended">;
  /** Types the text at the CLI's prompt (`typeIntoAgentCliWhenFree` with `holdUntilFree`). */
  typeIntoCli?: (projectId: string, sessionId: string, message: { text: string; clientMessageId: string }) => Promise<"delivered" | "held" | "deferred" | "ended">;
  /** The provider sign-in wait (`cloudLaunchSignInWait.ts`); left out, nothing waits. */
  signIn?: SignInWaitDeps;
  /** Holds the computer awake for one named step, up to `ttlMs`. */
  holdFor?: <T>(reason: string, ttlMs: number, run: () => Promise<T>) => Promise<T>;
  sleep?: (ms: number) => Promise<void>;
};

export type CloudChatQueueDrainResult = {
  /** Messages the server listed for this computer. */
  listed: number;
  /** True when every listed message was settled (sent, failed or not this computer's). */
  done: boolean;
  /** The list could not be read (an older server, no account session, the network). */
  error?: string;
};

export type CloudChatMessageQueue = {
  /**
   * One drain round. A call while a round runs waits for it and starts one
   * more after it, so a message queued during the round is not missed.
   */
  drain: (reason: string) => Promise<CloudChatQueueDrainResult>;
};

/** A file a queued message carries, downloaded here. */
type QueuedFile = SavedCloudFile;

/** The CLI's process is gone (a cold restart): nothing ADE types reaches it. */
const CLI_ENDED_SENTENCE = "This CLI isn't running on its computer any more (the computer restarted), so ADE couldn't type the message. Open the CLI and send the message again.";

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function downloadAttachments(
  api: CloudApiClient,
  rootPath: string,
  messageId: string,
  attachments: readonly CloudChatMessageAttachment[],
): Promise<QueuedFile[]> {
  if (!attachments.length) return [];
  if (!MESSAGE_ID.test(messageId)) throw new Error("The message has an id this computer can't keep files under.");
  return await saveCloudFiles(
    path.join(rootPath, ".ade", "attachments", `chat-message-${messageId}`),
    attachments,
    (file) => api.readLaunchFile(file.launchId, file.fileId),
    "message",
  );
}

export function createCloudChatMessageQueue(deps: CloudChatQueueDeps): CloudChatMessageQueue {
  const { logger, instanceId } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  const journalFile = path.join(deps.adeHome, "cloud", "chat-messages.json");
  /** Holds the computer awake for one step; with no keep-awake, just runs it. */
  const holdFor = deps.holdFor ?? (<T>(_reason: string, _ttlMs: number, run: () => Promise<T>) => run());
  let running: Promise<CloudChatQueueDrainResult> | null = null;
  let again = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;

  const round = async (reason: string): Promise<CloudChatQueueDrainResult> => {
    const api = await deps.api().catch(() => null);
    if (!api) return { listed: 0, done: false, error: "not_signed_in" };
    let messages: CloudComputerQueuedMessage[];
    try {
      messages = await api.computerMessages(instanceId);
    } catch (error) {
      logger.warn("cloud.chat_queue_read_failed", { reason, error: errorText(error) });
      return { listed: 0, done: false, error: errorText(error).slice(0, 200) };
    }
    const journal = readMessageJournal(journalFile, CHAT_QUEUE_JOURNAL_KEY, logger);
    // A message the server no longer lists is settled there: its journal row goes.
    const listedIds = new Set(messages.map((message) => message.messageId));
    const before = Object.keys(journal.claims).length;
    for (const id of Object.keys(journal.claims)) if (!listedIds.has(id)) delete journal.claims[id];
    journal.attempted = journal.attempted.filter((id) => listedIds.has(id));
    journal.sent = journal.sent.filter((id) => listedIds.has(id));
    if (Object.keys(journal.claims).length !== before) writeMessageJournal(journalFile, journal);
    if (!messages.length) return { listed: 0, done: true };
    logger.info("cloud.chat_queue_drain", { reason, listed: messages.length });

    const byChat = new Map<string, CloudComputerQueuedMessage[]>();
    for (const message of messages) {
      const key = `${message.machineKey}/${message.chatId}`;
      byChat.set(key, [...(byChat.get(key) ?? []), message]);
    }
    const chats = [...byChat.values()];
    let done = true;
    let next = 0;
    const deliverChat = async (list: CloudComputerQueuedMessage[]): Promise<boolean> => {
      const first = list[0]!;
      const sessionId = first.chatId;
      const logMeta = { chatId: sessionId, reason };
      const report = async (messageId: string, claimId: string, report: Parameters<CloudApiClient["reportComputerMessage"]>[2]) => {
        await api.reportComputerMessage(instanceId, messageId, { ...report, claimId });
      };
      let located: { projectId: string; rootPath: string } | null | undefined;
      const locate = async () => {
        if (located === undefined) located = await deps.locateChat(first).catch(() => null);
        return located;
      };
      let kind: "chat" | "cli" | "cli_ended" | undefined;
      const kindOf = async (projectId: string) => {
        kind ??= deps.sessionKind ? await deps.sessionKind(projectId, sessionId).catch(() => "chat" as const) : "chat";
        return kind;
      };
      return await deliverInOrder(list, {
        journal,
        saveJournal: () => writeMessageJournal(journalFile, journal),
        claim: async (messageId, claimId) => {
          await api.claimComputerMessage(instanceId, messageId, claimId);
        },
        report: async (messageId, claimId, state, error) => {
          await report(messageId, claimId, { claimId, state, sessionId, ...(error ? { error } : {}) });
        },
        beforeSend: async (message, claimId) => {
          const where = await locate();
          if (!where) return { kind: "failed", error: "This chat is not on its computer any more. Send the message again." };
          const sessionKind = await kindOf(where.projectId);
          if (sessionKind === "cli_ended") return { kind: "failed", error: CLI_ENDED_SENTENCE };
          // A running CLI is signed in already; its own prompt waits for the turn.
          if (sessionKind === "cli") return deps.typeIntoCli ? { kind: "go" } : { kind: "failed", error: "This computer's ADE can't type into a CLI. Update ADE, then send the message again." };
          const provider = message.provider ?? await deps.chatProvider(where.projectId, sessionId).catch(() => null);
          if (!provider) return { kind: "failed", error: "This chat is not on its computer any more. Send the message again." };
          if (!deps.signIn) return { kind: "go" };
          const waited = await holdFor("chat_message_sign_in", SIGN_IN_WAIT_MS + 10 * 60_000, () => waitForSignIn(deps.signIn!, provider, {
            show: async (signIn) => {
              try {
                await report(message.messageId, claimId, { claimId, state: "waiting_for_sign_in", sessionId, signIn });
                return true;
              } catch (error) {
                logger.warn("cloud.chat_queue_sign_in_report_failed", { ...logMeta, error: errorText(error) });
                return false;
              }
            },
            // Back to `sending`: every client drops the sign-in card.
            ready: async () => {
              await report(message.messageId, claimId, { claimId, state: "sending", sessionId }).catch((error: unknown) => {
                logger.warn("cloud.chat_queue_sign_in_report_failed", { ...logMeta, error: errorText(error) });
              });
            },
            logMeta,
          }, sleep));
          if (waited.kind === "ready") return { kind: "go" };
          if (waited.kind === "cancelled") return { kind: "stop" };
          return { kind: "failed", error: waited.error };
        },
        waitIdle: async () => {
          const where = await locate();
          if (!where) return false;
          // A CLI's queued text is held on the brain and typed at its next free prompt.
          if ((await kindOf(where.projectId)) === "cli") return true;
          return await deps.waitForChatIdle(where.projectId, sessionId);
        },
        send: async (message) => {
          const where = await locate();
          if (!where) throw new Error("This chat is not on its computer any more.");
          const attachments = await downloadAttachments(api, where.rootPath, message.messageId, message.attachments ?? []);
          if ((await kindOf(where.projectId)) === "cli" && deps.typeIntoCli) {
            const outcome = await deps.typeIntoCli(where.projectId, sessionId, {
              text: withAttachmentPaths(message.text, attachments),
              clientMessageId: message.clientSendId || message.messageId,
            });
            if (outcome === "ended") throw new Error(CLI_ENDED_SENTENCE);
            // Another runtime runs the CLI now: not typed, so a later round types it.
            if (outcome === "deferred") throw Object.assign(new Error("The CLI is busy."), { code: "turn_in_flight" });
            return;
          }
          // Older servers send no settings; the same checks as the server's.
          const settings = cloudChatMessageSettingsOf(message.settings);
          if (deps.applyChatSettings && (settings || message.modelId)) {
            // A setting the chat refuses must not lose the message: it goes on the chat's current settings.
            await deps.applyChatSettings(where.projectId, sessionId, { ...settings, modelId: message.modelId }).catch((error: unknown) => {
              logger.warn("cloud.chat_queue_settings_failed", { ...logMeta, error: errorText(error) });
            });
          }
          await deps.sendChatMessage(where.projectId, sessionId, {
            text: message.text,
            clientSendId: message.clientSendId || message.messageId,
            ...(attachments.length ? { attachments } : {}),
          });
        },
        logger,
        logMeta,
      });
    };
    const worker = async () => {
      while (next < chats.length) {
        const list = chats[next++]!;
        const finished = await deliverChat(list).catch((error: unknown) => {
          logger.warn("cloud.chat_queue_chat_failed", { reason, error: errorText(error) });
          return false;
        });
        if (!finished) done = false;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHAT_PARALLEL, chats.length) }, worker));
    logger.info("cloud.chat_queue_drained", { reason, listed: messages.length, done });
    return { listed: messages.length, done };
  };

  /**
   * A round that left messages (a claim or a list that failed for a moment)
   * runs again a few times, so a message never waits for the next wake. The
   * timer never holds the computer awake or the process open.
   */
  const retryLater = (result: CloudChatQueueDrainResult) => {
    if (result.done) {
      retries = 0;
      return;
    }
    if (result.error === "not_signed_in" || retryTimer || retries >= RETRY_DELAYS_MS.length) return;
    const delayMs = RETRY_DELAYS_MS[retries++]!;
    logger.info("cloud.chat_queue_retry_scheduled", { attempt: retries, delayMs });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drain("retry").catch((error: unknown) => logger.warn("cloud.chat_queue_drain_failed", { reason: "retry", error: errorText(error) }));
    }, delayMs);
    retryTimer.unref?.();
  };

  const drain = (reason: string): Promise<CloudChatQueueDrainResult> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let result: CloudChatQueueDrainResult;
      do {
        again = false;
        // Held awake through the round; a sign-in wait holds on its own.
        result = await holdFor("chat_messages", 10 * 60_000, () => round(reason));
      } while (again);
      return result;
    })().finally(() => {
      running = null;
    });
    void running.then(retryLater, () => {});
    return running;
  };

  return { drain };
}
