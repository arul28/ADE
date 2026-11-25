import {
  CLOUD_CHAT_MESSAGE_MAX_CHARS,
  CLOUD_CHAT_MESSAGE_PRUNE_MS,
  CLOUD_CHAT_MESSAGE_TTL_MS,
  CLOUD_CHAT_MESSAGES_LIST_MAX,
  CLOUD_CHAT_MESSAGES_OPEN_PER_ACCOUNT,
  CLOUD_CHAT_MESSAGES_OPEN_PER_CHAT,
  CLOUD_CHAT_MESSAGES_PER_MINUTE,
  CLOUD_LAUNCH_DRAFT_TTL_MS,
  cloudChatMessageSettingsOf,
  type CloudChatMessageAddResult,
  type CloudChatMessageAttachment,
  type CloudChatMessageSettings,
  type CloudChatMessageState,
  type CloudChatQueuedMessage,
  type CloudComputerQueuedMessage,
  type CloudLaunchMessage,
  type CloudLaunchRecord,
  type CloudLaunchSignIn,
  type CloudTierId,
  type CloudWakeOutcome,
} from "./contract";
import { ROW_ID, UNREADABLE_REQUEST_MESSAGE, UUID_PATTERN, badRequest, clippedText, fail, json, readJson, shortString } from "./http";
import { addLaunchMessage, cancelLaunchMessageStatement, LAUNCH_MESSAGE_ID, launchMessageOf } from "./launchMessages";
import { activeContinueLaunch, githubOriginOf, parseAttachments, parseSignIn, r2KeyOf, recordOf, type LaunchRow, type ParsedLaunchRequest } from "./launches";
import { cloudSizeForTier, type CloudSize } from "./plans";
import { openJson, sealJson, userKeys, type UserKeys } from "./seal";
import { handOverQueuedMessagesStatements, logCloud, ownedComputer, reportCloudFailure, type CloudEnv, type ComputerRow } from "./store";
import { copyRow, openSummary, type CopyRow } from "./chats";
import { cliSessionCopy } from "./sessionCopies";
import { MOVE_HOLDS_MESSAGES_SQL, MOVE_JOB_KIND, moveMessageRouteOf } from "./moves";

/**
 * The person's queue for an existing cloud chat (CONTRACTS 3.1). A send to a
 * sleeping lane is kept here, wakes its computer, and is sent once: the
 * computer claims each message (one conditional write), sends it with
 * `clientSendId = messageId`, and reports it. Closing the tab never loses a
 * message, and the same id from two devices is one message.
 *
 * A refusal (blocked, out of hours, too many awake, deleting) stores
 * nothing, so a message never arrives days later. A chat whose computer is
 * gone is continued by a launch the server starts for the same lane
 * (`continueChat`), which carries the message; its rows here are
 * `via_launch` and read their state from the launch's own message.
 *
 * A send can also go to a saved CLI session (`cloud_session_copies`, kind
 * `cli`): its session id takes the chat id's place, and the computer types
 * the text into the CLI. A shell takes no messages.
 *
 * While a move of the chat's computer to the other kind runs (`moves.ts`),
 * a send is kept here and nothing wakes or takes it (`wake.state:
 * "moving"`): the move stops the old computer's ADE and would cut its turn.
 * The new computer sends it once it has the lane, and a later send to the
 * old address goes on to the new computer (`queueComputerOf`). A move that
 * fails or is cancelled leaves it to the old computer.
 *
 * The text is sealed with the user's key. No text reaches a log line.
 */

const CLAIM_ID = /^[A-Za-z0-9_-]{16,80}$/;
const OPEN_STATES = "('queued', 'sending', 'waiting_for_sign_in')";

const notFound = () => fail("not_found", "That saved chat doesn't exist.", 404);
const messageNotFound = () => fail("not_found", "ADE Cloud has no such message.", 404);
const unavailable = () => fail("unavailable", "Saved chats aren't available right now. Try again soon.", 503);

export type ChatMessageRow = {
  user_id: string;
  machine_key: string;
  chat_id: string;
  message_id: string;
  instance_id: string | null;
  launch_id: string | null;
  via_launch: number;
  seq: number;
  body_sealed: string;
  provider: string | null;
  model_id: string | null;
  state: CloudChatMessageState;
  claim_id: string | null;
  claimed_at: number | null;
  sign_in_json: string | null;
  session_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

const bodyAad = (row: Pick<ChatMessageRow, "user_id" | "message_id">): string =>
  // The machine key and chat id are left out on purpose: a chat move re-keys the row, and the body must still open.
  `ade.cloud.chat.message.v1\0${row.user_id}\0${row.message_id}`;

/** The sealed body: the text, its files, and the chat settings picked with it (only the chat's computer reads them). */
type MessageBody = { text: string; attachments: CloudChatMessageAttachment[]; settings: CloudChatMessageSettings | null };

async function openBody(keys: UserKeys, row: ChatMessageRow): Promise<MessageBody> {
  const value = await openJson(keys, bodyAad(row), row.body_sealed);
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!record) logCloud("cloud.chat_message_unreadable", { userId: row.user_id, messageId: row.message_id });
  return {
    text: typeof record?.text === "string" ? record.text : "",
    attachments: Array.isArray(record?.attachments) ? record.attachments as CloudChatMessageAttachment[] : [],
    settings: cloudChatMessageSettingsOf(record?.settings),
  };
}

function signInOf(row: ChatMessageRow): CloudLaunchSignIn | null {
  if (!row.sign_in_json) return null;
  try {
    return JSON.parse(row.sign_in_json) as CloudLaunchSignIn;
  } catch {
    return null;
  }
}

/**
 * A new chat's launch got its chat (the computer reported its session id).
 * The messages the person queued on the launch after the first one join
 * that chat's queue as rows the launch carries (`via_launch`), so the chat
 * shows where each one is, a failed one too, after the launch's own page is
 * gone. They read their state from the launch's messages and the computer
 * never claims them (it sends the launch's own). A continue launch's rows
 * exist already. The same message again changes nothing.
 */
