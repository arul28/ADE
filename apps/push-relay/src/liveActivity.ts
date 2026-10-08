/**
 * ACCOUNT-WIDE LIVE ACTIVITY.
 *
 * One aggregate ActivityKit activity per account ("agent-runs") whose content
 * state is recomputed from the whole `attention_items` table and pushed to every
 * owned device. Lifted out of `attention.ts` because it is the one seam in that
 * file with a single entry point: everything below is reached through
 * `deliverAccountLiveActivity`, and the rest is the pure derivation feeding it —
 * the state-group table, the roster projection, and the transition fingerprint
 * that decides whether a refresh is worth an APNs push.
 *
 * The content state leads with `columns`: agent counts in the Work board's four
 * columns (needs you, working, waiting, done). `activityBoardColumn` here is one
 * of three copies of that rule (renderer, iOS, relay), pinned to a shared
 * fixture; see `apps/desktop/src/shared/attention/activityBoardColumn.cases.json`.
 *
 * `runs`, `prs`, `groups` and `activeCount` still ship for app builds that
 * predate the four-column Live Activity. `activityStateGroup` below is the old
 * six-group rule those builds read, pinned to `activityStateGroup.cases.json`.
 */
import {
  sendApnsPush,
  type ApnsEnvironment,
  type ApnsSendResult,
} from "./apns";
import {
  apnsConfig,
  boundedText,
  isActivityBoardColumn,
  isRecord,
  logAttentionDeliveryError,
  preferenceBoolean,
  readPreferences,
  requiredString,
  LIVE_ACTIVITY_START_CLAIM_TTL_MS,
  MAX_PREVIEW_LENGTH,
  MAX_TITLE_LENGTH,
  type ActivityBoardColumn,
  type AttentionDeviceRow,
  type AttentionRelayEnv,
  type OwnedAttentionDeviceRow,
  type ParsedAttentionItem,
} from "./attentionShared";

function resolveActivityDevicePreferences(
  device: AttentionDeviceRow,
  preferences: Record<string, unknown>,
): Record<string, unknown> {
  const registered = readPreferences(device.preferences_json);
  const accountPreferences = isRecord(preferences.account) ? preferences.account : {};
  const devicePreferences = isRecord(preferences.devices) ? preferences.devices : {};
  const accountOverride = isRecord(devicePreferences[device.device_id])
    ? devicePreferences[device.device_id] as Record<string, unknown>
    : {};
  // Registration preferences are a compatibility fallback. iOS includes its
  // ordinary defaults on every device registration, so treating them as
  // overrides would make account-wide delivery/privacy settings ineffective.
  // Only the explicit account `devices[deviceId]` scope may override account
  // settings for one device.
  return { ...registered, ...accountPreferences, ...accountOverride };
}

/**
 * The Work-board column for an agent item. Mirrors `activityBoardColumn` in
 * `apps/desktop/src/shared/attention/activityBoardColumn.ts` exactly: trust a
 * column the brain published, and otherwise derive one from the phase for items
 * an older brain sent. Pull-request items are never counted.
 */
function activityBoardColumn(item: ParsedAttentionItem): ActivityBoardColumn | null {
  if (item.kind !== "agent") return null;
  if (isActivityBoardColumn(item.boardColumn)) return item.boardColumn;
  if (item.phase === "needs_you" || item.phase === "failed") return "needs_you";
  if (item.activityTier === "idle") return "done";
  if (item.phase === "starting" || item.phase === "running" || item.phase === "stale") {
    return "working";
  }
  return "done";
}

/**
 * Non-urgent count changes (working, waiting, done) refresh the Live Activity
 * at most this often. A needs-you change always pushes at once.
 */
const LIVE_ACTIVITY_COUNT_REFRESH_MS = 5 * 60 * 1_000;

/**
 * The six-way state vocabulary of the Live Activity before the four-column
 * redesign. Kept only for app builds that still read `groups`. Ordered by
 * urgency: the island shows the first nonzero group's glyph.
 *
 * `idle` is its own band rather than a corner of `done`: a session that went
 * quiet mid-work and a session that finished are not the same fact, and folding
 * the first into the second made `done` a bucket that filled with week-old
 * roster rows. It sorts above `done` because "stopped without finishing" is
 * likelier to want you than "finished".
 */
