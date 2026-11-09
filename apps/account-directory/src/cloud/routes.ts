import { authenticate } from "../callerToken";
import { handleCloudWakeRequest, isCloudWakeRequest } from "../cloudWake";
import { CLOUD_PATHS, type CloudInstance } from "./contract";
import {
  DISK_ON_CREATE_GB,
  DISK_STEP_GB,
  FREE_DISK_GB,
  PAID_DISK_POOL_GB,
  WAKE_PORT,
  cloudSizeFor,
  isMeteredStatus,
  type CloudSize,
} from "./plans";
import { CloudProviderError, cloudErrorMessage, createCloudProvider, type CloudProvider } from "./provider";
import {
  accountRules,
  buildAccountState,
  computerLimit,
  deleteLogStatement,
  isOutOfHours,
  isPendingId,
  listComputers,
  liveUsedMilli,
  loadAccount,
  logCloud,
  markDeletedStatements,
  newPendingId,
  ownedComputer,
  powerLogStatement,
  readSetting,
  statusChangeStatements,
  type AccountRow,
  type CloudEnv,
  type ComputerRow,
} from "./store";

/**
 * The ADE Cloud routes (README, "ADE Cloud account"; shapes in `contract.ts`).
 * Each mirrors one `CloudProvider` method: the owner check, the limits and the
 * pinned template are enforced here so a client can't talk around them.
 */

const PREFIX = "/cloud";
const INSTANCE_ID = /^[a-z0-9]{4,40}$/;
const MAX_BODY_BYTES = 256_000;
const MAX_METADATA_ENTRIES = 32;
const MAX_ENV_ENTRIES = 64;
const MAX_STRING = 4096;
const MAX_COMMAND = 100_000;
const MAX_EXEC_TIMEOUT_MS = 15 * 60_000;
/** A push-work wake runs this long, once a day per computer. */
const FREE_WAKE_MS = 15 * 60_000;
const FREE_WAKE_COOLDOWN_MS = 24 * 60 * 60_000;
const PENDING_TIMEOUT_MS = 15 * 60_000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const fail = (code: string, message: string, status: number): Response => json({ error: { code, message } }, status);

const NOT_FOUND_MESSAGE = "ADE Cloud has no such computer.";
const notFound = () => fail("not_found", NOT_FOUND_MESSAGE, 404);
const badRequest = (message: string) => fail("bad_request", message, 400);
const outOfHours = () => fail("out_of_hours", "You're out of ADE Cloud hours for this period.", 402);

export const CANT_MAKE_COMPUTER_MESSAGE = "ADE Cloud can't make a computer right now. Try again soon.";

/** `CLOUD_ACCESS_ACCOUNTS`: comma list of Clerk ids, or `*`. Unset is nobody. */
export function cloudAccessAllows(env: Pick<CloudEnv, "CLOUD_ACCESS_ACCOUNTS">, userId: string): boolean {
  const list = (env.CLOUD_ACCESS_ACCOUNTS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return list.includes("*") || list.includes(userId);
}

export function isCloudRequest(url: URL): boolean {
  return url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (!text) return {};
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringMap(value: unknown, maxEntries: number): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxEntries) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (typeof entry !== "string" || key.length > 200 || entry.length > MAX_STRING) return null;
    out[key] = entry;
  }
  return out;
}

const shortText = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

function providerFor(env: CloudEnv): CloudProvider | null {
  const key = env.AGENT37_API_KEY?.trim();
  return key ? createCloudProvider(key) : null;
}

/** Runs a provider call; its failure becomes the plain sentence the client shows. */
async function providerCall(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CloudProviderError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return fail(error.code, error.message, status);
    }
    throw error;
  }
}

async function getAccountContext(env: CloudEnv, userId: string, now: number): Promise<{ account: AccountRow; computers: ComputerRow[]; outOfHours: boolean }> {
  const account = await loadAccount(env, userId, now);
  const computers = await listComputers(env, userId);
  return { account, computers, outOfHours: isOutOfHours(account, liveUsedMilli(account, computers, now)) };
}

