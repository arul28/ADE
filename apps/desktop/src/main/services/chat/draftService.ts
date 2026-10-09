import { randomUUID } from "node:crypto";
import {
  MAX_DRAFT_ATTACHMENTS,
  MAX_DRAFT_GRACE_SECONDS,
  MAX_DRAFT_SCHEDULE_LEAD_MS,
  MAX_DRAFTS,
  MAX_SCHEDULED_DRAFTS,
  type AgentChatFileRef,
  type DraftDeliveryPolicy,
  type DraftEntry,
  type DraftKind,
  type DraftScheduledBy,
  type DraftScheduleInput,
  type DraftStatus,
  type DraftTargetKind,
} from "../../../shared/types/chat";
import type { AdeDb } from "../state/kvDb";
import type { SqlValue } from "../state/kvDb";

/**
 * The slice of the project database the draft store needs. Every public
 * function takes this rather than `AdeDb` because the chat service reaches its
 * database through a guarded `args.db` whose members are optional there.
 */
export type DraftDb = Pick<AdeDb, "get" | "all" | "run"> & Partial<Pick<AdeDb, "sync">>;

export {
  MAX_DRAFT_ATTACHMENTS,
  MAX_DRAFTS,
  MAX_SCHEDULED_DRAFTS,
};
export const MAX_DRAFT_TEXT_CHARS = 200_000;
export const MAX_DRAFT_ATTACHMENT_PATH_CHARS = 8_192;

/**
 * Statuses a scheduled send can still act on. These rows are never pruned:
 * losing an armed send is the failure this feature exists to prevent.
 */
export const PENDING_DRAFT_STATUSES: readonly DraftStatus[] = [
  "scheduled",
  "sending",
  "blocked",
];

/**
 * How long a row must look stale to this machine before the retention prune
 * may remove it. Kept at zero by default: the locked product decision is a
 * strict 20-row ceiling for plain drafts, so the cap is enforced on count.
 * Skew is handled at the stamp instead — `nextCreatedAt` never issues a
 * timestamp older than the newest row this machine has already seen — and a
 * draft armed on another machine is exempt entirely.
 */
const DRAFT_PRUNE_MIN_AGE_MS = 0;

type DraftRow = {
  id: string;
  text: string;
  attachments_json: string;
  attachment_origin_site_id: string | null;
  provider: string | null;
  model_id: string | null;
  model: string | null;
  created_at: string;
  updated_at: string | null;
  kind: string | null;
  status: string | null;
  scheduled_at: string | null;
  delivery_policy: string | null;
  grace_seconds: number | null;
  target_kind: string | null;
  target_session_id: string | null;
  target_lane_id: string | null;
  target_machine_key: string | null;
  origin_session_id: string | null;
  permission_mode: string | null;
  thinking: string | null;
  scheduled_by: string | null;
  scheduled_by_session_id: string | null;
  fired_at: string | null;
  last_error: string | null;
};

const DRAFT_COLUMNS = `
  id, text, attachments_json, attachment_origin_site_id, provider, model_id, model, created_at,
  updated_at, kind, status, scheduled_at, delivery_policy, grace_seconds, target_kind,
  target_session_id, target_lane_id, target_machine_key, origin_session_id, permission_mode,
  thinking, scheduled_by, scheduled_by_session_id, fired_at, last_error
`;

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeAttachments(value: unknown): AgentChatFileRef[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_DRAFT_ATTACHMENTS) {
    throw new Error(`A draft can include at most ${MAX_DRAFT_ATTACHMENTS} attachments.`);
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Draft attachments are invalid.");
    }
    const attachment = candidate as Partial<AgentChatFileRef>;
    const path = typeof attachment.path === "string" ? attachment.path.trim() : "";
    if (!path || path.length > MAX_DRAFT_ATTACHMENT_PATH_CHARS) {
      throw new Error("Draft attachment path is invalid.");
    }
    if (attachment.type === "image-url") {
      const url = typeof attachment.url === "string" ? attachment.url.trim() : "";
      if (!url || url !== path || url.length > MAX_DRAFT_ATTACHMENT_PATH_CHARS) {
        throw new Error("Draft image URL is invalid.");
      }
      let protocol: string;
      try {
        protocol = new URL(url).protocol;
      } catch {
        throw new Error("Draft image URL is invalid.");
      }
      if (protocol !== "https:" && protocol !== "http:") {
        throw new Error("Draft image URL is invalid.");
      }
      return { path: url, type: "image-url", url };
    }
    if (attachment.type !== "image") {
      throw new Error("Draft attachment type is invalid.");
    }
    return { path, type: "image" };
  });
}

