import {
  sendApnsPush,
  type ApnsEnvironment,
  type ApnsSendResult,
} from "./apns";
import {
  AttentionAuthVerificationUnavailableError,
  inspectAttentionAuthConfiguration,
  verifyAttentionBearerToken,
} from "./attentionAuth";
import {
  apnsConfig,
  boundedText,
  isRecord,
  json,
  logAttentionDeliveryError,
  optionalIsoDate,
  preferenceBoolean,
  preferenceNumber,
  readPreferences,
  requiredString,
  MAX_DETAIL_LENGTH,
  MAX_PREVIEW_LENGTH,
  MAX_TITLE_LENGTH,
  type AttentionDeviceRow,
  type AttentionRelayEnv,
  type ParsedAttentionItem,
} from "./attentionShared";
import { deliverAccountLiveActivity } from "./liveActivity";
export {
  inspectAttentionAuthConfiguration,
  type AttentionAuthConfigurationStatus,
} from "./attentionAuth";
export type { AttentionRelayEnv } from "./attentionShared";

type AttentionItemRow = {
  payload_json: string;
  seen_at: string | null;
  dismissed_at: string | null;
  account_revision: number;
};

type AttentionTombstoneRow = {
  item_id: string;
  source_revision: number;
  account_revision: number;
  deleted_at: string;
};

type IncomingAttentionTombstone = {
  id: string;
  revision: number;
  revivable: boolean;
};

type AttentionDeviceOwnershipRow = {
  device_id: string;
  user_id: string;
  ownership_epoch: number;
  apns_token: string | null;
};

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ATTENTION_ITEMS = 64;
const MAX_ATTENTION_TOMBSTONES = 64;
const MAX_ATTENTION_DEVICES = 32;
const MAX_ATTENTION_MACHINE_PREFERENCES = 64;
const MAX_ACCOUNT_ATTENTION_ITEMS = 2_000;
const ATTENTION_DEVICE_LEASE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_NOTIFICATION_ATTEMPTS_PER_PUBLISH = 64;
const APNS_TOKEN_PATTERN = /^[a-f0-9]{32,512}$/i;
const ACCOUNT_MACHINE_ONLINE_WINDOW_MS = 90_000;
const DEFAULT_DESKTOP_ESCALATION_DELAY_SECONDS = 30;
const DESKTOP_PRESENCE_WINDOW_MS = 45_000;
const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_OWNERSHIP_EPOCH_FUTURE_MS = 5 * 60 * 1_000;
const NOTIFICATION_DELIVERY_CLAIM_TTL_MS = 60_000;
const MAX_ALERT_AGE_MS = 15 * 60_000;
const ATTENTION_DELIVERY_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const ATTENTION_ALERT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
// A machine that has not published for this long is treated as gone: its rows
// can no longer be swept by the epoch reconcile (that only runs when the owning
// machine publishes), so the account-level sweep retires them instead. This is
// the only relief for a rotated machine key, whose old identity never returns.
const ORPHANED_MACHINE_ACTIVITY_MS = 14 * 24 * 60 * 60 * 1_000;
// Each swept account costs a revision commit (and an aggregate Live Activity
// refresh, i.e. an outbound APNs fetch per device), so a pass stays small and
// the backlog drains over later passes. The sweeps run from the hourly cron
// only — see `sweepAttentionState` — so 25 accounts an hour is the drain rate.
const MAX_SWEPT_ACCOUNTS_PER_PRUNE = 25;

const EVENT_KINDS = new Set([
  "agent_running",
  "agent_needs_you",
  "agent_failed",
  "agent_completed",
  "pr_checks_failing",
  "pr_review_requested",
  "pr_changes_requested",
  "pr_merge_ready",
  "pr_merged",
  "pr_opened",
  "pr_closed",
]);

const PHASES = new Set([
  "starting",
  "running",
  "needs_you",
  "blocked",
  "failed",
  "completed",
  "stale",
  "checks_failing",
  "review_requested",
  "changes_requested",
  "merge_ready",
  "open",
  "merged",
  "closed",
]);

const ACTION_KINDS = new Set([
  "approve",
  "deny",
  "answer",
  "restart",
  "rerun_checks",
  "mark_seen",
  "dismiss",
  "open",
]);

const PR_TABS = new Set(["overview", "activity", "checks", "files"]);

const DEFAULT_NOTIFY_EVENTS = new Set([
  "agent_needs_you",
  "agent_failed",
  "pr_checks_failing",
  "pr_review_requested",
  "pr_changes_requested",
  "pr_merge_ready",
]);

function deepLinkForItem(item: ParsedAttentionItem): string | null {
  const destination = item.destination;
  if (!isRecord(destination)) return null;
  const accountMachineKey = requiredString(item.machine.accountMachineKey, 128);
  if (destination.kind === "session") {
    const sessionId = requiredString(destination.sessionId);
    if (!sessionId) return null;
    const query = new URLSearchParams();
    const itemId = requiredString(destination.itemId);
    const eventId = requiredString(destination.eventId);
    if (itemId) query.set("item", itemId);
    if (eventId) query.set("event", eventId);
    if (accountMachineKey) query.set("accountMachineKey", accountMachineKey);
    return `ade://session/${encodeURIComponent(sessionId)}${query.size ? `?${query}` : ""}`;
  }
  if (destination.kind === "pull_request") {
    const number = Number(destination.number);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    const owner = requiredString(destination.repoOwner);
    const repo = requiredString(destination.repoName);
    const tab = requiredString(destination.tab, 32);
    const query = new URLSearchParams();
    if (tab && tab !== "overview") query.set("tab", tab);
    if (accountMachineKey) query.set("accountMachineKey", accountMachineKey);
    const suffix = query.size ? `?${query}` : "";
    return owner && repo
      ? `ade://pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}${suffix}`
      : `ade://pr/${number}${suffix}`;
  }
  return null;
}

function attentionAlertRoutingPayload(
  item: ParsedAttentionItem,
  deepLink: string | null,
): Record<string, unknown> {
  const accountMachineKey = requiredString(item.machine.accountMachineKey, 128);
  return {
    attentionItemId: item.id,
    eventKind: item.eventKind,
    ...(accountMachineKey ? { accountMachineKey } : {}),
    ...(deepLink ? { deepLink } : {}),
    ...(isRecord(item.destination) && typeof item.destination.sessionId === "string"
      ? { sessionId: item.destination.sessionId }
      : {}),
    ...(isRecord(item.destination) && typeof item.destination.itemId === "string"
      ? { itemId: item.destination.itemId }
      : {}),
  };
}

function desktopEscalationDelayMs(accountPreferences: Record<string, unknown>): number {
  return Math.max(
    0,
    Math.min(
      300,
      Math.round(preferenceNumber(
        {},
        accountPreferences,
        "desktopFirstDelaySeconds",
        DEFAULT_DESKTOP_ESCALATION_DELAY_SECONDS,
      )),
    ),
  ) * 1_000;
}

function normalizedSnapshotCursor(
  requestedSince: number,
  headRevision: number,
  requestedStreamId?: string | null,
  currentStreamId?: string | null,
): number {
  const requested = Math.max(0, Math.trunc(requestedSince) || 0);
  const head = Math.max(0, Math.trunc(headRevision) || 0);
  if (
    requestedStreamId
    && currentStreamId
    && requestedStreamId.trim() !== currentStreamId.trim()
  ) {
    return 0;
  }
  return requested > head ? 0 : requested;
}

function attentionFullSnapshotUnchanged(
  existing: Array<{ item_id: string; source_revision: number; fingerprint: string }>,
  incoming: Array<{ id: string; revision: number; fingerprint: string }>,
  tombstoneCount: number,
): boolean {
  if (tombstoneCount > 0 || existing.length !== incoming.length) return false;
  const existingById = new Map(existing.map((item) => [item.item_id, item]));
  return incoming.every((item) => {
    const current = existingById.get(item.id);
    return (
      current != null
      && Number(current.source_revision) === item.revision
      && current.fingerprint === item.fingerprint
    );
  });
}

function implicitFullSnapshotTombstone(
  item: { item_id: string; source_revision: number },
  incomingItemCount: number,
): IncomingAttentionTombstone {
  return {
    id: item.item_id,
    revision: Math.max(0, Number(item.source_revision) || 0),
    // A full snapshot at the transport ceiling cannot distinguish a true
    // removal from an item displaced by a higher-priority row. Keep that
    // omission revivable until a later below-capacity snapshot confirms it.
    revivable: incomingItemCount === MAX_ATTENTION_ITEMS,
  };
}

function attentionTombstoneBlocksItem(
  tombstone: { source_revision: number; revivable: number },
  itemRevision: number,
): boolean {
  return Number(tombstone.revivable) !== 1
    && Number(tombstone.source_revision) >= itemRevision;
}

function upsertAttentionTombstoneStatement(
  env: AttentionRelayEnv,
  args: {
    userId: string;
    itemId: string;
    sourceRevision: number;
    accountRevision: number | null;
    deletedAt: string;
    revivable: boolean;
  },
): D1PreparedStatement {
  return env.DB.prepare(`
    insert into attention_tombstones(
      user_id, item_id, source_revision, account_revision, revivable, deleted_at
    )
    values (
      ?, ?, ?,
      coalesce(
        ?,
        (select revision from attention_revisions where user_id = ?)
      ),
      ?, ?
    )
    on conflict(user_id, item_id) do update set
      source_revision = excluded.source_revision,
      account_revision = excluded.account_revision,
      revivable = case
        when excluded.source_revision > attention_tombstones.source_revision
          then excluded.revivable
        else min(attention_tombstones.revivable, excluded.revivable)
      end,
      deleted_at = excluded.deleted_at
    where excluded.source_revision >= attention_tombstones.source_revision
  `).bind(
    args.userId,
    args.itemId,
    args.sourceRevision,
    args.accountRevision,
    args.userId,
    args.revivable ? 1 : 0,
    args.deletedAt,
  );
}

async function upsertAttentionTombstone(
  env: AttentionRelayEnv,
  args: {
    userId: string;
    itemId: string;
    sourceRevision: number;
    accountRevision: number;
    deletedAt: string;
    revivable: boolean;
  },
): Promise<void> {
  await upsertAttentionTombstoneStatement(env, args).run();
}

function sealCapacityTombstonesStatement(
  env: AttentionRelayEnv,
  userId: string,
  machineKey: string,
): D1PreparedStatement {
  return env.DB.prepare(`
    update attention_tombstones
    set revivable = 0
    where user_id = ?
      and revivable = 1
      and (
        item_id like ?
        or item_id like ?
      )
  `).bind(
    userId,
    `agent:${machineKey}:%`,
    `pull-request:${machineKey}:%`,
  );
}

async function sealCapacityTombstones(
  env: AttentionRelayEnv,
  userId: string,
  machineKey: string,
): Promise<void> {
  await sealCapacityTombstonesStatement(env, userId, machineKey).run();
}

function attentionItemUpsertStatement(
  env: AttentionRelayEnv,
  userId: string,
  machineKey: string,
  item: ParsedAttentionItem,
  rosterEpoch: number,
): D1PreparedStatement {
  return env.DB.prepare(`
    insert into attention_items(
      user_id, item_id, machine_key, source_revision, account_revision,
      fingerprint, content_fingerprint, alert_fingerprint, activity_tier,
      roster_epoch, event_kind, phase, payload_json, seen_at, dismissed_at,
      expires_at, updated_at
    )
    select ?, ?, ?, ?, revision, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?
    from attention_revisions
    where user_id = ?
      and not exists (
        select 1
        from attention_tombstones
        where user_id = ? and item_id = ?
          and revivable != 1
          and source_revision >= ?
      )
    on conflict(user_id, item_id) do update set
      machine_key = excluded.machine_key,
      source_revision = excluded.source_revision,
      account_revision = excluded.account_revision,
      fingerprint = excluded.fingerprint,
      content_fingerprint = excluded.content_fingerprint,
      alert_fingerprint = excluded.alert_fingerprint,
      activity_tier = excluded.activity_tier,
      roster_epoch = excluded.roster_epoch,
      event_kind = excluded.event_kind,
      phase = excluded.phase,
      payload_json = excluded.payload_json,
      seen_at = case
        when coalesce(attention_items.alert_fingerprint, attention_items.fingerprint)
          = excluded.alert_fingerprint
          then attention_items.seen_at
        else null
      end,
      dismissed_at = case
        when coalesce(attention_items.alert_fingerprint, attention_items.fingerprint)
          = excluded.alert_fingerprint
          then attention_items.dismissed_at
        else null
      end,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    where excluded.source_revision >= attention_items.source_revision
  `).bind(
    userId,
    item.id,
    machineKey,
    item.revision,
    item.contentFingerprint,
    item.contentFingerprint,
    item.alertFingerprint,
    item.activityTier ?? null,
    rosterEpoch,
    item.eventKind,
    item.phase,
    JSON.stringify(item),
    item.expiresAt,
    item.updatedAt,
    userId,
    userId,
    item.id,
    item.revision,
  );
}

function attentionItemTombstoneDeleteStatement(
  env: AttentionRelayEnv,
  userId: string,
  item: ParsedAttentionItem,
): D1PreparedStatement {
  return env.DB.prepare(`
    delete from attention_tombstones
    where user_id = ? and item_id = ?
      and (revivable = 1 or source_revision < ?)
  `).bind(userId, item.id, item.revision);
}

function attentionTombstoneUpsertForCurrentRevisionStatement(
  env: AttentionRelayEnv,
  args: {
    userId: string;
    machineKey: string;
    itemId: string;
    sourceRevision: number;
    deletedAt: string;
    revivable: boolean;
  },
): D1PreparedStatement {
  return env.DB.prepare(`
    insert into attention_tombstones(
      user_id, item_id, source_revision, account_revision, revivable, deleted_at
    )
    select ?, ?, ?, revision, ?, ?
    from attention_revisions
    where user_id = ?
      and not exists (
        select 1
        from attention_items
        where user_id = ? and machine_key = ? and item_id = ?
          and source_revision > ?
      )
    on conflict(user_id, item_id) do update set
      source_revision = excluded.source_revision,
      account_revision = excluded.account_revision,
      revivable = case
        when excluded.source_revision > attention_tombstones.source_revision
          then excluded.revivable
        else min(attention_tombstones.revivable, excluded.revivable)
      end,
      deleted_at = excluded.deleted_at
    where excluded.source_revision >= attention_tombstones.source_revision
  `).bind(
    args.userId,
    args.itemId,
    args.sourceRevision,
    args.revivable ? 1 : 0,
    args.deletedAt,
    args.userId,
    args.userId,
    args.machineKey,
    args.itemId,
    args.sourceRevision,
  );
}

async function commitAttentionMachineChanges(
  env: AttentionRelayEnv,
  args: {
    userId: string;
    machineKey: string;
    items: ParsedAttentionItem[];
    tombstones: IncomingAttentionTombstone[];
    sealCapacityTombstones: boolean;
    rosterEpoch?: number;
    now: string;
  },
): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  for (const item of args.items) {
    statements.push(
      attentionItemUpsertStatement(
        env,
        args.userId,
        args.machineKey,
        item,
        args.rosterEpoch ?? 0,
      ),
      attentionItemTombstoneDeleteStatement(env, args.userId, item),
    );
  }
  if (args.sealCapacityTombstones) {
    statements.push(
      sealCapacityTombstonesStatement(env, args.userId, args.machineKey),
    );
  }
  for (const tombstone of args.tombstones) {
    statements.push(
      env.DB
        .prepare(`
          delete from attention_items
          where user_id = ? and machine_key = ? and item_id = ? and source_revision <= ?
        `)
        .bind(args.userId, args.machineKey, tombstone.id, tombstone.revision),
      attentionTombstoneUpsertForCurrentRevisionStatement(env, {
        userId: args.userId,
        machineKey: args.machineKey,
        itemId: tombstone.id,
        sourceRevision: tombstone.revision,
        deletedAt: args.now,
        revivable: tombstone.revivable,
      }),
    );
  }
  return commitAttentionRevision(env, args.userId, statements, args.now);
}