/** Writes the status from a provider answer, on change only. */
async function recordStatus(env: CloudEnv, computer: ComputerRow, status: string, now: number, reason: string): Promise<void> {
  const statements = statusChangeStatements(env, computer, status, now, reason);
  if (statements.length) await env.DB.batch(statements);
}

async function markGone(env: CloudEnv, computer: ComputerRow, now: number): Promise<void> {
  await env.DB.batch([
    ...markDeletedStatements(env, computer, now),
    deleteLogStatement(env, computer, { who: null, reason: "gone_from_provider", events: null }, now),
  ]);
}

/** A reservation that makes the limit and disk checks hold under concurrent creates. */
async function reserveComputer(env: CloudEnv, account: AccountRow, args: {
  size: CloudSize;
  diskGb: number;
  name: string | null;
  requestId: string;
  templateVersion: string | null;
  now: number;
}): Promise<{ ok: true; pendingId: string } | { ok: false; response: Response }> {
  const rules = accountRules(account);
  const limit = computerLimit(account);
  const pendingId = newPendingId();
  const cutoff = args.now - PENDING_TIMEOUT_MS;
  const result = await env.DB.prepare(`
    insert into cloud_computers (instance_id, user_id, request_id, type, cpu, memory_gb, disk_gb, multiplier_milli, template_version, name, status, status_changed_at, last_awake_at, created_at)
    select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?
    where (select count(*) from cloud_computers where user_id = ? and deleted_at is null and (status != 'provisioning' or created_at > ?)) < ?
      and (? is null or (select coalesce(sum(disk_gb), 0) from cloud_computers where user_id = ? and deleted_at is null) + ? <= ?)
  `).bind(
    pendingId, account.user_id, args.requestId, args.size.type, args.size.cpu, args.size.memoryGb, args.diskGb, args.size.multiplierMilli,
    args.templateVersion, args.name, args.now, args.now, args.now,
    account.user_id, cutoff, limit,
    rules === "paid" ? PAID_DISK_POOL_GB : null, account.user_id, args.diskGb, PAID_DISK_POOL_GB,
  ).run();
  if (result.meta.changes === 1) return { ok: true, pendingId };
  const computers = await listComputers(env, account.user_id);
  if (computers.length >= limit) {
    const message = rules === "paid"
      ? `Your plan allows ${limit} computers. Delete one to make another.`
      : `The free plan allows ${limit} computers. Delete one to make another, or move to a paid plan.`;
    return { ok: false, response: fail("computer_limit", message, 403) };
  }
  return {
    ok: false,
    response: fail("disk_limit", `Your computers share ${PAID_DISK_POOL_GB} GB of disk, and this would go past it.`, 403),
  };
}

async function releasePending(env: CloudEnv, pendingId: string): Promise<void> {
  await env.DB.prepare("delete from cloud_computers where instance_id = ?").bind(pendingId).run();
}

/** The reservation becomes the real row, unless a tick already adopted it. */
async function adoptReservation(env: CloudEnv, pendingId: string, instance: CloudInstance, machineKey: string | null, now: number, reason: string): Promise<void> {
  const statements = [
    env.DB.prepare(`
      update cloud_computers set instance_id = ?, machine_key = coalesce(?, machine_key), status = ?, status_changed_at = ?,
        awake_since = ?, last_awake_at = ?
      where instance_id = ?
    `).bind(instance.id, machineKey, instance.status, now, isMeteredStatus(instance.status) ? now : null, now, pendingId),
  ];
  await env.DB.batch(statements);
  await env.DB.prepare("insert into cloud_power_log (instance_id, user_id, action, reason, created_at) select ?, user_id, 'start', ?, ? from cloud_computers where instance_id = ?")
    .bind(instance.id, reason, now, instance.id).run();
}

const withRequestId = (metadata: Record<string, string>): { metadata: Record<string, string>; requestId: string } => {
  const requestId = metadata.ade_request_id || crypto.randomUUID();
  return { metadata: { ...metadata, ade_request_id: requestId }, requestId };
};

