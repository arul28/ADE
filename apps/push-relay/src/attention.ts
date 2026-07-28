import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  sendApnsPush,
  type ApnsEnvironment,
  type ApnsKeyConfig,
  type ApnsSendResult,
} from "./apns";

export type AttentionRelayEnv = {
  DB: D1Database;
  CLERK_JWKS_URL?: string;
  CLERK_ISSUER?: string;
  CLERK_OAUTH_CLIENT_ID?: string;
  CLERK_SECONDARY_JWKS_URL?: string;
  CLERK_SECONDARY_ISSUER?: string;
  CLERK_SECONDARY_OAUTH_CLIENT_ID?: string;
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_DEFAULT_TOPIC?: string;
};

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

type AttentionDeviceRow = {
  device_id: string;
  apns_token: string | null;
  push_to_start_token: string | null;
  bundle_id: string;
  aps_environment: string;
  preferences_json: string;
};

type AttentionDeviceOwnershipRow = {
  device_id: string;
  user_id: string;
  ownership_epoch: number;
  apns_token: string | null;
};

type ParsedAttentionItem = Record<string, unknown> & {
  contractVersion: 1;
  id: string;
  revision: number;
  fingerprint: string;
  kind: "agent" | "pull_request";
  eventKind: string;
  phase: string;
  title: string;
  preview: string;
  privacyPreview: string;
  updatedAt: string;
  expiresAt: string | null;
  machine: Record<string, unknown> & { machineKey: string; name: string };
  project: {
    projectId: string;
    name: string;
    rootPath: string | null;
  };
  destination: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
};

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ATTENTION_ITEMS = 64;
const MAX_ATTENTION_TOMBSTONES = 64;
const MAX_ATTENTION_DEVICES = 32;
const ATTENTION_DEVICE_LEASE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_NOTIFICATION_ATTEMPTS_PER_PUBLISH = 64;
const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 180;
const MAX_PREVIEW_LENGTH = 320;
const MAX_DETAIL_LENGTH = 1_000;
const APNS_TOKEN_PATTERN = /^[a-f0-9]{32,512}$/i;
const ACCOUNT_MACHINE_ONLINE_WINDOW_MS = 90_000;
const DEFAULT_DESKTOP_ESCALATION_DELAY_SECONDS = 30;
const DESKTOP_PRESENCE_WINDOW_MS = 45_000;
const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_OWNERSHIP_EPOCH_FUTURE_MS = 5 * 60 * 1_000;
const LIVE_ACTIVITY_START_CLAIM_TTL_MS = 30_000;
const remoteJwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

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

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(value: unknown, maxLength = MAX_ID_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function optionalIsoDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  const normalized = requiredString(value, 64);
  if (!normalized || Number.isNaN(Date.parse(normalized))) return undefined;
  return new Date(normalized).toISOString();
}

function boundedText(value: unknown, maxLength: number): string | null {
  const text = requiredString(value, maxLength * 4);
  if (!text) return null;
  const sanitized = text
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.slice(0, maxLength);
}

function apnsConfig(env: AttentionRelayEnv): ApnsKeyConfig | null {
  const keyPem = env.APNS_KEY?.trim() ?? "";
  const keyId = env.APNS_KEY_ID?.trim() ?? "";
  const teamId = env.APNS_TEAM_ID?.trim() ?? "";
  return keyPem && keyId && teamId ? { keyPem, keyId, teamId } : null;
}

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