async function commitActivityReconcileFinal(
  env: AttentionRelayEnv,
  args: {
    userId: string;
    machineKey: string;
    rosterEpoch: number;
    now: string;
  },
): Promise<number> {
  return commitAttentionRevision(env, args.userId, [
    env.DB.prepare(`
      insert into attention_tombstones(
        user_id, item_id, source_revision, account_revision, revivable, deleted_at
      )
      select user_id, item_id, source_revision,
        (select revision from attention_revisions where user_id = ?), 0, ?
      from attention_items
      where user_id = ? and machine_key = ? and roster_epoch < ?
      on conflict(user_id, item_id) do update set
        source_revision = excluded.source_revision,
        account_revision = excluded.account_revision,
        revivable = 0,
        deleted_at = excluded.deleted_at
      where excluded.source_revision >= attention_tombstones.source_revision
    `).bind(
      args.userId,
      args.now,
      args.userId,
      args.machineKey,
      args.rosterEpoch,
    ),
    env.DB.prepare(`
      delete from attention_items
      where user_id = ? and machine_key = ? and roster_epoch < ?
    `).bind(args.userId, args.machineKey, args.rosterEpoch),
  ], args.now);
}

function accountMachineActivityTombstoneStatement(
  env: AttentionRelayEnv,
  args: { userId: string; machineKey: string; now: string },
): D1PreparedStatement {
  // Same statement `commitActivityReconcileFinal` uses to seal a roster sweep,
  // minus the epoch predicate: an account-level removal retires every row the
  // machine owns, not just the ones a newer roster left behind.
  return env.DB.prepare(`
    insert into attention_tombstones(
      user_id, item_id, source_revision, account_revision, revivable, deleted_at
    )
    select user_id, item_id, source_revision,
      (select revision from attention_revisions where user_id = ?), 0, ?
    from attention_items
    where user_id = ? and machine_key = ?
    on conflict(user_id, item_id) do update set
      source_revision = excluded.source_revision,
      account_revision = excluded.account_revision,
      revivable = 0,
      deleted_at = excluded.deleted_at
    where excluded.source_revision >= attention_tombstones.source_revision
  `).bind(args.userId, args.now, args.userId, args.machineKey);
}

type AccountMachinePurgeResult = {
  revision: number;
  removedItems: number;
};

/**
 * DELIVERY TARGETS LEAVE WITH THE OWNERSHIP.
 *
 * The legacy machine-signed routes (`/machines/<key>/publish`,
 * `/machines/<key>/live-activity-tokens`) deliver out of one table set keyed by
 * MACHINE KEY ALONE — `device_registrations` and `live_activity_tokens` carry no
 * account id, so they keep pointing at whichever phones last registered through
 * that machine no matter who owns it now. `machineKeyRevokedAt` is the only
 * server-side gate on those routes, which makes every path that legitimately
 * clears a revocation (an ownership transfer in `linkMachineToAccount`, the
 * directory's deliberate re-pair) a path that would otherwise hand a machine its
 * PREVIOUS owner's phones back: arbitrary alert text and Live Activity frames,
 * plus the ability to re-arm Live Activity tokens against them.
 *
 * So the rows are dropped at both ends of a change of ownership — when the
 * machine is removed from an account (below) and again when the key links to a
 * different account — leaving no window in which a cleared revocation exposes
 * targets the machine no longer has any claim to. Devices only ever enter these
 * tables by registering through the machine, so the new owner's phones come back
 * on their next launch and nothing legitimate is lost.
 *
 * `publish_suppression` goes with them: it is per-machine dedupe state keyed by
 * the device ids that just left, and keeping it would let a stale content hash
 * silently swallow the first publish to a re-registered device.
 */
function legacyMachineDeliveryPurgeStatements(
  env: AttentionRelayEnv,
  machineKey: string,
): D1PreparedStatement[] {
  return [
    env.DB
      .prepare("delete from device_registrations where machine_key = ?")
      .bind(machineKey),
    env.DB
      .prepare("delete from live_activity_tokens where machine_key = ?")
      .bind(machineKey),
    env.DB
      .prepare("delete from publish_suppression where machine_key = ?")
      .bind(machineKey),
  ];
}

/**
 * Retire everything one machine owns on an account in a single revision:
 * tombstone + delete its items, drop its presence link, and release the
 * installs it seeded. Removing a machine from the account directory is the
 * caller; the epoch reconcile cannot do this job because it only runs while the
 * machine is still publishing, and a removed machine never publishes again.
 *
 * `revoke` records the removal so the still-signed-in machine cannot publish
 * itself back in — a purge without it (the staleness sweep) leaves the machine
 * free to return on its own. It also drops the machine's legacy delivery rows
 * (see `legacyMachineDeliveryPurgeStatements`): a removal ends this account's
 * relationship with the machine, so the account's phones must stop being
 * reachable through it immediately, not only once something clears the
 * revocation. The staleness sweep passes `revoke: false` precisely because the
 * machine was never removed — it just went quiet — so its own devices stay.
 */
async function purgeAccountMachineActivity(
  env: AttentionRelayEnv,
  args: {
    userId: string;
    machineKey: string;
    now: string;
    revoke: boolean;
  },
): Promise<AccountMachinePurgeResult> {
  const removedItemsRow = await env.DB.prepare(`
    select count(*) as count
    from attention_items
    where user_id = ? and machine_key = ?
  `).bind(args.userId, args.machineKey).first<{ count: number }>();
  const statements: D1PreparedStatement[] = [
    accountMachineActivityTombstoneStatement(env, args),
    env.DB
      .prepare("delete from attention_items where user_id = ? and machine_key = ?")
      .bind(args.userId, args.machineKey),
    env.DB
      .prepare("delete from attention_machine_links where user_id = ? and machine_key = ?")
      .bind(args.userId, args.machineKey),
  ];
  if (args.revoke) {
    statements.push(env.DB.prepare(`
      insert into attention_revoked_machines(user_id, machine_key, revoked_at)
      values (?, ?, ?)
      on conflict(user_id, machine_key) do update set
        revoked_at = excluded.revoked_at
    `).bind(args.userId, args.machineKey, args.now));
    statements.push(...legacyMachineDeliveryPurgeStatements(env, args.machineKey));
  }
  const revision = await commitAttentionRevision(
    env,
    args.userId,
    statements,
    args.now,
  );

  // Installs this machine seeded are its property: they were imported from the
  // machine's own legacy registrations, so they leave with it. Ownership rows
  // are deactivated rather than dropped so a delayed request from the removed
  // machine cannot reclaim the installation.
  const ownedDevices = await env.DB
    .prepare("select device_id from attention_devices where user_id = ? and source_machine_key = ?")
    .bind(args.userId, args.machineKey)
    .all<{ device_id: string }>();
  for (const device of ownedDevices.results) {
    await deleteAttentionDeviceOwnership(env, args.userId, device.device_id);
  }
  // Devices that stay on the account still show an aggregate that just lost
  // this machine's rows; refresh it in the same request.
  await deliverAccountLiveActivity(env, args.userId);
  return {
    revision,
    removedItems: Number(removedItemsRow?.count ?? 0),
  };
}

async function accountMachineRevokedAt(
  env: AttentionRelayEnv,
  userId: string,
  machineKey: string,
): Promise<string | null> {
  const row = await env.DB
    .prepare(`
      select revoked_at
      from attention_revoked_machines
      where user_id = ? and machine_key = ?
      limit 1
    `)
    .bind(userId, machineKey)
    .first<{ revoked_at: string }>();
  return row?.revoked_at ?? null;
}

/**
 * Revocation lookup for the LEGACY machine-signed routes (`/machines/<key>/…`),
 * which authenticate a machine signature and carry no account id at all.
 *
 * `attention_revoked_machines` is keyed `(user_id, machine_key)`, so this asks a
 * deliberately different question than `accountMachineRevokedAt`: REVOKED ON ANY
 * ACCOUNT BLOCKS THE MACHINE KEY. Two reasons that is the right default here:
 *
 * 1. A machine key is machine identity, not account identity — it is minted per
 *    install and signs with a per-machine secret. "Some account de-authorized
 *    this physical machine" is therefore a statement about the machine.
 * 2. This is a de-authorization path. Over-blocking costs a re-pair (which the
 *    directory performs, clearing the row); under-blocking means a removed,
 *    stolen, or sold machine running an older or modified binary keeps pushing
 *    alerts and Live Activity frames to the owner's phone.
 *
 * Two paths clear a row so this never becomes a permanent brick:
 * `handleAccountMachinePairingRestore` (the directory's deliberate re-pair, for
 * the same account) and `linkMachineToAccount` (a completed ownership transfer,
 * which clears every account other than the one now publishing).
 *
 * Neither clear can reopen a channel to an account that lost the machine:
 * `legacyMachineDeliveryPurgeStatements` drops this machine key's
 * `device_registrations` / `live_activity_tokens` when it is removed from an
 * account and again, atomically with the clear, when it links to a different
 * one. This gate therefore blocks a de-authorized machine, and the purge makes
 * sure that even after the gate legitimately opens there is nothing of the
 * previous owner's left to deliver to.
 *
 * Cost is one indexed point lookup against a table that only ever holds removed
 * machines (see migration 0007 for the machine_key index).
 */
export async function machineKeyRevokedAt(
  env: AttentionRelayEnv,
  machineKey: string,
): Promise<string | null> {
  const row = await env.DB
    .prepare(`
      select revoked_at
      from attention_revoked_machines
      where machine_key = ?
      order by revoked_at desc
      limit 1
    `)
    .bind(machineKey)
    .first<{ revoked_at: string }>();
  return row?.revoked_at ?? null;
}

async function enforceActivityAccountItemCap(
  env: AttentionRelayEnv,
  userId: string,
  now: string,
): Promise<{ itemsTruncated: boolean; revision: number | null }> {
  const countRow = await env.DB.prepare(`
    select count(*) as count
    from attention_items
    where user_id = ?
  `).bind(userId).first<{ count: number }>();
  const overflow = Math.max(
    0,
    Number(countRow?.count ?? 0) - MAX_ACCOUNT_ATTENTION_ITEMS,
  );
  if (overflow === 0) return { itemsTruncated: false, revision: null };

  const evictionEligibleCountRow = await env.DB.prepare(`
    select count(*) as count
    from attention_items
    where user_id = ?
      and (activity_tier = 'idle' or activity_tier is null)
  `).bind(userId).first<{ count: number }>();
  const rowsToRemove = Math.min(
    overflow,
    Number(evictionEligibleCountRow?.count ?? 0),
  );
  if (rowsToRemove === 0) return { itemsTruncated: true, revision: null };

  const revision = await commitAttentionRevision(env, userId, [
    env.DB.prepare(`
      insert into attention_tombstones(
        user_id, item_id, source_revision, account_revision, revivable, deleted_at
      )
      select user_id, item_id, source_revision,
        (select revision from attention_revisions where user_id = ?), 0, ?
      from attention_items
      where user_id = ?
        and (activity_tier = 'idle' or activity_tier is null)
      order by case when activity_tier = 'idle' then 0 else 1 end,
        updated_at asc
      limit ?
      on conflict(user_id, item_id) do update set
        source_revision = excluded.source_revision,
        account_revision = excluded.account_revision,
        revivable = 0,
        deleted_at = excluded.deleted_at
      where excluded.source_revision >= attention_tombstones.source_revision
    `).bind(userId, now, userId, rowsToRemove),
    env.DB.prepare(`
      delete from attention_items
      where user_id = ? and item_id in (
        select item_id
        from attention_items
        where user_id = ?
          and (activity_tier = 'idle' or activity_tier is null)
        order by case when activity_tier = 'idle' then 0 else 1 end,
          updated_at asc
        limit ?
      )
    `).bind(userId, userId, rowsToRemove),
  ], now);
  return { itemsTruncated: true, revision };
}

function resolveActivityDeliveryPreferences(
  device: AttentionDeviceRow,
  item: ParsedAttentionItem,
  preferences: Record<string, unknown>,
): Record<string, unknown> {
  const registered = readPreferences(device.preferences_json);
  const account = isRecord(preferences.account) ? preferences.account : {};
  const projects = isRecord(preferences.projects) ? preferences.projects : {};
  const project = isRecord(projects[item.project.projectId])
    ? projects[item.project.projectId] as Record<string, unknown>
    : {};
  const machines = isRecord(preferences.machines) ? preferences.machines : {};
  const machine = isRecord(machines[item.machine.machineKey])
    ? machines[item.machine.machineKey] as Record<string, unknown>
    : {};
  const devices = isRecord(preferences.devices) ? preferences.devices : {};
  const explicitDevice = isRecord(devices[device.device_id])
    ? devices[device.device_id] as Record<string, unknown>
    : {};
  return { ...registered, ...account, ...project, ...machine, ...explicitDevice };
}

function resolvedMutedSessionIds(
  device: AttentionDeviceRow,
  preferences: Record<string, unknown>,
  devicePreferences: Record<string, unknown>,
): unknown {
  const explicitDevice = isRecord(devicePreferences[device.device_id])
    ? devicePreferences[device.device_id] as Record<string, unknown>
    : {};
  if (Array.isArray(explicitDevice.mutedSessionIds)) {
    return explicitDevice.mutedSessionIds;
  }
  if (Array.isArray(preferences.mutedSessionIds)) {
    return preferences.mutedSessionIds;
  }
  return readPreferences(device.preferences_json).mutedSessionIds;
}

function quietHoursActive(
  device: Record<string, unknown>,
  account: Record<string, unknown>,
  nowMs: number,
): boolean {
  const raw = isRecord(device.quietHours)
    ? device.quietHours
    : isRecord(account.quietHours)
      ? account.quietHours
      : null;
  if (!raw) return false;
  if (raw.enabled === false || device.quietHoursEnabled === false) return false;

  let startMinute = Number(raw.startMinute);
  let endMinute = Number(raw.endMinute);
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) {
    const parseClock = (value: unknown): number | null => {
      if (typeof value !== "string") return null;
      const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      return hour * 60 + minute;
    };
    const parsedStart = parseClock(raw.start);
    const parsedEnd = parseClock(raw.end);
    if (parsedStart === null || parsedEnd === null) return false;
    startMinute = parsedStart;
    endMinute = parsedEnd;
  }
  if (
    startMinute < 0
    || startMinute >= 24 * 60
    || endMinute < 0
    || endMinute >= 24 * 60
    || startMinute === endMinute
  ) {
    return false;
  }
  const timeZone = requiredString(raw.timeZone ?? raw.timezone, 120) ?? "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(nowMs));
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    const current = hour * 60 + minute;
    return startMinute < endMinute
      ? current >= startMinute && current < endMinute
      : current >= startMinute || current < endMinute;
  } catch {
    return false;
  }
}

function itemSessionId(item: ParsedAttentionItem): string | null {
  return item.destination.kind === "session"
    ? requiredString(item.destination.sessionId)
    : null;
}

function stringListIncludes(value: unknown, target: string | null): boolean {
  if (!target || !Array.isArray(value)) return false;
  return value.some((entry) => typeof entry === "string" && entry === target);
}

async function recentDesktopAttentionItemIds(
  env: AttentionRelayEnv,
  userId: string,
  nowMs: number,
): Promise<Set<string>> {
  const cutoff = new Date(nowMs - DESKTOP_PRESENCE_WINDOW_MS).toISOString();
  const rows = await env.DB.prepare(`
    select payload_json
    from attention_presence
    where user_id = ? and observed_at >= ?
  `).bind(userId, cutoff).all<{ payload_json: string }>();
  const visibleItemIds = new Set<string>();
  for (const row of rows.results) {
    const presence = readPreferences(row.payload_json);
    if (presence.platform !== "macOS" || presence.ambientSurfaceVisible !== true) continue;
    if (!Array.isArray(presence.visibleItemIds)) continue;
    for (const itemId of presence.visibleItemIds) {
      if (typeof itemId === "string" && itemId.trim()) visibleItemIds.add(itemId);
    }
  }
  return visibleItemIds;
}

