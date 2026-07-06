import {
  sendApnsPush,
  type ApnsEnvironment,
  type ApnsKeyConfig,
  type ApnsPushType,
  type ApnsSendResult,
} from "./apns";

export type PushRelayEnv = {
  DB: D1Database;
  /** PKCS#8 PEM contents of the APNs .p8 signing key (wrangler secret). */
  APNS_KEY?: string;
  /** 10-character APNs Key ID (wrangler secret or var). */
  APNS_KEY_ID?: string;
  /** Apple Developer Team ID (wrangler secret or var). */
  APNS_TEAM_ID?: string;
  /** Fallback apns-topic when a registration has no bundle id (should not happen). */
  APNS_DEFAULT_TOPIC?: string;
  REGISTRATION_RETENTION_DAYS?: string;
  MAX_DEVICES_PER_MACHINE?: string;
};

type MachineRow = {
  machine_key: string;
  secret: string;
};

type DeviceRow = {
  machine_key: string;
  device_id: string;
  apns_token: string | null;
  push_to_start_token: string | null;
  bundle_id: string;
  aps_environment: string;
  platform: string | null;
  device_name: string | null;
  registered_at: string;
  updated_at: string;
};

type ActivityTokenRow = {
  device_id: string;
  activity_id: string;
  token: string;
};

type SuppressionRow = {
  content_hash: string;
};

export type PushPhase = "running" | "waiting" | "terminal";

type AlertPublishItem = {
  deviceIds: string[] | null;
  title: string;
  subtitle: string | null;
  body: string | null;
  deepLink: string | null;
  threadId: string | null;
  sound: string | null;
  interruptionLevel: "passive" | "active" | "time-sensitive" | null;
  collapseId: string | null;
  dedupeKey: string | null;
  phase: PushPhase;
};

type LiveActivityPublishItem = {
  deviceIds: string[] | null;
  event: "start" | "update" | "end";
  activityId: string;
  attributesType: string | null;
  attributes: Record<string, unknown> | null;
  contentState: Record<string, unknown>;
  staleDate: number | null;
  dismissalDate: number | null;
  relevanceScore: number | null;
  alert: { title: string; body: string | null } | null;
  dedupeKey: string | null;
  phase: PushPhase;
};

type DeliveryOutcome = {
  deviceId: string;
  kind: "alert" | "liveactivity";
  delivered: boolean;
  suppressed: boolean;
  skipped: string | null;
  status: number | null;
  reason: string | null;
};

const MACHINE_KEY_PATTERN = /^[a-f0-9]{32,64}$/i;
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9._:-]{4,128}$/;
const APNS_TOKEN_PATTERN = /^[a-f0-9]{32,512}$/i;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PUBLISH_ITEMS = 32;
const MAX_SECRET_LENGTH = 128;
const MIN_SECRET_LENGTH = 32;
const SIGNATURE_TIMESTAMP_SKEW_SECONDS = 5 * 60;
const SUPPRESSION_RETENTION_HOURS = 48;
const DEFAULT_REGISTRATION_RETENTION_DAYS = 120;
const DEFAULT_MAX_DEVICES_PER_MACHINE = 16;

// Phase-dependent APNs TTLs: a "running" transition is worthless a couple of
// hours later, while "waiting for input" / terminal outcomes stay actionable
// for a day. (Pattern borrowed from the best-in-class agent push relays.)
const PHASE_TTL_SECONDS: Record<PushPhase, number> = {
  running: 2 * 60 * 60,
  waiting: 24 * 60 * 60,
  terminal: 24 * 60 * 60,
};