function readPreferences(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function preferenceBoolean(
  device: Record<string, unknown>,
  account: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  if (typeof device[key] === "boolean") return device[key];
  if (typeof account[key] === "boolean") return account[key];
  return fallback;
}

function preferenceNumber(
  device: Record<string, unknown>,
  account: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  if (typeof device[key] === "number" && Number.isFinite(device[key])) return device[key];
  if (typeof account[key] === "number" && Number.isFinite(account[key])) return account[key];
  return fallback;
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
): D1PreparedStatement {
  return env.DB.prepare(`
    insert into attention_items(
      user_id, item_id, machine_key, source_revision, account_revision,
      fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
      expires_at, updated_at
    )
    select ?, ?, ?, ?, revision, ?, ?, ?, ?, null, null, ?, ?
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
      event_kind = excluded.event_kind,
      phase = excluded.phase,
      payload_json = excluded.payload_json,
      seen_at = case
        when attention_items.fingerprint = excluded.fingerprint then attention_items.seen_at
        else null
      end,
      dismissed_at = case
        when attention_items.fingerprint = excluded.fingerprint then attention_items.dismissed_at
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
    item.fingerprint,
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
    now: string;
  },
): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  for (const item of args.items) {
    statements.push(
      attentionItemUpsertStatement(env, args.userId, args.machineKey, item),
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

function mergedDevicePreferences(
  device: AttentionDeviceRow,
  accountPreferences: Record<string, unknown>,
  devicePreferences: Record<string, unknown>,
): Record<string, unknown> {
  const registered = readPreferences(device.preferences_json);
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

async function hasRecentForegroundDesktop(
  env: AttentionRelayEnv,
  userId: string,
  nowMs: number,
): Promise<boolean> {
  const cutoff = new Date(nowMs - DESKTOP_PRESENCE_WINDOW_MS).toISOString();
  const rows = await env.DB.prepare(`
    select payload_json
    from attention_presence
    where user_id = ? and observed_at >= ?
  `).bind(userId, cutoff).all<{ payload_json: string }>();
  return rows.results.some((row) => {
    const presence = readPreferences(row.payload_json);
    return presence.platform === "macOS" && presence.appForeground === true;
  });
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
  const eventPolicies = isRecord(accountPreferences.eventPolicies)
    ? accountPreferences.eventPolicies
    : {};
  const devicePreferences = isRecord(preferences.devices) ? preferences.devices : {};
  const nowMs = Date.now();
  const desktopForeground = await hasRecentForegroundDesktop(env, userId, nowMs);
  const desktopFirstEnabled = preferenceBoolean(
    {},
    accountPreferences,
    "desktopFirstEnabled",
    true,
  );
  const desktopFirstDelayMs = desktopEscalationDelayMs(accountPreferences);
  let notificationAttempts = 0;

  for (const item of items) {
    const policy = typeof eventPolicies[item.eventKind] === "string"
      ? eventPolicies[item.eventKind]
      : DEFAULT_NOTIFY_EVENTS.has(item.eventKind)
        ? "notify"
        : "ambient";
    if (policy !== "notify") continue;
    const current = await env.DB
      .prepare(`
        select source_revision, fingerprint, seen_at, dismissed_at
        from attention_items
        where user_id = ? and item_id = ?
        limit 1
      `)
      .bind(userId, item.id)
      .first<{
        source_revision: number;
        fingerprint: string;
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
      || current.fingerprint !== item.fingerprint
      || current.seen_at
      || current.dismissed_at
    ) {
      continue;
    }
    // Give an active desktop/notch the first chance to surface the item. The
    // machine heartbeat republishes the full snapshot every 30s; if the item
    // remains unseen, the next pass escalates it to the phone.
    if (
      desktopFirstEnabled
      && desktopForeground
      && nowMs - Date.parse(item.updatedAt) < desktopFirstDelayMs
    ) {
      continue;
    }

    const deepLink = deepLinkForItem(item);
    for (const device of devicesResult.results) {
      if (notificationAttempts >= MAX_NOTIFICATION_ATTEMPTS_PER_PUBLISH) return;
      if (!device.apns_token) continue;
      const override = mergedDevicePreferences(
        device,
        accountPreferences,
        devicePreferences,
      );
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
      const receiptState = `alert:${item.fingerprint.slice(0, 48)}`;
      const existing = await env.DB.prepare(`
        select 1 as found
        from attention_delivery_receipts
        where user_id = ? and item_id = ? and device_id = ? and state = ?
        limit 1
      `).bind(userId, item.id, device.device_id, receiptState).first<{ found: number }>();
      if (existing?.found) continue;

      const hideDetails = preferenceBoolean(override, accountPreferences, "hideDetails", false);
      const soundsEnabled = preferenceBoolean(override, accountPreferences, "soundsEnabled", false);
      const body = hideDetails
        ? boundedText(item.privacyPreview, MAX_PREVIEW_LENGTH)
        : boundedText(item.preview, MAX_PREVIEW_LENGTH);
      const result = await sendPush(config, {
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
            "thread-id": item.id,
            "interruption-level": item.eventKind === "agent_needs_you"
              ? "time-sensitive"
              : "active",
          },
          ...attentionAlertRoutingPayload(item, deepLink),
        },
      });
      notificationAttempts += 1;
      if (result.ok) {
        await env.DB.prepare(`
          insert into attention_delivery_receipts(user_id, item_id, device_id, state, delivered_at)
          values (?, ?, ?, ?, ?)
          on conflict(user_id, item_id, device_id, state) do nothing
        `).bind(
          userId,
          item.id,
          device.device_id,
          receiptState,
          new Date(nowMs).toISOString(),
        ).run();
      } else if (result.tokenInvalid) {
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
    case "stale":
    case "open": return 4;
    case "completed":
    case "merged": return 5;
    default: return 6;
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
  return {
    id: sessionId,
    accountMachineKey: requiredString(item.machine.accountMachineKey, 128),
    title: boundedText(item.title, MAX_TITLE_LENGTH) ?? "Agent run",
    phase,
    model: boundedText(item.model, 120),
    lane: boundedText(item.laneName, 160),
    detail: boundedText(item.preview, MAX_PREVIEW_LENGTH),
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

async function accountActivityContentState(
  env: AttentionRelayEnv,
  userId: string,
): Promise<{
  contentState: Record<string, unknown>;
  fingerprint: string;
  count: number;
  focusTitle: string | null;
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
      if ((item.phase === "completed" || item.phase === "merged") && row.seen_at) return [];
      return [item];
    } catch {
      return [];
    }
  }).sort((left, right) => {
    const priority = activityPriority(left) - activityPriority(right);
    if (priority !== 0) return priority;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
  const runs = items.flatMap((item) => {
    const run = activityRun(item);
    return run ? [run] : [];
  }).slice(0, 3);
  const prs = items.flatMap((item) => {
    const pr = activityPullRequest(item);
    return pr ? [pr] : [];
  }).slice(0, 2);
  const newestUpdate = items.reduce(
    (latest, item) => Math.max(latest, Date.parse(item.updatedAt)),
    0,
  );
  const activeCount = items.filter((item) =>
    item.kind === "agent"
    && (
      item.phase === "starting"
      || item.phase === "running"
      || item.phase === "needs_you"
      || item.phase === "blocked"
    )).length;
  const contentState = {
    updatedAt: Math.floor((newestUpdate || Date.now()) / 1_000),
    activeCount,
    runs,
    prs,
  };
  const fingerprintBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(contentState)),
  );
  const fingerprint = Array.from(new Uint8Array(fingerprintBuffer), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
  return {
    contentState,
    fingerprint,
    count: runs.length + prs.length,
    focusTitle: boundedText(items[0]?.title, MAX_TITLE_LENGTH),
  };
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

function notificationTitle(item: ParsedAttentionItem, hideDetails: boolean): string {
  if (!hideDetails) return boundedText(item.title, MAX_TITLE_LENGTH) ?? "ADE needs you";
  return item.kind === "pull_request" ? "ADE pull request update" : "ADE agent update";
}

async function claimAccountLiveActivityStart(
  env: AttentionRelayEnv,
  userId: string,
  deviceId: string,
  activityId: string,
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
    ) values (?, ?, ?, 0, ?, ?)
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
): Promise<void> {
  await env.DB
    .prepare(`
      delete from attention_activity_state
      where user_id = ? and device_id = ? and activity_id = ?
        and started = 0 and fingerprint = ?
    `)
    .bind(userId, deviceId, activityId, claim)
    .run();
}

async function deliverAccountLiveActivity(
  env: AttentionRelayEnv,
  userId: string,
): Promise<void> {
  const config = apnsConfig(env);
  if (!config) return;
  const activityId = "agent-runs";
  const [{ contentState, fingerprint, count, focusTitle }, devicesResult, preferencesRow] =
    await Promise.all([
      accountActivityContentState(env, userId),
      env.DB.prepare(`
        select device_id, apns_token, push_to_start_token, bundle_id,
          aps_environment, preferences_json
        from attention_devices
        where user_id = ? and lease_expires_at > ?
      `).bind(userId, new Date().toISOString()).all<AttentionDeviceRow>(),
      env.DB
        .prepare("select payload_json from attention_preferences where user_id = ? limit 1")
        .bind(userId)
        .first<{ payload_json: string }>(),
    ]);
  const preferences = readPreferences(preferencesRow?.payload_json);
  const accountPreferences = isRecord(preferences.account) ? preferences.account : {};
  const devicePreferences = isRecord(preferences.devices) ? preferences.devices : {};
  const nowSeconds = Math.floor(Date.now() / 1_000);

  for (const device of devicesResult.results) {
    const override = mergedDevicePreferences(
      device,
      accountPreferences,
      devicePreferences,
    );
    const state = await env.DB.prepare(`
      select started, fingerprint
      from attention_activity_state
      where user_id = ? and device_id = ? and activity_id = ?
      limit 1
    `).bind(userId, device.device_id, activityId).first<{
      started: number;
      fingerprint: string | null;
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
    const deviceContentState = liveActivitiesEnabled
      ? hideDetails
        ? privacyPreservingActivityContentState(contentState)
        : contentState
      : {
          updatedAt: nowSeconds,
          activeCount: 0,
          runs: [],
          prs: [],
        };
    const deviceFingerprint = hideDetails ? `${fingerprint}:private` : fingerprint;
    if (deviceCount === 0 && !started) continue;
    if (deviceCount > 0 && started && state?.fingerprint === deviceFingerprint) continue;

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
          .prepare("delete from attention_activity_state where user_id = ? and device_id = ? and activity_id = ?")
          .bind(userId, device.device_id, activityId)
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
      aps.attributes = { machineName: "All machines", accountWide: true };
      aps.alert = {
        title: hideDetails
          ? "ADE activity started"
          : deviceCount === 1
          ? focusTitle ?? "ADE activity started"
          : `${deviceCount} ADE items active`,
        body: "Across your signed-in machines",
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
        );
      }
      throw error;
    }
    if (result.ok) {
      if (event === "end") {
        await Promise.all([
          env.DB
            .prepare("delete from attention_activity_state where user_id = ? and device_id = ? and activity_id = ?")
            .bind(userId, device.device_id, activityId)
            .run(),
          env.DB
            .prepare("delete from attention_activity_tokens where user_id = ? and device_id = ? and activity_id = ?")
            .bind(userId, device.device_id, activityId)
            .run(),
        ]);
      } else if (event === "start" && startClaim) {
        await env.DB
          .prepare(`
            update attention_activity_state
            set started = 1, fingerprint = ?, updated_at = ?
            where user_id = ? and device_id = ? and activity_id = ?
              and started = 0 and fingerprint = ?
          `)
          .bind(
            deviceFingerprint,
            new Date().toISOString(),
            userId,
            device.device_id,
            activityId,
            startClaim,
          )
          .run();
      } else {
        await env.DB.prepare(`
          insert into attention_activity_state(
            user_id, device_id, activity_id, started, fingerprint, updated_at
          ) values (?, ?, ?, 1, ?, ?)
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
        );
      }
      if (result.tokenInvalid && event === "start") {
        await env.DB
          .prepare("update attention_devices set push_to_start_token = null where user_id = ? and device_id = ?")
          .bind(userId, device.device_id)
          .run();
      } else if (result.tokenInvalid) {
        await env.DB
          .prepare("delete from attention_activity_tokens where user_id = ? and device_id = ? and activity_id = ?")
          .bind(userId, device.device_id, activityId)
          .run();
      }
    }
  }
}