async function claimAttentionNotificationDelivery(
  env: AttentionRelayEnv,
  args: {
    userId: string;
    itemId: string;
    deviceId: string;
    receiptState: string;
  },
): Promise<string | null> {
  const claimState = `pending:${args.receiptState}`;
  const claimNowMs = Date.now();
  const claim = `${new Date(claimNowMs).toISOString()}|${crypto.randomUUID()}`;
  const staleBefore = new Date(
    claimNowMs - NOTIFICATION_DELIVERY_CLAIM_TTL_MS,
  ).toISOString();
  const row = await env.DB.prepare(`
    insert into attention_delivery_receipts(
      user_id, item_id, device_id, state, delivered_at
    ) values (?, ?, ?, ?, ?)
    on conflict(user_id, item_id, device_id, state) do update set
      delivered_at = excluded.delivered_at
    where substr(attention_delivery_receipts.delivered_at, 1, 24) <= ?
    returning delivered_at
  `).bind(
    args.userId,
    args.itemId,
    args.deviceId,
    claimState,
    claim,
    staleBefore,
  ).first<{ delivered_at: string }>();
  return row?.delivered_at === claim ? claim : null;
}

async function releaseAttentionNotificationDelivery(
  env: AttentionRelayEnv,
  args: {
    userId: string;
    itemId: string;
    deviceId: string;
    receiptState: string;
    claim: string;
  },
): Promise<void> {
  await env.DB.prepare(`
    delete from attention_delivery_receipts
    where user_id = ? and item_id = ? and device_id = ?
      and state = ? and delivered_at = ?
  `).bind(
    args.userId,
    args.itemId,
    args.deviceId,
    `pending:${args.receiptState}`,
    args.claim,
  ).run();
}

async function deliverAttentionNotifications(
  env: AttentionRelayEnv,
  userId: string,
  items: ParsedAttentionItem[],
  sendPush: typeof sendApnsPush = sendApnsPush,
): Promise<void> {
  const config = apnsConfig(env);
  if (!config || items.length === 0) return;
  const [devicesResult, preferencesRow] = await Promise.all([
    env.DB.prepare(`
      select device_id, apns_token, bundle_id, aps_environment, preferences_json
      from attention_devices
      where user_id = ? and apns_token is not null and lease_expires_at > ?
    `).bind(userId, new Date().toISOString()).all<AttentionDeviceRow>(),
    env.DB
      .prepare("select payload_json from attention_preferences where user_id = ? limit 1")
      .bind(userId)
      .first<{ payload_json: string }>(),
  ]);
  if (devicesResult.results.length === 0) return;

  const preferences = readPreferences(preferencesRow?.payload_json);
  const accountPreferences = isRecord(preferences.account) ? preferences.account : {};
  const devicePreferences = isRecord(preferences.devices) ? preferences.devices : {};
  const nowMs = Date.now();
  const desktopVisibleItemIds = await recentDesktopAttentionItemIds(env, userId, nowMs);
  const desktopFirstEnabled = preferenceBoolean(
    {},
    accountPreferences,
    "desktopFirstEnabled",
    true,
  );
  const desktopFirstDelayMs = desktopEscalationDelayMs(accountPreferences);
  let notificationAttempts = 0;

  for (const item of items) {
    if (item.activityTier && item.activityTier !== "signal") continue;
    if (nowMs - Date.parse(item.updatedAt) > MAX_ALERT_AGE_MS) continue;
    const current = await env.DB
      .prepare(`
        select source_revision, fingerprint,
          coalesce(alert_fingerprint, fingerprint) as alert_fingerprint,
          seen_at, dismissed_at
        from attention_items
        where user_id = ? and item_id = ?
        limit 1
      `)
      .bind(userId, item.id)
      .first<{
        source_revision: number;
        fingerprint: string;
        alert_fingerprint: string;
        seen_at: string | null;
        dismissed_at: string | null;
      }>();
    // The atomic publish may intentionally reject a stale item or an item
    // blocked by a sealed tombstone. Only the exact row that committed is
    // eligible to notify; otherwise an ignored inbound payload could still
    // produce a phone alert.
    if (
      !current
      || Number(current.source_revision) !== item.revision
      || current.fingerprint !== item.contentFingerprint
      || current.alert_fingerprint !== item.alertFingerprint
      || current.seen_at
      || current.dismissed_at
    ) {
      continue;
    }
    // Give a desktop surface that actually contains this item the first chance
    // to surface it. A merely foreground ADE window is not enough: the header,
    // full center, or native notch must report the exact visible item.
    // The machine heartbeat republishes the full snapshot every 30s; if the
    // item remains unseen, the next pass escalates it to the phone.
    if (
      desktopFirstEnabled
      && desktopVisibleItemIds.has(item.id)
      && nowMs - Date.parse(item.updatedAt) < desktopFirstDelayMs
    ) {
      continue;
    }

    const deepLink = deepLinkForItem(item);
    for (const device of devicesResult.results) {
      if (notificationAttempts >= MAX_NOTIFICATION_ATTEMPTS_PER_PUBLISH) return;
      if (!device.apns_token) continue;
      const override = resolveActivityDeliveryPreferences(
        device,
        item,
        preferences,
      );
      const eventPolicies = isRecord(override.eventPolicies)
        ? override.eventPolicies
        : {};
      const policy = typeof eventPolicies[item.eventKind] === "string"
        ? eventPolicies[item.eventKind]
        : DEFAULT_NOTIFY_EVENTS.has(item.eventKind)
          ? "notify"
          : "ambient";
      if (policy !== "notify") continue;
      const notificationsEnabled = preferenceBoolean(
        override,
        {},
        "notificationsEnabled",
        typeof override.enabled === "boolean" ? override.enabled : true,
      );
      if (
        !notificationsEnabled
        || quietHoursActive(override, accountPreferences, nowMs)
        || stringListIncludes(
          resolvedMutedSessionIds(device, preferences, devicePreferences),
          itemSessionId(item),
        )
      ) {
        continue;
      }
      const receiptState = `alert:${item.alertFingerprint.slice(0, 48)}`;
      const existing = await env.DB.prepare(`
        select 1 as found from (
          select 1
          from attention_delivery_receipts
          where user_id = ? and item_id = ? and device_id = ? and state = ?
          union all
          select 1
          from attention_alert_log
          where user_id = ? and alert_fingerprint = ? and device_id = ?
        )
        limit 1
      `).bind(
        userId,
        item.id,
        device.device_id,
        receiptState,
        userId,
        item.alertFingerprint,
        device.device_id,
      ).first<{ found: number }>();
      if (existing?.found) continue;
      const deliveryClaim = await claimAttentionNotificationDelivery(env, {
        userId,
        itemId: item.id,
        deviceId: device.device_id,
        receiptState,
      });
      if (!deliveryClaim) continue;

      const hideDetails = preferenceBoolean(override, accountPreferences, "hideDetails", false);
      const soundsEnabled = preferenceBoolean(override, accountPreferences, "soundsEnabled", false);
      const body = hideDetails
        ? boundedText(item.privacyPreview, MAX_PREVIEW_LENGTH)
        : boundedText(item.preview, MAX_PREVIEW_LENGTH);
      let result: ApnsSendResult;
      try {
        result = await sendPush(config, {
          environment: device.aps_environment as ApnsEnvironment,
          deviceToken: device.apns_token,
          topic: device.bundle_id || env.APNS_DEFAULT_TOPIC?.trim() || "",
          pushType: "alert",
          priority: 10,
          expiration: Math.floor(nowMs / 1_000) + 24 * 60 * 60,
          collapseId: item.id,
          payload: {
            aps: {
              alert: {
                title: notificationTitle(item, hideDetails),
                ...(body ? { body } : {}),
              },
              ...(soundsEnabled ? { sound: "default" } : {}),
              // Wakes the app for a background snapshot refresh alongside the
              // visible alert; foreground polling remains the guaranteed path.
              "content-available": 1,
              "thread-id": item.id,
              "interruption-level": item.eventKind === "agent_needs_you"
                ? "time-sensitive"
                : "active",
            },
            ...attentionAlertRoutingPayload(item, deepLink),
          },
        });
      } catch (error) {
        notificationAttempts += 1;
        await releaseAttentionNotificationDelivery(env, {
          userId,
          itemId: item.id,
          deviceId: device.device_id,
          receiptState,
          claim: deliveryClaim,
        });
        logAttentionDeliveryError("notification", device.device_id, error);
        continue;
      }
      notificationAttempts += 1;
      if (result.ok) {
        await env.DB.batch([
          env.DB.prepare(`
            insert into attention_delivery_receipts(
              user_id, item_id, device_id, state, delivered_at
            )
            values (?, ?, ?, ?, ?)
            on conflict(user_id, item_id, device_id, state) do nothing
          `).bind(
            userId,
            item.id,
            device.device_id,
            receiptState,
            new Date(nowMs).toISOString(),
          ),
          env.DB.prepare(`
            insert into attention_alert_log(
              user_id, alert_fingerprint, device_id, delivered_at
            ) values (?, ?, ?, ?)
            on conflict(user_id, alert_fingerprint, device_id) do nothing
          `).bind(
            userId,
            item.alertFingerprint,
            device.device_id,
            new Date(nowMs).toISOString(),
          ),
          env.DB.prepare(`
            delete from attention_delivery_receipts
            where user_id = ? and item_id = ? and device_id = ?
              and state = ? and delivered_at = ?
          `).bind(
            userId,
            item.id,
            device.device_id,
            `pending:${receiptState}`,
            deliveryClaim,
          ),
        ]);
      } else {
        await releaseAttentionNotificationDelivery(env, {
          userId,
          itemId: item.id,
          deviceId: device.device_id,
          receiptState,
          claim: deliveryClaim,
        });
      }
      if (!result.ok && result.tokenInvalid) {
        await env.DB.prepare(`
          update attention_devices
          set apns_token = null, updated_at = ?
          where user_id = ? and device_id = ? and apns_token = ?
        `).bind(
          new Date(nowMs).toISOString(),
          userId,
          device.device_id,
          device.apns_token,
        ).run();
      }
    }
  }
}

function notificationTitle(item: ParsedAttentionItem, hideDetails: boolean): string {
  if (!hideDetails) return boundedText(item.title, MAX_TITLE_LENGTH) ?? "ADE needs you";
  return item.kind === "pull_request" ? "ADE pull request update" : "ADE agent update";
}