const encoder = new TextEncoder();

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(source: Record<string, unknown> | null | undefined, key: string): string {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(source: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = readString(source, key);
  return value ? value : null;
}

function readNumber(source: Record<string, unknown> | null | undefined, key: string): number | null {
  // Distinguish an explicit JSON null/absent value from 0 — `Number(null)` is 0,
  // which would (e.g.) turn a null staleDate into the Unix epoch. Mirrors the
  // explicit-null handling the `sound` field uses in parseAlertItems.
  const raw = source?.[key];
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * Canonical string every signed call commits to. Binding the method, path and
 * body hash prevents replaying a captured signature against another endpoint
 * or with a mutated body; the timestamp bounds the replay window.
 */
export async function buildSignatureBase(args: {
  timestamp: string;
  method: string;
  pathname: string;
  body: string | ArrayBuffer;
}): Promise<string> {
  const bodyHash = await sha256Hex(args.body);
  return `${args.timestamp}.${args.method.toUpperCase()}.${args.pathname}.${bodyHash}`;
}

export async function signPushRelayRequest(secret: string, args: {
  timestamp: string;
  method: string;
  pathname: string;
  body: string | ArrayBuffer;
}): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, await buildSignatureBase(args))}`;
}

function parseTimestampSeconds(raw: string): number | null {
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return raw.length === 13 ? Math.floor(numeric / 1000) : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

async function loadMachine(env: PushRelayEnv, machineKey: string): Promise<MachineRow | null> {
  return await env.DB
    .prepare("select machine_key, secret from machines where machine_key = ? limit 1")
    .bind(machineKey)
    .first<MachineRow>();
}

async function assertMachineAuthorized(
  request: Request,
  env: PushRelayEnv,
  machineKey: string,
  body: ArrayBuffer,
): Promise<{ machine: MachineRow } | { response: Response }> {
  const machine = await loadMachine(env, machineKey);
  if (!machine) {
    return { response: json({ ok: false, error: "unknown machine" }, { status: 401 }) };
  }
  const timestamp = request.headers.get("x-ade-push-timestamp")?.trim() || "";
  const signature = request.headers.get("x-ade-push-signature")?.trim() || "";
  if (!timestamp || !signature) {
    return { response: json({ ok: false, error: "missing signature headers" }, { status: 401 }) };
  }
  const timestampSeconds = parseTimestampSeconds(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (timestampSeconds == null || Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_TIMESTAMP_SKEW_SECONDS) {
    return { response: json({ ok: false, error: "stale or invalid timestamp" }, { status: 401 }) };
  }
  const expected = await signPushRelayRequest(machine.secret, {
    timestamp,
    method: request.method,
    pathname: new URL(request.url).pathname,
    body,
  });
  if (!constantTimeEqual(expected, signature)) {
    return { response: json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  }
  await env.DB
    .prepare("update machines set last_seen_at = ? where machine_key = ?")
    .bind(new Date().toISOString(), machineKey)
    .run();
  return { machine };
}

function apnsConfig(env: PushRelayEnv): ApnsKeyConfig | null {
  const keyPem = env.APNS_KEY?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  if (!keyPem || !keyId || !teamId) return null;
  return { keyPem, keyId, teamId };
}

function parseBodyJson(body: ArrayBuffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEnvironment(raw: string): ApnsEnvironment | null {
  if (raw === "sandbox" || raw === "production") return raw;
  if (raw === "development") return "sandbox";
  return null;
}

function normalizePhase(raw: string): PushPhase {
  return raw === "running" || raw === "waiting" || raw === "terminal" ? raw : "waiting";
}

function readDeviceIds(source: Record<string, unknown>): string[] | null {
  const raw = source.deviceIds;
  // Absent (not an array) means "no restriction → all devices"; a present but
  // empty/invalid array must target zero devices, not silently broadcast.
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => DEVICE_ID_PATTERN.test(value));
}

function parseAlertItems(raw: unknown): AlertPublishItem[] {
  if (!Array.isArray(raw)) return [];
  const items: AlertPublishItem[] = [];
  for (const entry of raw.slice(0, MAX_PUBLISH_ITEMS)) {
    if (!isRecord(entry)) continue;
    const title = readString(entry, "title");
    if (!title) continue;
    const interruption = readString(entry, "interruptionLevel");
    items.push({
      deviceIds: readDeviceIds(entry),
      title,
      subtitle: readOptionalString(entry, "subtitle"),
      body: readOptionalString(entry, "body"),
      deepLink: readOptionalString(entry, "deepLink"),
      threadId: readOptionalString(entry, "threadId"),
      sound: entry.sound === null ? null : readOptionalString(entry, "sound") ?? "default",
      interruptionLevel:
        interruption === "passive" || interruption === "active" || interruption === "time-sensitive"
          ? interruption
          : null,
      collapseId: readOptionalString(entry, "collapseId"),
      dedupeKey: readOptionalString(entry, "dedupeKey"),
      phase: normalizePhase(readString(entry, "phase")),
    });
  }
  return items;
}

function parseLiveActivityItems(raw: unknown): LiveActivityPublishItem[] {
  if (!Array.isArray(raw)) return [];
  const items: LiveActivityPublishItem[] = [];
  for (const entry of raw.slice(0, MAX_PUBLISH_ITEMS)) {
    if (!isRecord(entry)) continue;
    const event = readString(entry, "event");
    const activityId = readString(entry, "activityId");
    const contentState = isRecord(entry.contentState) ? entry.contentState : null;
    if ((event !== "start" && event !== "update" && event !== "end") || !activityId || !contentState) continue;
    const alert = isRecord(entry.alert) && readString(entry.alert, "title")
      ? { title: readString(entry.alert, "title"), body: readOptionalString(entry.alert, "body") }
      : null;
    items.push({
      deviceIds: readDeviceIds(entry),
      event,
      activityId,
      attributesType: readOptionalString(entry, "attributesType"),
      attributes: isRecord(entry.attributes) ? entry.attributes : null,
      contentState,
      staleDate: readNumber(entry, "staleDate"),
      dismissalDate: readNumber(entry, "dismissalDate"),
      relevanceScore: readNumber(entry, "relevanceScore"),
      alert,
      dedupeKey: readOptionalString(entry, "dedupeKey"),
      phase: normalizePhase(readString(entry, "phase")),
    });
  }
  return items;
}

async function listMachineDevices(env: PushRelayEnv, machineKey: string): Promise<DeviceRow[]> {
  return (await env.DB
    .prepare(`
      select machine_key, device_id, apns_token, push_to_start_token, bundle_id,
             aps_environment, platform, device_name, registered_at, updated_at
        from device_registrations
       where machine_key = ?
       order by updated_at desc
    `)
    .bind(machineKey)
    .all<DeviceRow>()).results ?? [];
}

async function loadActivityTokens(
  env: PushRelayEnv,
  machineKey: string,
  activityId: string,
): Promise<ActivityTokenRow[]> {
  return (await env.DB
    .prepare(`
      select device_id, activity_id, token
        from live_activity_tokens
       where machine_key = ? and activity_id = ?
    `)
    .bind(machineKey, activityId)
    .all<ActivityTokenRow>()).results ?? [];
}

async function shouldSuppress(
  env: PushRelayEnv,
  machineKey: string,
  dedupeKey: string,
  contentHash: string,
): Promise<boolean> {
  const row = await env.DB
    .prepare("select content_hash from publish_suppression where machine_key = ? and suppression_key = ? limit 1")
    .bind(machineKey, dedupeKey)
    .first<SuppressionRow>();
  return row != null && row.content_hash === contentHash;
}

async function recordSuppression(
  env: PushRelayEnv,
  machineKey: string,
  dedupeKey: string,
  contentHash: string,
): Promise<void> {
  await env.DB
    .prepare(`
      insert into publish_suppression(machine_key, suppression_key, content_hash, published_at)
      values (?, ?, ?, ?)
      on conflict(machine_key, suppression_key) do update set
        content_hash = excluded.content_hash,
        published_at = excluded.published_at
    `)
    .bind(machineKey, dedupeKey, contentHash, new Date().toISOString())
    .run();
}

async function clearInvalidToken(
  env: PushRelayEnv,
  machineKey: string,
  deviceId: string,
  column: "apns_token" | "push_to_start_token",
): Promise<void> {
  await env.DB
    .prepare(`update device_registrations set ${column} = null, updated_at = ? where machine_key = ? and device_id = ?`)
    .bind(new Date().toISOString(), machineKey, deviceId)
    .run();
}

async function deleteActivityToken(env: PushRelayEnv, machineKey: string, deviceId: string, activityId: string): Promise<void> {
  await env.DB
    .prepare("delete from live_activity_tokens where machine_key = ? and device_id = ? and activity_id = ?")
    .bind(machineKey, deviceId, activityId)
    .run();
}

async function pruneRelayState(env: PushRelayEnv): Promise<void> {
  const suppressionCutoff = new Date(Date.now() - SUPPRESSION_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare("delete from publish_suppression where published_at < ?")
    .bind(suppressionCutoff)
    .run();
  const days = Number(env.REGISTRATION_RETENTION_DAYS ?? DEFAULT_REGISTRATION_RETENTION_DAYS);
  const retentionDays = Number.isFinite(days) ? Math.max(7, Math.trunc(days)) : DEFAULT_REGISTRATION_RETENTION_DAYS;
  const registrationCutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare("delete from device_registrations where updated_at < ?")
    .bind(registrationCutoff)
    .run();
}

function phaseExpiration(phase: PushPhase, nowSeconds = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + PHASE_TTL_SECONDS[phase];
}

function alertApnsPayload(item: AlertPublishItem): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    alert: {
      title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      ...(item.body ? { body: item.body } : {}),
    },
  };
  if (item.sound) aps.sound = item.sound;
  if (item.threadId) aps["thread-id"] = item.threadId;
  if (item.interruptionLevel) aps["interruption-level"] = item.interruptionLevel;
  return {
    aps,
    ...(item.deepLink ? { deepLink: item.deepLink } : {}),
  };
}

// Too-short stale dates dim healthy-but-quiet activities (updates are
// event-driven, not periodic); 10 minutes is the proven sweet spot.
const DEFAULT_STALE_AFTER_SECONDS = 10 * 60;

function liveActivityApnsPayload(item: LiveActivityPublishItem, nowSeconds: number): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    timestamp: nowSeconds,
    event: item.event,
    "content-state": item.contentState,
  };
  if (item.event !== "end") {
    aps["stale-date"] = item.staleDate != null ? Math.floor(item.staleDate) : nowSeconds + DEFAULT_STALE_AFTER_SECONDS;
  } else if (item.staleDate != null) {
    aps["stale-date"] = Math.floor(item.staleDate);
  }
  if (item.relevanceScore != null) aps["relevance-score"] = item.relevanceScore;
  if (item.event === "start") {
    // Asks APNs/ActivityKit to mint and deliver the per-activity update token.
    aps["input-push-token"] = 1;
    if (item.attributesType) aps["attributes-type"] = item.attributesType;
    if (item.attributes) aps.attributes = item.attributes;
    if (item.alert) {
      aps.alert = { title: item.alert.title, ...(item.alert.body ? { body: item.alert.body } : {}) };
    }
  }
  if (item.event === "end" && item.dismissalDate != null) {
    aps["dismissal-date"] = Math.floor(item.dismissalDate);
  }
  return { aps };
}

function liveActivityTopic(bundleId: string): string {
  return `${bundleId}.push-type.liveactivity`;
}

function selectTargets(devices: DeviceRow[], requested: string[] | null): DeviceRow[] {
  if (!requested) return devices;
  const wanted = new Set(requested);
  return devices.filter((device) => wanted.has(device.device_id));
}

async function deliverAlertItem(
  env: PushRelayEnv,
  config: ApnsKeyConfig,
  machineKey: string,
  devices: DeviceRow[],
  item: AlertPublishItem,
  defaultTopic: string,
): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = [];
  const targets = selectTargets(devices, item.deviceIds).filter((device) => device.apns_token);
  if (targets.length === 0) return outcomes;

  let suppressionHash: string | null = null;
  if (item.dedupeKey) {
    suppressionHash = await sha256Hex(JSON.stringify(alertApnsPayload(item)));
    if (await shouldSuppress(env, machineKey, item.dedupeKey, suppressionHash)) {
      return targets.map((device) => ({
        deviceId: device.device_id,
        kind: "alert" as const,
        delivered: false,
        suppressed: true,
        skipped: null,
        status: null,
        reason: null,
      }));
    }
  }

  const expiration = phaseExpiration(item.phase);
  for (const device of targets) {
    const environment = normalizeEnvironment(device.aps_environment) ?? "production";
    const result: ApnsSendResult = await sendApnsPush(config, {
      environment,
      deviceToken: device.apns_token as string,
      topic: device.bundle_id || defaultTopic,
      pushType: "alert",
      priority: 10,
      expiration,
      collapseId: item.collapseId,
      payload: alertApnsPayload(item),
    });
    if (result.tokenInvalid) {
      await clearInvalidToken(env, machineKey, device.device_id, "apns_token");
    }
    outcomes.push({
      deviceId: device.device_id,
      kind: "alert",
      delivered: result.ok,
      suppressed: false,
      skipped: null,
      status: result.status,
      reason: result.reason,
    });
  }
  // Only a delivered publish counts for future suppression — recording before
  // the send would turn a transient APNs failure into a permanently-suppressed
  // retry of the same content.
  if (item.dedupeKey && suppressionHash && outcomes.some((outcome) => outcome.delivered)) {
    await recordSuppression(env, machineKey, item.dedupeKey, suppressionHash);
  }
  return outcomes;
}

async function deliverLiveActivityItem(
  env: PushRelayEnv,
  config: ApnsKeyConfig,
  machineKey: string,
  devices: DeviceRow[],
  item: LiveActivityPublishItem,
  defaultTopic: string,
): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = liveActivityApnsPayload(item, nowSeconds);
  const expiration = phaseExpiration(item.phase, nowSeconds);
  const targets = selectTargets(devices, item.deviceIds);

  let suppressionHash: string | null = null;
  if (item.dedupeKey) {
    suppressionHash = await sha256Hex(JSON.stringify({ event: item.event, contentState: item.contentState }));
    if (await shouldSuppress(env, machineKey, item.dedupeKey, suppressionHash)) {
      return targets.map((device) => ({
        deviceId: device.device_id,
        kind: "liveactivity" as const,
        delivered: false,
        suppressed: true,
        skipped: null,
        status: null,
        reason: null,
      }));
    }
  }

  // See deliverAlertItem: suppression is recorded only after a delivered send.
  const recordIfDelivered = async (): Promise<void> => {
    if (item.dedupeKey && suppressionHash && outcomes.some((outcome) => outcome.delivered)) {
      await recordSuppression(env, machineKey, item.dedupeKey, suppressionHash);
    }
  };

  if (item.event === "start") {
    for (const device of targets) {
      if (!device.push_to_start_token) {
        outcomes.push({
          deviceId: device.device_id,
          kind: "liveactivity",
          delivered: false,
          suppressed: false,
          skipped: "no push-to-start token",
          status: null,
          reason: null,
        });
        continue;
      }
      const environment = normalizeEnvironment(device.aps_environment) ?? "production";
      const result = await sendApnsPush(config, {
        environment,
        deviceToken: device.push_to_start_token,
        topic: liveActivityTopic(device.bundle_id || defaultTopic),
        pushType: "liveactivity",
        priority: 10,
        expiration,
        collapseId: item.activityId,
        payload,
      });
      if (result.tokenInvalid) {
        await clearInvalidToken(env, machineKey, device.device_id, "push_to_start_token");
      }
      outcomes.push({
        deviceId: device.device_id,
        kind: "liveactivity",
        delivered: result.ok,
        suppressed: false,
        skipped: null,
        status: result.status,
        reason: result.reason,
      });
    }
    await recordIfDelivered();
    return outcomes;
  }

  // update / end target the per-activity tokens the phones reported.
  const activityTokens = await loadActivityTokens(env, machineKey, item.activityId);
  const deviceById = new Map(devices.map((device) => [device.device_id, device]));
  const wanted = item.deviceIds ? new Set(item.deviceIds) : null;
  for (const tokenRow of activityTokens) {
    if (wanted && !wanted.has(tokenRow.device_id)) continue;
    const device = deviceById.get(tokenRow.device_id);
    if (!device) continue;
    const environment = normalizeEnvironment(device.aps_environment) ?? "production";
    const result = await sendApnsPush(config, {
      environment,
      deviceToken: tokenRow.token,
      topic: liveActivityTopic(device.bundle_id || defaultTopic),
      pushType: "liveactivity",
      priority: item.event === "end" || item.phase === "waiting" ? 10 : 5,
      expiration,
      collapseId: item.activityId,
      payload,
    });
    if (result.tokenInvalid || item.event === "end") {
      await deleteActivityToken(env, machineKey, tokenRow.device_id, item.activityId);
    }
    outcomes.push({
      deviceId: tokenRow.device_id,
      kind: "liveactivity",
      delivered: result.ok,
      suppressed: false,
      skipped: null,
      status: result.status,
      reason: result.reason,
    });
  }
  await recordIfDelivered();
  return outcomes;
}

async function handleMachineClaim(request: Request, env: PushRelayEnv, machineKey: string): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  if (!MACHINE_KEY_PATTERN.test(machineKey)) {
    return json({ ok: false, error: "machine key must be 32-64 hex characters" }, { status: 400 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const payload = parseBodyJson(body);
  const secret = payload ? readString(payload, "secret") : "";
  if (secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
    return json({ ok: false, error: `secret must be ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} characters` }, { status: 400 });
  }
  // `machine_key` is the primary key, so a plain read-then-insert races: two
  // concurrent first claims can both pass the read and one insert then throws a
  // unique-constraint 500. Insert atomically (ON CONFLICT DO NOTHING) and read
  // back the winner to decide idempotent-reclaim vs conflict.
  const existingBefore = await loadMachine(env, machineKey);
  const now = new Date().toISOString();
  await env.DB
    .prepare("insert into machines(machine_key, secret, created_at, last_seen_at) values (?, ?, ?, ?) on conflict(machine_key) do nothing")
    .bind(machineKey, secret, now, now)
    .run();
  const stored = await loadMachine(env, machineKey);
  if (!stored) {
    return json({ ok: false, error: "claim failed" }, { status: 500 });
  }
  if (!constantTimeEqual(stored.secret, secret)) {
    return json({ ok: false, error: "machine key is already claimed" }, { status: 409 });
  }
  return existingBefore
    ? json({ ok: true, claimed: false })
    : json({ ok: true, claimed: true }, { status: 201 });
}

async function handleDeviceUpsert(
  request: Request,
  env: PushRelayEnv,
  machineKey: string,
  deviceId: string,
): Promise<Response> {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return json({ ok: false, error: "invalid device id" }, { status: 400 });
  }
  const payload = parseBodyJson(body);
  if (!payload) return json({ ok: false, error: "invalid json" }, { status: 400 });

  const bundleId = readString(payload, "bundleId");
  const environment = normalizeEnvironment(readString(payload, "apsEnvironment"));
  if (!bundleId || !environment) {
    return json({ ok: false, error: "bundleId and apsEnvironment (sandbox|production) are required" }, { status: 400 });
  }
  const apnsToken = readOptionalString(payload, "apnsToken");
  const pushToStartToken = readOptionalString(payload, "pushToStartToken");
  if (apnsToken && !APNS_TOKEN_PATTERN.test(apnsToken)) {
    return json({ ok: false, error: "invalid apnsToken" }, { status: 400 });
  }
  if (pushToStartToken && !APNS_TOKEN_PATTERN.test(pushToStartToken)) {
    return json({ ok: false, error: "invalid pushToStartToken" }, { status: 400 });
  }

  const devices = await listMachineDevices(env, machineKey);
  const maxDevicesRaw = Number(env.MAX_DEVICES_PER_MACHINE ?? DEFAULT_MAX_DEVICES_PER_MACHINE);
  const maxDevices = Number.isFinite(maxDevicesRaw) ? Math.max(1, Math.trunc(maxDevicesRaw)) : DEFAULT_MAX_DEVICES_PER_MACHINE;
  const isExisting = devices.some((device) => device.device_id === deviceId);
  if (!isExisting && devices.length >= maxDevices) {
    return json({ ok: false, error: "device limit reached for this machine" }, { status: 409 });
  }

  const now = new Date().toISOString();
  await env.DB
    .prepare(`
      insert into device_registrations(
        machine_key, device_id, apns_token, push_to_start_token, bundle_id,
        aps_environment, platform, device_name, registered_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(machine_key, device_id) do update set
        apns_token = coalesce(excluded.apns_token, device_registrations.apns_token),
        push_to_start_token = coalesce(excluded.push_to_start_token, device_registrations.push_to_start_token),
        bundle_id = excluded.bundle_id,
        aps_environment = excluded.aps_environment,
        platform = coalesce(excluded.platform, device_registrations.platform),
        device_name = coalesce(excluded.device_name, device_registrations.device_name),
        updated_at = excluded.updated_at
    `)
    .bind(
      machineKey,
      deviceId,
      apnsToken,
      pushToStartToken,
      bundleId,
      environment,
      readOptionalString(payload, "platform"),
      readOptionalString(payload, "deviceName"),
      now,
      now,
    )
    .run();
  await pruneRelayState(env);
  return json({ ok: true, deviceId, updatedAt: now });
}

async function handleDeviceDelete(
  request: Request,
  env: PushRelayEnv,
  machineKey: string,
  deviceId: string,
): Promise<Response> {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  await env.DB
    .prepare("delete from device_registrations where machine_key = ? and device_id = ?")
    .bind(machineKey, deviceId)
    .run();
  await env.DB
    .prepare("delete from live_activity_tokens where machine_key = ? and device_id = ?")
    .bind(machineKey, deviceId)
    .run();
  return json({ ok: true, deviceId });
}

async function handleDeviceList(request: Request, env: PushRelayEnv, machineKey: string): Promise<Response> {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  const devices = await listMachineDevices(env, machineKey);
  return json({
    ok: true,
    devices: devices.map((device) => ({
      deviceId: device.device_id,
      hasApnsToken: Boolean(device.apns_token),
      hasPushToStartToken: Boolean(device.push_to_start_token),
      bundleId: device.bundle_id,
      apsEnvironment: device.aps_environment,
      platform: device.platform,
      deviceName: device.device_name,
      registeredAt: device.registered_at,
      updatedAt: device.updated_at,
    })),
  });
}

async function handleActivityTokenUpsert(request: Request, env: PushRelayEnv, machineKey: string): Promise<Response> {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  const payload = parseBodyJson(body);
  if (!payload) return json({ ok: false, error: "invalid json" }, { status: 400 });
  const deviceId = readString(payload, "deviceId");
  const activityId = readString(payload, "activityId");
  const token = readString(payload, "token");
  if (!DEVICE_ID_PATTERN.test(deviceId) || !activityId) {
    return json({ ok: false, error: "deviceId and activityId are required" }, { status: 400 });
  }
  if (!token) {
    await deleteActivityToken(env, machineKey, deviceId, activityId);
    return json({ ok: true, removed: true });
  }
  if (!APNS_TOKEN_PATTERN.test(token)) {
    return json({ ok: false, error: "invalid activity token" }, { status: 400 });
  }
  await env.DB
    .prepare(`
      insert into live_activity_tokens(machine_key, device_id, activity_id, token, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(machine_key, device_id, activity_id) do update set
        token = excluded.token,
        updated_at = excluded.updated_at
    `)
    .bind(machineKey, deviceId, activityId, token, new Date().toISOString())
    .run();
  return json({ ok: true, removed: false });
}

async function handlePublish(request: Request, env: PushRelayEnv, machineKey: string): Promise<Response> {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  const config = apnsConfig(env);
  if (!config) {
    return json({ ok: false, error: "APNs signing key is not configured on the relay" }, { status: 503 });
  }
  const payload = parseBodyJson(body);
  if (!payload) return json({ ok: false, error: "invalid json" }, { status: 400 });

  const alerts = parseAlertItems(payload.notifications);
  const liveActivities = parseLiveActivityItems(payload.liveActivity);
  if (alerts.length === 0 && liveActivities.length === 0) {
    return json({ ok: false, error: "nothing to publish" }, { status: 400 });
  }

  const devices = await listMachineDevices(env, machineKey);
  const defaultTopic = env.APNS_DEFAULT_TOPIC?.trim() || "";
  const outcomes: DeliveryOutcome[] = [];
  for (const item of alerts) {
    outcomes.push(...await deliverAlertItem(env, config, machineKey, devices, item, defaultTopic));
  }
  for (const item of liveActivities) {
    outcomes.push(...await deliverLiveActivityItem(env, config, machineKey, devices, item, defaultTopic));
  }
  // Publishes far outnumber device re-registrations, so prune here too or a
  // chatty machine holds expired suppression rows past their retention.
  await pruneRelayState(env);

  return json({
    ok: true,
    delivered: outcomes.filter((outcome) => outcome.delivered).length,
    suppressed: outcomes.filter((outcome) => outcome.suppressed).length,
    failed: outcomes.filter((outcome) => !outcome.delivered && !outcome.suppressed && !outcome.skipped).length,
    outcomes,
  });
}

function routeMachine(pathname: string): { machineKey: string; rest: string[] } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && parts[0] === "machines") {
    return { machineKey: decodeURIComponent(parts[1] ?? ""), rest: parts.slice(2) };
  }
  return null;
}

export async function handleRequest(request: Request, env: PushRelayEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return json({ ok: true, apnsConfigured: apnsConfig(env) != null });
  }
  if (contentLengthExceeds(request.headers, MAX_BODY_BYTES)) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const route = routeMachine(url.pathname);
  if (!route || !MACHINE_KEY_PATTERN.test(route.machineKey)) return text("not found", 404);
  const { machineKey, rest } = route;

  if (rest.length === 1 && rest[0] === "claim") {
    return await handleMachineClaim(request, env, machineKey);
  }
  if (rest.length === 1 && rest[0] === "devices" && request.method === "GET") {
    return await handleDeviceList(request, env, machineKey);
  }
  if (rest.length === 2 && rest[0] === "devices") {
    const deviceId = decodeURIComponent(rest[1] ?? "");
    if (request.method === "PUT" || request.method === "POST") {
      return await handleDeviceUpsert(request, env, machineKey, deviceId);
    }
    if (request.method === "DELETE") {
      return await handleDeviceDelete(request, env, machineKey, deviceId);
    }
    return text("method not allowed", 405);
  }
  if (rest.length === 1 && rest[0] === "live-activity-tokens" && request.method === "POST") {
    return await handleActivityTokenUpsert(request, env, machineKey);
  }
  if (rest.length === 1 && rest[0] === "publish" && request.method === "POST") {
    return await handlePublish(request, env, machineKey);
  }
  return text("not found", 404);
}

function contentLengthExceeds(headers: Headers, limit: number): boolean {
  const value = headers.get("content-length")?.trim();
  if (!value || !/^\d+$/.test(value)) return false;
  try {
    return BigInt(value) > BigInt(limit);
  } catch {
    return true;
  }
}