function parseAttachments(json: string): AgentChatFileRef[] {
  try {
    return normalizeAttachments(JSON.parse(json));
  } catch {
    return [];
  }
}

type DraftSiteDb = Pick<AdeDb, "get"> & Partial<Pick<AdeDb, "sync">>;

function normalizeSiteId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function currentSiteId(db: DraftSiteDb): string | null {
  try {
    const siteId = normalizeSiteId(db.sync?.getSiteId());
    if (siteId) return siteId;
  } catch {
    // Fall through to the SQL read for narrow test/runtime adapters.
  }
  try {
    return normalizeSiteId(db.get<{ site_id: string }>(
      "select lower(hex(crsql_site_id())) as site_id",
    )?.site_id);
  } catch {
    return null;
  }
}

const DRAFT_KINDS: readonly DraftKind[] = ["draft", "scheduled"];
const DRAFT_STATUSES: readonly DraftStatus[] = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "missed",
  "blocked",
  "cancelled",
];
const DELIVERY_POLICIES: readonly DraftDeliveryPolicy[] = ["wait", "strict", "grace"];
const TARGET_KINDS: readonly DraftTargetKind[] = ["existing", "new"];

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? value as T
    : null;
}

function fromRow(row: DraftRow, localSiteId: string | null): DraftEntry {
  const storedAttachments = parseAttachments(row.attachments_json);
  const originMatches = Boolean(
    localSiteId
    && normalizeSiteId(row.attachment_origin_site_id) === localSiteId,
  );
  const attachments = storedAttachments.filter((attachment) => (
    attachment.type !== "image" || originMatches
  ));
  return {
    id: row.id,
    text: row.text,
    attachments,
    attachmentCount: storedAttachments.length,
    attachmentsAvailable: attachments.length === storedAttachments.length,
    provider: row.provider,
    modelId: row.model_id,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    kind: asEnum(row.kind, DRAFT_KINDS) ?? "draft",
    status: asEnum(row.status, DRAFT_STATUSES) ?? "draft",
    scheduledAt: row.scheduled_at,
    deliveryPolicy: asEnum(row.delivery_policy, DELIVERY_POLICIES) ?? undefined,
    graceSeconds: typeof row.grace_seconds === "number" ? row.grace_seconds : undefined,
    targetKind: asEnum(row.target_kind, TARGET_KINDS) ?? undefined,
    targetSessionId: row.target_session_id,
    targetLaneId: row.target_lane_id,
    targetMachineKey: row.target_machine_key,
    originSessionId: row.origin_session_id,
    permissionMode: row.permission_mode,
    thinking: row.thinking,
    scheduledBy: asEnum(row.scheduled_by, ["user", "agent"] as const) ?? undefined,
    scheduledBySessionId: row.scheduled_by_session_id,
    firedAt: row.fired_at,
    lastError: row.last_error,
  };
}

/**
 * Newest-first ordering across replicas. `created_at` is a hybrid stamp: this
 * machine's wall clock, or one millisecond past the newest row it has already
 * seen. That keeps locally-created rows on top even when this machine's clock
 * lags the machine that created the newest synced row.
 */