/** Length-independent comparison so a wrong secret leaks no timing signal. */
function secretsMatch(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Prove a request came from the account-directory worker, not merely from
 * something holding a valid account token.
 *
 * The revocation design (migrations 0004/0006) rests on one fact: A REMOVED
 * MACHINE KEEPS A VALID ACCOUNT TOKEN until the user signs it out. Every other
 * account route is safe under that assumption because a user token can only
 * ever act on the user's own data. The re-pair route is not: it CLEARS a
 * revocation, so a bearer token is exactly the credential the attacker already
 * has. Without this gate a removed, stolen, or sold machine POSTs its own
 * `/pairing`, un-revokes itself, and resumes publishing agent titles and
 * previews into the account feed — while the directory roster row stays deleted
 * so the user never sees it listed.
 *
 * A shared secret header is the only provenance the relay can actually verify.
 * A Cloudflare service binding leaves no attestable marker on the inbound
 * request (nothing distinguishes it from a public-edge call), so the binding is
 * a transport choice on the directory side; the directory sends this header
 * over either transport. Unset secret fails closed with 503, never open.
 */
function assertDirectoryProvenance(
  request: Request,
  env: AttentionRelayEnv,
): { ok: true } | { response: Response } {
  const expected = env.DIRECTORY_AUTH_SECRET?.trim();
  if (!expected) {
    return {
      response: json({
        ok: false,
        error: "directory authentication unavailable",
        code: "directory_auth_unavailable",
        recovery: "DIRECTORY_AUTH_SECRET must be configured on the relay by the ADE service owner.",
      }, { status: 503 }),
    };
  }
  const presented = request.headers.get("x-ade-directory-auth")?.trim();
  if (!presented || !secretsMatch(presented, expected)) {
    return {
      response: json({
        ok: false,
        error: "directory provenance required",
        code: "directory_auth_required",
        recovery: "Pair this machine from ADE's account settings; a machine cannot restore its own pairing.",
      }, { status: 403 }),
    };
  }
  return { ok: true };
}

async function authorizedUser(
  request: Request,
  env: AttentionRelayEnv,
): Promise<{ userId: string } | { response: Response }> {
  const configuration = inspectAttentionAuthConfiguration(env);
  if (!configuration.configured) {
    return {
      response: json(
        {
          ok: false,
          error: "account authentication unavailable",
          code: "account_auth_unavailable",
          recovery: "Relay authentication must be configured by the ADE service owner.",
        },
        { status: 503 },
      ),
    };
  }
  let userId: string | null;
  try {
    userId = await verifyAttentionBearerToken(request, env);
  } catch (error) {
    if (error instanceof AttentionAuthVerificationUnavailableError) {
      return {
        response: json(
          {
            ok: false,
            error: "account authentication unavailable",
            code: "account_auth_unavailable",
            recovery: "ADE's account verifier is temporarily unreachable. Retry shortly.",
          },
          { status: 503 },
        ),
      };
    }
    throw error;
  }
  return userId
    ? { userId }
    : {
        response: json(
          {
            ok: false,
            error: "account token rejected",
            code: "account_token_rejected",
            recovery: "Refresh the ADE account session and try again.",
          },
          { status: 401 },
        ),
      };
}

function parseAttentionItem(value: unknown, machineKey: string): ParsedAttentionItem | null {
  if (!isRecord(value) || value.contractVersion !== 1) return null;
  const id = requiredString(value.id);
  const revision = Number(value.revision);
  const fingerprint = requiredString(value.fingerprint);
  const contentFingerprint = value.contentFingerprint == null
    ? fingerprint
    : requiredString(value.contentFingerprint);
  const alertFingerprint = value.alertFingerprint == null
    ? fingerprint
    : requiredString(value.alertFingerprint);
  const activityTier = value.activityTier == null ? undefined : value.activityTier;
  // Deliberately lenient rather than rejecting: this is an additive field a
  // newer publisher may widen. Anything that is not the single known literal is
  // treated as absent, which degrades to the phase-derived group instead of
  // dropping the whole item.
  const chatActivityMode = value.chatActivityMode === "planning" ? "planning" : undefined;
  const kind = value.kind;
  const eventKind = requiredString(value.eventKind, 64);
  const phase = requiredString(value.phase, 64);
  const title = boundedText(value.title, MAX_TITLE_LENGTH);
  const preview = boundedText(value.preview, MAX_PREVIEW_LENGTH);
  const privacyPreview = boundedText(value.privacyPreview, MAX_PREVIEW_LENGTH);
  const updatedAt = optionalIsoDate(value.updatedAt);
  const occurredAt = optionalIsoDate(value.occurredAt);
  const statusSince = optionalIsoDate(value.statusSince);
  const expiresAt = optionalIsoDate(value.expiresAt);
  if (
    !id
    || !Number.isSafeInteger(revision)
    || revision < 0
    || !fingerprint
    || !contentFingerprint
    || !alertFingerprint
    || (
      activityTier !== undefined
      && activityTier !== "signal"
      && activityTier !== "ambient"
      && activityTier !== "idle"
    )
    || (kind !== "agent" && kind !== "pull_request")
    || !eventKind
    || !EVENT_KINDS.has(eventKind)
    || (kind === "agent" && !eventKind.startsWith("agent_"))
    || (kind === "pull_request" && !eventKind.startsWith("pr_"))
    || !phase
    || !PHASES.has(phase)
    || !title
    || !preview
    || !privacyPreview
    || !updatedAt
    || !occurredAt
    || statusSince === undefined
    || expiresAt === undefined
    || !isRecord(value.machine)
    || requiredString(value.machine.machineKey) !== machineKey
  ) {
    return null;
  }
  const expectedIdPrefix = kind === "agent"
    ? `agent:${machineKey}:`
    : `pull-request:${machineKey}:`;
  if (!id.startsWith(expectedIdPrefix)) return null;
  const machineName = boundedText(value.machine.name, 120);
  const accountMachineKey = value.machine.accountMachineKey == null
    ? null
    : requiredString(value.machine.accountMachineKey, 128);
  const deviceId = value.machine.deviceId == null
    ? null
    : requiredString(value.machine.deviceId, 128);
  if (
    (accountMachineKey !== null && !/^[a-f0-9]{32,64}$/i.test(accountMachineKey))
    || (value.machine.deviceId != null && !deviceId)
  ) {
    return null;
  }
  if (!machineName || !isRecord(value.project) || !isRecord(value.destination)) return null;

  const projectId = requiredString(value.project.projectId);
  const projectName = boundedText(value.project.name, 160);
  const rootPath = value.project.rootPath == null
    ? null
    : boundedText(value.project.rootPath, 1_000);
  // Absent is normal (older publisher); present-but-unusable is dropped rather
  // than rejecting the item, because the reader already falls back to rootPath.
  const canonicalId = value.project.canonicalId == null
    ? null
    : requiredString(value.project.canonicalId);
  if (!projectId || !projectName || (value.project.rootPath != null && !rootPath)) return null;

  let destination: Record<string, unknown>;
  if (kind === "agent") {
    const sessionId = requiredString(value.destination.sessionId);
    const itemId = value.destination.itemId == null
      ? null
      : requiredString(value.destination.itemId);
    const eventId = value.destination.eventId == null
      ? null
      : requiredString(value.destination.eventId);
    if (
      value.destination.kind !== "session"
      || !sessionId
      || (value.destination.itemId != null && !itemId)
      || (value.destination.eventId != null && !eventId)
    ) {
      return null;
    }
    destination = { kind: "session", sessionId, itemId, eventId };
  } else {
    const number = Number(value.destination.number);
    const prId = value.destination.prId == null
      ? null
      : requiredString(value.destination.prId);
    const repoOwner = value.destination.repoOwner == null
      ? null
      : requiredString(value.destination.repoOwner);
    const repoName = value.destination.repoName == null
      ? null
      : requiredString(value.destination.repoName);
    const tab = requiredString(value.destination.tab, 32);
    const eventId = value.destination.eventId == null
      ? null
      : requiredString(value.destination.eventId);
    if (
      value.destination.kind !== "pull_request"
      || !Number.isSafeInteger(number)
      || number <= 0
      || !tab
      || !PR_TABS.has(tab)
      || (value.destination.prId != null && !prId)
      || (value.destination.repoOwner != null && !repoOwner)
      || (value.destination.repoName != null && !repoName)
      || (value.destination.eventId != null && !eventId)
    ) {
      return null;
    }
    destination = {
      kind: "pull_request",
      prId,
      repoOwner,
      repoName,
      number,
      tab,
      eventId,
    };
  }

  if (!Array.isArray(value.actions) || value.actions.length > 8) return null;
  const actions = value.actions.map((rawAction) => {
    if (!isRecord(rawAction)) return null;
    const actionId = requiredString(rawAction.id, 64);
    const actionKind = requiredString(rawAction.kind, 64);
    const label = boundedText(rawAction.label, 80);
    if (!actionId || !actionKind || !ACTION_KINDS.has(actionKind) || !label) return null;
    let payload: Record<string, string | number | boolean | null> | undefined;
    if (rawAction.payload !== undefined) {
      if (!isRecord(rawAction.payload) || Object.keys(rawAction.payload).length > 16) return null;
      payload = {};
      for (const [rawKey, rawValue] of Object.entries(rawAction.payload)) {
        const key = requiredString(rawKey, 64);
        if (!key) return null;
        if (typeof rawValue === "string") {
          const text = boundedText(rawValue, MAX_PREVIEW_LENGTH);
          if (!text) return null;
          payload[key] = text;
        } else if (
          rawValue === null
          || typeof rawValue === "boolean"
          || (typeof rawValue === "number" && Number.isFinite(rawValue))
        ) {
          payload[key] = rawValue;
        } else {
          return null;
        }
      }
    }
    return {
      id: actionId,
      kind: actionKind,
      label,
      ...(rawAction.destructive === true ? { destructive: true } : {}),
      ...(payload ? { payload } : {}),
    };
  });
  if (actions.some((action) => action === null)) return null;

  const recentActivity = Array.isArray(value.recentActivity)
    ? value.recentActivity
      .map((entry) => boundedText(entry, MAX_PREVIEW_LENGTH))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 5)
    : undefined;
  const detail = value.detail == null ? null : boundedText(value.detail, MAX_DETAIL_LENGTH);
  if (value.detail != null && !detail) return null;
  const planProgress = value.planProgress == null
    ? null
    : isRecord(value.planProgress)
      ? {
          completed: Number(value.planProgress.completed),
          total: Number(value.planProgress.total),
          current: value.planProgress.current == null
            ? null
            : boundedText(value.planProgress.current, MAX_PREVIEW_LENGTH),
        }
      : undefined;
  if (
    planProgress === undefined
    || (
      planProgress !== null
      && (
        !Number.isSafeInteger(planProgress.completed)
        || !Number.isSafeInteger(planProgress.total)
        || planProgress.completed < 0
        || planProgress.total < 0
        || planProgress.total > 10_000
        || planProgress.completed > planProgress.total
        || (value.planProgress != null
          && isRecord(value.planProgress)
          && value.planProgress.current != null
          && !planProgress.current)
      )
    )
  ) {
    return null;
  }
  const laneId = value.laneId == null ? null : requiredString(value.laneId);
  const laneName = value.laneName == null ? null : boundedText(value.laneName, 160);
  const provider = value.provider == null ? null : boundedText(value.provider, 120);
  const model = value.model == null ? null : boundedText(value.model, 160);
  if (
    (value.laneId != null && !laneId)
    || (value.laneName != null && !laneName)
    || (value.provider != null && !provider)
    || (value.model != null && !model)
  ) {
    return null;
  }

  return {
    contractVersion: 1,
    id,
    revision,
    fingerprint: contentFingerprint,
    contentFingerprint,
    alertFingerprint,
    ...(activityTier ? { activityTier } : {}),
    ...(chatActivityMode ? { chatActivityMode } : {}),
    kind,
    eventKind,
    phase,
    title,
    preview,
    privacyPreview,
    detail,
    recentActivity,
    planProgress,
    laneId,
    laneName,
    provider,
    model,
    destination,
    actions: actions as Array<Record<string, unknown>>,
    updatedAt,
    occurredAt,
    statusSince,
    // Idle roster rows used to have their expiry stripped here, which is how a
    // machine's ambient rows outlived the machine: nothing but that machine's
    // own reconcile could ever remove them. Honor whatever lifetime the
    // publisher stamps — `null` still means "until reconciled".
    expiresAt,
    seenAt: null,
    dismissedAt: null,
    machine: {
      machineKey,
      accountMachineKey,
      deviceId,
      name: machineName,
      online: true,
      lastSeenAt: null,
    },
    project: {
      projectId,
      canonicalId,
      name: projectName,
      rootPath,
    },
  } as ParsedAttentionItem;
}

function attentionRevisionBumpStatement(
  env: AttentionRelayEnv,
  userId: string,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(`
    insert into attention_revisions(user_id, revision, updated_at)
    values (?, 1, ?)
    on conflict(user_id) do update set
      revision = attention_revisions.revision + 1,
      updated_at = excluded.updated_at
    returning revision
  `).bind(userId, now);
}

async function commitAttentionRevision(
  env: AttentionRelayEnv,
  userId: string,
  statements: D1PreparedStatement[],
  now = new Date().toISOString(),
): Promise<number> {
  const [revisionResult, ...mutationResults] = await env.DB.batch<{ revision: number }>([
    attentionRevisionBumpStatement(env, userId, now),
    ...statements,
  ]);
  if (
    !revisionResult?.success
    || mutationResults.some((result) => !result.success)
  ) {
    throw new Error("attention revision transaction failed");
  }
  const revision = Number(revisionResult.results[0]?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("attention revision transaction did not return a revision");
  }
  return revision;
}

function attentionDeviceOwnershipDeleteStatements(
  env: AttentionRelayEnv,
  userId: string,
  deviceId: string,
): D1PreparedStatement[] {
  return [
    env.DB
      .prepare("delete from attention_activity_tokens where user_id = ? and device_id = ?")
      .bind(userId, deviceId),
    env.DB
      .prepare("delete from attention_activity_state where user_id = ? and device_id = ?")
      .bind(userId, deviceId),
    env.DB
      .prepare("delete from attention_delivery_receipts where user_id = ? and device_id = ?")
      .bind(userId, deviceId),
    env.DB
      .prepare("delete from attention_presence where user_id = ? and device_id = ?")
      .bind(userId, deviceId),
    env.DB
      .prepare(`
        update attention_device_ownership
        set active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        where user_id = ? and device_id = ?
      `)
      .bind(userId, deviceId),
    env.DB
      .prepare("delete from attention_devices where user_id = ? and device_id = ?")
      .bind(userId, deviceId),
  ];
}

function isAttentionDeviceLimitError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("attention account device limit reached");
}

function isStaleAttentionDeviceOwnershipError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("stale attention device ownership");
}

function parsedOwnershipEpoch(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= Date.now() + MAX_OWNERSHIP_EPOCH_FUTURE_MS
    ? value
    : null;
}

async function attentionDeviceOwnershipRows(
  env: AttentionRelayEnv,
  deviceId: string,
  apnsToken: string | null,
): Promise<AttentionDeviceOwnershipRow[]> {
  const result = apnsToken
    ? await env.DB.prepare(`
        select device_id, user_id, ownership_epoch, apns_token
        from attention_device_ownership
        where device_id = ? or apns_token = ?
      `).bind(deviceId, apnsToken).all<AttentionDeviceOwnershipRow>()
    : await env.DB.prepare(`
        select device_id, user_id, ownership_epoch, apns_token
        from attention_device_ownership
        where device_id = ?
      `).bind(deviceId).all<AttentionDeviceOwnershipRow>();
  return result.results;
}

function staleAttentionDeviceOwnershipEpoch(
  rows: AttentionDeviceOwnershipRow[],
  userId: string,
  ownershipEpoch: number,
): number | null {
  const conflict = rows.some((row) => {
    const currentEpoch = Number(row.ownership_epoch);
    return currentEpoch > ownershipEpoch
      || (currentEpoch === ownershipEpoch && row.user_id !== userId);
  });
  if (!conflict) return null;
  return rows.reduce(
    (latest, row) => Math.max(latest, Number(row.ownership_epoch) || 0),
    ownershipEpoch,
  );
}

function attentionDeviceOwnershipConflict(ownershipEpoch: number): Response {
  return json({
    ok: false,
    error: "stale device ownership",
    ownershipEpoch,
  }, { status: 409 });
}

function attentionDeviceOwnershipUpsertStatement(
  env: AttentionRelayEnv,
  args: {
    deviceId: string;
    userId: string;
    ownershipEpoch: number;
    apnsToken: string | null;
    active: boolean;
    updatedAt: string;
  },
): D1PreparedStatement {
  return env.DB.prepare(`
    insert into attention_device_ownership(
      device_id, user_id, ownership_epoch, apns_token, active, updated_at
    ) values (?, ?, ?, ?, ?, ?)
    on conflict(device_id) do update set
      user_id = excluded.user_id,
      ownership_epoch = excluded.ownership_epoch,
      apns_token = coalesce(excluded.apns_token, attention_device_ownership.apns_token),
      active = excluded.active,
      updated_at = excluded.updated_at
    where excluded.ownership_epoch > attention_device_ownership.ownership_epoch
      or (
        excluded.ownership_epoch = attention_device_ownership.ownership_epoch
        and excluded.user_id = attention_device_ownership.user_id
      )
  `).bind(
    args.deviceId,
    args.userId,
    args.ownershipEpoch,
    args.apnsToken,
    args.active ? 1 : 0,
    args.updatedAt,
  );
}

function releasePriorApnsOwnershipStatement(
  env: AttentionRelayEnv,
  args: {
    deviceId: string;
    userId: string;
    ownershipEpoch: number;
    apnsToken: string;
    updatedAt: string;
  },
): D1PreparedStatement {
  return env.DB.prepare(`
    update attention_device_ownership
    set apns_token = null, active = 0, updated_at = ?
    where apns_token = ?
      and device_id <> ?
      and (
        ownership_epoch < ?
        or (ownership_epoch = ? and user_id = ?)
      )
  `).bind(
    args.updatedAt,
    args.apnsToken,
    args.deviceId,
    args.ownershipEpoch,
    args.ownershipEpoch,
    args.userId,
  );
}

async function latestAttentionDeviceOwnershipEpoch(
  env: AttentionRelayEnv,
  deviceId: string,
  apnsToken: string | null,
  fallback: number,
): Promise<number> {
  const rows = await attentionDeviceOwnershipRows(env, deviceId, apnsToken);
  return rows.reduce(
    (latest, row) => Math.max(latest, Number(row.ownership_epoch) || 0),
    fallback,
  );
}