const onlyWakePorts = (ports: unknown): Array<{ port: number; label: string }> | null => {
  if (ports === undefined) return [];
  if (!Array.isArray(ports)) return null;
  const out: Array<{ port: number; label: string }> = [];
  for (const entry of ports) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (record?.port !== WAKE_PORT) return null;
    out.push({ port: WAKE_PORT, label: shortText(record.label, 60) ?? "ADE wake" });
  }
  return out;
};

async function handleCreate(request: Request, env: CloudEnv, userId: string, provider: CloudProvider, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest("That request could not be read.");
  const resources = body.resources && typeof body.resources === "object" ? body.resources as Record<string, unknown> : null;
  const size = cloudSizeFor(body.type, resources?.cpu, resources?.memory);
  if (!size) return badRequest("That size isn't one ADE Cloud offers.");
  const name = shortText(body.name, 60) ?? "ADE computer";
  const clientMetadata = stringMap(body.metadata, MAX_METADATA_ENTRIES);
  const clientEnv = stringMap(body.env, MAX_ENV_ENTRIES);
  const publicPorts = onlyWakePorts(body.publicPorts);
  if (!clientMetadata || !clientEnv || !publicPorts) return badRequest("That request could not be read.");

  const templateVersion = await readSetting(env, "template_version");
  if (!templateVersion) {
    logCloud("cloud.create_refused_no_template_version", { userId });
    return fail("template_unset", CANT_MAKE_COMPUTER_MESSAGE, 503);
  }
  const { account, outOfHours: empty } = await getAccountContext(env, userId, now);
  if (empty) return outOfHours();

  const { metadata, requestId } = withRequestId(clientMetadata);
  const reservation = await reserveComputer(env, account, { size, diskGb: DISK_ON_CREATE_GB, name, requestId, templateVersion, now });
  if (!reservation.ok) return reservation.response;

  try {
    const instance = await provider.createInstance({
      template: templateVersion,
      name,
      type: size.type,
      resources: { cpu: size.cpu, memory: size.memoryGb, disk: DISK_ON_CREATE_GB },
      ...(Object.keys(clientEnv).length ? { env: clientEnv } : {}),
      metadata,
      ...(publicPorts.length ? { publicPorts } : {}),
    });
    await adoptReservation(env, reservation.pendingId, instance, metadata.ade_machine_key ?? null, Date.now(), "create");
    return json(instance, 201);
  } catch (error) {
    await releasePending(env, reservation.pendingId);
    if (error instanceof CloudProviderError && (error.code === "not_found" || error.code === "invalid_request")) {
      logCloud("cloud.create_refused_template", { userId, templateVersion, code: error.code });
      return fail("template_unavailable", CANT_MAKE_COMPUTER_MESSAGE, 503);
    }
    throw error;
  }
}

async function handleFork(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest("That request could not be read.");
  const { account, outOfHours: empty } = await getAccountContext(env, computer.user_id, now);
  if (empty) return outOfHours();

  const resources = body.resources && typeof body.resources === "object" ? body.resources as Record<string, unknown> : null;
  const size = resources
    ? cloudSizeFor(computer.type, resources.cpu, resources.memory)
    : cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
  if (!size) return badRequest("That size isn't one ADE Cloud offers.");
  const requestedDisk = typeof resources?.disk === "number" ? resources.disk : computer.disk_gb;
  if (requestedDisk < computer.disk_gb) return badRequest("A copy's disk can't be smaller than the original's.");
  if (accountRules(account) === "free" && requestedDisk > FREE_DISK_GB) return diskNeedsPaid();

  const metadataIn = stringMap(body.metadata, MAX_METADATA_ENTRIES);
  if (!metadataIn) return badRequest("That request could not be read.");
  const { metadata, requestId } = withRequestId(metadataIn);
  const name = shortText(body.name, 60);
  const reservation = await reserveComputer(env, account, {
    size,
    diskGb: requestedDisk,
    name: name ?? computer.name,
    requestId,
    templateVersion: computer.template_version,
    now,
  });
  if (!reservation.ok) return reservation.response;
  try {
    const instance = await provider.forkInstance(computer.instance_id, {
      ...(name ? { name } : {}),
      resources: { cpu: size.cpu, memory: size.memoryGb, disk: requestedDisk },
      metadata,
    });
    await adoptReservation(env, reservation.pendingId, instance, metadata.ade_machine_key ?? null, Date.now(), "copy");
    return json(instance, 201);
  } catch (error) {
    await releasePending(env, reservation.pendingId);
    throw error;
  }
}