function audienceIncludes(audience: JWTPayload["aud"], expected: string): boolean {
  return typeof audience === "string"
    ? audience === expected
    : Array.isArray(audience) && audience.includes(expected);
}

async function verifyBearerToken(request: Request, env: AttentionRelayEnv): Promise<string | null> {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)\s*$/i);
  const token = match?.[1];
  if (!token) return null;
  const configurations = [
    {
      jwksUrl: env.CLERK_JWKS_URL?.trim() ?? "",
      issuer: env.CLERK_ISSUER?.trim() ?? "",
      oauthClientId: env.CLERK_OAUTH_CLIENT_ID?.trim() ?? "",
    },
    {
      jwksUrl: env.CLERK_SECONDARY_JWKS_URL?.trim() ?? "",
      issuer: env.CLERK_SECONDARY_ISSUER?.trim() ?? "",
      oauthClientId: env.CLERK_SECONDARY_OAUTH_CLIENT_ID?.trim() ?? "",
    },
  ].filter((config) => config.jwksUrl && config.issuer && config.oauthClientId);

  for (const config of configurations) {
    let jwks = remoteJwksByUrl.get(config.jwksUrl);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(config.jwksUrl));
      remoteJwksByUrl.set(config.jwksUrl, jwks);
    }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        algorithms: ["RS256"],
        clockTolerance: 5,
      });
      const subject = requiredString(payload.sub);
      if (!subject) continue;
      // Clerk's native session tokens have no audience; their `azp` may be
      // origin-based. OAuth access tokens are client-bound through `aud`/`azp`.
      // Keep this byte-for-byte in policy with apps/account-directory.
      if (
        payload.aud !== undefined
        && !audienceIncludes(payload.aud, config.oauthClientId)
        && payload.azp !== config.oauthClientId
      ) {
        continue;
      }
      // Development and production Clerk instances can emit the same opaque
      // `sub` shape. Namespace the database key by verified issuer so those
      // identity domains can never see or overwrite one another.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${config.issuer}\0${subject}`),
      );
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
    } catch {
      // Try the next configured issuer.
    }
  }
  return null;
}