async function linkMachineToAccount(
  env: AttentionRelayEnv,
  userId: string,
  machineKey: string,
  machineName: string,
): Promise<void> {
  const now = new Date().toISOString();
  const previous = await env.DB
    .prepare(`
      select user_id, legacy_devices_imported_at
      from attention_machine_links
      where machine_key = ?
      limit 1
    `)
    .bind(machineKey)
    .first<{ user_id: string; legacy_devices_imported_at: string | null }>();
  const freshOwnership = !previous || previous.user_id !== userId;

  // WHO OWNED THIS KEY BEFORE THIS PUBLISH?
  //
  // The link row answers it while the machine is still on an account, but the
  // case that matters here is the one where the link is already gone:
  // `purgeAccountMachineActivity` deletes it as part of an account removal. It
  // leaves `machines.account_user_id` — the legacy claim `linkMachineToAccount`
  // maintains — untouched, so that is the surviving record of the prior owner.
  const priorClaim = previous
    ? null
    : await env.DB
      .prepare("select account_user_id from machines where machine_key = ? limit 1")
      .bind(machineKey)
      .first<{ account_user_id: string | null }>();
  const previousOwnerUserId = previous?.user_id ?? priorClaim?.account_user_id ?? null;
  // A COMPLETED OWNERSHIP TRANSFER IS THE DELIBERATE RE-PAIR.
  //
  // `machineKeyRevokedAt` blocks a machine key revoked on ANY account (see its
  // note: that is what keeps a sold machine from pushing to the previous
  // owner's phone), but `handleAccountMachinePairingRestore` only ever clears
  // the CURRENT account's row. Machine keys are per-install and never rotate,
  // so without a clear here a machine removed from account A and then signed
  // into account B registers fine, takes ownership, and is still terminal-403'd
  // on publish/token-upsert by A's leftover row — forever, and only for alerts
  // and Live Activities, while protocol-2 Activity (which uses the
  // account-scoped check) keeps working. The directory cannot repair it either:
  // it looks for a `(B, machine)` revocation and finds none.
  //
  // EVERY prior owner's row goes, not just the most recent. `machines.account_
  // user_id` records only the LAST linker, so scoping the clear to it survives
  // exactly one hop: a key that goes A → C → B leaves A's row behind and the
  // brick is back. And a revocation written by an account that is NOT the one
  // this key is currently publishing under is stale by construction — it says
  // "that account de-authorized this machine", which is already true and is
  // enforced by the fact that the machine cannot publish to that account.
  //
  // Clearing them is only safe because the legacy delivery rows go in the SAME
  // atomic batch: the machine loses every phone the previous owners reached
  // through it at the exact moment it stops being blocked, so there is no
  // window in which a cleared revocation resurrects a channel to an account
  // that no longer owns the machine.
  const staleRevocations = await env.DB
    .prepare(`
      select user_id
      from attention_revoked_machines
      where machine_key = ? and user_id <> ?
    `)
    .bind(machineKey, userId)
    .all<{ user_id: string }>();
  const ownershipChanged = previousOwnerUserId != null && previousOwnerUserId !== userId;
  if (ownershipChanged || staleRevocations.results.length > 0) {
    await env.DB.batch([
      ...legacyMachineDeliveryPurgeStatements(env, machineKey),
      env.DB
        .prepare("delete from attention_revoked_machines where machine_key = ? and user_id <> ?")
        .bind(machineKey, userId),
    ]);
  }
  if (previous?.user_id && previous.user_id !== userId) {
    const previousItems = await env.DB
      .prepare(`
        select item_id, source_revision
        from attention_items
        where machine_key = ? and user_id = ?
      `)
      .bind(machineKey, previous.user_id)
      .all<{ item_id: string; source_revision: number }>();
    if (previousItems.results.length > 0) {
      const statements: D1PreparedStatement[] = [
        env.DB
          .prepare("delete from attention_items where machine_key = ? and user_id = ?")
          .bind(machineKey, previous.user_id),
        ...previousItems.results.map((item) =>
          attentionTombstoneUpsertForCurrentRevisionStatement(env, {
            userId: previous.user_id,
            machineKey,
            itemId: item.item_id,
            sourceRevision: Number(item.source_revision),
            deletedAt: now,
            revivable: false,
          })),
      ];
      await commitAttentionRevision(env, previous.user_id, statements, now);
    }
    const previousDevices = await env.DB
      .prepare("select device_id from attention_devices where user_id = ? and source_machine_key = ?")
      .bind(previous.user_id, machineKey)
      .all<{ device_id: string }>();
    for (const device of previousDevices.results) {
      await deleteAttentionDeviceOwnership(env, previous.user_id, device.device_id);
    }
    if (previousItems.results.length > 0) {
      // The destination account is delivered later in the publish flow, but
      // other devices that remain signed into the previous account also need
      // an update/end after this machine's rows leave that aggregate.
      await deliverAccountLiveActivity(env, previous.user_id);
    }
  }
  if (freshOwnership) {
    // A machine returning to an account starts a fresh source stream. Remove
    // only tombstones in that machine's namespace so the first full snapshot
    // can revive an item even when its local revision counter restarted.
    await env.DB.prepare(`
      delete from attention_tombstones
      where user_id = ?
        and (
          item_id like ?
          or item_id like ?
        )
    `).bind(
      userId,
      `agent:${machineKey}:%`,
      `pull-request:${machineKey}:%`,
    ).run();
  }
  await env.DB.prepare(`
    insert into attention_machine_links(
      machine_key, user_id, machine_name, last_seen_at, linked_at,
      legacy_devices_imported_at
    )
    values (?, ?, ?, ?, ?, null)
    on conflict(machine_key) do update set
      user_id = excluded.user_id,
      machine_name = excluded.machine_name,
      last_seen_at = excluded.last_seen_at
  `).bind(machineKey, userId, machineName, now, now).run();
  await env.DB
    .prepare("update machines set account_user_id = ? where machine_key = ?")
    .bind(userId, machineKey)
    .run();
  if (previous?.legacy_devices_imported_at) return;

  // Legacy machine registrations are migration input, not ongoing authority.
  // Seed only currently unowned installs/tokens, at most once per machine.
  const leaseExpiresAt = new Date(Date.now() + ATTENTION_DEVICE_LEASE_MS).toISOString();
  const existingDeviceCount = await env.DB
    .prepare("select count(*) as count from attention_devices where user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  const availableSlots = Math.max(
    0,
    MAX_ATTENTION_DEVICES - Number(existingDeviceCount?.count ?? 0),
  );
  await env.DB.batch([
    env.DB.prepare(`
      insert or ignore into attention_devices(
        user_id, device_id, source_machine_key, apns_token, push_to_start_token,
        bundle_id, aps_environment, platform, device_name, preferences_json,
        registered_at, updated_at, lease_expires_at, generation
      )
      select ?, legacy.device_id, ?, legacy.apns_token,
        legacy.push_to_start_token, legacy.bundle_id, aps_environment, platform,
        device_name, '{}', registered_at, updated_at, ?,
        lower(hex(randomblob(16)))
      from device_registrations as legacy
      where legacy.machine_key = ?
        and not exists (
          select 1
          from attention_devices as owned
          where owned.device_id = legacy.device_id
            or (
              legacy.apns_token is not null
              and owned.apns_token = legacy.apns_token
            )
        )
        and not exists (
          select 1
          from attention_device_ownership as ownership
          where ownership.device_id = legacy.device_id
            or (
              legacy.apns_token is not null
              and ownership.apns_token = legacy.apns_token
            )
        )
      limit ?
    `).bind(userId, machineKey, leaseExpiresAt, machineKey, availableSlots),
    env.DB.prepare(`
      insert or ignore into attention_device_ownership(
        device_id, user_id, ownership_epoch, apns_token, active, updated_at
      )
      select device.device_id, ?, 1, device.apns_token, 1, ?
      from attention_devices as device
      where device.user_id = ? and device.source_machine_key = ?
    `).bind(userId, now, userId, machineKey),
    env.DB.prepare(`
      insert or ignore into attention_activity_tokens(
        user_id, device_id, activity_id, token, updated_at
      )
      select ?, token.device_id, token.activity_id, token.token, token.updated_at
      from live_activity_tokens as token
      join attention_devices as device
        on device.user_id = ?
        and device.device_id = token.device_id
        and device.source_machine_key = ?
      where token.machine_key = ?
    `).bind(userId, userId, machineKey, machineKey),
    env.DB.prepare(`
      insert or ignore into attention_activity_state(
        user_id, device_id, activity_id, started, fingerprint, updated_at
      )
      select ?, token.device_id, token.activity_id, 1, null, token.updated_at
      from live_activity_tokens as token
      join attention_devices as device
        on device.user_id = ?
        and device.device_id = token.device_id
        and device.source_machine_key = ?
      where token.machine_key = ?
    `).bind(userId, userId, machineKey, machineKey),
    env.DB.prepare(`
      update attention_machine_links
      set legacy_devices_imported_at = ?
      where machine_key = ? and user_id = ?
    `).bind(now, machineKey, userId),
  ]);
}

async function refreshActivityMachinePresence(
  env: AttentionRelayEnv,
  args: {
    userId: string;
    machineKey: string;
    machineName: string;
    now: string;
  },
): Promise<void> {
  await env.DB.prepare(`
    insert into attention_machine_links(
      machine_key, user_id, machine_name, last_seen_at, linked_at,
      legacy_devices_imported_at
    ) values (?, ?, ?, ?, ?, null)
    on conflict(machine_key) do update set
      user_id = excluded.user_id,
      machine_name = excluded.machine_name,
      last_seen_at = excluded.last_seen_at
  `).bind(
    args.machineKey,
    args.userId,
    args.machineName,
    args.now,
    args.now,
  ).run();
}

async function activityItemsForMachine(
  env: AttentionRelayEnv,
  userId: string,
  machineKey: string,
  now: string,
): Promise<ParsedAttentionItem[]> {
  const rows = await env.DB.prepare(`
    select payload_json
    from attention_items
    where user_id = ? and machine_key = ?
      and seen_at is null and dismissed_at is null
      and (expires_at is null or expires_at > ?)
    order by updated_at desc
    limit ?
  `).bind(
    userId,
    machineKey,
    now,
    MAX_ACCOUNT_ATTENTION_ITEMS,
  ).all<{ payload_json: string }>();
  return rows.results.flatMap((row) => {
    try {
      return [JSON.parse(row.payload_json) as ParsedAttentionItem];
    } catch {
      return [];
    }
  });
}

type ActivityPublishAcknowledgment = {
  itemId: string;
  seenAt: string | null;
  dismissedAt: string | null;
  sourceRevision: number;
};

async function activityPublishAcknowledgments(
  env: AttentionRelayEnv,
  args: {
    userId: string;
    machineKey: string;
    requestItems: ParsedAttentionItem[];
  },
): Promise<ActivityPublishAcknowledgment[]> {
  type AckRow = {
    item_id: string;
    seen_at: string | null;
    dismissed_at: string | null;
    source_revision: number;
    account_revision: number;
  };
  const requestRows = args.requestItems.length > 0
    ? await env.DB.prepare(`
        select item_id, seen_at, dismissed_at, source_revision, account_revision
        from attention_items
        where user_id = ? and machine_key = ?
          and item_id in (${args.requestItems.map(() => "?").join(", ")})
      `).bind(
        args.userId,
        args.machineKey,
        ...args.requestItems.map((item) => item.id),
      ).all<AckRow>()
    : { results: [] as AckRow[] };
  const recentRows = await env.DB.prepare(`
    select item_id, seen_at, dismissed_at, source_revision, account_revision
    from attention_items
    where user_id = ? and machine_key = ?
      and (seen_at is not null or dismissed_at is not null)
    order by account_revision desc
    limit 64
  `).bind(args.userId, args.machineKey).all<AckRow>();
  const requestById = new Map(requestRows.results.map((row) => [row.item_id, row]));
  const acknowledgments = args.requestItems.map((item) => {
    const row = requestById.get(item.id);
    return {
      itemId: item.id,
      seenAt: row?.seen_at ?? null,
      dismissedAt: row?.dismissed_at ?? null,
      sourceRevision: Number(row?.source_revision ?? item.revision),
    };
  });
  const includedIds = new Set(acknowledgments.map((ack) => ack.itemId));
  for (const row of recentRows.results) {
    if (includedIds.has(row.item_id)) continue;
    acknowledgments.push({
      itemId: row.item_id,
      seenAt: row.seen_at,
      dismissedAt: row.dismissed_at,
      sourceRevision: Number(row.source_revision),
    });
  }
  return acknowledgments;
}

/**
 * A machine key the caller PROVED it holds, by signing the request with that
 * machine's relay secret (`assertMachineAuthorized`). Deliberately not just a
 * `string`: the point is that the value cannot be read off the request path.
 */
export type VerifiedMachineIdentity = {
  machineKey: string;
};

export async function handleAttentionMachinePublish(
  request: Request,
  env: AttentionRelayEnv,
  machineKey: string,
  body: ArrayBuffer,
  verifiedMachine: VerifiedMachineIdentity,
): Promise<Response> {
  // THE PATH `machineKey` IS AN ASSERTION; THIS IS THE PROOF.
  //
  // The account bearer token says who the caller is, never which machine they
  // are speaking for, and machine keys are not secret — they ride published
  // items as `accountMachineKey` and appear in deeplink query strings. A publish
  // that reached `linkMachineToAccount` for an arbitrary key would let any
  // signed-in account write itself a `(caller, victimKey)` link row, which is
  // the first piece of evidence `accountKnowsMachine` accepts on the removal
  // route — a self-minted licence to terminal-403 a stranger's machine.
  //
  // `assertMachineAuthorized` (the HMAC signature the legacy machine routes
  // already require) is what actually binds the key, and the machine route
  // hands its result in here. Re-asserting it locally keeps the invariant a
  // property of this handler instead of a property of one caller: any future
  // route reaching this function has to produce the same proof.
  if (verifiedMachine.machineKey !== machineKey) {
    return json({
      ok: false,
      error: "machine key does not match the signed machine",
      code: "machine_key_unbound",
    }, { status: 403 });
  }
  const account = await authorizedUser(request, env);
  if ("response" in account) return account.response;
  // The machine key is taken from the request path and a removed machine keeps
  // a valid account token until it signs out, so membership has to be checked
  // here: without it a de-authorized install republishes itself (and relinks
  // through `linkMachineToAccount`) on its next 30 s heartbeat.
  const revokedAt = await accountMachineRevokedAt(env, account.userId, machineKey);
  if (revokedAt) {
    return json({
      ok: false,
      error: "machine removed from account",
      code: "machine_revoked",
      revokedAt,
      recovery: "This machine was removed from the ADE account. Pair it again to publish activity.",
    }, { status: 403 });
  }
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) return json({ ok: false, error: "invalid payload" }, { status: 400 });
  const machineName = boundedText(payload.machineName, 120) ?? "ADE machine";
  const mode = payload.mode === "delta"
    || payload.mode === "reconcile"
    || payload.mode === "presence"
    ? payload.mode
    : null;
  if (payload.mode != null && !mode) {
    return json({ ok: false, error: "invalid publish mode" }, { status: 400 });
  }
  const fullSnapshot = payload.fullSnapshot === true;
  const rosterEpoch = mode ? Number(payload.rosterEpoch) : 0;
  if (mode && (!Number.isSafeInteger(rosterEpoch) || rosterEpoch <= 0)) {
    return json({ ok: false, error: "invalid roster epoch" }, { status: 400 });
  }
  if (mode === "reconcile") {
    if (
      payload.page != null
      && (!Number.isSafeInteger(Number(payload.page)) || Number(payload.page) < 0)
    ) {
      return json({ ok: false, error: "invalid reconcile page" }, { status: 400 });
    }
    if (payload.final != null && typeof payload.final !== "boolean") {
      return json({ ok: false, error: "invalid reconcile final flag" }, { status: 400 });
    }
  } else if (mode && (payload.page != null || payload.final != null)) {
    return json({ ok: false, error: "page and final require reconcile mode" }, { status: 400 });
  }
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const rawTombstones = Array.isArray(payload.tombstones) ? payload.tombstones : [];
  if (rawItems.length > MAX_ATTENTION_ITEMS || rawTombstones.length > MAX_ATTENTION_TOMBSTONES) {
    return json({ ok: false, error: "too many changes" }, { status: 400 });
  }
  if (mode === "presence" && (rawItems.length > 0 || rawTombstones.length > 0)) {
    return json({ ok: false, error: "presence cannot write items" }, { status: 400 });
  }
  const items = rawItems.map((entry) => parseAttentionItem(entry, machineKey));
  if (items.some((entry) => entry === null)) {
    return json({ ok: false, error: "invalid attention item" }, { status: 400 });
  }
  const parsedTombstones = rawTombstones.map((entry) => {
    if (!isRecord(entry)) return null;
    const id = requiredString(entry.id);
    const revision = Number(entry.revision);
    return id && Number.isSafeInteger(revision) && revision >= 0 ? { id, revision } : null;
  });
  if (parsedTombstones.some((entry) => entry === null)) {
    return json({ ok: false, error: "invalid attention tombstone" }, { status: 400 });
  }
  const ownsItemId = (id: string) =>
    id.startsWith(`agent:${machineKey}:`)
    || id.startsWith(`pull-request:${machineKey}:`);
  if ((parsedTombstones as Array<{ id: string }>).some((entry) => !ownsItemId(entry.id))) {
    return json({ ok: false, error: "foreign attention tombstone" }, { status: 403 });
  }
  const tombstonesById = new Map<string, IncomingAttentionTombstone>(
    (parsedTombstones as Array<{ id: string; revision: number }>).map((entry) => [
      entry.id,
      { ...entry, revivable: false },
    ]),
  );
  const publishedIds = new Set(
    (items as ParsedAttentionItem[]).map((item) => item.id),
  );
  if ([...tombstonesById.keys()].some((id) => publishedIds.has(id))) {
    return json({ ok: false, error: "an item cannot also be removed" }, { status: 400 });
  }
  let existingMachineItems: Array<{
    item_id: string;
    source_revision: number;
    fingerprint: string;
  }> = [];
  if (!mode && fullSnapshot) {
    const existing = await env.DB.prepare(`
      select item_id, source_revision, fingerprint
      from attention_items
      where user_id = ? and machine_key = ?
    `).bind(account.userId, machineKey).all<{
      item_id: string;
      source_revision: number;
      fingerprint: string;
    }>();
    existingMachineItems = existing.results;
    for (const row of existing.results) {
      if (!publishedIds.has(row.item_id) && !tombstonesById.has(row.item_id)) {
        tombstonesById.set(
          row.item_id,
          implicitFullSnapshotTombstone(row, rawItems.length),
        );
      }
    }
  }
  const tombstones = [...tombstonesById.values()];
  const firstItem = items.find((entry): entry is ParsedAttentionItem => entry !== null);
  const now = new Date().toISOString();
  if (mode === "presence") {
    await refreshActivityMachinePresence(env, {
      userId: account.userId,
      machineKey,
      machineName,
      now,
    });
    const storedItems = await activityItemsForMachine(
      env,
      account.userId,
      machineKey,
      now,
    );
    await deliverAttentionNotifications(env, account.userId, storedItems);
    const [current, acks] = await Promise.all([
      env.DB
        .prepare("select revision from attention_revisions where user_id = ? limit 1")
        .bind(account.userId)
        .first<{ revision: number }>(),
      activityPublishAcknowledgments(env, {
        userId: account.userId,
        machineKey,
        requestItems: [],
      }),
    ]);
    return json({
      ok: true,
      protocol: 2,
      revision: Number(current?.revision ?? 0),
      acks,
      upserted: 0,
      removed: 0,
      unchanged: true,
    });
  }
  await linkMachineToAccount(
    env,
    account.userId,
    machineKey,
    firstItem?.machine.name ?? machineName,
  );
  if (
    !mode
    && fullSnapshot
    && attentionFullSnapshotUnchanged(
      existingMachineItems,
      items as ParsedAttentionItem[],
      tombstones.length,
    )
  ) {
    // Identical heartbeats still drive desktop-first escalation. The delivery
    // path checks acknowledgments and durable receipts, so a due alert retries
    // without rewriting account state or duplicating an already-delivered push.
    await deliverAttentionNotifications(
      env,
      account.userId,
      items as ParsedAttentionItem[],
    );
    await deliverAccountLiveActivity(env, account.userId);
    const [current, acks] = await Promise.all([
      env.DB
        .prepare("select revision from attention_revisions where user_id = ? limit 1")
        .bind(account.userId)
        .first<{ revision: number }>(),
      activityPublishAcknowledgments(env, {
        userId: account.userId,
        machineKey,
        requestItems: items as ParsedAttentionItem[],
      }),
    ]);
    return json({
      ok: true,
      protocol: 2,
      revision: Number(current?.revision ?? 0),
      acks,
      upserted: 0,
      removed: 0,
      unchanged: true,
    });
  }
  let accountRevision = await commitAttentionMachineChanges(env, {
    userId: account.userId,
    machineKey,
    items: items as ParsedAttentionItem[],
    tombstones,
    sealCapacityTombstones:
      !mode && fullSnapshot && rawItems.length < MAX_ATTENTION_ITEMS,
    rosterEpoch,
    now,
  });
  if (mode === "reconcile" && payload.final === true) {
    accountRevision = await commitActivityReconcileFinal(env, {
      userId: account.userId,
      machineKey,
      rosterEpoch,
      now,
    });
  }
  const cap = await enforceActivityAccountItemCap(env, account.userId, now);
  if (cap.revision !== null) accountRevision = cap.revision;
  await deliverAttentionNotifications(
    env,
    account.userId,
    items as ParsedAttentionItem[],
  );
  await deliverAccountLiveActivity(env, account.userId);
  const acks = await activityPublishAcknowledgments(env, {
    userId: account.userId,
    machineKey,
    requestItems: items as ParsedAttentionItem[],
  });

  return json({
    ok: true,
    protocol: 2,
    revision: accountRevision,
    acks,
    upserted: items.length,
    removed: tombstones.length,
    ...(cap.itemsTruncated ? { itemsTruncated: true } : {}),
  });
}

