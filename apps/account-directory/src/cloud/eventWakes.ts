import {
  CLOUD_EVENT_WAKE_COOLDOWN_MS,
  CLOUD_EVENT_WAKE_HEADER,
  CLOUD_EVENT_WAKE_MAX_TOPICS,
  type CloudEventWakeInternalResult,
  type CloudEventWakesResult,
} from "./contract";
import { accountRepoScopeKey } from "../../../desktop/src/shared/accountSettingsScope";
import type { RelayEnv } from "./accountVault";
import { UNREADABLE_REQUEST_MESSAGE, fail, json, readJson } from "./http";
import { linearOrganizationOf } from "./integrations";
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
 * A `linear-org` topic must name the workspace of the computer's own lane's
 * Linear connection, as Linear answers for it (kept a week per project in
 * `cloud_linear_orgs`), so no account listens to another team's workspace. A
 * delivery wakes every account's newest listeners first, so one account's
 * many rows can't keep another account's computers out of the 20.
 * A subscription is not use. A wake from an event is: its time bills hours
 * and it restarts the idle cleanup's clock, the same as a person's wake.
 */

export type EventWakeEnv = CloudEnv & { CLOUD_EVENT_WAKE_SECRET?: string };

/** What a wake did: `woken`, `awake` (nothing to do), `refused:<code>`, or `failed`. */
export type EventWakeOutcome = string;
export type EventWakeComputer = (computer: ComputerRow, now: number) => Promise<EventWakeOutcome>;

const TOPIC_PATTERN = /^(linear-org|linear-account|hooks-account):[A-Za-z0-9_.:-]{1,200}$/;
/** Computers one delivery may wake. A topic is one person's or one team's, so this is far above real use. */
const MAX_WAKES_PER_TOPIC = 20;
/** How long a workspace Linear named for an account counts without asking Linear again. */
const LINEAR_ORG_CHECK_TTL_MS = 7 * 24 * 60 * 60_000;
const LINEAR_ORG_PREFIX = "linear-org:";
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

/**
 * The topics a computer may listen to: its `linear-org` topics only for the
 * workspace of its own lane's project's Linear connection (kept a week per
 * project), others as they are. `settled` is false when a workspace was left
 * out: the computer sends the list again at its next rest, so one that is
 * connected later, or couldn't be checked now (the vault or Linear didn't
 * answer, or the OAuth token waits for its owner to renew it), is added then.
 * Until a check runs, a workspace this computer already listens to stays.
 */
async function topicsInOwnWorkspace(env: RelayEnv, request: Request, computer: ComputerRow, topics: string[], now: number): Promise<{ topics: string[]; settled: boolean }> {
  const orgIds = topics.filter((topic) => topic.startsWith(LINEAR_ORG_PREFIX)).map((topic) => topic.slice(LINEAR_ORG_PREFIX.length));
  if (!orgIds.length) return { topics, settled: true };
  const scope = accountRepoScopeKey(computer.lane_project_origin ?? null);
  const known = scope
    ? (await env.DB.prepare("select org_id from cloud_linear_orgs where user_id = ? and scope = ? and checked_at > ?")
      .bind(computer.user_id, scope, now - LINEAR_ORG_CHECK_TTL_MS).all<{ org_id: string }>()).results ?? []
    : [];
  const own = new Set(known.map((row) => row.org_id));
  if (orgIds.some((id) => !own.has(id))) {
    const org = await linearOrganizationOf(env, request.headers.get("authorization") ?? "", scope, now);
    if (org === "unavailable") {
      const listening = (await env.DB.prepare("select topic from cloud_event_wakes where instance_id = ? and topic like 'linear-org:%'")
        .bind(computer.instance_id).all<{ topic: string }>()).results ?? [];
      for (const row of listening) own.add(row.topic.slice(LINEAR_ORG_PREFIX.length));
    } else if (org && scope) {
      own.add(org);
      await env.DB.prepare(`
        insert into cloud_linear_orgs (user_id, scope, org_id, checked_at) values (?, ?, ?, ?)
        on conflict (user_id, scope, org_id) do update set checked_at = excluded.checked_at
      `).bind(computer.user_id, scope, org, now).run();
    }
  }
  const kept = topics.filter((topic) => !topic.startsWith(LINEAR_ORG_PREFIX) || own.has(topic.slice(LINEAR_ORG_PREFIX.length)));
  return { topics: kept, settled: kept.length === topics.length };
}

/** `PUT /cloud/instances/:id/event-wakes {topics}`: the computer's whole list, replaced. An empty list removes it. */
export async function routeEventWakeSubscription(request: Request, env: RelayEnv, userId: string, instanceId: string, now: number): Promise<Response> {
  if (request.method !== "PUT") return fail("not_found", "Daex Cloud has no such route.", 404);
  const computer = await ownedComputer(env, userId, instanceId);
  if (!computer) return fail("not_found", "Daex Cloud has no such computer.", 404);
  const body = await readJson(request);
  if (!body) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const asked = eventWakeTopicsOf(body.topics, userId);
  if (typeof asked === "string") return fail("bad_request", asked, 400);
  const { topics, settled } = await topicsInOwnWorkspace(env, request, computer, asked, now);
  await env.DB.batch([
    env.DB.prepare("delete from cloud_event_wakes where instance_id = ?").bind(instanceId),
    ...topics.map((topic) => env.DB.prepare("insert into cloud_event_wakes (instance_id, topic, user_id, updated_at) values (?, ?, ?, ?)")
      .bind(instanceId, topic, userId, now)),
  ]);
  logCloud("cloud.event_wakes_set", { instanceId, topics: topics.length, ...(settled ? {} : { leftOut: asked.length - topics.length }) });
  // Not a success, so the computer doesn't record the list as sent and sends it again at its next rest.
  if (!settled) return fail("linear_workspace_unchecked", "Daex couldn't match a Linear workspace to this lane's Linear connection yet. It checks again next time.", 409);
  return json({ topics } satisfies CloudEventWakesResult);
}

/**
 * Whether a request carries the webhook relay's shared secret. `null`: no
 * secret is set on this server, so every such route answers 503, never open.
 */
export function presentsEventWakeSecret(request: Request, env: { CLOUD_EVENT_WAKE_SECRET?: string }): boolean | null {
  const expected = env.CLOUD_EVENT_WAKE_SECRET?.trim();
  if (!expected) return null;
  const presented = request.headers.get(CLOUD_EVENT_WAKE_HEADER)?.trim() ?? "";
  return presented !== "" && sameSecret(presented, expected);
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
  const proven = presentsEventWakeSecret(request, env);
  if (proven === null) return fail("unavailable", "Event wakes are not set up on this server.", 503);
  if (request.method !== "POST" || !proven) return fail("not_found", "Daex Cloud has no such route.", 404);
  const body = await readJson(request);
  const topic = typeof body?.topic === "string" ? body.topic : "";
  if (!TOPIC_PATTERN.test(topic)) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);

  // Each account's newest listener first, then each one's next: an account's many rows can't crowd out another's.
  const rows = (await env.DB.prepare(`
    select * from (
      select c.*, row_number() over (partition by w.user_id order by w.updated_at desc, w.instance_id) as listener_rank, w.updated_at as listened_at
      from cloud_event_wakes w
      join cloud_computers c on c.instance_id = w.instance_id and c.user_id = w.user_id and c.deleted_at is null
      where w.topic = ?
    )
    order by listener_rank, listened_at desc
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
