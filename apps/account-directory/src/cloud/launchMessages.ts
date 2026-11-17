import {
  CLOUD_LAUNCH_MAX_MESSAGES,
  CLOUD_LAUNCH_MAX_PROMPT_CHARS,
  type CloudLaunchMessage,
  type CloudLaunchMessageState,
  type CloudServerLaunchRequest,
} from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, badRequest, clippedText, fail, json, readJson, shortString } from "./http";
import type { LaunchRow } from "./launches";
import { parseJsonColumn, type CloudEnv } from "./store";

/**
 * A chat launch's messages, sent before its chat exists (`launches.ts` keeps
 * the launch). Row 1 is the first message: the start writes it, and the
 * computer's stage report with the chat's session id marks it delivered. The
 * person adds more while the chat doesn't exist yet; the computer claims each
 * of the rest once the chat started, sends it, and says so. A launch that
 * never got its chat fails what is still queued; the rows go with the launch.
 */

/** A client's id for a launch message: the launch id, or its own. */
export const LAUNCH_MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A computer's claim on a message: random, made once per message and kept on the computer. */
const CLAIM_ID = /^[A-Za-z0-9_-]{16,80}$/;

const notFound = () => fail("not_found", "ADE Cloud has no such launch.", 404);

type MessageRow = {
  launch_id: string;
  message_id: string;
  user_id: string;
  seq: number;
  text: string;
  provider: string | null;
  model_id: string | null;
  state: CloudLaunchMessageState;
  claim_id: string | null;
  claimed_at: number | null;
  session_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

/* ---- The lifecycle writes, for `launches.ts` ---- */

/** Row 1, the start's first message: sent once, as the chat's first message. A start sent again changes nothing. */
export function firstMessageStatement(
  env: CloudEnv,
  launchId: string,
  userId: string,
  chat: Pick<NonNullable<CloudServerLaunchRequest["chat"]>, "prompt" | "provider" | "modelId"> & { messageId: string },
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(`
    insert into cloud_launch_messages (launch_id, message_id, user_id, seq, text, provider, model_id, state, created_at, updated_at)
    values (?, ?, ?, 1, ?, ?, ?, 'queued', ?, ?) on conflict do nothing
  `).bind(launchId, chat.messageId, userId, chat.prompt, chat.provider, chat.modelId, now, now);
}

/**
 * Row 1 goes, so the start that follows writes its own prompt as message 1:
 * a draft turned into the launch (a queued row 1), or a Retry (row 1 of the
 * failed attempt, queued or failed; never one the chat already got).
 */
export function dropFirstMessageStatement(env: CloudEnv, launchId: string, from: "draft" | "retry" = "draft"): D1PreparedStatement {
  return env.DB.prepare(`delete from cloud_launch_messages where launch_id = ? and seq = 1 and ${from === "retry" ? "state <> 'delivered'" : "state = 'queued'"}`)
    .bind(launchId);
}

/**
 * A chat's queued messages that this launch carries (`cloud_chat_messages`,
 * `via_launch`) read delivered once the launch's own message is delivered.
 * The computer's report wins over any failed mark: an earlier failed or
 * timed-out try of the same launch, or the 24 h expiry. Only a delivered
 * launch message moves a row, so this never makes a sent message look unsent.
 */
export function chatMessagesDeliveredStatement(env: CloudEnv, launchId: string, now: number): D1PreparedStatement {
  return env.DB.prepare(`
    update cloud_chat_messages set state = 'delivered', error = null, updated_at = ?
    where launch_id = ? and via_launch = 1 and state <> 'delivered'
      and exists (select 1 from cloud_launch_messages lm
        where lm.launch_id = cloud_chat_messages.launch_id and lm.message_id = cloud_chat_messages.message_id and lm.state = 'delivered')
  `).bind(now, launchId);
}

/** The chat exists: the computer started it with the first message. */
export function firstMessageDeliveredStatement(env: CloudEnv, launchId: string, sessionId: string, now: number): D1PreparedStatement {
  return env.DB.prepare(`
    update cloud_launch_messages set state = 'delivered', session_id = ?, updated_at = ? where launch_id = ? and seq = 1 and state in ('queued', 'sending')
  `).bind(sessionId, now, launchId);
}

/** A launch that ended before its chat existed: what is still queued is failed with its reason. */
export function failQueuedMessagesStatement(env: CloudEnv, launchId: string, error: string, now: number): D1PreparedStatement {
  return env.DB.prepare("update cloud_launch_messages set state = 'failed', error = ?, updated_at = ? where launch_id = ? and state = 'queued'")
    .bind(error, now, launchId);
}

/**
 * A start the create refused: its messages (all of them, or a draft's row 1)
 * go only while the launch is still that unmade start. Batched before the
 * launch's own write, so a new start of the same id never loses its messages.
 */
export function refusedStartMessagesStatement(env: CloudEnv, launchId: string, which: "all" | "first"): D1PreparedStatement {
  return env.DB.prepare(`
    delete from cloud_launch_messages where launch_id = ?${which === "first" ? " and seq = 1 and state = 'queued'" : ""}
      and exists (select 1 from cloud_launches where launch_id = ? and state = 'making' and instance_id is null)
  `).bind(launchId, launchId);
}

/** The messages of a launch past its record's time, only while the launch is still past it. */
export function expiredLaunchMessagesStatement(env: CloudEnv, launchId: string, now: number): D1PreparedStatement {
  return env.DB.prepare("delete from cloud_launch_messages where launch_id = ? and exists (select 1 from cloud_launches where launch_id = ? and expires_at < ?)")
    .bind(launchId, launchId, now);
}

/** Every launch message of one account, for an account deletion. */
export function accountLaunchMessagesStatement(env: Pick<CloudEnv, "DB">, userId: string): D1PreparedStatement {
  return env.DB.prepare("delete from cloud_launch_messages where user_id = ?").bind(userId);
}

/* ---- The routes ---- */

function messageOf(row: MessageRow): CloudLaunchMessage {
  return {
    messageId: row.message_id,
    seq: row.seq,
    text: row.text,
    provider: row.provider,
    modelId: row.model_id,
    state: row.state,
    sessionId: row.session_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readMessage(env: CloudEnv, launchId: string, messageId: string): Promise<MessageRow | null> {
  return await env.DB.prepare("select * from cloud_launch_messages where launch_id = ? and message_id = ?").bind(launchId, messageId).first<MessageRow>();
}

/**
 * `/cloud/launches/:launch/messages[/:msg[/claim]]`. The person adds a
 * message while the chat doesn't exist yet; the computer, once it started
 * the chat with the first one, claims each of the rest, sends it, and says
 * so. A claim is one conditional write, so a message is claimed once; a
 * claim retried with the same claim id (an answer that was lost) gets the
 * same message back, and only that claim id may finish it. A message the
 * computer claimed but couldn't confirm is reported failed, never sent again.
 */
export async function routeLaunchMessages(request: Request, env: CloudEnv, row: LaunchRow, rest: string[], now: number): Promise<Response> {
  const launchId = row.launch_id;
  if (rest.length === 0) {
    if (request.method === "GET") {
      const rows = (await env.DB.prepare("select * from cloud_launch_messages where launch_id = ? order by seq").bind(launchId).all<MessageRow>()).results ?? [];
      return json({ messages: rows.map(messageOf) });
    }
    if (request.method === "POST") return await handleAddMessage(request, env, row, now);
    return notFound();
  }
  const messageId = rest[0]!;
  if (!LAUNCH_MESSAGE_ID.test(messageId) || rest.length > 2) return notFound();
  if (rest.length === 2) {
    return rest[1] === "claim" && request.method === "POST" ? await handleClaimMessage(request, env, row, messageId, now) : notFound();
  }
  return request.method === "PUT" ? await handleReportMessage(request, env, row, messageId, now) : notFound();
}

async function handleAddMessage(request: Request, env: CloudEnv, launch: LaunchRow, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const messageId = typeof body.messageId === "string" && LAUNCH_MESSAGE_ID.test(body.messageId) ? body.messageId : null;
  const text = typeof body.text === "string" ? body.text : null;
  if (!messageId || text == null) return badRequest("A message needs its id and its text.");
  if (!text.trim()) return badRequest("The message is empty.");
  if (text.length > CLOUD_LAUNCH_MAX_PROMPT_CHARS) return badRequest("The message is too long.");
  if (launch.kind !== "chat") return badRequest("Only a chat launch takes messages.");
  const added = await addLaunchMessage(env, launch, messageId, text, now);
  return added instanceof Response ? added : json(added.message, added.created ? 201 : 200);
}

/**
 * Adds one message to a chat launch whose chat doesn't exist yet: the
 * route's add, and a send to a saved chat that a continuing launch carries
 * (`chatMessages.ts`). The same id again is the same message. A refusal
 * (`chat_ready`, `launch_closed`, `too_many_messages`) is a response.
 */
export async function addLaunchMessage(env: CloudEnv, launch: LaunchRow, messageId: string, text: string, now: number): Promise<{ message: CloudLaunchMessage; created: boolean } | Response> {
  const request_ = parseJsonColumn<CloudServerLaunchRequest | null>(launch.request_json, null, { launchId: launch.launch_id, column: "request_json" });
  // One statement: added only while the chat doesn't exist and the launch is open, under the cap.
  const insert = () => env.DB.prepare(`
    insert into cloud_launch_messages (launch_id, message_id, user_id, seq, text, provider, model_id, state, created_at, updated_at)
    select ?, ?, ?, coalesce((select max(seq) from cloud_launch_messages where launch_id = ?), 1) + 1, ?, ?, ?, 'queued', ?, ?
    where exists (
      select 1 from cloud_launches where launch_id = ? and user_id = ? and kind = 'chat' and session_id is null
        and state not in ('draft', 'done', 'failed', 'cancelled', 'retrying')
    ) and (select count(*) from cloud_launch_messages where launch_id = ?) < ?
    on conflict (launch_id, message_id) do nothing
  `).bind(
    launch.launch_id, messageId, launch.user_id, launch.launch_id, text, request_?.chat?.provider ?? null, request_?.chat?.modelId ?? null, now, now,
    launch.launch_id, launch.user_id, launch.launch_id, CLOUD_LAUNCH_MAX_MESSAGES,
  ).run();
  let changes = 0;
  try {
    changes = (await insert()).meta?.changes ?? 0;
  } catch (error) {
    // Two messages raced for the same place: the next place is free now.
    if (!(error instanceof Error && /UNIQUE/i.test(error.message))) throw error;
    changes = (await insert()).meta?.changes ?? 0;
  }
  const stored = await readMessage(env, launch.launch_id, messageId);
  // The same id again is the same message.
  if (stored) return { message: messageOf(stored), created: changes === 1 };
  const latest = (await env.DB.prepare("select session_id, state from cloud_launches where launch_id = ?").bind(launch.launch_id)
    .first<Pick<LaunchRow, "session_id" | "state">>()) ?? launch;
  if (latest.session_id || latest.state === "done") {
    return fail("chat_ready", "The chat is ready. Send the message to the chat.", 409, latest.session_id ? { sessionId: latest.session_id } : undefined);
  }
  if (latest.state === "failed" || latest.state === "cancelled" || latest.state === "retrying" || latest.state === "draft") {
    return fail("launch_closed", "This launch isn't running.", 409);
  }
  return fail("too_many_messages", `A launch keeps at most ${CLOUD_LAUNCH_MAX_MESSAGES} messages before its chat starts.`, 413);
}

/** One launch message, for a saved chat's queue that a launch carries. */
export async function launchMessageOf(env: CloudEnv, launchId: string, messageId: string): Promise<CloudLaunchMessage | null> {
  const row = await readMessage(env, launchId, messageId);
  return row ? messageOf(row) : null;
}

/** A queued launch message the person took back: failed with that reason, never sent. Not row 1 (the start sends it). */
export function cancelLaunchMessageStatement(env: CloudEnv, launchId: string, messageId: string, now: number): D1PreparedStatement {
  return env.DB.prepare("update cloud_launch_messages set state = 'failed', error = 'Cancelled.', updated_at = ? where launch_id = ? and message_id = ? and seq > 1 and state = 'queued'")
    .bind(now, launchId, messageId);
}

async function handleClaimMessage(request: Request, env: CloudEnv, launch: LaunchRow, messageId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  const claimId = typeof body?.claimId === "string" && CLAIM_ID.test(body.claimId) ? body.claimId : null;
  if (!claimId) return badRequest("A claim needs its claim id.");
  // Only once the chat exists, and never the first message: the chat's start sent it.
  if (!launch.session_id) return fail("chat_not_ready", "The chat doesn't exist yet.", 409);
  const claimed = await env.DB.prepare(`
    update cloud_launch_messages set state = 'sending', claim_id = ?, claimed_at = coalesce(claimed_at, ?), updated_at = ?
    where launch_id = ? and message_id = ? and seq > 1 and (state = 'queued' or (state = 'sending' and claim_id = ?))
  `).bind(claimId, now, now, launch.launch_id, messageId, claimId).run();
  const stored = await readMessage(env, launch.launch_id, messageId);
  if (!stored) return notFound();
  if ((claimed.meta?.changes ?? 0) !== 1) return fail("message_taken", "This message was already sent or claimed.", 409, { state: stored.state });
  return json(messageOf(stored));
}

async function handleReportMessage(request: Request, env: CloudEnv, launch: LaunchRow, messageId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  const claimId = typeof body?.claimId === "string" && CLAIM_ID.test(body.claimId) ? body.claimId : null;
  const state = body?.state === "delivered" || body?.state === "failed" ? body.state : null;
  if (!claimId || !state) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const sessionId = shortString(body?.sessionId, 120) ?? launch.session_id;
  const error = state === "failed" ? clippedText(body?.error, 300) ?? "ADE couldn't send this message to the chat." : null;
  // Only the claim that took it; the same report again changes nothing and answers the same.
  const written = await env.DB.prepare(`
    update cloud_launch_messages set state = ?, session_id = ?, error = ?, updated_at = ?
    where launch_id = ? and message_id = ? and claim_id = ? and (state = 'sending' or state = ?)
  `).bind(state, state === "delivered" ? sessionId : null, error, now, launch.launch_id, messageId, claimId, state).run();
  if ((written.meta?.changes ?? 0) === 1 && state === "delivered") await chatMessagesDeliveredStatement(env, launch.launch_id, now).run();
  const stored = await readMessage(env, launch.launch_id, messageId);
  if (!stored) return notFound();
  if ((written.meta?.changes ?? 0) !== 1) return fail("message_taken", "This message isn't this computer's to finish.", 409, { state: stored.state });
  return json(messageOf(stored));
}