async function handleSnapshot(
  env: AttentionRelayEnv,
  userId: string,
  url: URL,
): Promise<Response> {
  const pageSize = 512;
  const requestedSince = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0);
  const requestedStreamId = url.searchParams.get("streamId")?.trim() || null;
  const revisionRow = await env.DB
    .prepare("select revision from attention_revisions where user_id = ? limit 1")
    .bind(userId)
    .first<{ revision: number }>();
  const headRevision = Number(revisionRow?.revision ?? 0);
  // Account cursors are scoped to one verified identity. A desktop that signs
  // out and into another account can legitimately present a cursor larger than
  // the new account's head; treat that as a new stream and return a full page.
  const since = normalizedSnapshotCursor(
    requestedSince,
    headRevision,
    requestedStreamId,
    userId,
  );
  const now = Date.now();
  const itemRows = await env.DB.prepare(`
    select payload_json, seen_at, dismissed_at, account_revision
    from attention_items
    where user_id = ?
      and account_revision > ?
      and (expires_at is null or expires_at > ?)
    order by account_revision asc
    limit ?
  `).bind(userId, since, new Date(now).toISOString(), pageSize).all<AttentionItemRow>();
  const tombstoneRows = await env.DB.prepare(`
    select item_id, source_revision, account_revision, deleted_at
    from attention_tombstones
    where user_id = ? and account_revision > ?
    order by account_revision asc
    limit ?
  `).bind(userId, since, pageSize).all<AttentionTombstoneRow>();
  const itemBoundary = itemRows.results.length === pageSize
    ? Math.max(since, Number(itemRows.results.at(-1)?.account_revision ?? since) - 1)
    : Number.POSITIVE_INFINITY;
  const tombstoneBoundary = tombstoneRows.results.length === pageSize
    ? Math.max(since, Number(tombstoneRows.results.at(-1)?.account_revision ?? since) - 1)
    : Number.POSITIVE_INFINITY;
  const boundary = Math.min(itemBoundary, tombstoneBoundary);
  const responseRevision = Number.isFinite(boundary)
    ? Math.min(headRevision, boundary)
    : headRevision;
  const responseItemRows = itemRows.results.filter(
    (row) => row.account_revision <= responseRevision,
  );
  const responseTombstoneRows = tombstoneRows.results.filter(
    (row) => row.account_revision <= responseRevision,
  );
  const accountItemCountRow = await env.DB.prepare(`
    select count(*) as count
    from attention_items
    where user_id = ?
  `).bind(userId).first<{ count: number }>();
  const itemsTruncated = Number(accountItemCountRow?.count ?? 0)
    > MAX_ACCOUNT_ATTENTION_ITEMS;
  const links = await env.DB.prepare(`
    select machine_key, machine_name, last_seen_at
    from attention_machine_links
    where user_id = ?
  `).bind(userId).all<{
    machine_key: string;
    machine_name: string | null;
    last_seen_at: string;
  }>();
  const presenceByMachine = new Map(
    links.results.map((row) => [
      row.machine_key,
      {
        online: now - Date.parse(row.last_seen_at) <= ACCOUNT_MACHINE_ONLINE_WINDOW_MS,
        lastSeenAt: row.last_seen_at,
      },
    ]),
  );

  const items = responseItemRows.flatMap((row) => {
    try {
      const payload = JSON.parse(row.payload_json) as ParsedAttentionItem;
      return [{
        ...payload,
        machine: {
          ...payload.machine,
          online: presenceByMachine.get(payload.machine.machineKey)?.online ?? false,
          lastSeenAt: presenceByMachine.get(payload.machine.machineKey)?.lastSeenAt ?? null,
        },
        seenAt: row.seen_at,
        dismissedAt: row.dismissed_at,
      }];
    } catch {
      return [];
    }
  });
  return json({
    ok: true,
    contractVersion: 1,
    streamId: userId,
    revision: responseRevision,
    generatedAt: new Date(now).toISOString(),
    machines: links.results.map((row) => ({
      machineKey: row.machine_key,
      name: row.machine_name?.trim() || "ADE machine",
      online: now - Date.parse(row.last_seen_at) <= ACCOUNT_MACHINE_ONLINE_WINDOW_MS,
      lastSeenAt: row.last_seen_at,
    })),
    items,
    itemsTruncated,
    tombstones: responseTombstoneRows.map((row) => ({
      id: row.item_id,
      revision: row.source_revision,
      deletedAt: row.deleted_at,
    })),
  });
}

async function handleAcknowledgment(
  request: Request,
  env: AttentionRelayEnv,
  userId: string,
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload) || !Array.isArray(payload.itemIds) || payload.itemIds.length > 64) {
    return json({ ok: false, error: "invalid acknowledgment" }, { status: 400 });
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "expectedAccountOwnerId")
    && payload.expectedAccountOwnerId !== userId
  ) {
    return json({ ok: false, error: "account owner changed" }, { status: 409 });
  }
  const itemIds = payload.itemIds.map((value) => requiredString(value));
  if (itemIds.some((value) => value === null)) {
    return json({ ok: false, error: "invalid item id" }, { status: 400 });
  }
  const seenAt = optionalIsoDate(payload.seenAt ?? new Date().toISOString());
  const dismissedAt = optionalIsoDate(payload.dismissedAt);
  if (!seenAt || dismissedAt === undefined) {
    return json({ ok: false, error: "invalid timestamp" }, { status: 400 });
  }
  // `sourceRevisions` is accepted and ignored. Clients still send it, and the
  // revision fence it fed was deliberately removed (see the comment on the
  // update statement below), so validating it could only ever produce a 400 for
  // a field with no effect — a client one revision behind on a running agent is
  // the NORMAL case, not an error. No shape check either: there is nothing
  // downstream to protect.
  //
  // `alertFingerprints` is the fence that replaced it, and it IS validated,
  // because unlike a revision it changes what the statement does. It answers
  // "acknowledge this item only if it is still the alert I rendered", which is
  // the one lost update that can actually happen: a needs-you row that flipped
  // to a NEW question between the client's render and its tap must not arrive
  // pre-dismissed. Deliberately sparse — see `fencedAlertFingerprint` below.
  const rawAlertFingerprints = payload.alertFingerprints;
  const hasAlertFingerprints = rawAlertFingerprints !== undefined
    && rawAlertFingerprints !== null;
  if (hasAlertFingerprints && !isRecord(rawAlertFingerprints)) {
    return json({ ok: false, error: "invalid alert fingerprints" }, { status: 400 });
  }
  const alertFingerprints = new Map<string, string>();
  if (hasAlertFingerprints) {
    const quoted = rawAlertFingerprints as Record<string, unknown>;
    const batch = new Set(itemIds as string[]);
    for (const [itemId, value] of Object.entries(quoted)) {
      // Out-of-batch keys are a caller bug, not a fence: the client drops them
      // before sending, so their presence means the two sides disagree about
      // what is being acknowledged. Say so rather than silently ignoring them.
      if (!batch.has(itemId)) {
        return json({ ok: false, error: "invalid alert fingerprints" }, { status: 400 });
      }
      if (typeof value !== "string") {
        return json({ ok: false, error: "invalid alert fingerprints" }, { status: 400 });
      }
      const normalized = value.trim();
      // 1024 matches the notch snapshot parser's bound on the same field.
      if (!normalized || normalized.length > 1024) {
        return json({ ok: false, error: "invalid alert fingerprints" }, { status: 400 });
      }
      alertFingerprints.set(itemId, normalized);
    }
  }
  /**
   * The fence for one item, or null for "apply unfenced".
   *
   * ABSENCE IS NOT A MISMATCH. The map is optional and sparse: a legacy
   * desktop, mobile, or TUI caller sends nothing, and even a current caller
   * omits items it never rendered a fingerprint for. Treating an absent entry
   * as a failed fence would break "Clear all" for every one of them, which is
   * the exact regression the removed revision fence caused.
   */
  const fencedAlertFingerprint = (itemId: string): string | null =>
    alertFingerprints.get(itemId) ?? null;
  if (itemIds.length === 0) {
    const current = await env.DB
      .prepare("select revision from attention_revisions where user_id = ? limit 1")
      .bind(userId)
      .first<{ revision: number }>();
    return json({
      ok: true,
      revision: Number(current?.revision ?? 0),
      itemIds,
      applied: [],
      stale: [],
    });
  }
  // Acknowledgments are keyed by item id alone. An item's `revision` is the raw
  // epoch-ms of its last source activity, so a running agent outruns any client
  // that read it a poll ago — fencing on `source_revision <= ?` rejected the
  // normal case and broke every dismiss (including "Clear all"). seen/dismissed
  // are monotonic and idempotent (the timestamp guards below never move a mark
  // backwards), so there is no lost update to protect. The only thing revision
  // still guards is revival: an acknowledgment must never bring back a row a
  // sealed tombstone already removed, which the tombstone predicate enforces.
  // If the item's alert identity changes after an ack, the next publish resets
  // seen/dismissed through the alert-fingerprint branch of the item upsert, so
  // a racing acknowledgment cannot swallow a genuinely new alert.
  const statements = (itemIds as string[]).map((itemId) => {
    const fence = fencedAlertFingerprint(itemId);
    // A fenced item whose stored identity moved on simply matches no row, so it
    // falls out of `applied` and into `stale` through the existing per-item
    // outcome check. No new response field, no new status code.
    return env.DB.prepare(`
      update attention_items
      set seen_at = case
          when seen_at is null or seen_at > ? then ?
          else seen_at
        end,
        dismissed_at = case
          when ? is null then dismissed_at
          when dismissed_at is null or dismissed_at > ? then ?
          else dismissed_at
        end,
        account_revision = (
          select revision
          from attention_revisions
          where user_id = ?
        )
      where user_id = ? and item_id = ?
        ${fence === null ? "" : "and alert_fingerprint = ?"}
        and not exists (
          select 1
          from attention_tombstones
          where user_id = attention_items.user_id
            and item_id = attention_items.item_id
            and revivable != 1
            and source_revision >= attention_items.source_revision
        )
      returning item_id
    `).bind(
      seenAt,
      seenAt,
      dismissedAt,
      dismissedAt,
      dismissedAt,
      userId,
      userId,
      itemId,
      ...(fence === null ? [] : [fence]),
    );
  });
  const [revisionResult, ...mutationResults] = await env.DB.batch<{
    revision?: number;
    item_id?: string;
  }>([
    attentionRevisionBumpStatement(env, userId, new Date().toISOString()),
    ...statements,
  ]);
  if (!revisionResult?.success || mutationResults.some((result) => !result.success)) {
    throw new Error("attention acknowledgment transaction failed");
  }
  const revision = Number(revisionResult.results[0]?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("attention acknowledgment transaction did not return a revision");
  }
  // One batch, one revision: a bulk acknowledgment either commits for the whole
  // set or throws above, and the per-item outcome is reported back so a caller
  // clearing an inbox can tell which rows are simply gone. `stale` now means
  // only that: an id this account has no live row for (never published, already
  // swept, or sealed by a tombstone).
  const applied = (itemIds as string[]).filter(
    (_itemId, index) => mutationResults[index]?.results.length === 1,
  );
  const appliedIds = new Set(applied);
  const stale = (itemIds as string[]).filter((itemId) => !appliedIds.has(itemId));
  await deliverAccountLiveActivity(env, userId);
  return json({ ok: true, revision, itemIds, applied, stale });
}

async function handlePresence(
  request: Request,
  env: AttentionRelayEnv,
  userId: string,
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) return json({ ok: false, error: "invalid presence" }, { status: 400 });
  const deviceId = requiredString(payload.deviceId, 128);
  const observedAt = optionalIsoDate(payload.observedAt ?? new Date().toISOString());
  const visibleItemIds = Array.isArray(payload.visibleItemIds)
    ? payload.visibleItemIds.map((value) => requiredString(value)).filter(Boolean).slice(0, 64)
    : [];
  if (!deviceId || !observedAt) {
    return json({ ok: false, error: "invalid presence" }, { status: 400 });
  }
  const platform = payload.platform === "macOS"
    || payload.platform === "iOS"
    || payload.platform === "web"
    || payload.platform === "unknown"
    ? payload.platform
    : "unknown";
  const stored = {
    deviceId,
    platform,
    appForeground: payload.appForeground === true,
    observedAt,
    visibleItemIds,
  };
  await env.DB.prepare(`
    insert into attention_presence(user_id, device_id, payload_json, observed_at)
    values (?, ?, ?, ?)
    on conflict(user_id, device_id) do update set
      payload_json = excluded.payload_json,
      observed_at = excluded.observed_at
  `).bind(userId, deviceId, JSON.stringify(stored), observedAt).run();
  return json({ ok: true, observedAt });
}

async function handlePreferences(
  request: Request,
  env: AttentionRelayEnv,
  userId: string,
): Promise<Response> {
  if (request.method === "GET") {
    const row = await env.DB
      .prepare("select payload_json, updated_at from attention_preferences where user_id = ? limit 1")
      .bind(userId)
      .first<{ payload_json: string; updated_at: string }>();
    let preferences: Record<string, unknown> | null = null;
    if (row) {
      try {
        const parsed = JSON.parse(row.payload_json);
        preferences = isRecord(parsed) ? parsed : null;
      } catch {
        preferences = null;
      }
    }
    return json({
      ok: true,
      preferences,
      updatedAt: row?.updated_at ?? null,
    });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) return json({ ok: false, error: "invalid preferences" }, { status: 400 });
  const preservesDevices = !Object.prototype.hasOwnProperty.call(payload, "devices");
  const preservesMachines = !Object.prototype.hasOwnProperty.call(payload, "machines");
  const preservesProjects = !Object.prototype.hasOwnProperty.call(payload, "projects");
  const result = await mutateAttentionPreferences(env, userId, (current) => ({
    ...payload,
    ...(preservesDevices && isRecord(current.devices)
      ? { devices: current.devices }
      : {}),
    ...(preservesMachines && isRecord(current.machines)
      ? { machines: current.machines }
      : {}),
    ...(preservesProjects && isRecord(current.projects)
      ? { projects: current.projects }
      : {}),
  }));
  if ("response" in result) return result.response;
  await deliverAccountLiveActivity(env, userId);
  return json({
    ok: true,
    preferences: result.preferences,
    updatedAt: result.updatedAt,
  });
}