type ActivityStateGroup =
  | "needs_you"
  | "failed"
  | "planning"
  | "working"
  | "idle"
  | "done";

const ACTIVITY_STATE_GROUP_ORDER: readonly ActivityStateGroup[] = [
  "needs_you",
  "failed",
  "planning",
  "working",
  "idle",
  "done",
];

/**
 * Mirrors the renderer's `activityStateGroup` exactly, including the three rules
 * that are easy to get wrong:
 *
 * - `planning` comes from `chatActivityMode`, never from a phase. The phase
 *   vocabulary is frozen wire and cannot carry the state, so an item that does
 *   not stamp the field groups exactly as it did before the field existed.
 * - Idle-tier rows are disk-only roster history — quiet, never alerting, and
 *   they land in `idle`, NOT `done`: `done` means the work actually finished.
 * - `stale` is a resting state, not a live one. It used to file with `working`,
 *   which is how the island came to claim agents were working hours after they
 *   had stopped.
 */
function activityStateGroup(item: ParsedAttentionItem): ActivityStateGroup {
  if (item.activityTier === "idle") return "idle";
  switch (item.phase) {
    case "needs_you":
      return "needs_you";
    case "failed":
    case "checks_failing":
    case "changes_requested":
      return "failed";
    case "starting":
    case "running":
      return item.chatActivityMode === "planning" ? "planning" : "working";
    case "stale":
      // Went quiet mid-work: not live, not finished — the exact gap `idle` names.
      return "idle";
    case "open":
    case "review_requested":
    case "merge_ready":
    case "blocked":
      // Someone else's move, not the reader's, but still an open thread: filed
      // with the live band so it cannot borrow the amber "needs you" heading.
      return "working";
    default:
      return "done";
  }
}

/**
 * Sort rank for the roster, which is sliced to the top three — so this ladder
 * decides which runs the island can see at all, and a session that has gone
 * quiet must never take a slot from a live one.
 *
 * `stale` used to share rank 4 with `open`, back when it grouped as `working`.
 * That was never an observable bug — `running` already outranked both, and this
 * function's only caller filters `open`/`closed` rows out before sorting, so
 * rank 4 had exactly one occupant — but it encoded stale as a live phase, which
 * is the belief that let the island report agents as working hours after they
 * stopped. Now that `stale` groups as `idle`, it ranks below every live phase
 * and above the terminal ones: resting-but-unfinished beats finished, and never
 * beats running. Keeping the ladder honest here means the next reader cannot
 * re-derive "stale is live" from the sort.
 */
function activityPriority(item: ParsedAttentionItem): number {
  switch (item.phase) {
    case "needs_you": return 0;
    case "failed":
    case "checks_failing":
    case "changes_requested": return 1;
    case "review_requested":
    case "merge_ready":
    case "blocked": return 2;
    case "starting":
    case "running": return 3;
    case "open": return 4;
    case "stale": return 5;
    case "completed":
    case "merged": return 6;
    default: return 7;
  }
}

function activityRun(item: ParsedAttentionItem): Record<string, unknown> | null {
  if (item.kind !== "agent" || !isRecord(item.destination)) return null;
  const sessionId = requiredString(item.destination.sessionId);
  if (!sessionId) return null;
  const actions = Array.isArray(item.actions) ? item.actions.filter(isRecord) : [];
  const approval = actions.some((action) => action.kind === "approve");
  const phase = item.phase === "needs_you" || item.phase === "blocked"
    ? approval ? "waiting_for_approval" : "waiting_for_input"
    : item.phase;
  // Unix SECONDS, matching `updatedAt`'s unit on this content state. The
  // client renders a system-ticked relative date from it, so a row's elapsed
  // time keeps counting between pushes instead of freezing at whatever it read
  // when the last transition happened to earn one. `statusSince` is the right
  // anchor rather than `updatedAt`: it is immutable for the life of a phase,
  // so the timer measures time in the STATE and does not reset on a cosmetic
  // republish.
  const statusSinceRaw = typeof item.statusSince === "string"
    ? item.statusSince
    : typeof item.occurredAt === "string" ? item.occurredAt : "";
  const statusSinceMs = Date.parse(statusSinceRaw);
  return {
    id: sessionId,
    accountMachineKey: requiredString(item.machine.accountMachineKey, 128),
    title: boundedText(item.title, MAX_TITLE_LENGTH) ?? "Agent run",
    phase,
    model: boundedText(item.model, 120),
    lane: boundedText(item.laneName, 160),
    detail: boundedText(item.preview, MAX_PREVIEW_LENGTH),
    ...(Number.isFinite(statusSinceMs)
      ? { statusSince: Math.floor(statusSinceMs / 1_000) }
      : {}),
  };
}