export async function carryLaunchMessagesToChat(env: CloudEnv, launch: LaunchRow, sessionId: string, now: number): Promise<void> {
  if (launch.kind === "lane" || launch.continue_chat_id || !launch.instance_id) return;
  // Only the ones not carried yet: each report of the chat, and the computer's key arriving, try again.
  const messages = (await env.DB.prepare(`
    select lm.message_id, lm.text, lm.provider, lm.model_id from cloud_launch_messages lm
    where lm.launch_id = ? and lm.seq > 1
      and not exists (select 1 from cloud_chat_messages m where m.launch_id = lm.launch_id and m.message_id = lm.message_id and m.via_launch = 1)
    order by lm.seq
  `).bind(launch.launch_id).all<{ message_id: string; text: string; provider: string | null; model_id: string | null }>()).results ?? [];
  if (messages.length === 0) return;
  const computer = await env.DB.prepare("select machine_key from cloud_computers where instance_id = ? and user_id = ?")
    .bind(launch.instance_id, launch.user_id).first<{ machine_key: string | null }>();
  const keys = await userKeys(env, launch.user_id, now);
  if (!computer?.machine_key || !keys) {
    logCloud("cloud.launch_messages_not_carried", { userId: launch.user_id, launchId: launch.launch_id, reason: keys ? "no_machine_key" : "no_keys" });
    return;
  }
  const chat = { machine_key: computer.machine_key, chat_id: sessionId };
  for (const message of messages) {
    await insertRow(env, keys, launch.user_id, chat, {
      messageId: message.message_id,
      text: message.text,
      attachments: [],
      provider: message.provider,
      modelId: message.model_id,
      settings: null,
    }, { instanceId: null, launchId: launch.launch_id, viaLaunch: true }, now);
  }
  logCloud("cloud.launch_messages_carried", { userId: launch.user_id, launchId: launch.launch_id, count: messages.length });
}

/**
 * A computer's machine key arrived (it writes it after the launch's path):
 * its chat launch's follow-ups that waited for the key join the chat now.
 * Never fails its caller; it logs.
 */
export async function carryLaunchMessagesForComputer(env: CloudEnv, instanceId: string, now: number): Promise<void> {
  try {
    const launch = await env.DB.prepare(`
      select * from cloud_launches where instance_id = ? and kind = 'chat' and session_id is not null and continue_chat_id is null
      order by created_at desc limit 1
    `).bind(instanceId).first<LaunchRow>();
    if (launch?.session_id) await carryLaunchMessagesToChat(env, launch, launch.session_id, now);
  } catch (error) {
    reportCloudFailure("cloud.launch_messages_carry_failed", { instanceId, error: error instanceof Error ? error.name : "unknown" });
  }
}

/** The sentences of a message a continue launch never sent; the launch's own sentence comes first when it has one. */
const LAUNCH_CANCELLED_SENTENCE = "The new computer for this chat was cancelled, so this message wasn't sent. Send it again.";
const LAUNCH_FAILED_SENTENCE = "The new computer for this chat didn't start, so this message wasn't sent. Send it again.";

/** A launch message's state as a queued chat message's. */
function stateFromLaunch(message: CloudLaunchMessage): CloudChatMessageState {
  if (message.state === "failed" && message.error === "Cancelled.") return "cancelled";
  return message.state;
}