const diskNeedsPaid = () => fail(
  "needs_paid_plan",
  `This needs a paid plan. Computers on the free plan stay at ${FREE_DISK_GB} GB, and Android needs 12 GB.`,
  403,
);

async function handleResize(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest("That request could not be read.");
  const { account, computers, outOfHours: empty } = await getAccountContext(env, computer.user_id, now);
  if (empty) return outOfHours();

  const size = cloudSizeFor(computer.type, body.cpu ?? computer.cpu, body.memory ?? computer.memory_gb);
  if (!size) return badRequest("That size isn't one ADE Cloud offers.");

  let nextDisk = computer.disk_gb;
  if (body.disk !== undefined) {
    if (typeof body.disk !== "number" || !Number.isInteger(body.disk)) return badRequest("That disk size isn't valid.");
    if (body.disk < computer.disk_gb) return badRequest("A computer's disk can only grow.");
    nextDisk = body.disk;
  }
  if (nextDisk !== computer.disk_gb) {
    if (accountRules(account) === "free") return diskNeedsPaid();
    if (nextDisk % DISK_STEP_GB !== 0) return badRequest(`Disk grows in steps of ${DISK_STEP_GB} GB.`);
    const usedElsewhere = computers.filter((entry) => entry.instance_id !== computer.instance_id).reduce((sum, entry) => sum + entry.disk_gb, 0);
    if (usedElsewhere + nextDisk > PAID_DISK_POOL_GB) {
      return fail("disk_limit", `Your computers share ${PAID_DISK_POOL_GB} GB of disk, and this would go past it.`, 403);
    }
    // A disk grow restarts the computer, so only the computer can say it's safe.
    if (isMeteredStatus(computer.status) && body.computerIdle !== true) {
      return fail("computer_busy", "A disk can only grow while the computer is idle.", 409);
    }
  }

  const resize: { cpu: number; memory: number; disk?: number } = { cpu: size.cpu, memory: size.memoryGb };
  if (nextDisk !== computer.disk_gb) resize.disk = nextDisk;
  const status = await provider.resizeInstance(computer.instance_id, resize);
  const statements = [
    env.DB.prepare("update cloud_computers set cpu = ?, memory_gb = ?, disk_gb = ?, multiplier_milli = ? where instance_id = ?")
      .bind(size.cpu, size.memoryGb, nextDisk, size.multiplierMilli, computer.instance_id),
    ...statusChangeStatements(env, computer, status, now, "resize"),
  ];
  await env.DB.batch(statements);
  return json({ status });
}

async function handleSleepLike(env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number, reason: string): Promise<Response> {
  const { outOfHours: empty } = await getAccountContext(env, computer.user_id, now);
  try {
    // At 0 hours a sleeping computer would wake on any request, so it stops instead.
    const status = empty ? await provider.stopInstance(computer.instance_id) : await provider.sleepInstance(computer.instance_id);
    await recordStatus(env, computer, status, now, reason);
    return json({ status });
  } catch (error) {
    if (error instanceof CloudProviderError && error.status === 400) return json({ status: computer.status });
    throw error;
  }
}

