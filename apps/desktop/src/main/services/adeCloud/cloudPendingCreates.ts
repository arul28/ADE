/**
 * Creates of cloud boxes that have not been resolved yet, kept on disk.
 *
 * A create is recorded BEFORE ADE asks the provider for the box, by the request id
 * ADE puts in the box's metadata (`ade_request_id`). That covers every way a
 * create can end without ADE knowing the box's id: a create that timed out or
 * lost its answer, an app quit mid-request, a failed list or delete. Whoever
 * finds the record (the create's own failure path, or the next app start)
 * reconciles it against the provider: boxes made for that request that never
 * signed in are deleted, and the record goes only once the provider confirms each
 * deletion. A box that signed in is a real machine and is kept.
 *
 * A record that matches no box is kept for a day, in case the provider had the
 * create in flight, and then dropped.
 */

import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { CloudProviderError, type CloudProvider, type CloudInstance } from "./cloudProvider";

export type CloudPendingCreate = {
  requestId: string;
  /** Epoch ms when ADE recorded the intent, before asking the provider. */
  startedAt: number;
  /** Boxes known to belong to this request (from the create answer or a list). */
  instanceIds: string[];
};

export type CloudPendingCreateStore = {
  list(): CloudPendingCreate[];
  /** Before the create request goes out. Throws when it could not be saved: then no box may be made. */
  begin(requestId: string, startedAt: number): void;
  /** The box this request made, once ADE knows its id. */
  attach(requestId: string, instanceId: string): void;
  /** Every box the request made is resolved (deleted, or signed in and kept). */
  finish(requestId: string): void;
};

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
};

const PENDING_CREATES_KEY = "cloud.pendingCreates.v2";
/** The first format: a bare list of instance ids, written after the create answered. */
const LEGACY_PENDING_CREATES_KEY = "cloud.pendingCreates.v1";
/** A record that matched no box for this long is dropped. */
const CLOUD_PENDING_CREATE_TTL_MS = 24 * 60 * 60_000;
const DELETE_CONFIRM_ATTEMPTS = 15;
const DELETE_CONFIRM_POLL_MS = 2_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRecords(raw: string | null | undefined): CloudPendingCreate[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  const out: CloudPendingCreate[] = [];
  for (const entry of parsed) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!record || typeof record.requestId !== "string" || !record.requestId) continue;
    out.push({
      requestId: record.requestId,
      startedAt: typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : 0,
      instanceIds: Array.isArray(record.instanceIds)
        ? record.instanceIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [],
    });
  }
  return out;
}

