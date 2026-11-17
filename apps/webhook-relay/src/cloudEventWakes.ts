import type { RelayEnv } from "./shared";

/**
 * Wakes resting ADE Cloud computers for a delivery this relay just stored.
 *
 * A cloud computer at rest holds no socket, so the topic hint
 * (`notifyLinearTopic`) never reaches it. After a Linear or machine-homed
 * custom-hook delivery is committed, the relay names the delivery's topics to
 * each account directory (`POST /cloud/internal/event-wake`, secret
 * `CLOUD_EVENT_WAKE_SECRET`). The directory wakes the computers that listen
 * to the topic, at most once every 5 minutes each, and the computer reads the
 * stored events itself when it is up. Nothing of the event is sent: only the
 * topic, which is an id.
 *
 * Repository events are not sent: they come in far more often, and a cloud
 * computer acting on them is woken by its own timed wakes and by people.
 *
 * Runs after the response (`runAfterResponse`); a failure only logs.
 */

/** The account directory's header and route (`CLOUD_EVENT_WAKE_HEADER`, `CLOUD_EDGE_PATHS.internalEventWake`). */
const EVENT_WAKE_HEADER = "x-ade-event-wake-secret";
const EVENT_WAKE_URL = "https://account-directory.internal/cloud/internal/event-wake";
const EVENT_WAKE_TIMEOUT_MS = 10_000;
/**
 * A topic no computer listens to is not asked about again for this long in
 * this isolate. A computer subscribes as it goes to rest, so a minute of
 * delay costs at most one missed wake right after it fell asleep.
 */
const QUIET_TOPIC_MS = 60_000;
const QUIET_TOPIC_MAX = 5_000;
const quietTopics = new Map<string, number>();

type DirectoryName = "ACCOUNT_DIRECTORY" | "ACCOUNT_DIRECTORY_PRODUCTION";
const DIRECTORIES: readonly DirectoryName[] = ["ACCOUNT_DIRECTORY_PRODUCTION", "ACCOUNT_DIRECTORY"];

function isQuiet(key: string, now: number): boolean {
  const until = quietTopics.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  quietTopics.delete(key);
  return false;
}

function markQuiet(key: string, now: number): void {
  if (quietTopics.size >= QUIET_TOPIC_MAX) {
    // Oldest first: a Map keeps insertion order.
    const oldest = quietTopics.keys().next().value;
    if (oldest !== undefined) quietTopics.delete(oldest);
  }
  quietTopics.set(key, now + QUIET_TOPIC_MS);
}

export async function wakeCloudComputersForTopics(env: RelayEnv, topics: string[], now = Date.now()): Promise<void> {
  const secret = env.CLOUD_EVENT_WAKE_SECRET?.trim();
  if (!secret || topics.length === 0) return;
  const calls: Promise<void>[] = [];
  for (const name of DIRECTORIES) {
    const binding = env[name];
    if (!binding) continue;
    for (const topic of topics) {
      const key = `${name}\n${topic}`;
      if (isQuiet(key, now)) continue;
      calls.push((async () => {
        try {
          const response = await binding.fetch(EVENT_WAKE_URL, {
            method: "POST",
            headers: { "content-type": "application/json", [EVENT_WAKE_HEADER]: secret },
            body: JSON.stringify({ topic }),
            signal: AbortSignal.timeout(EVENT_WAKE_TIMEOUT_MS),
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            // A directory without the route or the secret: quiet too, so it is not asked every delivery.
            if (response.status === 404 || response.status === 503) markQuiet(key, now);
            console.warn(JSON.stringify({ kind: "cloud_event_wake_refused", directory: name, status: response.status }));
            return;
          }
          const body = await response.json().catch(() => null) as { subscribed?: unknown; woken?: unknown } | null;
          if (body?.subscribed !== true) markQuiet(key, now);
          else if (typeof body.woken === "number" && body.woken > 0) {
            console.log(JSON.stringify({ kind: "cloud_event_wake_sent", directory: name, topicKind: topic.slice(0, topic.indexOf(":")), woken: body.woken }));
          }
        } catch (error) {
          console.warn(JSON.stringify({ kind: "cloud_event_wake_failed", directory: name, error: error instanceof Error ? error.name : "unknown" }));
        }
      })());
    }
  }
  await Promise.all(calls);
}