function activityPullRequest(item: ParsedAttentionItem): Record<string, unknown> | null {
  if (item.kind !== "pull_request" || !isRecord(item.destination)) return null;
  const number = Number(item.destination.number);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const phase = item.phase === "open" ? "opened" : item.phase;
  return {
    id: item.id,
    accountMachineKey: requiredString(item.machine.accountMachineKey, 128),
    prNumber: number,
    title: boundedText(item.title, MAX_TITLE_LENGTH) ?? `Pull request #${number}`,
    phase,
    lane: boundedText(item.laneName, 160),
    repoOwner: requiredString(item.destination.repoOwner),
    repoName: requiredString(item.destination.repoName),
    updatedAt: Date.parse(item.updatedAt) / 1_000,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

async function accountActivityContentState(
  env: AttentionRelayEnv,
  userId: string,
): Promise<{
  contentState: Record<string, unknown>;
  /**
   * The Live Activity refresh gate. NOT a digest of `contentState` — see
   * `activityTransitionSource` for why that would push on every agent turn.
   */
  transitionFingerprint: string;
  /** The exact four column counts. A change here pushes, but rate-limited. */
  countsFingerprint: string;
  count: number;
}> {
  const rows = await env.DB.prepare(`
    select payload_json, seen_at, dismissed_at
    from attention_items
    where user_id = ?
      and dismissed_at is null
      and (expires_at is null or expires_at > ?)
    limit 512
  `).bind(userId, new Date().toISOString()).all<{
    payload_json: string;
    seen_at: string | null;
    dismissed_at: string | null;
  }>();
  const items = rows.results.flatMap((row) => {
    try {
      const item = JSON.parse(row.payload_json) as ParsedAttentionItem;
      if (item.phase === "closed" || item.phase === "open") return [];
      // Seen finished work leaves the activity, but a finished chat that waits
      // on a scheduled wake is not finished: it stays counted in Waiting.
      if (
        (item.phase === "completed" || item.phase === "merged")
        && row.seen_at
        && activityBoardColumn(item) !== "waiting"
      ) return [];
      return [item];
    } catch {
      return [];
    }
  }).sort((left, right) => {
    const priority = activityPriority(left) - activityPriority(right);
    if (priority !== 0) return priority;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
  const runCandidates = items.flatMap((item) => {
    const run = activityRun(item);
    return run ? [run] : [];
  });
  const runs = runCandidates.slice(0, 3);
  const prs = items.flatMap((item) => {
    const pr = activityPullRequest(item);
    return pr ? [pr] : [];
  }).slice(0, 2);
  const newestUpdate = items.reduce(
    (latest, item) => Math.max(latest, Date.parse(item.updatedAt)),
    0,
  );
  // The island's "N agents working" headline, so the invariant is: an idle-tier
  // row is never active, whatever phase it preserved. Both halves are needed.
  //
  // The phase list excludes `stale` — a session that went quiet is not one of
  // the N. The group check then closes the case the phase list cannot see: an
  // idle-tier row keeps whatever phase it died in, so a roster row frozen at
  // `running` reads as live by phase alone. That is precisely the frame this
  // change set exists to kill (the island claiming agents were working hours
  // after they stopped), and the conformance fixture pins idle-tier-plus-
  // `running` as a case the vocabulary must handle — so `activeCount` handles it
  // by rule rather than by trusting today's publisher to never emit it.
  const activeCount = items.filter((item) =>
    item.kind === "agent"
    && activityStateGroup(item) !== "idle"
    && (
      item.phase === "starting"
      || item.phase === "running"
      || item.phase === "needs_you"
      || item.phase === "blocked"
    )).length;
  // Agent-only, and account-wide rather than roster-derived. The roster is
  // capped at three, so an agent raising its hand behind the cap is invisible
  // to any tally computed from `runs` — which is exactly the case where the
  // island most needs to turn amber.
  //
  // PR rows are tallied separately by the clients; counting them here would
  // inflate every group they touched ("a pull request is not planning").
  const agentItems = items.filter((item) => item.kind === "agent");
  const tally = new Map<ActivityStateGroup, number>();
  for (const item of agentItems) {
    const group = activityStateGroup(item);
    tally.set(group, (tally.get(group) ?? 0) + 1);
  }
  const groups = ACTIVITY_STATE_GROUP_ORDER
    .map((group) => ({ group, count: tally.get(group) ?? 0 }))
    .filter((entry) => entry.count > 0);
  const columns = { needsYou: 0, working: 0, waiting: 0, done: 0 };
  for (const item of agentItems) {
    switch (activityBoardColumn(item)) {
      case "needs_you": columns.needsYou += 1; break;
      case "working": columns.working += 1; break;
      case "waiting": columns.waiting += 1; break;
      case "done": columns.done += 1; break;
      default: break;
    }
  }
  const moreCount = Math.max(0, runCandidates.length - runs.length);
  const contentState = {
    updatedAt: Math.floor((newestUpdate || Date.now()) / 1_000),
    // Always present, zeros included: the four tiles read these directly.
    columns,
    activeCount,
    runs,
    prs,
    // Additive: omitted, never zero-filled. An older client ignores the keys,
    // and a newer client treats absence as "derive it locally from the roster".
    ...(groups.length > 0 ? { groups } : {}),
    ...(moreCount > 0 ? { moreCount } : {}),
  };
  return {
    contentState,
    transitionFingerprint: await sha256Hex(
      JSON.stringify(activityTransitionSource(items, columns.needsYou)),
    ),
    countsFingerprint: `${columns.needsYou}.${columns.working}.${columns.waiting}.${columns.done}`,
    // The activity lives while any agent needs you, works, or waits. Done
    // alone is not a reason to hold the Lock Screen.
    count: columns.needsYou + columns.working + columns.waiting,
  };
}

/**
 * WHEN A LIVE ACTIVITY REFRESH IS WORTH AN APNs PUSH.
 *
 * ActivityKit throttles pushed updates per activity per hour; blow the budget
 * and iOS silently stops delivering, which leaves the island frozen on a stale
 * frame — strictly worse than the undercount this feature set out to fix. The
 * account tallies churn on essentially every agent turn (a preview line, a
 * token counter, a `updatedAt` tick), so digesting `contentState` — as this
 * path used to — spent a push on every single publish, including the 30s
 * machine heartbeat's no-op republish.
 *
 * Two gates, reusing the publisher's alert-fingerprint semantics (identity =
 * `{id, eventKind, phase, statusSince, itemId}`, which deliberately excludes
 * preview copy AND `chatActivityMode`):
 *
 * - The urgent gate (this function) pushes at once. It holds the exact
 *   Needs-you count, the alert fingerprints of the Needs-you items (so a swap
 *   where the count holds but a different run now waits on you still pushes),
 *   and the pull-request alert fingerprints, whose phase entries are rare.
 *   Nothing else: a chat moving between working, waiting and done must never
 *   reach this gate, or it would skip the rate limit below.
 * - The count gate (`countsFingerprint`) holds the exact four column counts.
 *   A change pushes, but at most once per `LIVE_ACTIVITY_COUNT_REFRESH_MS`, so
 *   a busy account cannot exhaust the ActivityKit budget while every number
 *   still settles within minutes.
 *
 * Everything else (previews, roster ordering, `updatedAt`) still ships, on the
 * next push one of the two gates earns, never on a push of its own.
 */
function activityTransitionSource(
  items: ParsedAttentionItem[],
  needsYouCount: number,
): Record<string, unknown> {
  const alerting = items
    .filter((item) => activityBoardColumn(item) === "needs_you")
    .map((item) => item.alertFingerprint)
    .sort();
  const pullRequests = items
    .filter((item) => item.kind === "pull_request")
    .map((item) => item.alertFingerprint)
    .sort();
  return {
    needsYou: needsYouCount,
    alerting,
    pullRequests,
  };
}

/** "2 need you · 5 working", from the column counts. Never agent text. */
function liveActivityStartSummary(contentState: Record<string, unknown>): string {
  const columns = isRecord(contentState.columns) ? contentState.columns : {};
  const count = (key: string): number => {
    const value = Number(columns[key]);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  const parts = [
    count("needsYou") > 0 ? `${count("needsYou")} need${count("needsYou") === 1 ? "s" : ""} you` : null,
    count("working") > 0 ? `${count("working")} working` : null,
    count("waiting") > 0 ? `${count("waiting")} waiting` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "Agents are active";
}

function privacyPreservingActivityContentState(
  contentState: Record<string, unknown>,
): Record<string, unknown> {
  const runs = Array.isArray(contentState.runs)
    ? contentState.runs.filter(isRecord).map((run) => ({
        ...run,
        title: "Agent activity",
        model: null,
        lane: null,
        detail: null,
      }))
    : [];
  const prs = Array.isArray(contentState.prs)
    ? contentState.prs.filter(isRecord).map((pr) => ({
        ...pr,
        title: Number.isSafeInteger(pr.prNumber)
          ? `Pull request #${String(pr.prNumber)}`
          : "Pull request",
        lane: null,
      }))
    : [];
  return {
    ...contentState,
    runs,
    prs,
  };
}
async function claimAccountLiveActivityStart(
  env: AttentionRelayEnv,
  userId: string,
  deviceId: string,
  activityId: string,
  generation: string,
): Promise<string | null> {
  // `started = 0` is a short-lived lease: one heartbeat owns the remote start
  // while other concurrent heartbeats skip it. The unique fingerprint makes
  // release/commit conditional so a stale claimant cannot clobber its successor.
  const claim = `pending:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const staleBefore = new Date(
    Date.now() - LIVE_ACTIVITY_START_CLAIM_TTL_MS,
  ).toISOString();
  const row = await env.DB.prepare(`
    insert into attention_activity_state(
      user_id, device_id, activity_id, started, fingerprint, updated_at
    )
    select ?, ?, ?, 0, ?, ?
    where exists (
      select 1
      from attention_devices
      where user_id = ? and device_id = ? and generation = ?
    )
    on conflict(user_id, device_id, activity_id) do update set
      started = 0,
      fingerprint = excluded.fingerprint,
      updated_at = excluded.updated_at
    where attention_activity_state.started = 0
      and attention_activity_state.updated_at <= ?
    returning fingerprint
  `).bind(
    userId,
    deviceId,
    activityId,
    claim,
    now,
    userId,
    deviceId,
    generation,
    staleBefore,
  ).first<{ fingerprint: string }>();
  return row?.fingerprint === claim ? claim : null;
}

async function releaseAccountLiveActivityStart(
  env: AttentionRelayEnv,
  userId: string,
  deviceId: string,
  activityId: string,
  claim: string,
  generation: string,
): Promise<void> {
  await env.DB
    .prepare(`
      delete from attention_activity_state
      where user_id = ? and device_id = ? and activity_id = ?
        and started = 0 and fingerprint = ?
        and exists (
          select 1
          from attention_devices
          where user_id = ? and device_id = ? and generation = ?
        )
    `)
    .bind(
      userId,
      deviceId,
      activityId,
      claim,
      userId,
      deviceId,
      generation,
    )
    .run();
}

export async function deliverAccountLiveActivity(
  env: AttentionRelayEnv,
  userId: string,
): Promise<void> {
  const config = apnsConfig(env);
  if (!config) return;
  const activityId = "agent-runs";
  const [
    { contentState, transitionFingerprint, countsFingerprint, count },
    devicesResult,
    preferencesRow,
  ] = await Promise.all([
      accountActivityContentState(env, userId),
      env.DB.prepare(`
        select device.device_id, device.apns_token, device.push_to_start_token,
          device.bundle_id, device.aps_environment, device.preferences_json,
          device.generation, ownership.ownership_epoch
        from attention_devices as device
        join attention_device_ownership as ownership
          on ownership.device_id = device.device_id
          and ownership.user_id = device.user_id
          and ownership.active = 1
        where device.user_id = ? and device.lease_expires_at > ?
      `).bind(userId, new Date().toISOString()).all<OwnedAttentionDeviceRow>(),
      env.DB
        .prepare("select payload_json from attention_preferences where user_id = ? limit 1")
        .bind(userId)
        .first<{ payload_json: string }>(),
    ]);
  const preferences = readPreferences(preferencesRow?.payload_json);
  const accountPreferences = isRecord(preferences.account) ? preferences.account : {};
  const nowSeconds = Math.floor(Date.now() / 1_000);

  for (const device of devicesResult.results) {
    const ownershipEpoch = Number(device.ownership_epoch);
    // Account-wide ActivityKit delivery fails closed unless the current
    // registered device row is still owned by this exact account epoch.
    if (!Number.isSafeInteger(ownershipEpoch) || ownershipEpoch <= 0) continue;
    const override = resolveActivityDevicePreferences(device, preferences);
    const state = await env.DB.prepare(`
      select started, fingerprint, updated_at
      from attention_activity_state
      where user_id = ? and device_id = ? and activity_id = ?
      limit 1
    `).bind(userId, device.device_id, activityId).first<{
      started: number;
      fingerprint: string | null;
      updated_at: string | null;
    }>();
    const started = state?.started === 1;
    const liveActivitiesEnabled = preferenceBoolean(
      override,
      accountPreferences,
      "liveActivitiesEnabled",
      true,
    );
    const hideDetails = preferenceBoolean(
      override,
      accountPreferences,
      "hideDetails",
      false,
    );
    const deviceCount = liveActivitiesEnabled ? count : 0;
    const visibleContentState = liveActivitiesEnabled
      ? hideDetails
        ? privacyPreservingActivityContentState(contentState)
        : contentState
      : {
          updatedAt: nowSeconds,
          activeCount: 0,
          runs: [],
          prs: [],
        };
    const deviceContentState = {
      ...visibleContentState,
      ownershipEpoch,
    };
    // The stored refresh gate. `transitionFingerprint` (not a content digest)
    // is what keeps a per-turn count tick from spending an APNs push; the
    // privacy and ownership dimensions are per-device, so they stay here.
    const urgentFingerprint =
      `${transitionFingerprint}:${hideDetails ? "private" : "public"}:owner:${ownershipEpoch}`;
    const deviceFingerprint = `${urgentFingerprint}|${countsFingerprint}`;
    if (deviceCount === 0 && !started) continue;
    if (deviceCount > 0 && started && state?.fingerprint === deviceFingerprint) continue;
    if (
      deviceCount > 0
      && started
      && state?.fingerprint?.split("|")[0] === urgentFingerprint
      && Date.now() - Date.parse(state.updated_at ?? "") < LIVE_ACTIVITY_COUNT_REFRESH_MS
    ) {
      // Only the working, waiting or done counts moved, and the last push was
      // recent. The next publish after the window sends the settled numbers.
      continue;
    }

    let event: "start" | "update" | "end";
    let deviceToken: string | null;
    if (deviceCount === 0) {
      event = "end";
      const token = await env.DB
        .prepare("select token from attention_activity_tokens where user_id = ? and device_id = ? and activity_id = ? limit 1")
        .bind(userId, device.device_id, activityId)
        .first<{ token: string }>();
      deviceToken = token?.token ?? null;
    } else if (!started) {
      event = "start";
      deviceToken = device.push_to_start_token;
    } else {
      event = "update";
      const token = await env.DB
        .prepare("select token from attention_activity_tokens where user_id = ? and device_id = ? and activity_id = ? limit 1")
        .bind(userId, device.device_id, activityId)
        .first<{ token: string }>();
      deviceToken = token?.token ?? null;
    }
    if (!deviceToken) {
      if (event === "end") {
        await env.DB
          .prepare(`
            delete from attention_activity_state
            where user_id = ? and device_id = ? and activity_id = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `)
          .bind(
            userId,
            device.device_id,
            activityId,
            userId,
            device.device_id,
            device.generation,
          )
          .run();
      }
      continue;
    }
    const startClaim = event === "start"
      ? await claimAccountLiveActivityStart(
          env,
          userId,
          device.device_id,
          activityId,
          device.generation,
        )
      : null;
    if (event === "start" && !startClaim) continue;

    const aps: Record<string, unknown> = {
      timestamp: nowSeconds,
      event,
      "content-state": deviceContentState,
      "relevance-score": deviceCount > 0 ? 0.9 : 0,
    };
    if (event !== "end") aps["stale-date"] = nowSeconds + 10 * 60;
    if (event === "start") {
      aps["input-push-token"] = 1;
      aps["attributes-type"] = "ADEAgentRunsAttributes";
      aps.attributes = {
        machineName: "All machines",
        accountWide: true,
        ownershipEpoch,
      };
      // ActivityKit requires an alert to start an activity remotely. Keep it to
      // the same numbers the tiles show.
      aps.alert = {
        title: "ADE",
        body: liveActivityStartSummary(contentState),
      };
    }
    if (event === "end") aps["dismissal-date"] = nowSeconds + 60;
    let result: ApnsSendResult;
    try {
      result = await sendApnsPush(config, {
        environment: device.aps_environment as ApnsEnvironment,
        deviceToken,
        topic: `${device.bundle_id}.push-type.liveactivity`,
        pushType: "liveactivity",
        priority: 10,
        expiration: nowSeconds + 24 * 60 * 60,
        collapseId: `attention:${activityId}`,
        payload: { aps },
      });
    } catch (error) {
      if (startClaim) {
        await releaseAccountLiveActivityStart(
          env,
          userId,
          device.device_id,
          activityId,
          startClaim,
          device.generation,
        );
      }
      logAttentionDeliveryError("live_activity", device.device_id, error);
      continue;
    }
    if (result.ok) {
      if (event === "end") {
        await env.DB.batch([
          env.DB.prepare(`
            delete from attention_activity_state
            where user_id = ? and device_id = ? and activity_id = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `).bind(
            userId,
            device.device_id,
            activityId,
            userId,
            device.device_id,
            device.generation,
          ),
          env.DB.prepare(`
            delete from attention_activity_tokens
            where user_id = ? and device_id = ? and activity_id = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `).bind(
            userId,
            device.device_id,
            activityId,
            userId,
            device.device_id,
            device.generation,
          ),
        ]);
      } else if (event === "start" && startClaim) {
        await env.DB
          .prepare(`
            update attention_activity_state
            set started = 1, fingerprint = ?, updated_at = ?
            where user_id = ? and device_id = ? and activity_id = ?
              and started = 0 and fingerprint = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `)
          .bind(
            deviceFingerprint,
            new Date().toISOString(),
            userId,
            device.device_id,
            activityId,
            startClaim,
            userId,
            device.device_id,
            device.generation,
          )
          .run();
      } else {
        await env.DB.prepare(`
          insert into attention_activity_state(
            user_id, device_id, activity_id, started, fingerprint, updated_at
          )
          select ?, ?, ?, 1, ?, ?
          where exists (
            select 1
            from attention_devices
            where user_id = ? and device_id = ? and generation = ?
          )
          on conflict(user_id, device_id, activity_id) do update set
            started = 1,
            fingerprint = excluded.fingerprint,
            updated_at = excluded.updated_at
        `).bind(
          userId,
          device.device_id,
          activityId,
          deviceFingerprint,
          new Date().toISOString(),
          userId,
          device.device_id,
          device.generation,
        ).run();
      }
    } else {
      if (startClaim) {
        await releaseAccountLiveActivityStart(
          env,
          userId,
          device.device_id,
          activityId,
          startClaim,
          device.generation,
        );
      }
      if (result.tokenInvalid && event === "start") {
        await env.DB
          .prepare(`
            update attention_devices
            set push_to_start_token = null
            where user_id = ? and device_id = ? and generation = ?
          `)
          .bind(userId, device.device_id, device.generation)
          .run();
      } else if (result.tokenInvalid) {
        await env.DB.batch([
          env.DB.prepare(`
            delete from attention_activity_tokens
            where user_id = ? and device_id = ? and activity_id = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `).bind(
            userId,
            device.device_id,
            activityId,
            userId,
            device.device_id,
            device.generation,
          ),
          env.DB.prepare(`
            delete from attention_activity_state
            where user_id = ? and device_id = ? and activity_id = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `).bind(
            userId,
            device.device_id,
            activityId,
            userId,
            device.device_id,
            device.generation,
          ),
        ]);
      }
    }
  }
}

/**
 * The pure derivation behind `deliverAccountLiveActivity`, exposed only so relay
 * tests can cover it directly. Nothing in `src/` imports these — keeping them
 * off the module's public surface is what makes `deliverAccountLiveActivity` the
 * single entry point this file documents.
 */
export const liveActivityTestInternals = Object.freeze({
  accountActivityContentState,
  activityPullRequest,
  activityBoardColumn,
  activityRun,
  activityStateGroup,
  privacyPreservingActivityContentState,
});