async function mutateAttentionPreferences(
  env: AttentionRelayEnv,
  userId: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<
  | { preferences: Record<string, unknown>; updatedAt: string }
  | { response: Response }
> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await env.DB
      .prepare("select payload_json from attention_preferences where user_id = ? limit 1")
      .bind(userId)
      .first<{ payload_json: string }>();
    let current: Record<string, unknown> = {};
    if (row) {
      try {
        const parsed = JSON.parse(row.payload_json);
        if (isRecord(parsed)) current = parsed;
      } catch {
        current = {};
      }
    }
    const preferences = mutate(current);
    if (
      preferences.machines != null
      && (
        !isRecord(preferences.machines)
        || Object.keys(preferences.machines).length > MAX_ATTENTION_MACHINE_PREFERENCES
      )
    ) {
      return {
        response: json(
          { ok: false, error: "invalid machine preferences" },
          { status: 400 },
        ),
      };
    }
    const serialized = JSON.stringify(preferences);
    if (serialized.length > 32_000) {
      return {
        response: json(
          { ok: false, error: "preferences too large" },
          { status: 413 },
        ),
      };
    }
    const updatedAt = new Date().toISOString();
    const committed = row
      ? await env.DB.prepare(`
          update attention_preferences
          set payload_json = ?, updated_at = ?
          where user_id = ? and payload_json = ?
          returning payload_json
        `).bind(serialized, updatedAt, userId, row.payload_json)
        .first<{ payload_json: string }>()
      : await env.DB.prepare(`
          insert into attention_preferences(user_id, payload_json, updated_at)
          values (?, ?, ?)
          on conflict(user_id) do nothing
          returning payload_json
        `).bind(userId, serialized, updatedAt)
        .first<{ payload_json: string }>();
    if (committed) return { preferences, updatedAt };
  }
  return {
    response: json(
      { ok: false, error: "preferences changed concurrently; retry" },
      { status: 409 },
    ),
  };
}