async function handleStart(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest("That request could not be read.");
  const { outOfHours: empty } = await getAccountContext(env, computer.user_id, now);
  let freeWake = false;
  if (empty) {
    if (body.reason !== "push_work") return outOfHours();
    if (computer.free_wake_used_at != null && now - computer.free_wake_used_at < FREE_WAKE_COOLDOWN_MS) return outOfHours();
    freeWake = true;
  }
  const status = await provider.startInstance(computer.instance_id);
  if (freeWake) {
    // Metering starts when the free window ends; the stretch before it costs nothing.
    computer.awake_since = now + FREE_WAKE_MS;
    computer.free_wake_started_at = now;
    computer.free_wake_until = now + FREE_WAKE_MS;
    computer.free_wake_used_at = now;
    await env.DB.batch([
      env.DB.prepare("update cloud_computers set status = ?, status_changed_at = ?, awake_since = ?, last_awake_at = ?, free_wake_started_at = ?, free_wake_until = ?, free_wake_used_at = ?, zero_stop_started_at = null where instance_id = ?")
        .bind(status, now, computer.awake_since, now, now, computer.free_wake_until, now, computer.instance_id),
      powerLogStatement(env, computer, "start", "push_work", now),
    ]);
    return json({ status });
  }
  await recordStatus(env, computer, status, now, "user");
  return json({ status });
}

async function handleStop(env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number): Promise<Response> {
  const status = await provider.stopInstance(computer.instance_id);
  await recordStatus(env, computer, status, now, "user");
  return json({ status });
}

async function handleUpdate(env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number): Promise<Response> {
  const templateVersion = await readSetting(env, "template_version");
  if (!templateVersion) {
    logCloud("cloud.update_refused_no_template_version", { userId: computer.user_id, instanceId: computer.instance_id });
    return fail("template_unset", CANT_MAKE_COMPUTER_MESSAGE, 503);
  }
  const { outOfHours: empty } = await getAccountContext(env, computer.user_id, now);
  if (empty) return outOfHours();
  const status = await provider.updateInstance(computer.instance_id, templateVersion);
  await env.DB.batch([
    env.DB.prepare("update cloud_computers set template_version = ? where instance_id = ?").bind(templateVersion, computer.instance_id),
    ...statusChangeStatements(env, computer, status, now, "update"),
  ]);
  return json({ status, templateVersion });
}

async function handleDelete(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest("That request could not be read.");
  const events = await provider.instanceEvents(computer.instance_id).catch(() => null);
  try {
    await provider.deleteInstance(computer.instance_id);
  } catch (error) {
    if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
  }
  await env.DB.batch([
    deleteLogStatement(env, computer, { who: shortText(body.who, 200), reason: shortText(body.reason, 200) ?? "user", events }, now),
    ...markDeletedStatements(env, computer, now),
  ]);
  return json({ deleted: true });
}

async function handleExec(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest("That request could not be read.");
  const command = typeof body.command === "string" ? body.command : "";
  if (!command || command.length > MAX_COMMAND) return badRequest("That command can't be run.");
  const timeoutMs = typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
    ? Math.min(MAX_EXEC_TIMEOUT_MS, Math.max(1_000, Math.round(body.timeoutMs)))
    : undefined;
  if (!isMeteredStatus(computer.status)) {
    const { outOfHours: empty } = await getAccountContext(env, computer.user_id, now);
    if (empty) return outOfHours();
  }
  return json(await provider.exec(computer.instance_id, command, timeoutMs));
}

async function handleUsage(url: URL, env: CloudEnv, userId: string, provider: CloudProvider): Promise<Response> {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || (to !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(to))) return badRequest("That date range isn't valid.");
  const owned = await env.DB.prepare("select instance_id from cloud_computers where user_id = ?").bind(userId).all<{ instance_id: string }>();
  const mine = new Set((owned.results ?? []).map((row) => row.instance_id));
  const usage = await provider.usage({ from, ...(to ? { to } : {}) });
  const byInstance: Record<string, number> = {};
  for (const instance of usage.instances) if (mine.has(instance.id)) byInstance[instance.id] = instance.usd;
  return json({ from: usage.from, to: usage.to, byInstance, byDay: {} });
}