function nextCreatedAt(db: DraftDb): string {
  const latest = db.get<{ created_at: string }>(
    "select created_at from prompt_stashes order by created_at desc limit 1",
  )?.created_at;
  const latestTimestamp = latest ? Date.parse(latest) : Number.NaN;
  return new Date(Math.max(
    Date.now(),
    Number.isFinite(latestTimestamp) ? latestTimestamp + 1 : 0,
  )).toISOString();
}

type DraftRetentionDb = Pick<AdeDb, "run">;

function pruneStatusList(): string {
  return PENDING_DRAFT_STATUSES.map((status) => `'${status}'`).join(", ");
}

/**
 * Convergent retention. Scheduled rows that can still fire are never touched;
 * plain drafts and finished sends are pruned beyond their own caps, oldest
 * first. The single DELETE stays safe on partially converged replicas: adding
 * rows cannot promote an entry that was already outside the top N.
 *
 * `DRAFT_PRUNE_MIN_AGE_MS` is the one knob that would relax the count cap into
 * an age window; it stays 0 so the locked 20-row rule is exact.
 */
function pruneDraftRetention(db: DraftRetentionDb, nowMs = Date.now()): void {
  const cutoff = new Date(nowMs - DRAFT_PRUNE_MIN_AGE_MS).toISOString();
  const agePredicate = DRAFT_PRUNE_MIN_AGE_MS > 0 ? "and created_at < ?" : "";
  const pending = pruneStatusList();

  db.run(
    `
      delete from prompt_stashes
      where id in (
        select id
        from prompt_stashes
        where coalesce(kind, 'draft') = 'draft'
          ${agePredicate}
        order by created_at desc, id desc
        limit -1 offset ?
      )
    `,
    DRAFT_PRUNE_MIN_AGE_MS > 0 ? [cutoff, MAX_DRAFTS] : [MAX_DRAFTS],
  );

  db.run(
    `
      delete from prompt_stashes
      where id in (
        select id
        from prompt_stashes
        where kind = 'scheduled'
          and coalesce(status, 'draft') not in (${pending})
          ${agePredicate}
        order by created_at desc, id desc
        limit -1 offset ?
      )
    `,
    DRAFT_PRUNE_MIN_AGE_MS > 0 ? [cutoff, MAX_SCHEDULED_DRAFTS] : [MAX_SCHEDULED_DRAFTS],
  );
}

/** Plain-draft rows (the ones the 20-row ceiling applies to). */
function countPlainDrafts(db: DraftDb): number {
  return db.get<{ count: number }>(
    "select count(*) as count from prompt_stashes where coalesce(kind, 'draft') = 'draft'",
  )?.count ?? 0;
}

function countPendingScheduledDrafts(db: DraftDb): number {
  return db.get<{ count: number }>(
    `
      select count(*) as count
      from prompt_stashes
      where kind = 'scheduled' and status in (${pruneStatusList()})
    `,
  )?.count ?? 0;
}

export function listDrafts(
  db: DraftDb,
  limit = MAX_DRAFTS,
): DraftEntry[] {
  pruneDraftRetention(db);
  const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : MAX_DRAFTS;
  const safeLimit = Math.max(1, Math.min(MAX_DRAFTS + MAX_SCHEDULED_DRAFTS, normalizedLimit));
  return db.all<DraftRow>(
    `
      select ${DRAFT_COLUMNS}
      from prompt_stashes
      order by created_at desc, id desc
      limit ?
    `,
    [safeLimit],
  ).map((row) => fromRow(row, currentSiteId(db)));
}

export function getDraft(db: DraftDb, id: string): DraftEntry | null {
  const normalizedId = id.trim();
  if (!normalizedId) return null;
  const row = db.get<DraftRow>(
    `select ${DRAFT_COLUMNS} from prompt_stashes where id = ? limit 1`,
    [normalizedId],
  );
  return row ? fromRow(row, currentSiteId(db)) : null;
}