async function handleDevicePreferences(
  request: Request,
  env: AttentionRelayEnv,
  userId: string,
  deviceId: string,
): Promise<Response> {
  if (!requiredString(deviceId, 128)) {
    return json({ ok: false, error: "invalid device id" }, { status: 400 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) {
    return json({ ok: false, error: "invalid device preferences" }, { status: 400 });
  }
  const result = await mutateAttentionPreferences(env, userId, (current) => {
    const devices = isRecord(current.devices) ? current.devices : {};
    const device = isRecord(devices[deviceId]) ? devices[deviceId] : {};
    return {
      ...current,
      devices: {
        ...devices,
        [deviceId]: {
          ...device,
          ...payload,
        },
      },
    };
  });
  if ("response" in result) return result.response;
  await deliverAccountLiveActivity(env, userId);
  return json({
    ok: true,
    preferences: result.preferences,
    updatedAt: result.updatedAt,
  });
}

async function handleActivityMachinePreferences(
  request: Request,
  env: AttentionRelayEnv,
  userId: string,
  machineKey: string,
): Promise<Response> {
  if (!requiredString(machineKey, 128)) {
    return json({ ok: false, error: "invalid machine key" }, { status: 400 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) {
    return json({ ok: false, error: "invalid machine preferences" }, { status: 400 });
  }
  const result = await mutateAttentionPreferences(env, userId, (current) => {
    const machines = isRecord(current.machines) ? current.machines : {};
    const machine = isRecord(machines[machineKey]) ? machines[machineKey] : {};
    return {
      ...current,
      machines: {
        ...machines,
        [machineKey]: {
          ...machine,
          ...payload,
        },
      },
    };
  });
  if ("response" in result) return result.response;
  await deliverAccountLiveActivity(env, userId);
  return json({
    ok: true,
    preferences: result.preferences,
    updatedAt: result.updatedAt,
  });
}

/**
 * Did this account hold this machine? Any surface the machine touched counts:
 * its roster link, an item it published, an install it seeded, or the legacy
 * claim row `linkMachineToAccount` maintains. A legitimate removal — of a
 * machine the account could see well enough to click "remove" on — always
 * satisfies at least one of them.
 *
 * None of that evidence is writable by the account asking: every row is created
 * by a publish, and `handleAttentionMachinePublish` will only accept a machine
 * key the caller proved with that machine's relay secret
 * (`VerifiedMachineIdentity`). Without that binding this guard would read as
 * enforcement while being self-minted — name a stranger's key, publish an empty
 * delta to seed a link row, then "remove" it and terminal-403 their machine
 * through `machineKeyRevokedAt`'s any-account block.
 *
 * The `not exists` clause is the other half: evidence is HISTORICAL, and a key
 * that has since moved to another account must not still be revocable by the
 * account it left. Otherwise the previous owner can brick the new owner's
 * machine on the legacy routes at any time.
 */
async function accountKnowsMachine(
  env: AttentionRelayEnv,
  userId: string,
  machineKey: string,
): Promise<boolean> {
  const row = await env.DB.prepare(`
    select 1 as known
    where not exists (
        select 1 from attention_machine_links
         where machine_key = ? and user_id <> ?
      )
      and (
        exists (
          select 1 from attention_machine_links
           where user_id = ? and machine_key = ?
        )
        or exists (
          select 1 from attention_items
           where user_id = ? and machine_key = ?
        )
        or exists (
          select 1 from attention_devices
           where user_id = ? and source_machine_key = ?
        )
        or exists (
          select 1 from machines
           where machine_key = ? and account_user_id = ?
        )
      )
  `).bind(
    machineKey,
    userId,
    userId,
    machineKey,
    userId,
    machineKey,
    userId,
    machineKey,
    machineKey,
    userId,
  ).first<{ known: number }>();
  return row != null;
}

/**
 * Account-directory hook for "remove this machine from my account". The
 * directory owns the roster; the relay owns the feed, and the two live in
 * different workers over different databases, so removal has to be forwarded
 * here explicitly or the removed machine's rows stay in the account forever
 * (idle rows carry no expiry) and it keeps publishing new ones.
 */
async function handleAccountMachineRemoval(
  env: AttentionRelayEnv,
  userId: string,
  machineKey: string,
): Promise<Response> {
  if (!requiredString(machineKey, 128)) {
    return json({ ok: false, error: "invalid machine key" }, { status: 400 });
  }
  const now = new Date().toISOString();
  // Revoke only a machine this account currently holds. `machineKey` is a path
  // parameter with no ownership check of its own, and machine keys are not
  // secret — they ride published items as `accountMachineKey` and appear in
  // deeplink query strings. Combined with `machineKeyRevokedAt`'s deliberate
  // any-account block, an unchecked insert would let any signed-in account
  // terminal-403 a stranger's machine by naming its key. `accountKnowsMachine`
  // answers it from rows only a signature-bound publish can create, so a
  // fabricated removal degrades to a no-op instead of a weapon; the purge itself
  // is already account-scoped and harmlessly empty for a key this account never
  // had.
  const knownMachine = await accountKnowsMachine(env, userId, machineKey);
  const purge = await purgeAccountMachineActivity(env, {
    userId,
    machineKey,
    now,
    revoke: knownMachine,
  });
  return json({
    ok: true,
    machineKey,
    revision: purge.revision,
    removedItems: purge.removedItems,
    revokedAt: knownMachine ? now : null,
  });
}

/**
 * Deliberate re-pair of a previously removed machine. The directory calls this
 * before it lets the machine register again, so the two revocation records
 * clear in the same user action instead of leaving a machine that is on the
 * roster but silently unable to publish.
 *
 * Directory provenance is mandatory here and checked BEFORE anything else: this
 * is the one account route whose effect is to un-revoke, so the account bearer
 * token a removed machine still holds must not be sufficient on its own. See
 * `assertDirectoryProvenance`.
 */
async function handleAccountMachinePairingRestore(
  request: Request,
  env: AttentionRelayEnv,
  userId: string,
  machineKey: string,
): Promise<Response> {
  const provenance = assertDirectoryProvenance(request, env);
  if ("response" in provenance) return provenance.response;
  if (!requiredString(machineKey, 128)) {
    return json({ ok: false, error: "invalid machine key" }, { status: 400 });
  }
  const revokedAt = await accountMachineRevokedAt(env, userId, machineKey);
  await env.DB
    .prepare("delete from attention_revoked_machines where user_id = ? and machine_key = ?")
    .bind(userId, machineKey)
    .run();
  return json({ ok: true, machineKey, restored: revokedAt !== null });
}

async function deleteAttentionDeviceOwnership(
  env: AttentionRelayEnv,
  userId: string,
  deviceId: string,
): Promise<void> {
  await env.DB.batch(attentionDeviceOwnershipDeleteStatements(env, userId, deviceId));
}

async function handleDeviceRegistration(
  request: Request,
  env: AttentionRelayEnv,
  userId: string,
  deviceId: string,
): Promise<Response> {
  if (!requiredString(deviceId, 128)) {
    return json({ ok: false, error: "invalid device id" }, { status: 400 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) return json({ ok: false, error: "invalid device" }, { status: 400 });
  const ownershipEpoch = parsedOwnershipEpoch(payload.ownershipEpoch);
  if (ownershipEpoch === null) {
    return json({ ok: false, error: "invalid ownership epoch" }, { status: 400 });
  }
  const rawApnsToken = payload.apnsToken == null
    ? null
    : requiredString(payload.apnsToken, 512);
  if (
    rawApnsToken !== null
    && (!rawApnsToken || !APNS_TOKEN_PATTERN.test(rawApnsToken))
  ) {
    return json({ ok: false, error: "invalid device routing" }, { status: 400 });
  }
  if (request.method === "DELETE") {
    const deviceOwnership = await attentionDeviceOwnershipRows(env, deviceId, null);
    const registeredDevice = await env.DB.prepare(`
      select apns_token
      from attention_devices
      where device_id = ?
      limit 1
    `).bind(deviceId).first<{ apns_token: string | null }>();
    const apnsToken = deviceOwnership.find((row) => row.device_id === deviceId)?.apns_token
      ?? rawApnsToken
      ?? registeredDevice?.apns_token
      ?? null;
    const ownershipRows = apnsToken
      ? await attentionDeviceOwnershipRows(env, deviceId, apnsToken)
      : deviceOwnership;
    const staleEpoch = staleAttentionDeviceOwnershipEpoch(
      ownershipRows,
      userId,
      ownershipEpoch,
    );
    if (staleEpoch !== null) {
      return attentionDeviceOwnershipConflict(staleEpoch);
    }
    const conflicts = apnsToken
      ? await env.DB.prepare(`
          select user_id, device_id
          from attention_devices
          where device_id = ? or apns_token = ?
        `).bind(deviceId, apnsToken).all<{ user_id: string; device_id: string }>()
      : await env.DB.prepare(`
          select user_id, device_id
          from attention_devices
          where device_id = ?
        `).bind(deviceId).all<{ user_id: string; device_id: string }>();
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    if (apnsToken) {
      statements.push(releasePriorApnsOwnershipStatement(env, {
        deviceId,
        userId,
        ownershipEpoch,
        apnsToken,
        updatedAt: now,
      }));
    }
    statements.push(attentionDeviceOwnershipUpsertStatement(env, {
      deviceId,
      userId,
      ownershipEpoch,
      apnsToken,
      active: false,
      updatedAt: now,
    }));
    statements.push(...conflicts.results.flatMap((conflict) =>
      attentionDeviceOwnershipDeleteStatements(env, conflict.user_id, conflict.device_id)
    ));
    try {
      await env.DB.batch(statements);
    } catch (error) {
      if (isStaleAttentionDeviceOwnershipError(error)) {
        return attentionDeviceOwnershipConflict(
          await latestAttentionDeviceOwnershipEpoch(
            env,
            deviceId,
            apnsToken,
            ownershipEpoch,
          ),
        );
      }
      throw error;
    }
    return json({ ok: true, deviceId, ownershipEpoch });
  }
  const bundleId = requiredString(payload.bundleId, 200);
  const apsEnvironment = payload.apsEnvironment;
  const apnsToken = rawApnsToken;
  const pushToStartToken = payload.pushToStartToken == null
    ? null
    : requiredString(payload.pushToStartToken, 512);
  const clearPushToStartToken = payload.clearPushToStartToken === true;
  if (
    !bundleId
    || (apsEnvironment !== "sandbox" && apsEnvironment !== "production")
    || (apnsToken !== null && (!apnsToken || !APNS_TOKEN_PATTERN.test(apnsToken)))
    || (
      pushToStartToken !== null
      && (!pushToStartToken || !APNS_TOKEN_PATTERN.test(pushToStartToken))
    )
    || (pushToStartToken !== null && clearPushToStartToken)
  ) {
    return json({ ok: false, error: "invalid device routing" }, { status: 400 });
  }
  const ownershipRows = await attentionDeviceOwnershipRows(env, deviceId, apnsToken);
  const staleEpoch = staleAttentionDeviceOwnershipEpoch(
    ownershipRows,
    userId,
    ownershipEpoch,
  );
  if (staleEpoch !== null) {
    return attentionDeviceOwnershipConflict(staleEpoch);
  }
  // A physical installation/APNs token belongs to exactly one authenticated
  // account stream at a time.
  const conflicts = apnsToken
    ? await env.DB.prepare(`
        select user_id, device_id
        from attention_devices
        where not (user_id = ? and device_id = ?)
          and (device_id = ? or apns_token = ?)
      `).bind(userId, deviceId, deviceId, apnsToken).all<{ user_id: string; device_id: string }>()
    : await env.DB.prepare(`
        select user_id, device_id
        from attention_devices
        where not (user_id = ? and device_id = ?)
          and device_id = ?
      `).bind(userId, deviceId, deviceId).all<{ user_id: string; device_id: string }>();
  const existingDevice = await env.DB
    .prepare("select 1 as found from attention_devices where user_id = ? and device_id = ? limit 1")
    .bind(userId, deviceId)
    .first<{ found: number }>();
  const existingOwnership = ownershipRows.find((row) =>
    row.user_id === userId && row.device_id === deviceId
  );
  const ownershipChanged = Boolean(
    existingDevice?.found
    && (
      !existingOwnership
      || existingOwnership.ownership_epoch !== ownershipEpoch
    ),
  );
  const deviceCount = await env.DB
    .prepare("select count(*) as count from attention_devices where user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  const destinationConflicts = new Set(
    conflicts.results
      .filter((conflict) => conflict.user_id === userId)
      .map((conflict) => conflict.device_id),
  ).size;
  const projectedDeviceCount = Number(deviceCount?.count ?? 0)
    - destinationConflicts
    + (existingDevice?.found ? 0 : 1);
  if (projectedDeviceCount > MAX_ATTENTION_DEVICES) {
    return json({ ok: false, error: "account device limit reached" }, { status: 409 });
  }
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + ATTENTION_DEVICE_LEASE_MS).toISOString();
  const generation = crypto.randomUUID();
  const preferences = isRecord(payload.preferences) ? payload.preferences : {};
  const transferStatements: D1PreparedStatement[] = [];
  if (apnsToken) {
    transferStatements.push(releasePriorApnsOwnershipStatement(env, {
      deviceId,
      userId,
      ownershipEpoch,
      apnsToken,
      updatedAt: now,
    }));
  }
  transferStatements.push(attentionDeviceOwnershipUpsertStatement(env, {
    deviceId,
    userId,
    ownershipEpoch,
    apnsToken,
    active: true,
    updatedAt: now,
  }));
  transferStatements.push(...conflicts.results.flatMap((conflict) =>
    attentionDeviceOwnershipDeleteStatements(env, conflict.user_id, conflict.device_id)
  ));
  transferStatements.push(
    env.DB.prepare(`
      insert into attention_devices(
        user_id, device_id, source_machine_key, apns_token, push_to_start_token,
        bundle_id, aps_environment, platform, device_name, preferences_json,
        registered_at, updated_at, lease_expires_at, generation
      ) values (?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(user_id, device_id) do update set
        apns_token = coalesce(excluded.apns_token, attention_devices.apns_token),
        push_to_start_token = case
          when ? then null
          else coalesce(excluded.push_to_start_token, attention_devices.push_to_start_token)
        end,
        bundle_id = excluded.bundle_id,
        aps_environment = excluded.aps_environment,
        platform = excluded.platform,
        device_name = excluded.device_name,
        preferences_json = excluded.preferences_json,
        updated_at = excluded.updated_at,
        lease_expires_at = excluded.lease_expires_at,
        generation = case
          when ? then excluded.generation
          when excluded.apns_token is not null
            and excluded.apns_token is not attention_devices.apns_token
            then excluded.generation
          when excluded.push_to_start_token is not null
            and excluded.push_to_start_token is not attention_devices.push_to_start_token
            then excluded.generation
          when excluded.bundle_id is not attention_devices.bundle_id
            then excluded.generation
          when excluded.aps_environment is not attention_devices.aps_environment
            then excluded.generation
          else attention_devices.generation
        end
    `).bind(
      userId,
      deviceId,
      apnsToken,
      pushToStartToken,
      bundleId,
      apsEnvironment,
      requiredString(payload.platform, 32),
      boundedText(payload.deviceName, 120),
      JSON.stringify(preferences),
      now,
      now,
      leaseExpiresAt,
      generation,
      clearPushToStartToken ? 1 : 0,
      clearPushToStartToken || ownershipChanged ? 1 : 0,
    ),
  );
  if (!clearPushToStartToken) {
    transferStatements.push(
      env.DB.prepare(`
        delete from attention_activity_state
        where user_id = ? and device_id = ? and started = 0
          and exists (
            select 1
            from attention_devices
            where user_id = ? and device_id = ? and generation = ?
          )
      `).bind(userId, deviceId, userId, deviceId, generation),
    );
  }
  if (clearPushToStartToken) {
    transferStatements.push(
      env.DB
        .prepare("delete from attention_activity_tokens where user_id = ? and device_id = ?")
        .bind(userId, deviceId),
      env.DB
        .prepare("delete from attention_activity_state where user_id = ? and device_id = ?")
        .bind(userId, deviceId),
    );
  }
  // D1 batches are transactional: a failed destination insert rolls back all
  // ownership and Live Activity mutations, so a transfer cannot orphan the
  // previous account and an explicit token clear cannot leave stale state.
  try {
    await env.DB.batch(transferStatements);
  } catch (error) {
    if (isAttentionDeviceLimitError(error)) {
      return json({ ok: false, error: "account device limit reached" }, { status: 409 });
    }
    if (isStaleAttentionDeviceOwnershipError(error)) {
      return attentionDeviceOwnershipConflict(
        await latestAttentionDeviceOwnershipEpoch(
          env,
          deviceId,
          apnsToken,
          ownershipEpoch,
        ),
      );
    }
    throw error;
  }
  await deliverAccountLiveActivity(env, userId);
  return json({ ok: true, deviceId, ownershipEpoch, updatedAt: now });
}

async function handleActivityTokenRegistration(
  request: Request,
  env: AttentionRelayEnv,
  userId: string,
  deviceId: string,
  activityId: string,
): Promise<Response> {
  if (!requiredString(deviceId, 128) || !requiredString(activityId, 128)) {
    return json({ ok: false, error: "invalid activity target" }, { status: 400 });
  }
  const device = await env.DB
    .prepare("select 1 as found from attention_devices where user_id = ? and device_id = ? and lease_expires_at > ? limit 1")
    .bind(userId, deviceId, new Date().toISOString())
    .first<{ found: number }>();
  if (!device?.found) {
    return json({ ok: false, error: "attention device is not registered" }, { status: 404 });
  }
  if (request.method === "DELETE") {
    const generation = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`
        update attention_devices
        set generation = ?, updated_at = ?
        where user_id = ? and device_id = ? and lease_expires_at > ?
      `).bind(
        generation,
        new Date().toISOString(),
        userId,
        deviceId,
        new Date().toISOString(),
      ),
      env.DB.prepare(`
        delete from attention_activity_tokens
        where user_id = ? and device_id = ? and activity_id = ?
          and exists (
            select 1
            from attention_devices
            where user_id = ? and device_id = ? and generation = ?
          )
      `).bind(userId, deviceId, activityId, userId, deviceId, generation),
      env.DB.prepare(`
        delete from attention_activity_state
        where user_id = ? and device_id = ? and activity_id = ?
          and exists (
            select 1
            from attention_devices
            where user_id = ? and device_id = ? and generation = ?
          )
      `).bind(userId, deviceId, activityId, userId, deviceId, generation),
    ]);
    // The device is the authority on whether ActivityKit actually materialized
    // an APNs-accepted start. Recompute immediately so active account work can
    // issue a fresh push-to-start instead of remaining stuck forever.
    await deliverAccountLiveActivity(env, userId);
    return json({ ok: true, removed: true });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const token = isRecord(payload) ? requiredString(payload.token, 512) : null;
  if (!token || !APNS_TOKEN_PATTERN.test(token)) {
    return json({ ok: false, error: "invalid activity token" }, { status: 400 });
  }
  const generation = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      update attention_devices
      set generation = ?, updated_at = ?
      where user_id = ? and device_id = ? and lease_expires_at > ?
    `).bind(generation, now, userId, deviceId, now),
    env.DB.prepare(`
      insert into attention_activity_tokens(
        user_id, device_id, activity_id, token, updated_at
      )
      select ?, ?, ?, ?, ?
      where exists (
        select 1
        from attention_devices
        where user_id = ? and device_id = ? and generation = ?
      )
      on conflict(user_id, device_id, activity_id) do update set
        token = excluded.token,
        updated_at = excluded.updated_at
    `).bind(
      userId,
      deviceId,
      activityId,
      token,
      now,
      userId,
      deviceId,
      generation,
    ),
    env.DB.prepare(`
      insert into attention_activity_state(
        user_id, device_id, activity_id, started, fingerprint, updated_at
      )
      select ?, ?, ?, 1, null, ?
      where exists (
        select 1
        from attention_devices
        where user_id = ? and device_id = ? and generation = ?
      )
      on conflict(user_id, device_id, activity_id) do update set
        started = 1,
        updated_at = excluded.updated_at
    `).bind(
      userId,
      deviceId,
      activityId,
      now,
      userId,
      deviceId,
      generation,
    ),
  ]);
  await deliverAccountLiveActivity(env, userId);
  return json({ ok: true, removed: false });
}

async function handleAuthorizedAttentionAccountRequest(
  request: Request,
  env: AttentionRelayEnv,
  url: URL,
  userId: string,
): Promise<Response | null> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "attention" || parts[1] !== "account") return null;
  const route = parts.slice(2);
  if (route.length === 1 && route[0] === "snapshot" && request.method === "GET") {
    return await handleSnapshot(env, userId, url);
  }
  if (route.length === 1 && route[0] === "ack" && request.method === "POST") {
    return await handleAcknowledgment(request, env, userId);
  }
  if (route.length === 1 && route[0] === "presence" && request.method === "POST") {
    return await handlePresence(request, env, userId);
  }
  if (route.length === 1 && route[0] === "preferences" && (request.method === "GET" || request.method === "PUT")) {
    return await handlePreferences(request, env, userId);
  }
  if (
    route.length === 3
    && route[0] === "preferences"
    && route[1] === "devices"
    && request.method === "PATCH"
  ) {
    return await handleDevicePreferences(
      request,
      env,
      userId,
      decodeURIComponent(route[2] ?? ""),
    );
  }
  if (
    route.length === 3
    && route[0] === "preferences"
    && route[1] === "machines"
    && request.method === "PATCH"
  ) {
    return await handleActivityMachinePreferences(
      request,
      env,
      userId,
      decodeURIComponent(route[2] ?? ""),
    );
  }
  if (
    route.length === 2
    && route[0] === "machines"
    && request.method === "DELETE"
  ) {
    return await handleAccountMachineRemoval(
      env,
      userId,
      decodeURIComponent(route[1] ?? ""),
    );
  }
  if (
    route.length === 3
    && route[0] === "machines"
    && route[2] === "pairing"
    && request.method === "POST"
  ) {
    return await handleAccountMachinePairingRestore(
      request,
      env,
      userId,
      decodeURIComponent(route[1] ?? ""),
    );
  }
  if (
    route.length === 2
    && route[0] === "devices"
    && (request.method === "PUT" || request.method === "DELETE")
  ) {
    return await handleDeviceRegistration(
      request,
      env,
      userId,
      decodeURIComponent(route[1] ?? ""),
    );
  }
  if (
    route.length === 4
    && route[0] === "devices"
    && route[2] === "activities"
    && (request.method === "PUT" || request.method === "DELETE")
  ) {
    return await handleActivityTokenRegistration(
      request,
      env,
      userId,
      decodeURIComponent(route[1] ?? ""),
      decodeURIComponent(route[3] ?? ""),
    );
  }
  return json({ ok: false, error: "not found" }, { status: 404 });
}

export async function handleAttentionAccountRequest(
  request: Request,
  env: AttentionRelayEnv,
  url: URL,
): Promise<Response | null> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "attention" || parts[1] !== "account") return null;
  const account = await authorizedUser(request, env);
  if ("response" in account) return account.response;
  return await handleAuthorizedAttentionAccountRequest(
    request,
    env,
    url,
    account.userId,
  );
}

/**
 * Retire items whose publisher gave them a finite lifetime. Dropping the rows
 * alone is not enough: protocol 2 deltas never imply deletion, so a client that
 * already holds an expired row would keep it forever once the row stops
 * appearing in snapshot pages. Each account's expired rows leave as tombstones
 * inside one revision so every surface converges on the removal.
 */
async function sweepExpiredAttentionItems(
  env: AttentionRelayEnv,
  now: string,
): Promise<void> {
  const accounts = await env.DB.prepare(`
    select distinct user_id
    from attention_items
    where expires_at is not null and expires_at <= ?
    limit ?
  `).bind(now, MAX_SWEPT_ACCOUNTS_PER_PRUNE).all<{ user_id: string }>();
  for (const account of accounts.results) {
    await commitAttentionRevision(env, account.user_id, [
      env.DB.prepare(`
        insert into attention_tombstones(
          user_id, item_id, source_revision, account_revision, revivable, deleted_at
        )
        select user_id, item_id, source_revision,
          (select revision from attention_revisions where user_id = ?), 0, ?
        from attention_items
        where user_id = ? and expires_at is not null and expires_at <= ?
        on conflict(user_id, item_id) do update set
          source_revision = excluded.source_revision,
          account_revision = excluded.account_revision,
          revivable = 0,
          deleted_at = excluded.deleted_at
        where excluded.source_revision >= attention_tombstones.source_revision
      `).bind(account.user_id, now, account.user_id, now),
      env.DB.prepare(`
        delete from attention_items
        where user_id = ? and expires_at is not null and expires_at <= ?
      `).bind(account.user_id, now),
    ], now);
  }
}

/**
 * Retire rows whose owning machine is gone. The roster-epoch sweep is scoped to
 * one machine and only runs while that machine publishes, so rows survive both
 * a machine-key rotation (the old key never publishes again) and a link deleted
 * out from under them. This is the account-level counterpart: it needs no
 * cooperation from the source machine. Staleness is read from the machine's
 * presence when it still has a link, and from its newest item otherwise, so a
 * machine that is merely quiet between publishes is never swept.
 */
async function sweepOrphanedMachineActivity(
  env: AttentionRelayEnv,
  now: string,
): Promise<void> {
  const staleCutoff = new Date(
    Date.parse(now) - ORPHANED_MACHINE_ACTIVITY_MS,
  ).toISOString();
  const orphans = await env.DB.prepare(`
    select item.user_id as user_id, item.machine_key as machine_key
    from attention_items as item
    left join attention_machine_links as link
      on link.user_id = item.user_id
      and link.machine_key = item.machine_key
    group by item.user_id, item.machine_key
    having coalesce(max(link.last_seen_at), max(item.updated_at)) <= ?
    limit ?
  `).bind(staleCutoff, MAX_SWEPT_ACCOUNTS_PER_PRUNE).all<{
    user_id: string;
    machine_key: string;
  }>();
  for (const orphan of orphans.results) {
    // Not a revocation: the machine was never removed from the account, it just
    // stopped reporting. If it comes back, its next publish relinks and
    // republishes normally.
    await purgeAccountMachineActivity(env, {
      userId: orphan.user_id,
      machineKey: orphan.machine_key,
      now,
      revoke: false,
    });
  }
}

/**
 * The expensive half of Attention maintenance: CRON ONLY, never a request.
 *
 * Both sweeps are unbounded scans that fan out into per-account work —
 * `sweepExpiredAttentionItems` runs up to `MAX_SWEPT_ACCOUNTS_PER_PRUNE` SERIAL
 * `commitAttentionRevision` batches, and `sweepOrphanedMachineActivity` runs an
 * unindexed full aggregate over `attention_items` and then calls
 * `purgeAccountMachineActivity` → `deliverAccountLiveActivity` → an outbound
 * APNs fetch per device for each orphan it finds. Hung off device registration
 * and publish (as they were) a routine re-registration paid dozens of
 * subrequests and could hit the Worker CPU/subrequest ceiling on someone else's
 * backlog. Neither sweep is latency-sensitive: retention is measured in days.
 */
export async function sweepAttentionState(env: AttentionRelayEnv): Promise<void> {
  const now = new Date().toISOString();
  await sweepExpiredAttentionItems(env, now);
  await sweepOrphanedMachineActivity(env, now);
}

/**
 * The cheap half: bounded retention deletes, safe to run opportunistically from
 * a request. Anything added here must stay a pure DELETE over an indexed
 * predicate — per-account or per-device fan-out belongs in `sweepAttentionState`.
 */
export async function pruneAttentionState(env: AttentionRelayEnv): Promise<void> {
  const now = new Date();
  const tombstoneCutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_MS).toISOString();
  const presenceCutoff = new Date(now.getTime() - 10 * 60 * 1_000).toISOString();
  const receiptCutoff = new Date(
    now.getTime() - ATTENTION_DELIVERY_RECEIPT_RETENTION_MS,
  ).toISOString();
  const alertLogCutoff = new Date(
    now.getTime() - ATTENTION_ALERT_LOG_RETENTION_MS,
  ).toISOString();
  const expiredDevices = await env.DB.prepare(`
    select user_id, device_id
    from attention_devices
    where lease_expires_at <= ?
  `).bind(now.toISOString()).all<{ user_id: string; device_id: string }>();
  for (const device of expiredDevices.results) {
    await deleteAttentionDeviceOwnership(env, device.user_id, device.device_id);
  }
  await Promise.all([
    env.DB.batch([
      env.DB.prepare(`
        delete from attention_delivery_receipts
        where delivered_at <= ?
      `).bind(receiptCutoff),
      env.DB.prepare(`
        delete from attention_alert_log
        where delivered_at <= ?
      `).bind(alertLogCutoff),
    ]),
    env.DB.prepare("delete from attention_tombstones where deleted_at <= ?")
      .bind(tombstoneCutoff)
      .run(),
    env.DB.prepare("delete from attention_presence where observed_at <= ?")
      .bind(presenceCutoff)
      .run(),
  ]);
}

/** Pure contract helpers exposed only so relay tests can cover trust boundaries. */
export const attentionTestInternals = Object.freeze({
  accountMachineRevokedAt,
  activityPublishAcknowledgments,
  attentionAlertRoutingPayload,
  attentionFullSnapshotUnchanged,
  attentionTombstoneBlocksItem,
  commitAttentionMachineChanges,
  commitActivityReconcileFinal,
  deepLinkForItem,
  deliverAccountLiveActivity,
  deliverAttentionNotifications,
  desktopEscalationDelayMs,
  handleAuthorizedAttentionAccountRequest,
  resolvedMutedSessionIds,
  implicitFullSnapshotTombstone,
  linkMachineToAccount,
  notificationTitle,
  normalizedSnapshotCursor,
  parseAttentionItem,
  purgeAccountMachineActivity,
  refreshActivityMachinePresence,
  resolveActivityDeliveryPreferences,
  sealCapacityTombstones,
  upsertAttentionTombstone,
  MAX_ALERT_AGE_MS,
});