async function messageOf(env: CloudEnv, keys: UserKeys, row: ChatMessageRow, opened?: MessageBody): Promise<CloudChatQueuedMessage> {
  const body = opened ?? await openBody(keys, row);
  let state = row.state;
  let error = row.error;
  let signIn = signInOf(row);
  if (row.via_launch && row.launch_id) {
    // A launch carries it: its own message row is the truth, and the launch's sign-in wait is this message's.
    const carried = await launchMessageOf(env, row.launch_id, row.message_id);
    if (carried) {
      state = stateFromLaunch(carried);
      error = carried.error;
    }
    if (state === "queued" || state === "sending" || state === "waiting_for_sign_in") {
      const launch = await env.DB.prepare("select * from cloud_launches where launch_id = ?").bind(row.launch_id).first<LaunchRow>();
      const record = launch ? recordOf(launch, Date.now()) : null;
      if (!launch || !record) {
        // The launch record is gone (it expired): the message was never sent.
        state = "failed";
        error = error ?? LAUNCH_FAILED_SENTENCE;
      } else if (record.state === "failed" || record.state === "cancelled") {
        // The launch failed, timed out or was cancelled: say so in the chat, never a message that waits forever.
        state = "failed";
        error = record.state === "cancelled" ? LAUNCH_CANCELLED_SENTENCE : record.error ?? LAUNCH_FAILED_SENTENCE;
      } else if (launch.state === "waiting_for_sign_in" && launch.sign_in_json) {
        state = "waiting_for_sign_in";
        signIn = signInOf({ ...row, sign_in_json: launch.sign_in_json });
      }
    }
  }
  return {
    messageId: row.message_id,
    machineKey: row.machine_key,
    chatId: row.chat_id,
    seq: row.seq,
    state,
    text: body.text,
    attachments: body.attachments,
    provider: row.provider,
    modelId: row.model_id,
    signIn,
    error,
    launchId: row.launch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readRow(env: CloudEnv, userId: string, machineKey: string, chatId: string, messageId: string): Promise<ChatMessageRow | null> {
  return await env.DB.prepare("select * from cloud_chat_messages where user_id = ? and machine_key = ? and chat_id = ? and message_id = ?")
    .bind(userId, machineKey, chatId, messageId).first<ChatMessageRow>();
}

/* ---- What the router gives this module ---- */

/** What a send does to a live computer, from the routes that own wakes (`routes.ts`). */
export type ChatWake = {
  /**
   * Runs every check a start runs (block, outside agents on the free plan,
   * credits for the computer's size, an update in progress, an image too old to
   * drain, a past-due computer, the awake cap, the idle cleanup's claim), and
   * records the use. A response when the send must not be stored; else what
   * the wake will be. Nothing wakes yet.
   */
  check: (computer: ComputerRow, asker: { outsideAgent: boolean }) => Promise<Response | { state: "awake" | "waking" }>;
  /**
   * A send a move holds: nothing wakes this computer and the new one sends
   * it. Only the plan's refusals run (the account's block, outside agents on
   * the free plan, credits for `landsOn`, the size the move makes, as the
   * move's own start checked them; the computer's size when null); the wake's
   * checks (an update in progress, the queue feature, past due, the awake
   * cap, the idle cleanup's claim) are about a wake that never happens. A
   * response when the send must not be stored, else null.
   */
  heldCheck: (computer: ComputerRow, asker: { outsideAgent: boolean }, landsOn: CloudSize | null) => Promise<Response | null>;
  /** After the row is stored: wakes it when asleep, then asks it to drain. Runs after the answer. */
  wakeAndDrain: (computer: ComputerRow) => Promise<void>;
  /** A launch that continues the chat on a new computer (`startServerLaunch` with the router's deps). */
  startLaunch: (parsed: ParsedLaunchRequest) => Promise<Response>;
};

export type ChatMessageDeps = {
  now: number;
  waitUntil?: (promise: Promise<unknown>) => void;
  wake: ChatWake | null;
};

/* ---- Person routes: /cloud/chats/:m/:c/messages[/:msg] ---- */

/** The facts a continue launch needs, from the target's sealed summary. */
type TargetFacts = { provider: string | null; model: string | null; laneName: string | null; projectId: string | null };

/** What a send goes to: a saved chat, or a saved CLI session (its session id in `chat_id`). */
type QueueTarget = Pick<CopyRow, "machine_key" | "chat_id" | "instance_id" | "project_key" | "lane_id"> & {
  kind: "chat" | "cli";
  /** A chat with no saved copy yet, on a computer a move took (`movedChatTarget`): the insert has no copy to find. */
  bare?: true;
  facts: (keys: UserKeys) => Promise<TargetFacts>;
};

const textOf = (record: Record<string, unknown> | null | undefined, key: string): string | null =>
  typeof record?.[key] === "string" && record[key] ? record[key] as string : null;

/** The agent of a CLI tool type (`LAUNCH_PROFILE_TOOL_TYPES`): `cursor-cli` is `cursor`. A shell has none. */
function cliProviderOf(toolType: string | null): string | null {
  const provider = toolType?.trim().toLowerCase().replace(/-(cli|orchestrated|chat)$/, "") ?? "";
  return provider && provider !== "shell" && /^[a-z][a-z0-9_-]{0,39}$/.test(provider) ? provider : null;
}

function chatTarget(chat: CopyRow): QueueTarget {
  return {
    kind: "chat",
    machine_key: chat.machine_key,
    chat_id: chat.chat_id,
    instance_id: chat.instance_id,
    project_key: chat.project_key,
    lane_id: chat.lane_id,
    facts: async (keys) => {
      const summary = await openSummary(keys, chat) as Record<string, unknown> | null;
      return { provider: textOf(summary, "provider"), model: textOf(summary, "model"), laneName: textOf(summary, "laneName"), projectId: textOf(summary, "projectId") };
    },
  };
}

/**
 * The target a send names: the saved chat, or the row a fork restore moved
 * it to (an older client still names the old machine key), or a saved CLI
 * session with that id, or a chat with no saved copy on a computer a move
 * took (`movedChatTarget`).
 */
async function resolveTarget(env: CloudEnv, userId: string, machineKey: string, chatId: string): Promise<QueueTarget | null> {
  const direct = await copyRow(env, userId, machineKey, chatId);
  if (direct) return chatTarget(direct);
  const moved = await env.DB.prepare(`
    select * from cloud_chat_copies where user_id = ? and forked_from_machine_key = ? and forked_from_chat_id = ? and chat_id = ?
    order by updated_at desc limit 1
  `).bind(userId, machineKey, chatId, chatId).first<CopyRow>();
  if (moved) return chatTarget(moved);
  // A CLI a new computer continued moved to that computer's key (`POST
  // /cloud/sessions/:m/:s/move`): a send to the old address finds it by its id.
  const cli = await env.DB.prepare(`
    select machine_key, session_id, instance_id, project_key, lane_id from cloud_session_copies
    where user_id = ? and session_id = ? and kind = 'cli'
    order by case when machine_key = ? then 0 else 1 end, updated_at desc limit 1
  `).bind(userId, chatId, machineKey)
    .first<{ machine_key: string; session_id: string; instance_id: string | null; project_key: string | null; lane_id: string | null }>();
  if (!cli) return await movedChatTarget(env, userId, machineKey, chatId);
  return {
    kind: "cli",
    machine_key: cli.machine_key,
    chat_id: cli.session_id,
    instance_id: cli.instance_id,
    project_key: cli.project_key,
    lane_id: cli.lane_id,
    facts: async (keys) => {
      const copy = await cliSessionCopy(env, keys, userId, cli.machine_key, cli.session_id);
      return { provider: cliProviderOf(copy?.toolType ?? null), model: null, laneName: copy?.laneName ?? null, projectId: copy?.projectId ?? null };
    },
  };
}

/** The live computer that holds a saved chat now: the one with its machine key, else the one that saved it. */
async function liveComputerOf(env: CloudEnv, userId: string, chat: QueueTarget): Promise<ComputerRow | null> {
  const byKey = await env.DB.prepare(`
    select * from cloud_computers where user_id = ? and lower(machine_key) = lower(?) and deleted_at is null order by created_at desc limit 1
  `).bind(userId, chat.machine_key).first<ComputerRow>();
  if (byKey) return byKey;
  if (!chat.instance_id) return null;
  return await env.DB.prepare("select * from cloud_computers where user_id = ? and instance_id = ? and deleted_at is null")
    .bind(userId, chat.instance_id).first<ComputerRow>();
}

/**
 * A chat with no saved copy yet on a computer a move took or takes (the
 * move's save writes the copy while it makes the new computer, and a busy
 * chat may never have rested before): a send still has a place by the old
 * computer's address for as long as the move's record lasts. The computer
 * finds the chat by its id. A shell's id stays refused.
 */
async function movedChatTarget(env: CloudEnv, userId: string, machineKey: string, chatId: string): Promise<QueueTarget | null> {
  const move = await env.DB.prepare(`
    select j.source_machine_key, j.source_instance_id, c.lane_id from cloud_jobs j
      left join cloud_computers c on c.instance_id = j.source_instance_id
    where j.user_id = ? and j.kind = ? and lower(j.source_machine_key) = lower(?)
      and not exists (select 1 from cloud_session_copies s where s.user_id = ? and s.session_id = ?)
    order by j.created_at desc limit 1
  `).bind(userId, MOVE_JOB_KIND, machineKey, userId, chatId)
    .first<{ source_machine_key: string | null; source_instance_id: string | null; lane_id: string | null }>();
  if (!move?.source_machine_key) return null;
  return {
    kind: "chat",
    bare: true,
    // The key as the account stored it: every later read matches it exactly.
    machine_key: move.source_machine_key,
    chat_id: chatId,
    instance_id: move.source_instance_id,
    project_key: null,
    lane_id: move.lane_id,
    facts: async () => ({ provider: null, model: null, laneName: null, projectId: null }),
  };
}

/** A move from a computer a move made, and so on: the queue follows at most this many. */
const MOVE_HOPS = 4;

/**
 * The live computer a message to this chat goes to, and whether a move of
 * it holds the message (`moveMessageRouteOf`): held from the move's making
 * until the new computer has the lane, then (and after the move, also when
 * the old computer is gone) on to the new computer. Null with no computer:
 * the chat's computer is gone.
 */
async function queueComputerOf(
  env: CloudEnv,
  userId: string,
  chat: QueueTarget,
): Promise<{ computer: ComputerRow | null; held: boolean; landsOn: CloudSize | null }> {
  let computer = await liveComputerOf(env, userId, chat);
  let from: { instanceId: string | null; machineKey: string | null } = {
    instanceId: computer?.instance_id ?? chat.instance_id,
    machineKey: computer?.machine_key ?? chat.machine_key,
  };
  for (let hop = 0; hop < MOVE_HOPS; hop += 1) {
    const route = await moveMessageRouteOf(env, userId, from);
    if (route?.kind === "held") return { computer, held: true, landsOn: route.size };
    if (route?.kind !== "moved") break;
    const target = await ownedComputer(env, userId, route.targetInstanceId);
    if (!target) break;
    computer = target;
    from = { instanceId: target.instance_id, machineKey: target.machine_key };
  }
  return { computer, held: false, landsOn: null };
}

export async function routeChatMessages(
  request: Request,
  env: CloudEnv,
  userId: string,
  machineKey: string,
  chatId: string,
  rest: string[],
  deps: ChatMessageDeps,
): Promise<Response> {
  if (rest.length === 0) {
    if (request.method === "GET") return await handleList(env, userId, machineKey, chatId, deps.now);
    if (request.method === "POST") return await handleSend(request, env, userId, machineKey, chatId, deps);
    return notFound();
  }
  const messageId = rest[0]!;
  if (rest.length !== 1 || !LAUNCH_MESSAGE_ID.test(messageId)) return notFound();
  if (request.method === "DELETE") return await handleCancel(env, userId, machineKey, chatId, messageId, deps.now);
  return notFound();
}

async function handleList(env: CloudEnv, userId: string, machineKey: string, chatId: string, now: number): Promise<Response> {
  const chat = await resolveTarget(env, userId, machineKey, chatId);
  if (!chat) return notFound();
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  // Every open message, then the newest final ones, in send order.
  const rows = (await env.DB.prepare(`
    select * from (
      select * from cloud_chat_messages where user_id = ? and machine_key = ? and chat_id = ?
      order by case when state in ${OPEN_STATES} then 0 else 1 end, seq desc limit ?
    ) order by seq
  `).bind(userId, chat.machine_key, chat.chat_id, CLOUD_CHAT_MESSAGES_LIST_MAX).all<ChatMessageRow>()).results ?? [];
  return json({ messages: await Promise.all(rows.map((row) => messageOf(env, keys, row))) });
}

function parseChatAttachments(value: unknown): CloudChatMessageAttachment[] | string {
  if (value == null) return [];
  if (!Array.isArray(value)) return "A file on this message can't be read.";
  const base = parseAttachments(value);
  if (typeof base === "string") return base;
  const out: CloudChatMessageAttachment[] = [];
  for (const [index, entry] of base.entries()) {
    const raw = (value[index] ?? {}) as Record<string, unknown>;
    const launchId = typeof raw.launchId === "string" ? raw.launchId.trim().toLowerCase() : "";
    if (!UUID_PATTERN.test(launchId)) return "A file on this message can't be read.";
    out.push({ ...entry, launchId });
  }
  return out;
}

/** Every file named must be one of the caller's uploads, at the size it says. */
async function attachmentsUploaded(env: CloudEnv, userId: string, attachments: CloudChatMessageAttachment[]): Promise<string | null> {
  if (!attachments.length) return null;
  const bucket = env.CLOUD_CHATS;
  if (!bucket) return "ADE Cloud can't keep files right now. Send without them.";
  for (const file of attachments) {
    const head = await bucket.head(`launches/${userId}/${file.launchId}/${file.fileId}`);
    if (!head || head.size !== file.sizeBytes) return `Upload "${file.name}" first, then send the message.`;
  }
  return null;
}

/**
 * A message's files stay as long as the message can wait: the drafts they were
 * uploaded to live a day from the upload, and a message queued late in that
 * day would lose its files before its computer reads them.
 */
async function keepDraftFiles(env: CloudEnv, userId: string, attachments: CloudChatMessageAttachment[], now: number): Promise<void> {
  const launchIds = [...new Set(attachments.map((file) => file.launchId))];
  if (!launchIds.length) return;
  await env.DB.batch(launchIds.map((launchId) => env.DB.prepare(`
    update cloud_launches set expires_at = max(expires_at, ?) where launch_id = ? and user_id = ? and state = 'draft'
  `).bind(now + CLOUD_CHAT_MESSAGE_TTL_MS, launchId, userId)));
}

/**
 * A message that starts a new computer brings its files to that launch: the
 * start reads them under its own id. The new id gets a draft row first, so a
 * start that is refused (or answered by another launch) leaves files the cron
 * removes with the draft.
 */
async function copyFilesToLaunch(env: CloudEnv, userId: string, attachments: CloudChatMessageAttachment[], launchId: string, now: number): Promise<string | null> {
  if (!attachments.length) return null;
  const bucket = env.CLOUD_CHATS;
  if (!bucket) return "ADE Cloud can't keep files right now. Send without them.";
  await env.DB.prepare(`
    insert into cloud_launches (launch_id, user_id, state, created_at, updated_at, expires_at)
    values (?, ?, 'draft', ?, ?, ?) on conflict (launch_id) do nothing
  `).bind(launchId, userId, now, now, now + CLOUD_LAUNCH_DRAFT_TTL_MS).run();
  for (const file of attachments) {
    const object = await bucket.get(r2KeyOf(userId, file.launchId, file.fileId));
    if (!object) return `Upload "${file.name}" first, then send the message.`;
    await bucket.put(r2KeyOf(userId, launchId, file.fileId), await object.arrayBuffer(), {
      httpMetadata: { contentType: object.httpMetadata?.contentType ?? "application/octet-stream" },
    });
  }
  return null;
}

/** The per-chat and per-account caps, and the minute rate limit. A response when the send is refused. */
async function capsRefusal(env: CloudEnv, userId: string, chat: QueueTarget, now: number): Promise<Response | null> {
  const counts = await env.DB.prepare(`
    select
      (select count(*) from cloud_chat_messages where user_id = ? and created_at > ?) as recent,
      (select count(*) from cloud_chat_messages where user_id = ? and machine_key = ? and chat_id = ? and state in ${OPEN_STATES}) as open_chat,
      (select count(*) from cloud_chat_messages where user_id = ? and state in ${OPEN_STATES} and created_at > ?) as open_account
  `).bind(userId, now - 60_000, userId, chat.machine_key, chat.chat_id, userId, now - CLOUD_CHAT_MESSAGE_TTL_MS)
    .first<{ recent: number; open_chat: number; open_account: number }>();
  if ((counts?.recent ?? 0) >= CLOUD_CHAT_MESSAGES_PER_MINUTE) {
    logCloud("cloud.chat_message_rate_limited", { userId });
    return fail("rate_limited", "You sent a lot of messages in the last minute. Wait a moment, then send again.", 429);
  }
  if ((counts?.open_chat ?? 0) >= CLOUD_CHAT_MESSAGES_OPEN_PER_CHAT) {
    return fail("too_many_messages", `This chat already has ${CLOUD_CHAT_MESSAGES_OPEN_PER_CHAT} messages waiting. Wait for them to be sent, then send again.`, 429);
  }
  if ((counts?.open_account ?? 0) >= CLOUD_CHAT_MESSAGES_OPEN_PER_ACCOUNT) {
    return fail("too_many_messages", `Your chats already have ${CLOUD_CHAT_MESSAGES_OPEN_PER_ACCOUNT} messages waiting. Wait for them to be sent, then send again.`, 429);
  }
  return null;
}

type SendInput = {
  messageId: string;
  text: string;
  attachments: CloudChatMessageAttachment[];
  provider: string | null;
  modelId: string | null;
  settings: CloudChatMessageSettings | null;
  /** The new computer's size, when the person picked one; used only by a launch. */
  sizeId?: CloudTierId | null;
  /** Sent by an outside agent (`origin: "mcp"`). Left out: a person. */
  outsideAgent?: boolean;
};

type InsertWhere = { instanceId: string | null; launchId: string | null; viaLaunch: boolean };
type Inserted = { row: ChatMessageRow; created: boolean };

/**
 * Queues one message. With `copyAt`, only while the chat's or CLI's saved
 * copy is still at this address, read in the insert itself: a move that took
 * the copy since `resolveTarget` read it leaves nothing queued here, where no
 * computer would drain it. Null then.
 */
async function insertRow(env: CloudEnv, keys: UserKeys, userId: string, chat: Pick<QueueTarget, "machine_key" | "chat_id">, input: SendInput, where: InsertWhere & { copyAt: QueueTarget["kind"] }, now: number): Promise<Inserted | null>;
async function insertRow(env: CloudEnv, keys: UserKeys, userId: string, chat: Pick<QueueTarget, "machine_key" | "chat_id">, input: SendInput, where: InsertWhere, now: number): Promise<Inserted>;
async function insertRow(
  env: CloudEnv,
  keys: UserKeys,
  userId: string,
  chat: Pick<QueueTarget, "machine_key" | "chat_id">,
  input: SendInput,
  where: InsertWhere & { copyAt?: QueueTarget["kind"] },
  now: number,
): Promise<Inserted | null> {
  const sealed = await sealJson(keys, bodyAad({ user_id: userId, message_id: input.messageId }), {
    text: input.text,
    attachments: input.attachments,
    ...(input.settings ? { settings: input.settings } : {}),
  });
  const copyHere = where.copyAt === "cli"
    ? "where exists (select 1 from cloud_session_copies where user_id = ? and machine_key = ? and session_id = ? and kind = 'cli')"
    : where.copyAt === "chat"
      ? "where exists (select 1 from cloud_chat_copies where user_id = ? and machine_key = ? and chat_id = ?)"
      : "";
  const insert = () => env.DB.prepare(`
    insert into cloud_chat_messages (user_id, machine_key, chat_id, message_id, instance_id, launch_id, via_launch, seq, body_sealed, provider, model_id, state, created_at, updated_at)
    select ?, ?, ?, ?, ?, ?, ?, coalesce((select max(seq) from cloud_chat_messages where user_id = ? and machine_key = ? and chat_id = ?), 0) + 1, ?, ?, ?, 'queued', ?, ?
    ${copyHere}
    on conflict (user_id, machine_key, chat_id, message_id) do nothing
    returning *
  `).bind(
    userId, chat.machine_key, chat.chat_id, input.messageId, where.instanceId, where.launchId, where.viaLaunch ? 1 : 0,
    userId, chat.machine_key, chat.chat_id,
    sealed, input.provider, input.modelId, now, now,
    ...(copyHere ? [userId, chat.machine_key, chat.chat_id] : []),
  ).all<ChatMessageRow>();
  let inserted: ChatMessageRow | null;
  try {
    inserted = (await insert()).results?.[0] ?? null;
  } catch (error) {
    // Two sends raced for the same place: the next one is free now.
    if (!(error instanceof Error && /UNIQUE/i.test(error.message))) throw error;
    inserted = (await insert()).results?.[0] ?? null;
  }
  // The row the insert wrote, as it wrote it: a move that takes it to another key right after still finds it sent.
  if (inserted) return { row: inserted, created: true };
  // Nothing inserted: the same message id again (its row answers), or the copy moved before the insert.
  const existing = await readRow(env, userId, chat.machine_key, chat.chat_id, input.messageId);
  if (existing) return { row: existing, created: false };
  if (where.copyAt) {
    // The same id again, which a move took to the chat's new key right after the first send stored it:
    // a move keeps the chat's id and its messages' ids, so the message is found by those. It was sent.
    const moved = await env.DB.prepare("select * from cloud_chat_messages where user_id = ? and chat_id = ? and message_id = ? limit 1")
      .bind(userId, chat.chat_id, input.messageId).first<ChatMessageRow>();
    return moved ? { row: moved, created: false } : null;
  }
  throw new Error("A queued message wasn't stored.");
}

async function handleSend(request: Request, env: CloudEnv, userId: string, machineKey: string, chatId: string, deps: ChatMessageDeps): Promise<Response> {
  const { now } = deps;
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const messageId = typeof body.messageId === "string" && LAUNCH_MESSAGE_ID.test(body.messageId) ? body.messageId : null;
  const text = typeof body.text === "string" ? body.text : null;
  if (!messageId || text == null) return badRequest("A message needs its id and its text.");
  if (text.length > CLOUD_CHAT_MESSAGE_MAX_CHARS) return badRequest("The message is too long.");
  const attachments = parseChatAttachments(body.attachments);
  if (typeof attachments === "string") return badRequest(attachments);
  if (!text.trim() && attachments.length === 0) return badRequest("The message is empty.");
  const provider = body.provider == null ? null : shortString(body.provider, 40);
  const modelId = body.modelId == null ? null : shortString(body.modelId, 300);
  // Known keys and short values only; anything else is left out.
  const settings = cloudChatMessageSettingsOf(body.settings);
  // The size of a new computer, when this message makes one: a size ADE Cloud offers, or left out.
  const sizeId = body.sizeId == null ? null : cloudSizeForTier(body.sizeId) ? body.sizeId as CloudTierId : undefined;
  if (sizeId === undefined) return badRequest("That size isn't one ADE Cloud offers.");

  const chat = await resolveTarget(env, userId, machineKey, chatId);
  if (!chat) return notFound();
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();

  // The same id again is the same message: its answer, with no second wake.
  const repeat = await readRow(env, userId, chat.machine_key, chat.chat_id, messageId);
  if (repeat) {
    const routed = repeat.via_launch ? null : await queueComputerOf(env, userId, chat);
    const wake: CloudWakeOutcome = repeat.via_launch
      ? { state: "launching", launchId: repeat.launch_id }
      : routed?.held
        ? { state: "moving" }
        : { state: routed?.computer && routed.computer.status === "running" ? "awake" : "waking" };
    return json({ message: await messageOf(env, keys, repeat), wake } satisfies CloudChatMessageAddResult, 200);
  }

  const capped = await capsRefusal(env, userId, chat, now);
  if (capped) return capped;
  const missingFile = await attachmentsUploaded(env, userId, attachments);
  if (missingFile) return badRequest(missingFile);
  await keepDraftFiles(env, userId, attachments, now);
  if (!deps.wake) return fail("unavailable", "ADE Cloud can't wake computers right now. Try again soon.", 503);

  // `origin: "mcp"`: an outside agent (ADE MCP) sending; on the free plan it can't wake or start a computer.
  const input: SendInput = { messageId, text, attachments, provider, modelId, settings, sizeId, outsideAgent: body.origin === "mcp" };
  // The chat's computer, or the one a move took its lane to; `held` while a move of it runs.
  const { computer, held, landsOn } = await queueComputerOf(env, userId, chat);
  if (held && !computer) return fail("computer_busy", "This chat's computer is moving to a new one. Send the message again in a minute.", 409);
  if (computer) {
    // Every refusal runs before the row is written: a refused send stores nothing.
    // A held send runs only the plan's refusals: no wake happens (`heldCheck`).
    const asker = { outsideAgent: input.outsideAgent === true };
    const checked = held
      ? (await deps.wake.heldCheck(computer, asker, landsOn)) ?? { state: "moving" as const }
      : await deps.wake.check(computer, asker);
    if (checked instanceof Response) return checked;
    const where: InsertWhere = { instanceId: computer.instance_id, launchId: null, viaLaunch: false };
    // A chat with no saved copy has none for the insert to find.
    const inserted = chat.bare
      ? await insertRow(env, keys, userId, chat, input, where, now)
      : await insertRow(env, keys, userId, chat, input, { ...where, copyAt: chat.kind }, now);
    // The chat moved to another machine since it was read: nothing is queued, and a send again reaches it there.
    if (!inserted) return fail("chat_moved", "This chat moved to another machine just as the message was sent. Send it again.", 409);
    const { row, created } = inserted;
    // A move holds it: nothing wakes the old computer or asks it to send, and the move hands it on.
    const askTo = held ? await computerAfterHold(env, userId, chat, computer, now) : computer;
    if (askTo) {
      const work = deps.wake.wakeAndDrain(askTo).catch((error: unknown) => {
        logCloud("cloud.chat_message_wake_failed", { userId, instanceId: askTo.instance_id, error: error instanceof Error ? error.message : "unknown" });
      });
      if (deps.waitUntil) deps.waitUntil(work);
      else await work;
    }
    const wake: CloudWakeOutcome = { state: held && askTo ? "awake" : checked.state };
    logCloud("cloud.chat_message_queued", { userId, instanceId: computer.instance_id, wake: wake.state });
    return json({ message: await messageOf(env, keys, row), wake } satisfies CloudChatMessageAddResult, created ? 201 : 200);
  }
  return await sendThroughLaunch(env, keys, userId, chat, input, deps);
}

/**
 * A held send's row is written, and the move may have stopped holding it
 * meanwhile: a cancel gave the old computer the lane back and asked it to
 * send what was held, or the new computer took the lane and the last
 * hand-over ran. Nothing would ask for this row then. The route is read
 * again: while the move still holds it, null (the move hands it on). Else it
 * goes where the lane is now, and the computer there is returned to be asked
 * to send it, only when it runs: an asleep one sends it at its next wake, as
 * the move's own cancel leaves it (`sendHeldOnSource`), since a held send ran
 * none of the wake's checks.
 */
async function computerAfterHold(env: CloudEnv, userId: string, chat: QueueTarget, heldOn: ComputerRow, now: number): Promise<ComputerRow | null> {
  const after = await queueComputerOf(env, userId, chat);
  if (after.held || !after.computer) return null;
  if (after.computer.instance_id !== heldOn.instance_id) {
    await env.DB.batch(handOverQueuedMessagesStatements(env, { userId, fromInstanceId: heldOn.instance_id, toInstanceId: after.computer.instance_id, now }));
  }
  logCloud("cloud.chat_message_hold_ended", { userId, instanceId: after.computer.instance_id, status: after.computer.status });
  return after.computer.status === "running" && after.computer.idle_claimed_at == null ? after.computer : null;
}

/**
 * The chat's computer is gone: a launch for the same lane continues it
 * (`continueChat`) and carries this message. A launch already continuing it
 * takes the message as one more launch message.
 */
async function sendThroughLaunch(env: CloudEnv, keys: UserKeys, userId: string, chat: QueueTarget, input: SendInput, deps: ChatMessageDeps): Promise<Response> {
  const { now } = deps;
  const gone = (why: string) => fail("computer_deleted", why, 409);
  if (!chat.lane_id || !UUID_PATTERN.test(chat.lane_id)) {
    return gone("This chat's computer is gone and ADE doesn't know its lane, so it can't continue it. Start a new chat in the lane.");
  }
  const running = await activeContinueLaunch(env, userId, chat.lane_id, chat.chat_id);
  if (running) return await addToLaunch(env, keys, userId, chat, input, running, now);

  const lane = await laneFactsForChat(env, userId, chat);
  const facts = await chat.facts(keys);
  const provider = input.provider ?? facts.provider;
  // A CLI needs no model: the computer restores it from its capsule with its own settings, or starts it fresh.
  const modelId = input.modelId ?? facts.model ?? (chat.kind === "cli" ? "" : null);
  const origin = githubOriginOf(lane.projectOrigin ?? chat.project_key);
  if (!provider || modelId == null || !origin) {
    return gone(chat.kind === "cli"
      ? "This CLI's computer is gone and ADE can't tell which CLI or repository it used. Start a new CLI in the lane."
      : "This chat's computer is gone and ADE can't tell which agent or repository it used. Start a new chat in the lane.");
  }
  const parsed: ParsedLaunchRequest = {
    launchId: crypto.randomUUID(),
    kind: "chat",
    // A picked size starts as picked; none is Small, or bigger if the project needed it (`startSizeOf`).
    sizeId: input.sizeId ?? "small",
    sizeChoice: input.sizeId ? "picked" : "default",
    project: { origin },
    lane: {
      id: chat.lane_id,
      name: lane.laneName ?? facts.laneName ?? "Lane",
      ...(lane.branch ? { existingBranch: lane.branch } : {}),
    },
    chat: {
      provider,
      modelId,
      // The restore takes the chat's own permission mode from its capsule; this is the fallback.
      permissions: "default",
      prompt: input.text,
      ...(input.attachments.length ? { attachments: input.attachments.map(({ launchId: _launchId, ...file }) => file) } : {}),
      messageId: input.messageId,
    },
    // An outside agent's send makes the launch an outside agent's, so the free plan refuses it as a create.
    madeBy: input.outsideAgent ? { kind: "agent", agent: "mcp" } : { kind: "person" },
    channel: "beta",
    continueChat: {
      machineKey: chat.machine_key,
      chatId: chat.chat_id,
      ...(chat.kind === "cli" ? { kind: "cli" as const } : {}),
      ...(input.settings && chat.kind !== "cli" ? { settings: input.settings } : {}),
    },
  };
  const filesMissing = await copyFilesToLaunch(env, userId, input.attachments, parsed.launchId, now);
  if (filesMissing) return badRequest(filesMissing);
  const started = await deps.wake!.startLaunch(parsed);
  if (started.status !== 200 && started.status !== 201) return started;
  const record = await started.clone().json() as CloudLaunchRecord;
  // Another send started it first: this message rides along as one more launch message.
  if (record.launchId !== parsed.launchId) {
    const latest = await env.DB.prepare("select * from cloud_launches where launch_id = ?").bind(record.launchId).first<LaunchRow>();
    if (latest) return await addToLaunch(env, keys, userId, chat, input, latest, now);
  }
  const { row } = await insertRow(env, keys, userId, chat, input, { instanceId: null, launchId: record.launchId, viaLaunch: true }, now);
  logCloud("cloud.chat_message_launch", { userId, launchId: record.launchId });
  return json({ message: await messageOf(env, keys, row), wake: { state: "launching", launchId: record.launchId } } satisfies CloudChatMessageAddResult, 201);
}

async function addToLaunch(env: CloudEnv, keys: UserKeys, userId: string, chat: QueueTarget, input: SendInput, launch: LaunchRow, now: number): Promise<Response> {
  if (input.attachments.length) return badRequest("Files can't be added while the chat moves to its new computer. Send them once it is ready.");
  const added = await addLaunchMessage(env, launch, input.messageId, input.text, now);
  if (added instanceof Response) return added;
  const { row, created } = await insertRow(env, keys, userId, chat, input, { instanceId: null, launchId: launch.launch_id, viaLaunch: true }, now);
  return json({ message: await messageOf(env, keys, row), wake: { state: "launching", launchId: launch.launch_id } } satisfies CloudChatMessageAddResult, created ? 201 : 200);
}

/** The lane a gone computer held: its lane-without-computer row first, else the computer's own row. */
async function laneFactsForChat(env: CloudEnv, userId: string, chat: QueueTarget): Promise<{ laneName: string | null; projectOrigin: string | null; branch: string | null }> {
  const kept = await env.DB.prepare("select lane_name, project_origin, branch_ref from cloud_lanes_without_computer where user_id = ? and lane_id = ?")
    .bind(userId, chat.lane_id).first<{ lane_name: string; project_origin: string | null; branch_ref: string | null }>();
  if (kept) return { laneName: kept.lane_name, projectOrigin: kept.project_origin, branch: kept.branch_ref };
  const former = await env.DB.prepare(`
    select lane_name, lane_project_origin, lane_branch from cloud_computers where user_id = ? and lane_id = ? order by created_at desc limit 1
  `).bind(userId, chat.lane_id).first<{ lane_name: string | null; lane_project_origin: string | null; lane_branch: string | null }>();
  return { laneName: former?.lane_name ?? null, projectOrigin: former?.lane_project_origin ?? null, branch: former?.lane_branch ?? null };
}

async function handleCancel(env: CloudEnv, userId: string, machineKey: string, chatId: string, messageId: string, now: number): Promise<Response> {
  const chat = await resolveTarget(env, userId, machineKey, chatId);
  if (!chat) return notFound();
  const row = await readRow(env, userId, chat.machine_key, chat.chat_id, messageId);
  if (!row) return messageNotFound();
  const keys = await userKeys(env, userId, now);
  if (!keys) return unavailable();
  if (row.via_launch && row.launch_id) {
    const result = await cancelLaunchMessageStatement(env, row.launch_id, messageId, now).run();
    if ((result.meta?.changes ?? 0) !== 1) return fail("message_taken", "This message is already on its way to the chat.", 409);
  } else {
    const result = await env.DB.prepare(`
      update cloud_chat_messages set state = 'cancelled', updated_at = ? where user_id = ? and machine_key = ? and chat_id = ? and message_id = ? and state = 'queued'
    `).bind(now, userId, chat.machine_key, chat.chat_id, messageId).run();
    if ((result.meta?.changes ?? 0) !== 1) {
      const latest = (await readRow(env, userId, chat.machine_key, chat.chat_id, messageId))!;
      return fail("message_taken", "This message is already on its way to the chat.", 409, { state: latest.state });
    }
  }
  return json(await messageOf(env, keys, (await readRow(env, userId, chat.machine_key, chat.chat_id, messageId))!));
}

/* ---- Computer routes: /cloud/instances/:id/messages[/:msg[/claim]] ---- */

async function computerMessageOf(env: CloudEnv, keys: UserKeys, row: ChatMessageRow): Promise<CloudComputerQueuedMessage> {
  const target = await resolveTarget(env, row.user_id, row.machine_key, row.chat_id);
  const facts = target ? await target.facts(keys) : null;
  const body = await openBody(keys, row);
  return {
    ...(await messageOf(env, keys, row, body)),
    ...(body.settings ? { settings: body.settings } : {}),
    projectId: facts?.projectId ?? null,
    laneId: target?.lane_id ?? null,
    clientSendId: row.message_id,
    targetKind: target?.kind ?? "chat",
  };
}

async function computerRow(env: CloudEnv, computer: ComputerRow, messageId: string): Promise<ChatMessageRow | null> {
  return await env.DB.prepare("select * from cloud_chat_messages where user_id = ? and instance_id = ? and message_id = ? and via_launch = 0 order by created_at limit 1")
    .bind(computer.user_id, computer.instance_id, messageId).first<ChatMessageRow>();
}

export async function routeComputerMessages(request: Request, env: CloudEnv, computer: ComputerRow, rest: string[], now: number): Promise<Response> {
  const keys = await userKeys(env, computer.user_id, now);
  if (!keys) return unavailable();
  if (rest.length === 0) {
    if (request.method !== "GET") return messageNotFound();
    // Queued messages and ones this computer claimed but never finished (a restart mid-send), oldest first.
    // A move of this computer holds its queued ones: the new computer sends them (`moves.ts`).
    const rows = (await env.DB.prepare(`
      select * from cloud_chat_messages where instance_id = ? and user_id = ? and via_launch = 0 and state in ${OPEN_STATES}
        and not (state = 'queued' and ${MOVE_HOLDS_MESSAGES_SQL})
      order by created_at, seq limit ?
    `).bind(computer.instance_id, computer.user_id, CLOUD_CHAT_MESSAGES_LIST_MAX).all<ChatMessageRow>()).results ?? [];
    return json({ messages: await Promise.all(rows.map((row) => computerMessageOf(env, keys, row))) });
  }
  const messageId = rest[0]!;
  if (!LAUNCH_MESSAGE_ID.test(messageId) || rest.length > 2) return messageNotFound();
  const body = await readJson(request);
  const claimId = typeof body?.claimId === "string" && CLAIM_ID.test(body.claimId) ? body.claimId : null;
  if (!claimId) return badRequest("A claim needs its claim id.");
  if (rest.length === 2) {
    if (rest[1] !== "claim" || request.method !== "POST") return messageNotFound();
    // One conditional write: a message is claimed once; the same claim again gets it back.
    // A queued one a move of this computer holds is not its to take (a list read before the move began).
    const claimed = await env.DB.prepare(`
      update cloud_chat_messages set state = 'sending', claim_id = ?, claimed_at = coalesce(claimed_at, ?), updated_at = ?
      where user_id = ? and instance_id = ? and message_id = ? and via_launch = 0
        and ((state = 'queued' and not ${MOVE_HOLDS_MESSAGES_SQL}) or (state in ('sending', 'waiting_for_sign_in') and claim_id = ?))
    `).bind(claimId, now, now, computer.user_id, computer.instance_id, messageId, claimId).run();
    const stored = await computerRow(env, computer, messageId);
    if (!stored) return messageNotFound();
    if ((claimed.meta?.changes ?? 0) < 1) {
      const why = stored.state === "queued" ? "This message waits for this computer's move to end." : "This message was already sent, claimed or cancelled.";
      return fail("message_taken", why, 409, { state: stored.state });
    }
    return json(await computerMessageOf(env, keys, stored));
  }
  if (request.method !== "PUT") return messageNotFound();
  const state = body?.state === "delivered" || body?.state === "failed" || body?.state === "waiting_for_sign_in" || body?.state === "sending" ? body.state : null;
  if (!state) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const signIn = state === "waiting_for_sign_in" ? parseSignIn(body?.signIn) : null;
  if (state === "waiting_for_sign_in" && !signIn) return badRequest("A sign-in wait needs the sign-in.");
  const sessionId = typeof body?.sessionId === "string" && ROW_ID.test(body.sessionId) ? body.sessionId : null;
  const error = state === "failed" ? clippedText(body?.error, 300) ?? "ADE couldn't send this message to the chat." : null;
  // Only the claim that took it; a final state is final (the same report again answers the same).
  const written = await env.DB.prepare(`
    update cloud_chat_messages set state = ?, session_id = coalesce(?, session_id), error = ?, sign_in_json = ?, updated_at = ?
    where user_id = ? and instance_id = ? and message_id = ? and via_launch = 0 and claim_id = ?
      and (state in ('sending', 'waiting_for_sign_in') or state = ?)
  `).bind(
    state, sessionId, error, signIn ? JSON.stringify(signIn) : null, now,
    computer.user_id, computer.instance_id, messageId, claimId, state,
  ).run();
  const stored = await computerRow(env, computer, messageId);
  if (!stored) return messageNotFound();
  if ((written.meta?.changes ?? 0) < 1) return fail("message_taken", "This message isn't this computer's to finish.", 409, { state: stored.state });
  return json(await computerMessageOf(env, keys, stored));
}

/* ---- Lifecycle, for chats.ts, the account deletion and the cron ---- */

/** Rows the minute cron touches per tick, each kind: bounded, indexed (`cloud_chat_messages_state`). */
const CRON_BATCH = 200;

/**
 * The minute cron: a message still queued (or waiting on a sign-in) after
 * 24 hours fails with a plain reason, so it never arrives days later; a
 * final row is pruned after 7 days. A message a computer claimed and never
 * finished fails after the same 24 hours, never sent twice.
 */
export async function expireChatMessages(env: Pick<CloudEnv, "DB">, now = Date.now()): Promise<{ expired: number; pruned: number; launchSettled: number }> {
  // Messages a continue launch carries take their final state from it: first the ones its computer finished,
  // then the ones it never will (the launch failed, timed out, was cancelled or is gone), with its sentence.
  const finished = await env.DB.prepare(`
    update cloud_chat_messages set
      state = (select case when lm.state = 'failed' and lm.error = 'Cancelled.' then 'cancelled' else lm.state end
        from cloud_launch_messages lm where lm.launch_id = cloud_chat_messages.launch_id and lm.message_id = cloud_chat_messages.message_id),
      error = (select lm.error from cloud_launch_messages lm where lm.launch_id = cloud_chat_messages.launch_id and lm.message_id = cloud_chat_messages.message_id),
      updated_at = ?
    where rowid in (
      select m.rowid from cloud_chat_messages m
        join cloud_launch_messages lm on lm.launch_id = m.launch_id and lm.message_id = m.message_id
      where m.via_launch = 1
        and ((m.state in ${OPEN_STATES} and lm.state in ('delivered', 'failed')) or (m.state = 'failed' and lm.state = 'delivered'))
      limit ?
    )
  `).bind(now, CRON_BATCH).run();
  const neverSent = await env.DB.prepare(`
    update cloud_chat_messages set state = 'failed',
      error = coalesce(
        (select case when l.state = 'cancelled' then ? when l.state = 'failed' then l.error end from cloud_launches l where l.launch_id = cloud_chat_messages.launch_id),
        ?),
      updated_at = ?
    where rowid in (
      select m.rowid from cloud_chat_messages m left join cloud_launches l on l.launch_id = m.launch_id
      where m.state in ${OPEN_STATES} and m.via_launch = 1
        and (l.launch_id is null or l.state in ('failed', 'cancelled')
          or (l.state in ('joining', 'needs_approval') and l.join_expires_at is not null and l.join_expires_at <= ?))
        and not exists (select 1 from cloud_launch_messages lm where lm.launch_id = m.launch_id and lm.message_id = m.message_id and lm.state = 'delivered')
      limit ?
    )
  `).bind(LAUNCH_CANCELLED_SENTENCE, LAUNCH_FAILED_SENTENCE, now, now, CRON_BATCH).run();
  const launchSettled = (finished.meta?.changes ?? 0) + (neverSent.meta?.changes ?? 0);
  const expired = await env.DB.prepare(`
    update cloud_chat_messages set state = 'failed', error = ?, updated_at = ?
    where rowid in (
      select m.rowid from cloud_chat_messages m where m.state in ${OPEN_STATES} and m.updated_at < ?
        and not exists (select 1 from cloud_launch_messages lm where lm.launch_id = m.launch_id and lm.message_id = m.message_id and lm.state = 'delivered')
      limit ?
    )
  `).bind("This message waited more than a day and wasn't sent. Send it again.", now, now - CLOUD_CHAT_MESSAGE_TTL_MS, CRON_BATCH).run();
  const pruned = await env.DB.prepare(`
    delete from cloud_chat_messages where rowid in (
      select rowid from cloud_chat_messages where state in ('delivered', 'failed', 'cancelled') and updated_at < ? limit ?
    )
  `).bind(now - CLOUD_CHAT_MESSAGE_PRUNE_MS, CRON_BATCH).run();
  const counts = { expired: expired.meta?.changes ?? 0, pruned: pruned.meta?.changes ?? 0, launchSettled };
  if (counts.expired || counts.pruned || counts.launchSettled) logCloud("cloud.chat_messages_swept", counts);
  return counts;
}