/**
 * Image paths this machine owns and must not hand to the stale temporary-
 * attachment sweep while a draft still needs them.
 */
export function listDraftAttachmentPaths(
  db: Pick<AdeDb, "get" | "all" | "run"> & Partial<Pick<AdeDb, "sync">>,
): Set<string> {
  pruneDraftRetention(db);
  const localSiteId = currentSiteId(db);
  if (!localSiteId) return new Set();
  const rows = db.all<Pick<DraftRow, "attachments_json" | "attachment_origin_site_id">>(
    `
      select attachments_json, attachment_origin_site_id
      from prompt_stashes
    `,
  );
  return new Set(rows.flatMap((row) => (
    normalizeSiteId(row.attachment_origin_site_id) === localSiteId
      ? parseAttachments(row.attachments_json)
      .filter((attachment) => attachment.type === "image")
      .map((attachment) => attachment.path)
      : []
  )));
}

type NormalizedSchedule = {
  scheduledAt: string;
  targetKind: DraftTargetKind;
  targetSessionId: string | null;
  targetLaneId: string | null;
  targetMachineKey: string | null;
  deliveryPolicy: DraftDeliveryPolicy;
  graceSeconds: number | null;
  provider: string | null;
  modelId: string | null;
  model: string | null;
  permissionMode: string | null;
  thinking: string | null;
  scheduledBy: DraftScheduledBy;
  scheduledBySessionId: string | null;
};

function normalizeSchedule(value: unknown, nowMs = Date.now()): NormalizedSchedule {
  const args = objectRecord(value);
  const scheduledAt = typeof args.scheduledAt === "string" ? args.scheduledAt.trim() : "";
  if (!scheduledAt) throw new Error("A scheduled send needs a fire time.");
  const fireAt = Date.parse(scheduledAt);
  if (!Number.isFinite(fireAt)) {
    throw new Error("A scheduled send needs a valid fire time.");
  }
  if (fireAt <= nowMs) {
    throw new Error("A scheduled send must be set in the future.");
  }
  if (fireAt - nowMs > MAX_DRAFT_SCHEDULE_LEAD_MS) {
    throw new Error("A scheduled send cannot be more than a year away.");
  }

  const targetKind = asEnum(args.targetKind, TARGET_KINDS);
  if (!targetKind) {
    throw new Error("A scheduled send needs a target: an existing chat or a new chat.");
  }
  const targetSessionId = optionalString(args.targetSessionId);
  const targetLaneId = optionalString(args.targetLaneId);
  // The target is always explicit: a schedule never guesses where to send.
  if (targetKind === "existing" && !targetSessionId) {
    throw new Error("Choose the chat this send should go to.");
  }
  if (targetKind === "new" && !targetLaneId) {
    throw new Error("Choose the lane a new chat should start in.");
  }
  // A brand-new chat has to be created with a real model, and the scheduled
  // send captures the composer's, so require it here rather than discovering
  // the gap at fire time when nobody is watching.
  const newChatModel = optionalString(args.model);
  if (targetKind === "new" && !newChatModel) {
    throw new Error("Choose a model for the new chat.");
  }

  const deliveryPolicy = asEnum(args.deliveryPolicy, DELIVERY_POLICIES) ?? "wait";
  let graceSeconds: number | null = null;
  if (deliveryPolicy === "grace") {
    const raw = args.graceSeconds;
    if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
      throw new Error("A grace window needs a whole number of seconds.");
    }
    if (raw > MAX_DRAFT_GRACE_SECONDS) {
      throw new Error("A grace window cannot be longer than 24 hours.");
    }
    graceSeconds = raw;
  }

  return {
    scheduledAt: new Date(fireAt).toISOString(),
    targetKind,
    targetSessionId: targetKind === "existing" ? targetSessionId : null,
    targetLaneId: targetKind === "new" ? targetLaneId : null,
    targetMachineKey: optionalString(args.targetMachineKey),
    deliveryPolicy,
    graceSeconds,
    provider: optionalString(args.provider),
    modelId: optionalString(args.modelId),
    model: optionalString(args.model),
    permissionMode: optionalString(args.permissionMode),
    thinking: optionalString(args.thinking),
    scheduledBy: asEnum(args.scheduledBy, ["user", "agent"] as const) ?? "user",
    scheduledBySessionId: optionalString(args.scheduledBySessionId),
  };
}