async function handleTemplate(env: CloudEnv, provider: CloudProvider): Promise<Response> {
  const templateVersion = await readSetting(env, "template_version");
  if (!templateVersion) return json({ exists: false });
  return json({ exists: await provider.hasTemplate(templateVersion) });
}

async function handleList(env: CloudEnv, userId: string, provider: CloudProvider): Promise<Response> {
  const all = await provider.listInstances();
  const rows = await env.DB.prepare("select instance_id, request_id from cloud_computers where user_id = ? and deleted_at is null")
    .bind(userId).all<{ instance_id: string; request_id: string | null }>();
  const owned = new Set<string>();
  const pendingRequestIds = new Map<string, string>();
  for (const row of rows.results ?? []) {
    if (isPendingId(row.instance_id)) {
      if (row.request_id) pendingRequestIds.set(row.request_id, row.instance_id);
    } else {
      owned.add(row.instance_id);
    }
  }
  // A create cancelled or lost in flight: the client finds it by its request tag.
  const now = Date.now();
  for (const instance of all) {
    const pendingId = pendingRequestIds.get(instance.metadata.ade_request_id ?? "");
    if (pendingId) {
      await adoptReservation(env, pendingId, instance, instance.metadata.ade_machine_key ?? null, now, "create_adopted");
      owned.add(instance.id);
    }
  }
  return json({ data: all.filter((instance) => owned.has(instance.id)) });
}

const instanceRoutes: Record<string, (request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number) => Promise<Response>> = {
  "POST sleep": (_request, env, computer, provider, now) => handleSleepLike(env, computer, provider, now, "user"),
  "POST idle": (_request, env, computer, provider, now) => handleSleepLike(env, computer, provider, now, "idle_request"),
  "POST start": handleStart,
  "POST stop": (_request, env, computer, provider, now) => handleStop(env, computer, provider, now),
  "POST update": (_request, env, computer, provider, now) => handleUpdate(env, computer, provider, now),
  "POST resize": handleResize,
  "POST fork": handleFork,
  "POST exec": handleExec,
  "POST backups": async (_request, _env, computer, provider) => json(await provider.createBackup(computer.instance_id)),
  "POST signed-url": async (request, _env, computer, provider) => {
    const body = await readJson(request);
    const port = typeof body?.port === "number" && Number.isInteger(body.port) && body.port > 0 && body.port < 65536 ? body.port : null;
    const ttlSeconds = typeof body?.ttlSeconds === "number" && Number.isFinite(body.ttlSeconds) ? Math.round(body.ttlSeconds) : null;
    if (port == null || ttlSeconds == null || ttlSeconds <= 0 || ttlSeconds > 86_400) return badRequest("That link request isn't valid.");
    return json(await provider.signedUrl(computer.instance_id, { port, ttlSeconds }));
  },
  "POST public-ports": async (request, _env, computer, provider) => {
    const body = await readJson(request);
    if (body?.port !== WAKE_PORT) return badRequest("Only ADE's own wake port can be opened.");
    return json(await provider.addPublicPort(computer.instance_id, { port: WAKE_PORT, label: shortText(body.label, 60) ?? "ADE wake" }));
  },
  "PUT auto-sleep": async (request, _env, computer, provider) => {
    const body = await readJson(request);
    if (typeof body?.autoSleep !== "boolean") return badRequest("That request could not be read.");
    const seconds = typeof body.idleTimeoutSeconds === "number" ? Math.round(body.idleTimeoutSeconds) : undefined;
    if (seconds !== undefined && (seconds < 300 || seconds > 86_400)) return badRequest("That sleep time isn't valid.");
    await provider.setAutoSleep(computer.instance_id, { autoSleep: body.autoSleep, ...(seconds !== undefined ? { idleTimeoutSeconds: seconds } : {}) });
    return json({ ok: true });
  },
  "PUT name": async (request, env, computer, provider) => {
    const body = await readJson(request);
    const name = shortText(body?.name, 60);
    if (!name) return badRequest("That name isn't valid.");
    await provider.setInstanceName(computer.instance_id, name);
    await env.DB.prepare("update cloud_computers set name = ? where instance_id = ?").bind(name, computer.instance_id).run();
    return json({ ok: true });
  },
  "PUT metadata": async (request, env, computer, provider) => {
    const body = await readJson(request);
    const metadata = body ? stringMap(body.metadata, MAX_METADATA_ENTRIES) : null;
    if (!metadata) return badRequest("That request could not be read.");
    await provider.setInstanceMetadata(computer.instance_id, metadata);
    const machineKey = metadata.ade_machine_key ?? null;
    if (machineKey !== computer.machine_key) {
      await env.DB.prepare("update cloud_computers set machine_key = ? where instance_id = ?").bind(machineKey, computer.instance_id).run();
    }
    return json({ ok: true });
  },
};

