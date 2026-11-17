import {
  CLOUD_EVENT_WAKE_COOLDOWN_MS,
  CLOUD_EVENT_WAKE_HEADER,
  CLOUD_EVENT_WAKE_MAX_TOPICS,
  type CloudEventWakeInternalResult,
  type CloudEventWakesResult,
} from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, fail, json, readJson } from "./http";
import { isMeteredStatus } from "./plans";
import { logCloud, ownedComputer, reportCloudFailure, type CloudEnv, type ComputerRow } from "./store";

/**
 * Wakes from events: a resting cloud computer names the event topics it acts
 * on (`PUT /cloud/instances/:id/event-wakes`), and the webhook relay names a
 * topic after it stores a delivery (`POST /cloud/internal/event-wake`, with
 * the shared secret `CLOUD_EVENT_WAKE_SECRET`). Each subscribed computer is
 * woken at most once every `CLOUD_EVENT_WAKE_COOLDOWN_MS`, through the same
 * checks as a person's wake; it then reads the relay's stored events itself.
 *
 * A topic is an id (`linear-org:<id>`, `linear-account:<user>`,
 * `hooks-account:<user>`), never event text. An account topic must name the
 * caller's own account, so no computer is woken by another account's events.
 * A subscription is not use: the idle cleanup still counts the computer as
 * unused until something on it runs.
 */

export type EventWakeEnv = CloudEnv & { CLOUD_EVENT_WAKE_SECRET?: string };

/** What a wake did: `woken`, `awake` (nothing to do), `refused:<code>`, or `failed`. */
export type EventWakeOutcome = string;
export type EventWakeComputer = (computer: ComputerRow, now: number) => Promise<EventWakeOutcome>;

const TOPIC_PATTERN = /^(linear-org|linear-account|hooks-account):[A-Za-z0-9_.:-]{1,200}$/;
/** Computers one delivery may wake. A topic is one person's, so this is far above real use. */
const MAX_WAKES_PER_TOPIC = 20;
/** An idle cleanup's claim this fresh holds the computer (`CLAIM_STALE_MS` in idleCleanup.ts). */
const IDLE_CLAIM_HOLD_MS = 20 * 60_000;

/** The topics as stored, or a sentence saying why not. */
export function eventWakeTopicsOf(raw: unknown, userId: string): string[] | string {
  if (!Array.isArray(raw)) return "topics must be a list.";
  if (raw.length > CLOUD_EVENT_WAKE_MAX_TOPICS) return `A computer can listen to at most ${CLOUD_EVENT_WAKE_MAX_TOPICS} topics.`;
  const topics = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !TOPIC_PATTERN.test(entry)) return "That topic can't wake a computer.";
    const [kind, id] = [entry.slice(0, entry.indexOf(":")), entry.slice(entry.indexOf(":") + 1)];
    if ((kind === "linear-account" || kind === "hooks-account") && id !== userId) return "That topic belongs to another account.";
    topics.add(entry);
  }
  return [...topics].sort();
}

/** `PUT /cloud/instances/:id/event-wakes {topics}`: the computer's whole list, replaced. An empty list removes it. */
export async function routeEventWakeSubscription(request: Request, env: CloudEnv, userId: string, instanceId: string, now: number): Promise<Response> {
  if (request.method !== "PUT") return fail("not_found", "ADE Cloud has no such route.", 404);
  const computer = await ownedComputer(env, userId, instanceId);
  if (!computer) return fail("not_found", "ADE Cloud has no such computer.", 404);
  const body = await readJson(request);
  if (!body) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const topics = eventWakeTopicsOf(body.topics, userId);
  if (typeof topics === "string") return fail("bad_request", topics, 400);
  await env.DB.batch([
    env.DB.prepare("delete from cloud_event_wakes where instance_id = ?").bind(instanceId),
    ...topics.map((topic) => env.DB.prepare("insert into cloud_event_wakes (instance_id, topic, user_id, updated_at) values (?, ?, ?, ?)")
      .bind(instanceId, topic, userId, now)),
  ]);
  logCloud("cloud.event_wakes_set", { instanceId, topics: topics.length });
  return json({ topics } satisfies CloudEventWakesResult);
}

/** Constant time: the secret's length is public, its bytes are not. */
function sameSecret(presented: string, expected: string): boolean {
  const left = new TextEncoder().encode(presented);
  const right = new TextEncoder().encode(expected);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index]! ^ right[index]!;
  return diff === 0;
}

export function isInternalEventWakeRequest(path: string): boolean {
  return path === "/cloud/internal/event-wake";
}

/**
 * `POST /cloud/internal/event-wake {topic}` from the webhook relay. No account
 * token: the shared secret is the proof, and the topic names whose computers.
 * Unset secret: refused, never open.
 */
export async function handleInternalEventWake(request: Request, env: EventWakeEnv, wake: EventWakeComputer, now: number): Promise<Response> {
  const expected = env.CLOUD_EVENT_WAKE_SECRET?.trim();
  if (!expected) return fail("unavailable", "Event wakes are not set up on this server.", 503);
  const presented = request.headers.get(CLOUD_EVENT_WAKE_HEADER)?.trim() ?? "";
  if (request.method !== "POST" || !presented || !sameSecret(presented, expected)) return fail("not_found", "ADE Cloud has no such route.", 404);
  const body = await readJson(request);
  const topic = typeof body?.topic === "string" ? body.topic : "";
  if (!TOPIC_PATTERN.test(topic)) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);

  const rows = (await env.DB.prepare(`
    select c.* from cloud_event_wakes w
    join cloud_computers c on c.instance_id = w.instance_id and c.user_id = w.user_id and c.deleted_at is null
    where w.topic = ?
    limit ?
  `).bind(topic, MAX_WAKES_PER_TOPIC).all<ComputerRow>()).results ?? [];
  let woken = 0;
  for (const computer of rows) {
    if (isMeteredStatus(computer.status)) continue;
    if (computer.idle_claimed_at != null && computer.idle_claimed_at >= now - IDLE_CLAIM_HOLD_MS) continue;
    // One wake per computer per cooldown, even when two deliveries race: the
    // row's own `where` takes the slot.
    const claimed = await env.DB.prepare(`
      insert into cloud_event_wake_state (instance_id, user_id, last_woken_at, last_status) values (?, ?, ?, 'waking')
      on conflict (instance_id) do update set last_woken_at = excluded.last_woken_at, last_status = 'waking'
      where cloud_event_wake_state.last_woken_at <= ?
    `).bind(computer.instance_id, computer.user_id, now, now - CLOUD_EVENT_WAKE_COOLDOWN_MS).run();
    if ((claimed.meta?.changes ?? 0) === 0) continue;
    let outcome: EventWakeOutcome;
    try {
      outcome = await wake(computer, now);
    } catch (error) {
      reportCloudFailure("cloud.event_wake_failed", { instanceId: computer.instance_id, error: error instanceof Error ? error.name : "unknown" });
      outcome = "failed";
    }
    await env.DB.prepare("update cloud_event_wake_state set last_status = ? where instance_id = ? and last_woken_at = ?")
      .bind(outcome, computer.instance_id, now).run();
    logCloud("cloud.event_wake", { userId: computer.user_id, instanceId: computer.instance_id, topicKind: topic.slice(0, topic.indexOf(":")), outcome });
    if (outcome === "woken") woken += 1;
  }
  return json({ subscribed: rows.length > 0, woken } satisfies CloudEventWakeInternalResult);
}