/** The pending creates in this computer's shared credential file. Every read and write failure is logged. */
export function createCloudPendingCreateStore(
  machineStore: () => SyncCredentialStore,
  logger: Logger,
  now: () => number = () => Date.now(),
): CloudPendingCreateStore {
  /** `strict`: throw instead of reading an unreadable store as empty, so an update cannot overwrite it. */
  const read = (strict = false): CloudPendingCreate[] => {
    let records: CloudPendingCreate[] = [];
    try {
      records = parseRecords(machineStore().getSync(PENDING_CREATES_KEY));
    } catch (error) {
      logger.warn?.("cloud.pending_creates_read_failed", { error: errorText(error) });
      if (strict) throw error;
    }
    // Ids an older build recorded: reconciled by id, with no request to list by.
    try {
      const legacy = machineStore().getSync(LEGACY_PENDING_CREATES_KEY);
      if (legacy) {
        const ids = JSON.parse(legacy) as unknown;
        if (Array.isArray(ids)) {
          for (const id of ids) {
            if (typeof id === "string" && id) records.push({ requestId: `legacy:${id}`, startedAt: now(), instanceIds: [id] });
          }
        }
      }
    } catch (error) {
      logger.warn?.("cloud.pending_creates_read_failed", { error: errorText(error), legacy: true });
    }
    return records;
  };
  const write = (records: CloudPendingCreate[], strict = false): void => {
    try {
      if (records.length) machineStore().setSync(PENDING_CREATES_KEY, JSON.stringify(records));
      else machineStore().deleteSync(PENDING_CREATES_KEY);
      machineStore().deleteSync(LEGACY_PENDING_CREATES_KEY);
    } catch (error) {
      // The create still cleans up after itself in this session; only a quit
      // in the middle of it would go unrecovered.
      logger.warn?.("cloud.pending_creates_write_failed", { error: errorText(error), count: records.length });
      if (strict) throw error;
    }
  };
  const update = (
    requestId: string,
    change: (record: CloudPendingCreate | null) => CloudPendingCreate | null,
    strict = false,
  ) => {
    const records = read(strict);
    const index = records.findIndex((record) => record.requestId === requestId);
    const next = change(index >= 0 ? records[index]! : null);
    if (index >= 0) {
      if (next) records[index] = next;
      else records.splice(index, 1);
    } else if (next) {
      records.push(next);
    }
    write(records, strict);
  };
  return {
    list: read,
    begin: (requestId, startedAt) => update(requestId, (record) => record ?? { requestId, startedAt, instanceIds: [] }, true),
    attach: (requestId, instanceId) => update(requestId, (record) => {
      const base = record ?? { requestId, startedAt: now(), instanceIds: [] };
      return base.instanceIds.includes(instanceId) ? base : { ...base, instanceIds: [...base.instanceIds, instanceId] };
    }),
    finish: (requestId) => update(requestId, () => null),
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudProviderError && error.status === 404;
}

/** The instance, null when the provider no longer has it (404), undefined when ADE couldn't ask. */
async function lookUp(client: CloudProvider, instanceId: string, logger: Logger): Promise<CloudInstance | null | undefined> {
  try {
    return await client.getInstance(instanceId);
  } catch (error) {
    if (isNotFound(error)) return null;
    logger.warn?.("cloud.instance_lookup_failed", { instanceId, error: errorText(error) });
    return undefined;
  }
}

/**
 * Deletes a box and waits until the provider confirms it is gone (a 404 or
 * `deleted`). True only on that confirmation.
 */
export async function deleteCloudInstanceConfirmed(
  client: CloudProvider,
  instanceId: string,
  deps: { logger: Logger; sleep: (ms: number) => Promise<void> },
): Promise<boolean> {
  try {
    await client.deleteInstance(instanceId);
  } catch (error) {
    // A repeat delete answers 404; the read below says whether it is gone.
    if (!isNotFound(error)) {
      deps.logger.warn?.("cloud.instance_delete_failed", { instanceId, error: errorText(error) });
      return false;
    }
  }
  for (let attempt = 0; attempt < DELETE_CONFIRM_ATTEMPTS; attempt += 1) {
    const instance = await lookUp(client, instanceId, deps.logger);
    if (instance === null || instance?.status === "deleted") return true;
    await deps.sleep(DELETE_CONFIRM_POLL_MS);
  }
  deps.logger.warn?.("cloud.instance_delete_unconfirmed", { instanceId });
  return false;
}

/**
 * Whether a box signed in to ADE, asked on the box itself. Tri-state on
 * purpose: only a clear "signed out" lets a sweep delete a box. Asleep,
 * unreachable or an unreadable answer is "unknown", and a box that may be
 * someone's real machine is never deleted on a guess.
 */
export async function readCloudBoxSignedIn(
  client: CloudProvider,
  instanceId: string,
  logger: Logger,
): Promise<boolean | "unknown"> {
  let auth: Awaited<ReturnType<CloudProvider["exec"]>>;
  try {
    auth = await client.exec(instanceId, "timeout 20 ade auth status --json 2>/dev/null", { timeoutMs: 40_000 });
  } catch (error) {
    logger.warn?.("cloud.half_made_box_auth_read_failed", { instanceId, error: errorText(error) });
    return "unknown";
  }
  // The box answered but has no ADE to ask (127, command not found): it never signed in.
  if (auth.exitCode === 127) return false;
  if (auth.exitCode !== 0) return "unknown";
  if (/"signedIn"\s*:\s*true/.test(auth.stdout)) return true;
  if (/"signedIn"\s*:\s*false/.test(auth.stdout)) return false;
  logger.warn?.("cloud.half_made_box_auth_unreadable", { instanceId });
  return "unknown";
}

export type CloudReconcileResult = {
  /** Every box the request made is resolved and the record is gone. */
  resolved: boolean;
  deleted: string[];
  kept: string[];
  /** Boxes the provider already had no record of (or had marked deleted). */
  gone: string[];
  /** Boxes ADE could not delete or confirm; the record stays for the next start. */
  unresolved: string[];
};

/**
 * Brings one pending create to rest. `isSignedIn` decides which boxes are real
 * machines to keep; leave it out where no box can have signed in yet.
 */
export async function reconcileCloudPendingCreate(
  client: CloudProvider,
  record: CloudPendingCreate,
  deps: {
    store: CloudPendingCreateStore;
    logger: Logger;
    sleep: (ms: number) => Promise<void>;
    now?: () => number;
    /** "unknown" (asleep, unreachable, unreadable answer) keeps the box and its record. */
    isSignedIn?: (instanceId: string) => Promise<boolean | "unknown">;
  },
): Promise<CloudReconcileResult> {
  const now = deps.now ?? (() => Date.now());
  const result: CloudReconcileResult = { resolved: false, deleted: [], kept: [], gone: [], unresolved: [] };
  const legacy = record.requestId.startsWith("legacy:");
  let listed: CloudInstance[] | null = null;
  if (!legacy) {
    try {
      listed = await client.listInstances();
    } catch (error) {
      // Can't tell whether a box exists: keep the record and ask again later.
      deps.logger.warn?.("cloud.pending_create_list_failed", { requestId: record.requestId, error: errorText(error) });
      return result;
    }
  }
  const candidates = new Map<string, CloudInstance | null | undefined>();
  for (const instance of listed ?? []) {
    if (instance.metadata.ade_request_id === record.requestId) candidates.set(instance.id, instance);
  }
  for (const id of record.instanceIds) {
    if (!candidates.has(id)) candidates.set(id, await lookUp(client, id, deps.logger));
  }
  for (const [id, known] of candidates) {
    if (!record.instanceIds.includes(id)) deps.store.attach(record.requestId, id);
    if (known === undefined) {
      result.unresolved.push(id);
      continue;
    }
    if (known === null || known.status === "deleted") {
      result.gone.push(id);
      continue;
    }
    // Delete only on a clear "signed out". A box that is asleep or cannot be
    // asked may be a real machine: keep it, and its record, for the next start.
    const signedIn = deps.isSignedIn ? await deps.isSignedIn(id) : false;
    if (signedIn === true) {
      result.kept.push(id);
      continue;
    }
    if (signedIn === "unknown") {
      result.unresolved.push(id);
      continue;
    }
    if (await deleteCloudInstanceConfirmed(client, id, deps)) {
      result.deleted.push(id);
      deps.logger.warn?.("cloud.half_made_box_deleted", { instanceId: id, requestId: record.requestId });
    } else {
      result.unresolved.push(id);
    }
  }
  if (result.unresolved.length) return result;
  // No box at all for a fresh request: the provider may still be making it.
  if (candidates.size === 0 && now() - record.startedAt < CLOUD_PENDING_CREATE_TTL_MS) return result;
  deps.store.finish(record.requestId);
  result.resolved = true;
  return result;
}

/**
 * Creates a quit (or a lost answer) left unresolved: a box that never signed
 * in is only a bill, so it is deleted; one that signed in is a real machine
 * and is kept. Records stay until the provider confirms, so a failure here is
 * retried at the next start.
 */
export async function sweepCloudPendingCreates(
  client: CloudProvider,
  leftover: CloudPendingCreate[],
  pending: CloudPendingCreateStore,
  logger: Logger,
): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const isSignedIn = (instanceId: string) => readCloudBoxSignedIn(client, instanceId, logger);
  for (const record of leftover) {
    const result = await reconcileCloudPendingCreate(client, record, { store: pending, logger, sleep, isSignedIn });
    logger.info?.("cloud.pending_create_reconciled", {
      requestId: record.requestId,
      resolved: result.resolved,
      deleted: result.deleted,
      kept: result.kept,
      gone: result.gone,
      unresolved: result.unresolved,
    });
  }
}