async function routeInstance(request: Request, env: CloudEnv, provider: CloudProvider, userId: string, instanceId: string, action: string | undefined, now: number): Promise<Response> {
  if (!INSTANCE_ID.test(instanceId)) return notFound();
  const computer = await ownedComputer(env, userId, instanceId);
  if (!computer) return notFound();
  if (action === undefined) {
    if (request.method === "GET") {
      try {
        const instance = await provider.getInstance(instanceId);
        await recordStatus(env, computer, instance.status, now, "seen");
        return json(instance);
      } catch (error) {
        if (error instanceof CloudProviderError && error.status === 404) await markGone(env, computer, now);
        throw error;
      }
    }
    if (request.method === "DELETE") return handleDelete(request, env, computer, provider, now);
    return notFound();
  }
  const handler = instanceRoutes[`${request.method} ${action}`];
  return handler ? handler(request, env, computer, provider, now) : notFound();
}

export async function handleCloudRequest(request: Request, env: CloudEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const caller = await authenticate(request, env);
  if (!caller.ok) {
    return caller.reason === "authentication unavailable"
      ? fail("unavailable", "ADE Cloud can't check your sign-in right now. Try again soon.", 503)
      : fail("unauthorized", "Sign in to ADE to use ADE Cloud.", 401);
  }
  const allowed = cloudAccessAllows(env, caller.userId);
  if (path === CLOUD_PATHS.access) {
    if (request.method !== "GET") return fail("not_found", NOT_FOUND_MESSAGE, 404);
    return json({ enabled: allowed });
  }
  if (!allowed) return notFound();
  if (isCloudWakeRequest(url)) {
    // Scheduled work is refused at 0 hours; a timed wake would break the stop.
    if (request.method === "PUT") {
      const { outOfHours: empty } = await getAccountContext(env, caller.userId, Date.now());
      if (empty) return outOfHours();
    }
    return handleCloudWakeRequest(request, env);
  }

  const provider = providerFor(env);
  const now = Date.now();
  if (path === CLOUD_PATHS.account) {
    return request.method === "GET" ? json(await buildAccountState(env, caller.userId, now)) : notFound();
  }
  if (!provider) {
    logCloud("cloud.no_provider_key");
    return fail("unavailable", cloudErrorMessage("no_provider_key", 503), 503);
  }
  return providerCall(async () => {
    if (path === CLOUD_PATHS.usage && request.method === "GET") return handleUsage(url, env, caller.userId, provider);
    if (path === CLOUD_PATHS.instances) {
      if (request.method === "GET") return handleList(env, caller.userId, provider);
      if (request.method === "POST") return handleCreate(request, env, caller.userId, provider, now);
      return notFound();
    }
    if (path.startsWith(`${CLOUD_PATHS.templates}/`) && request.method === "GET") return handleTemplate(env, provider);
    if (path.startsWith(`${CLOUD_PATHS.instances}/`)) {
      const [instanceId, action, ...rest] = path.slice(CLOUD_PATHS.instances.length + 1).split("/");
      if (rest.length) return notFound();
      return routeInstance(request, env, provider, caller.userId, instanceId, action, now);
    }
    return notFound();
  });
}