export function createDraft(
  db: DraftDb,
  value: unknown,
): DraftEntry {
  const args = objectRecord(value);
  const text = typeof args.text === "string" ? args.text : "";
  const attachments = normalizeAttachments(args.attachments);
  const attachmentOriginSiteId = attachments.some((attachment) => attachment.type === "image")
    ? currentSiteId(db)
    : null;
  const schedule = args.schedule == null || args.schedule === undefined
    ? null
    : normalizeSchedule(args.schedule);
  if (!text.trim() && attachments.length === 0) {
    throw new Error("A draft cannot be empty.");
  }
  if (text.length > MAX_DRAFT_TEXT_CHARS) {
    throw new Error("This prompt is too large to save.");
  }
  if (schedule && countPendingScheduledDrafts(db) >= MAX_SCHEDULED_DRAFTS) {
    throw new Error(`You can have at most ${MAX_SCHEDULED_DRAFTS} scheduled sends. Cancel one first.`);
  }
  if (!schedule && countPlainDrafts(db) >= MAX_DRAFTS) {
    pruneDraftRetention(db);
  }

  const nowIso = new Date().toISOString();
  const entry: DraftEntry = {
    id: randomUUID(),
    text,
    attachments,
    attachmentCount: attachments.length,
    attachmentsAvailable: true,
    provider: schedule?.provider ?? optionalString(args.provider),
    modelId: schedule?.modelId ?? optionalString(args.modelId),
    model: schedule?.model ?? optionalString(args.model),
    createdAt: nextCreatedAt(db),
    updatedAt: nowIso,
    kind: schedule ? "scheduled" : "draft",
    status: schedule ? "scheduled" : "draft",
    scheduledAt: schedule?.scheduledAt ?? null,
    deliveryPolicy: schedule?.deliveryPolicy,
    graceSeconds: schedule?.graceSeconds ?? undefined,
    targetKind: schedule?.targetKind,
    targetSessionId: schedule?.targetSessionId ?? null,
    targetLaneId: schedule?.targetLaneId ?? null,
    targetMachineKey: schedule?.targetMachineKey ?? null,
    originSessionId: optionalString(args.originSessionId),
    permissionMode: schedule?.permissionMode ?? null,
    thinking: schedule?.thinking ?? null,
    scheduledBy: schedule?.scheduledBy,
    scheduledBySessionId: schedule?.scheduledBySessionId ?? null,
    firedAt: null,
    lastError: null,
  };
  db.run(
    `
      insert into prompt_stashes(
        id, text, attachments_json, attachment_origin_site_id, provider, model_id, model, created_at,
        updated_at, kind, status, scheduled_at, delivery_policy, grace_seconds, target_kind,
        target_session_id, target_lane_id, target_machine_key, origin_session_id, permission_mode,
        thinking, scheduled_by, scheduled_by_session_id, fired_at, last_error
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      entry.id,
      entry.text,
      JSON.stringify(entry.attachments),
      attachmentOriginSiteId,
      entry.provider,
      entry.modelId,
      entry.model ?? null,
      entry.createdAt,
      nowIso,
      entry.kind ?? "draft",
      entry.status ?? "draft",
      entry.scheduledAt ?? null,
      entry.deliveryPolicy ?? null,
      entry.graceSeconds ?? null,
      entry.targetKind ?? null,
      entry.targetSessionId ?? null,
      entry.targetLaneId ?? null,
      entry.targetMachineKey ?? null,
      entry.originSessionId ?? null,
      entry.permissionMode ?? null,
      entry.thinking ?? null,
      entry.scheduledBy ?? null,
      entry.scheduledBySessionId ?? null,
      null,
      null,
    ],
  );

  pruneDraftRetention(db);
  return entry;
}

export function deleteDraft(db: DraftDb, id: string): boolean {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new Error("A draft id is required.");
  }
  const existing = db.get<{ id: string }>(
    "select id from prompt_stashes where id = ? limit 1",
    [normalizedId],
  );
  if (!existing) return false;
  db.run("delete from prompt_stashes where id = ?", [normalizedId]);
  return true;
}

/**
 * Claim a draft before putting it in a composer, and return the claimed row.
 *
 * The delete *is* the claim: only the caller whose delete actually removed the
 * row may fill a composer, so the sequential two-machine case (restore on one
 * machine, then the other refreshes) can no longer put the same text in two
 * composers. Two humans clicking the same row on two machines at the same
 * instant is still decided by CRR convergence afterwards rather than before —
 * see docs/features/chat/drafts-and-scheduled-send.md.
 */
export function claimDraft(db: DraftDb, id: string): DraftEntry | null {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new Error("A draft id is required.");
  }
  // The runtime's SQLite handle is synchronous and single-connection, so the
  // read and the delete below cannot interleave with another claim here.
  const row = db.get<DraftRow>(
    `select ${DRAFT_COLUMNS} from prompt_stashes where id = ? limit 1`,
    [normalizedId],
  );
  if (!row) return null;
  const entry = fromRow(row, currentSiteId(db));
  db.run("delete from prompt_stashes where id = ?", [normalizedId]);
  return entry;
}

/**
 * Edit a draft's text, or arm/retime/clear its schedule. Returns the updated
 * row, or null when the draft is gone (taken on another machine).
 */
export function updateDraft(db: DraftDb, value: unknown): DraftEntry | null {
  const args = objectRecord(value);
  const id = optionalString(args.id);
  if (!id) throw new Error("A draft id is required.");
  const existing = db.get<DraftRow>(
    `select ${DRAFT_COLUMNS} from prompt_stashes where id = ? limit 1`,
    [id],
  );
  if (!existing) return null;

  const patch: Record<string, unknown> = {};
  if (typeof args.text === "string") {
    if (args.text.length > MAX_DRAFT_TEXT_CHARS) {
      throw new Error("This prompt is too large to save.");
    }
    patch.text = args.text;
  }

  if (args.unschedule === true) {
    patch.kind = "draft";
    patch.status = "draft";
    patch.scheduled_at = null;
    patch.delivery_policy = null;
    patch.grace_seconds = null;
    patch.target_kind = null;
    patch.target_session_id = null;
    patch.target_lane_id = null;
    patch.target_machine_key = null;
    patch.model = null;
    patch.permission_mode = null;
    patch.thinking = null;
    patch.scheduled_by = null;
    patch.scheduled_by_session_id = null;
    patch.last_error = null;
  } else if (args.schedule !== undefined && args.schedule !== null) {
    const existingStatus = asEnum(existing.status, DRAFT_STATUSES) ?? "draft";
    const wasPending = (PENDING_DRAFT_STATUSES as readonly string[]).includes(existingStatus);
    if (!wasPending && countPendingScheduledDrafts(db) >= MAX_SCHEDULED_DRAFTS) {
      throw new Error(`You can have at most ${MAX_SCHEDULED_DRAFTS} scheduled sends. Cancel one first.`);
    }
    const schedule = normalizeSchedule(args.schedule);
    patch.kind = "scheduled";
    patch.status = "scheduled";
    patch.scheduled_at = schedule.scheduledAt;
    patch.delivery_policy = schedule.deliveryPolicy;
    patch.grace_seconds = schedule.graceSeconds;
    patch.target_kind = schedule.targetKind;
    patch.target_session_id = schedule.targetSessionId;
    patch.target_lane_id = schedule.targetLaneId;
    patch.target_machine_key = schedule.targetMachineKey;
    patch.model = schedule.model;
    patch.permission_mode = schedule.permissionMode;
    patch.thinking = schedule.thinking;
    patch.scheduled_by = schedule.scheduledBy;
    patch.scheduled_by_session_id = schedule.scheduledBySessionId;
    patch.last_error = null;
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    return fromRow(existing, currentSiteId(db));
  }
  const updatedAt = new Date().toISOString();
  const assignments = [...keys, "updated_at"].map((key) => `${key} = ?`).join(", ");
  const values = keys.map((key) => patch[key] as SqlValue);
  db.run(`update prompt_stashes set ${assignments} where id = ?`, [...values, updatedAt, id]);
  return getDraft(db, id);
}

/** Statuses/errors the scheduler writes back onto a row. */
export function setDraftStatus(
  db: DraftDb,
  id: string,
  patch: {
    status: DraftStatus;
    firedAt?: string | null;
    lastError?: string | null;
  },
): void {
  db.run(
    `
      update prompt_stashes
      set status = ?, fired_at = coalesce(?, fired_at), last_error = ?, updated_at = ?
      where id = ?
    `,
    [
      patch.status,
      patch.firedAt ?? null,
      patch.lastError ?? null,
      new Date().toISOString(),
      id,
    ],
  );
}

/**
 * Scheduled sends that are due to fire on this machine, oldest fire time
 * first. `machineKey` filters to rows this runtime owns: another machine's
 * row is visible over sync but must not be delivered from here.
 */
export function listDueScheduledDrafts(
  db: DraftDb,
  machineKey: string | null,
  nowMs = Date.now(),
): DraftEntry[] {
  const nowIso = new Date(nowMs).toISOString();
  const localSiteId = currentSiteId(db);
  const rows = db.all<DraftRow>(
    `
      select ${DRAFT_COLUMNS}
      from prompt_stashes
      where kind = 'scheduled'
        and status in ('scheduled', 'sending')
        and scheduled_at is not null
        and scheduled_at <= ?
      order by scheduled_at asc, created_at asc
    `,
    [nowIso],
  ).map((row) => fromRow(row, localSiteId));

  return rows.filter((entry) => {
    const target = entry.targetMachineKey?.trim() || null;
    if (!target) return true;
    return machineKey != null && target === machineKey;
  });
}

/** Every armed send, for the drafts list's Scheduled bucket. */
export function listScheduledDrafts(db: DraftDb): DraftEntry[] {
  const localSiteId = currentSiteId(db);
  return db.all<DraftRow>(
    `
      select ${DRAFT_COLUMNS}
      from prompt_stashes
      where kind = 'scheduled'
      order by scheduled_at asc, created_at desc
    `,
  ).map((row) => fromRow(row, localSiteId));
}

/**
 * The soonest fire time this machine still has to wake for, or null when it
 * owns nothing pending. Machine-untargeted rows belong to whichever runtime is
 * running, so they count here; another machine's targeted row does not.
 */
export function nextScheduledDraftFireAt(
  db: DraftDb,
  machineKey: string | null,
): number | null {
  const rows = db.all<Pick<DraftRow, "scheduled_at" | "target_machine_key">>(
    `
      select scheduled_at, target_machine_key
      from prompt_stashes
      where kind = 'scheduled'
        and status = 'scheduled'
        and scheduled_at is not null
      order by scheduled_at asc
    `,
  );
  for (const row of rows) {
    const target = row.target_machine_key?.trim() || null;
    if (target && (machineKey == null || target !== machineKey)) continue;
    const fireAt = row.scheduled_at ? Date.parse(row.scheduled_at) : Number.NaN;
    if (Number.isFinite(fireAt)) return fireAt;
  }
  return null;
}

export type DraftScheduleInputType = DraftScheduleInput;