async function authorizedUser(
  request: Request,
  env: AttentionRelayEnv,
): Promise<{ userId: string } | { response: Response }> {
  const userId = await verifyBearerToken(request, env);
  return userId
    ? { userId }
    : { response: json({ ok: false, error: "unauthorized" }, { status: 401 }) };
}

function parseAttentionItem(value: unknown, machineKey: string): ParsedAttentionItem | null {
  if (!isRecord(value) || value.contractVersion !== 1) return null;
  const id = requiredString(value.id);
  const revision = Number(value.revision);
  const fingerprint = requiredString(value.fingerprint);
  const kind = value.kind;
  const eventKind = requiredString(value.eventKind, 64);
  const phase = requiredString(value.phase, 64);
  const title = boundedText(value.title, MAX_TITLE_LENGTH);
  const preview = boundedText(value.preview, MAX_PREVIEW_LENGTH);
  const privacyPreview = boundedText(value.privacyPreview, MAX_PREVIEW_LENGTH);
  const updatedAt = optionalIsoDate(value.updatedAt);
  const occurredAt = optionalIsoDate(value.occurredAt);
  const expiresAt = optionalIsoDate(value.expiresAt);
  if (
    !id
    || !Number.isSafeInteger(revision)
    || revision < 0
    || !fingerprint
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
    fingerprint,
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
        registered_at, updated_at, lease_expires_at
      )
      select ?, legacy.device_id, ?, legacy.apns_token,
        legacy.push_to_start_token, legacy.bundle_id, aps_environment, platform,
        device_name, '{}', registered_at, updated_at, ?
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

export async function handleAttentionMachinePublish(
  request: Request,
  env: AttentionRelayEnv,
  machineKey: string,
  body: ArrayBuffer,
): Promise<Response> {
  const account = await authorizedUser(request, env);
  if ("response" in account) return account.response;
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
  const fullSnapshot = payload.fullSnapshot === true;
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const rawTombstones = Array.isArray(payload.tombstones) ? payload.tombstones : [];
  if (rawItems.length > MAX_ATTENTION_ITEMS || rawTombstones.length > MAX_ATTENTION_TOMBSTONES) {
    return json({ ok: false, error: "too many changes" }, { status: 400 });
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
  if (fullSnapshot) {
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
  await linkMachineToAccount(
    env,
    account.userId,
    machineKey,
    firstItem?.machine.name ?? machineName,
  );
  if (
    fullSnapshot
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
    const current = await env.DB
      .prepare("select revision from attention_revisions where user_id = ? limit 1")
      .bind(account.userId)
      .first<{ revision: number }>();
    return json({
      ok: true,
      revision: Number(current?.revision ?? 0),
      upserted: 0,
      removed: 0,
      unchanged: true,
    });
  }
  const now = new Date().toISOString();
  const accountRevision = await commitAttentionMachineChanges(env, {
    userId: account.userId,
    machineKey,
    items: items as ParsedAttentionItem[],
    tombstones,
    sealCapacityTombstones:
      fullSnapshot && rawItems.length < MAX_ATTENTION_ITEMS,
    now,
  });
  await deliverAttentionNotifications(
    env,
    account.userId,
    items as ParsedAttentionItem[],
  );
  await deliverAccountLiveActivity(env, account.userId);

  return json({
    ok: true,
    revision: accountRevision,
    upserted: items.length,
    removed: tombstones.length,
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
  const itemIds = payload.itemIds.map((value) => requiredString(value));
  if (itemIds.some((value) => value === null)) {
    return json({ ok: false, error: "invalid item id" }, { status: 400 });
  }
  const seenAt = optionalIsoDate(payload.seenAt ?? new Date().toISOString());
  const dismissedAt = optionalIsoDate(payload.dismissedAt);
  if (!seenAt || dismissedAt === undefined) {
    return json({ ok: false, error: "invalid timestamp" }, { status: 400 });
  }
  if (itemIds.length === 0) {
    const current = await env.DB
      .prepare("select revision from attention_revisions where user_id = ? limit 1")
      .bind(userId)
      .first<{ revision: number }>();
    return json({
      ok: true,
      revision: Number(current?.revision ?? 0),
      itemIds,
    });
  }
  const statements = (itemIds as string[]).map((itemId) =>
    env.DB.prepare(`
      update attention_items
      set seen_at = ?,
        dismissed_at = coalesce(?, dismissed_at),
        account_revision = (
          select revision
          from attention_revisions
          where user_id = ?
        )
      where user_id = ? and item_id = ?
    `).bind(seenAt, dismissedAt, userId, userId, itemId),
  );
  const revision = await commitAttentionRevision(env, userId, statements);
  await deliverAccountLiveActivity(env, userId);
  return json({ ok: true, revision, itemIds });
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
  const result = await mutateAttentionPreferences(env, userId, (current) => ({
    ...payload,
    ...(preservesDevices && isRecord(current.devices)
      ? { devices: current.devices }
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
        registered_at, updated_at, lease_expires_at
      ) values (?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        lease_expires_at = excluded.lease_expires_at
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
      clearPushToStartToken ? 1 : 0,
    ),
  );
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
    await Promise.all([
      env.DB
        .prepare("delete from attention_activity_tokens where user_id = ? and device_id = ? and activity_id = ?")
        .bind(userId, deviceId, activityId)
        .run(),
      env.DB
        .prepare("delete from attention_activity_state where user_id = ? and device_id = ? and activity_id = ?")
        .bind(userId, deviceId, activityId)
        .run(),
    ]);
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
  await env.DB.prepare(`
    insert into attention_activity_tokens(user_id, device_id, activity_id, token, updated_at)
    values (?, ?, ?, ?, ?)
    on conflict(user_id, device_id, activity_id) do update set
      token = excluded.token,
      updated_at = excluded.updated_at
  `).bind(userId, deviceId, activityId, token, new Date().toISOString()).run();
  await env.DB.prepare(`
    insert into attention_activity_state(
      user_id, device_id, activity_id, started, fingerprint, updated_at
    ) values (?, ?, ?, 1, null, ?)
    on conflict(user_id, device_id, activity_id) do update set
      started = 1,
      updated_at = excluded.updated_at
  `).bind(userId, deviceId, activityId, new Date().toISOString()).run();
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

export async function pruneAttentionState(env: AttentionRelayEnv): Promise<void> {
  const now = new Date();
  const tombstoneCutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_MS).toISOString();
  const presenceCutoff = new Date(now.getTime() - 10 * 60 * 1_000).toISOString();
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
        where not exists (
          select 1
          from attention_items
          where attention_items.user_id = attention_delivery_receipts.user_id
            and attention_items.item_id = attention_delivery_receipts.item_id
            and (
              attention_items.expires_at is null
              or attention_items.expires_at > ?
            )
        )
      `).bind(now.toISOString()),
      env.DB.prepare("delete from attention_items where expires_at is not null and expires_at <= ?")
        .bind(now.toISOString()),
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
  activityPullRequest,
  activityRun,
  attentionAlertRoutingPayload,
  attentionFullSnapshotUnchanged,
  attentionTombstoneBlocksItem,
  commitAttentionMachineChanges,
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
  privacyPreservingActivityContentState,
  sealCapacityTombstones,
  upsertAttentionTombstone,
});
