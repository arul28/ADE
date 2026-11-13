import { authenticate } from "../callerToken";
import { handleCloudWakeRequest, isCloudWakeRequest } from "../cloudWake";
import { captureCloudAction, cloudActionTracker, type CloudActionOrigin, type CloudRefusal, type CloudRefusedAction, type CloudWaitUntil } from "./analytics";
import { CloudBillingError, createCheckoutUrl, createPortalUrl, setExtraDisk, setExtraHours } from "./billing";
import { buildAccountState } from "./accountState";
import { routeSavedChats } from "./chats";
import { readComputerSignal, settleFreePlanComputer } from "./freePlan";
import { routeReferrals } from "./referrals";
import { trustedHttpsOrigin } from "../trustedOrigin";
import { handleLaunchJoin, isLaunchJoinRequest, routeLaunches } from "./launches";
import { createAnswerOf, createInProgress, type CreateComputerExtras, type CreateComputerOutcome, type ReplayOutcome } from "./createOutcome";
import { serverGitCheck } from "./accountVault";
import { handleAutomationDelivery, isAutomationDeliveryRequest, noteAutomationLaunchProgress, routeAutomations } from "./automations";
import { routeProjectComputersDelete } from "./projectComputers";
import { routeSignIns } from "./signIns";
import {
  endLaneStatement,
  laneFactsOf,
  laneFactsOfRow,
  laneFactsStatement,
  markKeepLaneStatement,
  mergeLaneFacts,
  namesLane,
  routeLanesWithoutComputer,
  unmarkKeepLaneStatement,
  type CloudLaneFacts,
} from "./lanesWithoutComputer";
import { parseDiskUsageReport, recordDiskUsage, withUseFacts } from "./diskUsage";
import { CLOUD_PATHS, formatCloudCents, type CloudDiskRefusalReason, type CloudInstance, type CloudPlanId } from "./contract";
import { ownerLimitState } from "./costReport";
import { UNREADABLE_REQUEST_MESSAGE, cloudAccessAllows, fail, json, readJson } from "./http";
import {
  DISK_ON_CREATE_GB,
  DISK_STEP_GB,
  CENT_MICROS,
  EXTRA_DISK_CENTS_PER_10GB_MONTH,
  EXTRA_DISK_MICROS_PER_GB_DAY,
  extraDiskMonthMicros,
  WAKE_PORT,
  cloudSizeFor,
  daysLeftIn,
  isMeteredStatus,
  isPaidPlanId,
  tierOf,
  type CloudSize,
} from "./plans";
import { CloudProviderError, cloudErrorMessage, createCloudProvider, type CloudProvider } from "./provider";
import {
  accountDiskGb,
  accountDiskSql,
  cloudOffers,
  countedPlanDiskGb,
  diskDayStatement,
  extraDiskMicrosThisPeriod,
  countedDiskGb,
  freePlanOverDisk,
  overPlanDiskMessage,
  planIdOf,
  logCloud,
  reportCloudFailure,
  PENDING_TIMEOUT_MS,
  adoptionStatements,
  computerLimit,
  deleteComputer,
  goneFromProviderStatements,
  isOutOfHours,
  isPendingId,
  listComputers,
  liveUsedMilli,
  loadAccount,
  newPendingId,
  ownedComputer,
  powerLogStatement,
  readSetting,
  restartStretchStatements,
  settleStatements,
  statusChangeStatements,
  statusGuard,
  type AccountRow,
  type CloudEnv,
  type ComputerRow,
} from "./store";
import {
  CloudUpdateInProgressError,
  automaticTemplate,
  channelOfComputer,
  channelTemplate,
  isBehindAutomatic,
  readUpdateChannel,
  readUpdateTargets,
  recordBootReport,
  startCloudUpdate,
  updateCheckOf,
  withUpdateFacts,
} from "./updates";

/**
 * The ADE Cloud routes (README, "ADE Cloud account"; shapes in `contract.ts`).
 * Each mirrors one `CloudProvider` method: the owner check, the limits and the
 * pinned template are enforced here so a client can't talk around them.
 */

const PREFIX = "/cloud";
const INSTANCE_ID = /^[a-z0-9]{4,40}$/;
const MAX_METADATA_ENTRIES = 32;
const MAX_ENV_ENTRIES = 64;
/**
 * What a client may put in a new computer's env: only the ADE release it
 * installs on boot (`ADE_MIN_VERSION`, infra/ade-cloud/template/ade-entrypoint.sh),
 * as a version. Everything else is dropped: older desktops sent the person's
 * saved ADE Cloud keys and Claude token here (`OPENAI_API_KEY`,
 * `CLAUDE_CODE_OAUTH_TOKEN`, …), and the host keeps a computer's env in plain
 * text for its whole life. A new computer's brain takes every sign-in from the
 * account vault instead (Cloud 4 step 2b).
 */
const CLIENT_ENV = { ADE_MIN_VERSION: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/ } as const satisfies Record<string, RegExp>;
const MAX_STRING = 4096;
const MAX_COMMAND = 100_000;
const MAX_EXEC_TIMEOUT_MS = 15 * 60_000;
/** A push-work wake runs this long, once a day per computer. */
const FREE_WAKE_MS = 15 * 60_000;
const FREE_WAKE_COOLDOWN_MS = 24 * 60 * 60_000;

const NOT_FOUND_MESSAGE = "ADE Cloud has no such computer.";
const notFound = () => fail("not_found", NOT_FOUND_MESSAGE, 404);
const badRequest = (message: string) => fail("bad_request", message, 400);
const outOfHours = () => fail("out_of_hours", "You're out of ADE Cloud hours for this period.", 402);
const badDiskStep = () => badRequest(`Disk grows in steps of ${DISK_STEP_GB} GB.`);
const noProviderKey = () => fail("unavailable", cloudErrorMessage("no_provider_key", 503), 503);
/** Another change took the room while this one ran. */
const diskChanged = () => fail("disk_limit", "Your computers' disk changed while this ran. Try again.", 409);

const CANT_MAKE_COMPUTER_MESSAGE = "ADE Cloud can't make a computer right now. Try again soon.";
/** The owner's cost limit is reached: nothing new, no disk growth. Never names why. */
const cantMakeComputer = () => fail("unavailable", CANT_MAKE_COMPUTER_MESSAGE, 503);
const cantGrowDisk = () => fail("disk_limit", "ADE Cloud can't grow this disk right now. Try again later.", 403, { reason: "unavailable" satisfies CloudDiskRefusalReason });

type Refused = { response: Response; refusal: CloudRefusal };

/** What every handler gets from the request: one clock, and a way to finish work after the response. */
type CloudRequestContext = { now: number; waitUntil: CloudWaitUntil };

function diskRefusal(code: string, message: string, reason: CloudDiskRefusalReason, refusal: CloudRefusal): Refused {
  return { response: fail(code, message, 403, { reason }), refusal };
}

/** The ways out of a refused grow on a paid plan, the same on Plus and Pro. */
const PAID_DISK_WAYS_OUT = "Delete a computer you no longer use, or turn on extra disk in Settings.";

/** A disk past what this size's disk can grow to. `moving` is a computer whose disk is already that big. */
function tierRefusal(size: CloudSize, diskGb: number, moving: boolean): Refused | null {
  if (diskGb <= size.diskMaxGb) return null;
  const message = moving
    ? `This computer's disk is ${diskGb} GB, more than a ${size.label} computer holds (${size.diskMaxGb} GB). Pick a bigger size.`
    : `A ${size.label} computer's disk grows to ${size.diskMaxGb} GB. A bigger size holds more.`;
  return diskRefusal("disk_limit", message, "tier_limit", "tier_limit");
}

/**
 * Whether the account may hold `nextTotalGb` of disk at one time, and the most
 * the one-write reservation may let it reach. Inside the plan's disk: yes (a
 * downgrade waiting for the period end already holds to the next plan's
 * disk, so the switch finds nothing unpaid). Past it: never on the free plan;
 * on a paid plan only with extra disk set up, on, and inside the monthly
 * limit, which must hold for a full month of the new amount, not just the
 * days left in this period.
 */
async function diskRoom(env: CloudEnv, account: AccountRow, nextTotalGb: number, now: number): Promise<{ ok: true; capGb: number } | ({ ok: false } & Refused)> {
  const planGb = countedPlanDiskGb(account);
  if (nextTotalGb <= planGb) return { ok: true, capGb: planGb };
  if (planIdOf(account) === "free") {
    // `past_due` follows the free plan's disk until the card works again: that is its way out.
    const message = account.stripe_status === "past_due" && account.plan === "paid"
      ? "Your last payment didn't go through. Update your card in Manage, then try again."
      : `Free computers share ${planGb} GB of disk at one time, and this would go past it. Delete a computer you no longer use, or move to a bigger plan.`;
    return { ok: false, ...diskRefusal("needs_paid_plan", message, "plan_disk", "plan_disk") };
  }
  const overPlan = `Your computers share ${planGb} GB of disk at one time, and this would go past it.`;
  if (!cloudOffers(env).extraDisk) {
    return { ok: false, ...diskRefusal("disk_limit", `${overPlan} Delete a computer you no longer use.`, "extra_off", "extra_off") };
  }
  const extraGb = nextTotalGb - planGb;
  const limitCents = account.extra_disk_limit_cents;
  const needsApproval = (): Refused => diskRefusal(
    "disk_limit",
    `This needs ${extraGb} GB more disk than your plan's ${planGb} GB at one time. Extra disk is ${formatCloudCents(EXTRA_DISK_CENTS_PER_10GB_MONTH)} for each 10 GB a month, counted by the day. Turn it on in Settings, or delete a computer you no longer use.`,
    "needs_approval",
    "needs_approval",
  );
  if (account.extra_disk_state !== "on") {
    // `off`: never decided, so it asks once; `asked`: turned down.
    return { ok: false, ...(account.extra_disk_state === "off" ? needsApproval() : diskRefusal("disk_limit", `${overPlan} ${PAID_DISK_WAYS_OUT}`, "extra_off", "extra_off")) };
  }
  if (limitCents == null) return { ok: false, ...needsApproval() };
  const thisPeriod = await extraDiskMicrosThisPeriod(env, account) + extraGb * EXTRA_DISK_MICROS_PER_GB_DAY * daysLeftIn(account.period_end, now);
  if (Math.max(thisPeriod, extraDiskMonthMicros(extraGb)) > limitCents * CENT_MICROS) {
    return {
      ok: false,
      ...diskRefusal("disk_limit", `This would pass the ${formatCloudCents(limitCents)} a month you set for extra disk. Raise the limit in Settings, or delete a computer you no longer use.`, "monthly_limit", "monthly_limit"),
    };
  }
  return { ok: true, capGb: nextTotalGb };
}

/** On the free plan with more disk than it has, a wake is refused (`freePlanOverDisk`). */
function overPlanDisk(account: AccountRow, computers: ComputerRow[]): Refused | null {
  const diskGb = countedDiskGb(computers);
  return freePlanOverDisk(account, diskGb) ? { response: fail("over_plan_disk", overPlanDiskMessage(diskGb), 402), refusal: "over_plan_disk" } : null;
}

/** The plan to label an event with, for a route that didn't load the account. */
async function planIdFor(env: CloudEnv, userId: string): Promise<CloudPlanId> {
  const row = await env.DB.prepare("select plan, paid_plan, stripe_status from cloud_accounts where user_id = ?")
    .bind(userId).first<Pick<AccountRow, "plan" | "paid_plan" | "stripe_status">>();
  return row ? planIdOf(row) : "free";
}

/** An agent's create or copy carries the chat that asked; a person's doesn't. */
const originOf = (metadata: Record<string, string>): CloudActionOrigin => (metadata.ade_made_by_chat ? "agent" : "person");

export function isCloudRequest(url: URL): boolean {
  return url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`);
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
      // The provider refusing ADE's own key is ours to fix, not the person's sign-in.
      const providerAuth = error.status === 401 || error.status === 403;
      if (providerAuth || error.status >= 500 || error.status === 0) reportCloudFailure("cloud.provider_call_failed", { code: error.code, status: error.status });
      const status = !providerAuth && error.status >= 400 && error.status < 600 ? error.status : 502;
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

/** Why the account's computers may not wake now (0 hours, or disk the free plan doesn't cover), or null. */
async function wakeBlocker(env: CloudEnv, userId: string, now: number): Promise<{ blocked: Refused | null; account: AccountRow }> {
  const { account, computers, outOfHours: empty } = await getAccountContext(env, userId, now);
  return { account, blocked: empty ? { response: outOfHours(), refusal: "out_of_hours" } : overPlanDisk(account, computers) };
}

/** Writes the status from a provider answer, on change only. */
async function recordStatus(env: CloudEnv, computer: ComputerRow, status: string, now: number, reason: string): Promise<void> {
  const statements = statusChangeStatements(env, computer, status, now, reason);
  if (statements.length) await env.DB.batch(statements);
}

async function markGone(env: CloudEnv, computer: ComputerRow, now: number): Promise<void> {
  await env.DB.batch(goneFromProviderStatements(env, computer, now));
}

/**
 * A reservation that makes the computer and disk limits hold under concurrent
 * creates. `capGb` is the most disk the account may hold at one time (from
 * `diskRoom`). A move leaves its source out of the sum and records it in
 * `moving_from`: the move deletes it, and one still there after
 * `MOVE_GRACE_MS` counts again (the tick's `endMoves`).
 */
async function reserveComputer(env: CloudEnv, account: AccountRow, args: {
  size: CloudSize;
  diskGb: number;
  capGb: number;
  moveFromInstanceId: string | null;
  name: string | null;
  requestId: string;
  templateVersion: string | null;
  channel: "stable" | "beta";
  /** The lane the computer is for, kept on its row from the start. */
  lane: CloudLaneFacts;
  now: number;
}): Promise<{ ok: true; pendingId: string } | ({ ok: false } & Refused) | { ok: false; response: Response; refusal: null } | { ok: false; replay: true }> {
  const limit = computerLimit(account);
  const pendingId = newPendingId();
  const cutoff = args.now - PENDING_TIMEOUT_MS;
  const result = await env.DB.prepare(`
    insert into cloud_computers (instance_id, user_id, request_id, type, cpu, memory_gb, disk_gb, multiplier_milli, template_version, name, status, status_changed_at, last_awake_at, created_at, moving_from, channel,
      lane_id, lane_name, lane_project_origin, lane_branch)
    select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?
    where (select count(*) from cloud_computers where user_id = ? and deleted_at is null and (status != 'provisioning' or created_at > ?)) < ?
      and ${accountDiskSql("?", { except: true })} + ? <= ?
      and not exists (select 1 from cloud_computers where request_id = ? and user_id <> ?)
      and not exists (select 1 from cloud_computers where request_id = ? and user_id = ? and deleted_at is null)
      and not exists (select 1 from cloud_computers where deleted_at is null and moving_from is not null and (moving_from = ? or instance_id = ?))
  `).bind(
    pendingId, account.user_id, args.requestId, args.size.type, args.size.cpu, args.size.memoryGb, args.diskGb, args.size.multiplierMilli,
    args.templateVersion, args.name, args.now, args.now, args.now, args.moveFromInstanceId, args.channel,
    args.lane.laneId, args.lane.laneName, args.lane.projectOrigin, args.lane.branch,
    account.user_id, cutoff, limit,
    account.user_id, args.moveFromInstanceId ?? "", args.diskGb, args.capGb,
    args.requestId, account.user_id,
    args.requestId, account.user_id,
    args.moveFromInstanceId, args.moveFromInstanceId,
  ).run();
  if (result.meta.changes === 1) return { ok: true, pendingId };
  // A twin request with this id got its row in first (D1 runs one write at a
  // time, so only one insert can pass the check): answer as a repeat.
  const ownTwin = await env.DB.prepare("select 1 as taken from cloud_computers where request_id = ? and user_id = ? and deleted_at is null limit 1")
    .bind(args.requestId, account.user_id).first<{ taken: number }>();
  if (ownTwin) return { ok: false, replay: true };
  // The tag finds a lost create in the shared provider list, so it can only ever be one account's.
  const tagTaken = await env.DB.prepare("select 1 as taken from cloud_computers where request_id = ? and user_id <> ? limit 1")
    .bind(args.requestId, account.user_id).first<{ taken: number }>();
  if (tagTaken) return { ok: false, response: badRequest("That request can't be used."), refusal: null };
  const computers = await listComputers(env, account.user_id);
  if (computers.length >= limit) {
    const message = planIdOf(account) === "free"
      ? `The free plan allows ${limit} computers at one time. Delete one to make another, or move to a bigger plan.`
      : `Your plan allows ${limit} computers at one time. Delete one to make another.`;
    return { ok: false, response: fail("computer_limit", message, 403), refusal: "computer_limit" };
  }
  // Another create took the room after `diskRoom` said yes: say what is true now.
  const room = await diskRoom(env, account, await accountDiskGb(env, account.user_id, args.moveFromInstanceId ?? "") + args.diskGb, args.now);
  return room.ok ? { ok: false, response: diskChanged(), refusal: null } : room;
}

async function releasePending(env: CloudEnv, pendingId: string): Promise<void> {
  await env.DB.prepare("delete from cloud_computers where instance_id = ?").bind(pendingId).run();
}

/**
 * A create or copy that names a request id this account already used gets the
 * computer that request made, so a retried request (a lost answer, a client
 * that restarted mid-create) never makes a second one or holds a second slot.
 * Null when there is none to give, and a fresh create may go ahead:
 * - no live row: never used, or its computer was deleted or never made;
 * - its computer is gone from the provider (the row is closed here);
 * - its reservation is older than `PENDING_TIMEOUT_MS` and the provider has
 *   no computer with its tag (the row is released; the tick would drop it).
 * A reservation still inside that time with no computer yet is a create in
 * flight: 409 `create_in_progress`, and the client asks again in a moment.
 */
async function replayRequest(env: CloudEnv, provider: CloudProvider, userId: string, requestId: string, now: number): Promise<ReplayOutcome | null> {
  const row = await env.DB.prepare("select * from cloud_computers where user_id = ? and request_id = ? and deleted_at is null order by created_at desc limit 1")
    .bind(userId, requestId).first<ComputerRow>();
  if (!row) return null;
  if (!isPendingId(row.instance_id)) {
    try {
      const instance = await provider.getInstance(row.instance_id);
      // The first create may have died before its batch ended the lane's row: the lane has this computer.
      const ended = endLaneStatement(env, userId, row.lane_id ?? laneFactsOf(instance.metadata).laneId);
      const statements = [...statusChangeStatements(env, row, instance.status, now, "seen"), ...(ended ? [ended] : [])];
      if (statements.length) await env.DB.batch(statements);
      logCloud("cloud.create_replayed", { userId, instanceId: row.instance_id });
      return { kind: "replayed", instance };
    } catch (error) {
      if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
      await markGone(env, row, now);
      return null;
    }
  }
  // The first answer was lost, or the provider is still making it: its tag finds it.
  const instance = (await provider.listInstances())
    .find((entry) => entry.metadata.ade_request_id === requestId && entry.status !== "deleted");
  if (instance) {
    const [adopted] = await env.DB.batch(adoptionStatements(env, { pendingId: row.instance_id, instance, machineKey: instance.metadata.ade_machine_key ?? null, now, reason: "create_replayed" }));
    if (adopted?.meta.changes === 1) {
      logCloud("cloud.create_replayed", { userId, instanceId: instance.id, adopted: true });
      return { kind: "replayed", instance };
    }
  }
  if (now - row.created_at > PENDING_TIMEOUT_MS) {
    await releasePending(env, row.instance_id);
    return null;
  }
  return { kind: "in_progress" };
}

/** Only a provider's clear no means nothing was made. Timeouts and 5xx can leave a running computer, so its reservation stays for adoption. */
const providerMadeNothing = (error: unknown): boolean =>
  error instanceof CloudProviderError && error.status >= 400 && error.status < 500;

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

async function handleCreate(request: Request, env: CloudEnv, userId: string, provider: CloudProvider, ctx: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  return createAnswerOf(await createComputer(env, userId, provider, { body }, ctx));
}

/**
 * The one way a computer is made (`POST /cloud/instances` and the server
 * launcher): the same replay, limits, reservation, billing and metadata.
 * `createAnswerOf` turns the outcome into the route's answer.
 */
export async function createComputer(env: CloudEnv, userId: string, provider: CloudProvider, extras: CreateComputerExtras, { now, waitUntil }: CloudRequestContext): Promise<CreateComputerOutcome> {
  const refused = (response: Response): CreateComputerOutcome => ({ kind: "refused", response });
  const { body } = extras;
  const resources = body.resources && typeof body.resources === "object" ? body.resources as Record<string, unknown> : null;
  const size = cloudSizeFor(body.type, resources?.cpu, resources?.memory);
  if (!size) return refused(badRequest("That size isn't one ADE Cloud offers."));
  const name = shortText(body.name, 60) ?? "ADE computer";
  const clientMetadata = stringMap(body.metadata, MAX_METADATA_ENTRIES);
  const requestedEnv = stringMap(body.env, MAX_ENV_ENTRIES);
  const publicPorts = onlyWakePorts(body.publicPorts);
  if (!clientMetadata || !requestedEnv || !publicPorts) return refused(badRequest(UNREADABLE_REQUEST_MESSAGE));
  // The client's env is cut to `CLIENT_ENV`: no sign-in an older desktop
  // sends reaches the host, and a client can't name a launch or its join code
  // (the server's own entries). Only the dropped names are logged, never a value.
  const keptEnv: Record<string, string> = {};
  const droppedEnv: string[] = [];
  for (const [envName, value] of Object.entries(requestedEnv)) {
    const shape = Object.hasOwn(CLIENT_ENV, envName) ? CLIENT_ENV[envName as keyof typeof CLIENT_ENV] : null;
    if (shape?.test(value)) keptEnv[envName] = value;
    else droppedEnv.push(envName.slice(0, 64));
  }
  if (droppedEnv.length) logCloud("cloud.create_env_dropped", { userId, names: droppedEnv.sort() });
  const clientEnv = { ...keptEnv, ...extras.serverEnv };
  // The app's own update track: the computer starts from that channel's image and follows it.
  const channel = body.channel === undefined ? "stable" : readUpdateChannel(body.channel);
  if (!channel) return refused(badRequest("That update channel isn't one ADE knows."));

  // A repeat of a request this account made gets that computer, before any
  // limit: it is not a new computer, so hours or the computer limit can't refuse it.
  const repeatedId = clientMetadata.ade_request_id;
  if (repeatedId) {
    const replay = await replayRequest(env, provider, userId, repeatedId, now);
    if (replay) return replay;
  }

  const targets = await readUpdateTargets(env);
  const templateVersion = channelTemplate(targets, channel);
  if (!templateVersion) {
    reportCloudFailure("cloud.create_refused_no_template_version", { userId, channel });
    return refused(fail("template_unset", CANT_MAKE_COMPUTER_MESSAGE, 503));
  }
  const { account, outOfHours: empty } = await getAccountContext(env, userId, now);
  const isMove = body.moveFromInstanceId !== undefined;
  const action = isMove ? "move" : "create";
  const { metadata, requestId } = withRequestId(clientMetadata);
  const { track, refuse } = cloudActionTracker({ env, waitUntil, userId, plan: planIdOf(account), origin: originOf(clientMetadata), key: requestId, refusedAction: action, now });
  if (empty) return refused(refuse({ response: outOfHours(), refusal: "out_of_hours" }));
  if ((await ownerLimitState(env)).reached) return refused(refuse({ response: cantMakeComputer(), refusal: "owner_limit" }));

  // A move carries the old computer's disk; a plain create always starts at the smallest.
  let diskGb = DISK_ON_CREATE_GB;
  let moveFromInstanceId: string | null = null;
  let lane = laneFactsOf(metadata);
  if (isMove) {
    const source = typeof body.moveFromInstanceId === "string" ? await ownedComputer(env, userId, body.moveFromInstanceId) : null;
    if (!source) return refused(notFound());
    // One move at a time per computer: a chain (A to B, then B to C) would leave both A and B out of the disk.
    if (source.moving_from != null || await env.DB.prepare("select 1 as busy from cloud_computers where moving_from = ? and deleted_at is null limit 1").bind(source.instance_id).first()) {
      return refused(fail("computer_busy", "This computer is in the middle of a move. Try again when the move is done.", 409));
    }
    diskGb = source.disk_gb;
    moveFromInstanceId = source.instance_id;
    // The lane moves with its computer, even when the client's metadata left it out.
    lane = mergeLaneFacts(lane, laneFactsOfRow(source));
    const tooBig = tierRefusal(size, diskGb, true);
    if (tooBig) return refused(refuse(tooBig));
  }
  // The move's source is deleted at the end of the move, so its disk isn't counted twice while it runs.
  const room = await diskRoom(env, account, await accountDiskGb(env, userId, moveFromInstanceId ?? "") + diskGb, now);
  if (!room.ok) return refused(refuse(room));

  const reservation = await reserveComputer(env, account, { size, diskGb, capGb: room.capGb, moveFromInstanceId, name, requestId, templateVersion, channel, lane, now });
  if (!reservation.ok) {
    if ("replay" in reservation) return await replayRequest(env, provider, userId, requestId, now) ?? { kind: "in_progress" };
    return refused(reservation.refusal ? refuse({ response: reservation.response, refusal: reservation.refusal }) : reservation.response);
  }

  try {
    const instance = await provider.createInstance({
      template: templateVersion,
      name,
      type: size.type,
      resources: { cpu: size.cpu, memory: size.memoryGb, disk: diskGb },
      ...(Object.keys(clientEnv).length ? { env: clientEnv } : {}),
      metadata,
      ...(publicPorts.length ? { publicPorts } : {}),
    });
    // Billed disk only once the provider made it (a move's source stays out while the move runs).
    // The adoption also ends the lane's row in "Lanes without a computer", in this one batch.
    await env.DB.batch([
      ...adoptionStatements(env, { pendingId: reservation.pendingId, instance, machineKey: metadata.ade_machine_key ?? null, now: Date.now(), reason: "create" }),
      diskDayStatement(env, account, now),
      ...(extras.onMade?.(instance) ?? []),
    ]);
    track({ action, tier: tierOf(size) });
    return { kind: "made", instance, answer: withUpdateFacts(instance, { channel, template_version: templateVersion, update_state: null, updated_at: null, update_error: null }, targets) };
  } catch (error) {
    if (providerMadeNothing(error)) await releasePending(env, reservation.pendingId);
    if (error instanceof CloudProviderError && (error.code === "not_found" || error.code === "invalid_request")) {
      reportCloudFailure("cloud.create_refused_template", { userId, templateVersion, code: error.code });
      return refused(fail("template_unavailable", CANT_MAKE_COMPUTER_MESSAGE, 503));
    }
    throw error;
  }
}

async function handleFork(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, { now, waitUntil }: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const { account, outOfHours: empty } = await getAccountContext(env, computer.user_id, now);
  const metadataIn = stringMap(body.metadata, MAX_METADATA_ENTRIES);
  if (!metadataIn) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  // A repeat of a copy this account asked for gets that computer, before any
  // limit, as a repeated create does.
  if (metadataIn.ade_request_id) {
    const replay = await replayRequest(env, provider, computer.user_id, metadataIn.ade_request_id, now);
    if (replay) return createAnswerOf(replay);
  }
  const { track, refuse } = cloudActionTracker({
    env, waitUntil, userId: computer.user_id, plan: planIdOf(account), origin: originOf(metadataIn), key: computer.instance_id, refusedAction: "copy", now,
  });
  if (empty) return refuse({ response: outOfHours(), refusal: "out_of_hours" });
  if ((await ownerLimitState(env)).reached) return refuse({ response: cantMakeComputer(), refusal: "owner_limit" });

  const resources = body.resources && typeof body.resources === "object" ? body.resources as Record<string, unknown> : null;
  const size = resources
    ? cloudSizeFor(computer.type, resources.cpu, resources.memory)
    : cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
  if (!size) return badRequest("That size isn't one ADE Cloud offers.");
  const requestedDisk = typeof resources?.disk === "number" ? resources.disk : computer.disk_gb;
  if (!Number.isInteger(requestedDisk)) return badRequest("That disk size isn't valid.");
  if (requestedDisk < computer.disk_gb) return badRequest("A copy's disk can't be smaller than the original's.");
  if (requestedDisk !== computer.disk_gb && requestedDisk % DISK_STEP_GB !== 0) return badDiskStep();
  const tooBig = tierRefusal(size, requestedDisk, requestedDisk === computer.disk_gb);
  if (tooBig) return refuse(tooBig);
  const room = await diskRoom(env, account, await accountDiskGb(env, computer.user_id) + requestedDisk, now);
  if (!room.ok) return refuse(room);

  const { metadata, requestId } = withRequestId(metadataIn);
  const name = shortText(body.name, 60);
  const reservation = await reserveComputer(env, account, {
    size,
    diskGb: requestedDisk,
    capGb: room.capGb,
    moveFromInstanceId: null,
    name: name ?? computer.name,
    requestId,
    templateVersion: computer.template_version,
    // A copy follows its original's channel.
    channel: channelOfComputer(computer),
    lane: laneFactsOf(metadata),
    now,
  });
  if (!reservation.ok) {
    if ("replay" in reservation) return createAnswerOf(await replayRequest(env, provider, computer.user_id, requestId, now) ?? { kind: "in_progress" });
    return reservation.refusal ? refuse({ response: reservation.response, refusal: reservation.refusal }) : reservation.response;
  }
  try {
    const instance = await provider.forkInstance(computer.instance_id, {
      ...(name ? { name } : {}),
      resources: { cpu: size.cpu, memory: size.memoryGb, disk: requestedDisk },
      metadata,
    });
    await env.DB.batch([
      ...adoptionStatements(env, { pendingId: reservation.pendingId, instance, machineKey: metadata.ade_machine_key ?? null, now: Date.now(), reason: "copy" }),
      diskDayStatement(env, account, now),
    ]);
    track({ action: "copy", tier: tierOf(size) });
    return json(instance, 201);
  } catch (error) {
    if (providerMadeNothing(error)) await releasePending(env, reservation.pendingId);
    throw error;
  }
}

/**
 * A resize on an awake computer. The provider refuses a resize (like a
 * restart or a restore) of a sleeping one with `invalid_request`, so a
 * sleeping computer is woken first, under the same rules as any wake (the
 * free plan's disk), and the wake is recorded so its time is metered. The row
 * can be a minute behind the provider: a refusal on a computer the row calls
 * awake reads the provider once, and wakes and asks again if it sleeps.
 *
 * Here and not on each client: every resize (a person's size change, `ade
 * cloud resize`, the dashboard, a computer's own disk grow) comes through this
 * route, and only the server knows the wake rules and the meter.
 */
async function resizeAwake(
  env: CloudEnv,
  computer: ComputerRow,
  provider: CloudProvider,
  resize: { cpu: number; memory: number; disk?: number },
  now: number,
): Promise<{ status: string } | { blocked: Refused }> {
  const wake = async (): Promise<Refused | null> => {
    const { blocked } = await wakeBlocker(env, computer.user_id, now);
    if (blocked) return blocked;
    const status = await provider.startInstance(computer.instance_id);
    await recordStatus(env, computer, status, now, "resize");
    return null;
  };
  let woken = false;
  if (computer.status === "sleeping") {
    const blocked = await wake();
    if (blocked) return { blocked };
    woken = true;
  }
  try {
    return { status: await provider.resizeInstance(computer.instance_id, resize) };
  } catch (error) {
    if (woken || !(error instanceof CloudProviderError && error.code === "invalid_request")) throw error;
    const live = await provider.getInstance(computer.instance_id).catch(() => null);
    if (live?.status !== "sleeping") throw error;
    // The row said awake; the provider says asleep. Take its word for the meter too.
    // The provider gives no time it fell asleep, so the stretch up to now is
    // metered: at most the row's lag (about a minute), accepted.
    if (computer.status !== "sleeping") await recordStatus(env, computer, "sleeping", now, "resize");
    const blocked = await wake();
    if (blocked) return { blocked };
    return { status: await provider.resizeInstance(computer.instance_id, resize) };
  }
}

async function handleResize(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, { now, waitUntil }: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const { account, outOfHours: empty } = await getAccountContext(env, computer.user_id, now);
  // The computer's own disk grower says so; anything else is a person or their agent.
  const origin: CloudActionOrigin = body.origin === "auto" ? "system" : "person";
  const refusedAction: CloudRefusedAction = body.disk !== undefined ? "grow" : "tier_change";
  const { track, refuse } = cloudActionTracker({ env, waitUntil, userId: computer.user_id, plan: planIdOf(account), origin, key: computer.instance_id, refusedAction, now });
  if (empty) return refuse({ response: outOfHours(), refusal: "out_of_hours" });

  const size = cloudSizeFor(computer.type, body.cpu ?? computer.cpu, body.memory ?? computer.memory_gb);
  if (!size) return badRequest("That size isn't one ADE Cloud offers.");

  if (body.disk !== undefined && (typeof body.disk !== "number" || !Number.isInteger(body.disk))) return badRequest("That disk size isn't valid.");
  // The provider's size, not the row's: a grow whose answer was lost leaves the row ahead, and a retry must still ask for it.
  const currentDisk = body.disk === undefined ? computer.disk_gb : (await provider.getInstance(computer.instance_id)).resources?.disk ?? computer.disk_gb;
  let nextDisk = currentDisk;
  if (typeof body.disk === "number") {
    if (body.disk < currentDisk) return badRequest("A computer's disk can only grow.");
    nextDisk = body.disk;
  }
  const shapeChanges = size.cpu !== computer.cpu || size.memoryGb !== computer.memory_gb;
  if (nextDisk !== currentDisk) {
    if (nextDisk % DISK_STEP_GB !== 0) return badDiskStep();
    const tooBig = tierRefusal(size, nextDisk, false);
    if (tooBig) return refuse(tooBig);
    // A disk grow restarts the computer, so only the computer can say it's safe.
    if (isMeteredStatus(computer.status) && body.computerIdle !== true) {
      return fail("computer_busy", "A disk can only grow while the computer is idle.", 409);
    }
    // Reserved in one write, so two grows at once can't pass the shared limit together.
    // Already this size on the row: a retry, and its room is already held.
    if (nextDisk !== computer.disk_gb) {
      if ((await ownerLimitState(env)).reached) return refuse({ response: cantGrowDisk(), refusal: "owner_limit" });
      // The other computers plus this one at its new size (a move's source too, while its move runs).
      const room = await diskRoom(env, account, await accountDiskGb(env, computer.user_id, computer.instance_id) + nextDisk, now);
      if (!room.ok) return refuse(room);
      const reserved = await env.DB.prepare(`
        update cloud_computers set disk_gb = ?, disk_reserved_at = ?, disk_confirmed_gb = coalesce(disk_confirmed_gb, disk_gb)
        where instance_id = ? and disk_gb = ?
          and ${accountDiskSql("?", { except: true })} + ? <= ?
      `).bind(nextDisk, now, computer.instance_id, computer.disk_gb, computer.user_id, computer.instance_id, nextDisk, room.capGb).run();
      if (reserved.meta.changes !== 1) {
        const again = await diskRoom(env, account, await accountDiskGb(env, computer.user_id, computer.instance_id) + nextDisk, now);
        return again.ok ? diskChanged() : refuse(again);
      }
    } else if (nextDisk !== currentDisk) {
      // A retry: its room is held, so only the clock needs renewing.
      await env.DB.prepare("update cloud_computers set disk_reserved_at = ? where instance_id = ?").bind(now, computer.instance_id).run();
    }
  } else if (shapeChanges) {
    // A disk never shrinks, so a smaller size must still hold it.
    const tooBig = tierRefusal(size, currentDisk, true);
    if (tooBig) return refuse(tooBig);
  }

  const resize: { cpu: number; memory: number; disk?: number } = { cpu: size.cpu, memory: size.memoryGb };
  if (nextDisk !== currentDisk) resize.disk = nextDisk;
  /** Gives back the disk this resize reserved, unless something else has changed it since. */
  const releaseDiskReservation = async (): Promise<void> => {
    await env.DB.prepare("update cloud_computers set disk_gb = ?, disk_reserved_at = null, disk_confirmed_gb = null where instance_id = ? and disk_gb = ?")
      .bind(currentDisk, computer.instance_id, nextDisk).run();
  };
  let status: string;
  try {
    const awake = await resizeAwake(env, computer, provider, resize, now);
    if ("blocked" in awake) {
      if (nextDisk !== currentDisk) await releaseDiskReservation();
      return refuse(awake.blocked);
    }
    status = awake.status;
  } catch (error) {
    if (nextDisk !== currentDisk && providerMadeNothing(error)) {
      await releaseDiskReservation();
    }
    throw error;
  }
  const statements: D1PreparedStatement[] = [];
  // The time so far is charged at the old size; the new size starts its own stretch here.
  if (size.multiplierMilli !== computer.multiplier_milli && computer.awake_since != null && computer.awake_since <= now) {
    statements.push(...restartStretchStatements(env, computer, now));
  }
  computer.multiplier_milli = size.multiplierMilli;
  statements.push(
    // A confirmed grow is no longer a reservation, so it counts as billed disk from here.
    env.DB.prepare(`update cloud_computers set cpu = ?, memory_gb = ?, disk_gb = ?, multiplier_milli = ?${nextDisk !== currentDisk ? ", disk_reserved_at = null, disk_confirmed_gb = null" : ""} where instance_id = ?`)
      .bind(size.cpu, size.memoryGb, nextDisk, size.multiplierMilli, computer.instance_id),
    ...statusChangeStatements(env, computer, status, now, "resize"),
  );
  // The bigger disk is billed only now that the provider made it; a refused grow gave its room back above.
  if (nextDisk !== currentDisk) statements.push(diskDayStatement(env, account, now));
  await env.DB.batch(statements);
  if (shapeChanges) track({ action: "tier_change", tier: tierOf(size) });
  if (nextDisk !== currentDisk) track({ action: "grow", tier: tierOf(size) });
  return json({ status });
}

async function handleSleepLike(env: CloudEnv, computer: ComputerRow, provider: CloudProvider, now: number, reason: string): Promise<Response> {
  const { blocked } = await wakeBlocker(env, computer.user_id, now);
  try {
    // While wakes are refused a sleeping computer would still wake on any request, so it stops instead.
    const status = blocked ? await provider.stopInstance(computer.instance_id) : await provider.sleepInstance(computer.instance_id);
    await recordStatus(env, computer, status, now, reason);
    return json({ status });
  } catch (error) {
    if (error instanceof CloudProviderError && error.status === 400) return json({ status: computer.status });
    throw error;
  }
}

async function handleStart(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, { now, waitUntil }: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const { account, blocked } = await wakeBlocker(env, computer.user_id, now);
  let freeWake = false;
  if (blocked) {
    // Only the short push-work wake gets through, once a day per computer.
    const { refuse } = cloudActionTracker({ env, waitUntil, userId: computer.user_id, plan: planIdOf(account), origin: "person", key: computer.instance_id, refusedAction: "wake", now });
    if (body.reason !== "push_work") return refuse(blocked);
    if (computer.free_wake_used_at != null && now - computer.free_wake_used_at < FREE_WAKE_COOLDOWN_MS) return refuse(blocked);
    freeWake = true;
  }
  const status = await provider.startInstance(computer.instance_id);
  if (freeWake) {
    // A stretch already open is charged up to here, then it starts over after the free window.
    const closing = computer.awake_since != null && computer.awake_since <= now
      ? settleStatements(env, computer, now, statusGuard(computer))
      : [];
    // Metering starts when the free window ends; the stretch before it costs nothing.
    computer.awake_since = now + FREE_WAKE_MS;
    computer.free_wake_started_at = now;
    computer.free_wake_until = now + FREE_WAKE_MS;
    computer.free_wake_used_at = now;
    // Over the plan's disk, this wake doesn't count as use: the 30-day delete clock keeps
    // running (`last_awake_at` stays older than `free_wake_started_at`, which the close keeps).
    const lastAwakeAt = blocked?.refusal === "over_plan_disk" ? computer.last_awake_at : now;
    await env.DB.batch([
      ...closing,
      // `cold_storage` clears too: it's awake now, so the stop at the end of the window has to apply.
      env.DB.prepare("update cloud_computers set status = ?, status_changed_at = ?, awake_since = ?, last_awake_at = ?, free_wake_started_at = ?, free_wake_until = ?, free_wake_used_at = ?, zero_stop_started_at = null, cold_storage = 0 where instance_id = ?")
        .bind(status, now, computer.awake_since, lastAwakeAt, now, computer.free_wake_until, now, computer.instance_id),
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

/**
 * Moves the computer to its channel's image (`updates.ts`). A person's update
 * (no reason, or `manual`) always runs; the computer's own (`idle`) runs only
 * while it is running and says it is idle, and only when it is behind the
 * image a passed check allowed.
 */
async function handleUpdate(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, { now }: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const reason = body.reason === undefined || body.reason === "manual" ? "manual" : body.reason === "idle" ? "idle" : null;
  if (!reason) return badRequest("That update reason isn't one ADE Cloud knows.");
  const targets = await readUpdateTargets(env);
  const channel = channelOfComputer(computer);
  if (reason === "idle") {
    // It restarts the computer, so only the computer can say it's safe.
    if (body.computerIdle !== true || computer.status !== "running") {
      return fail("computer_busy", "A computer updates itself only while it's idle.", 409);
    }
    if (!isBehindAutomatic(computer, targets, now)) return json({ status: computer.status, templateVersion: computer.template_version, started: false });
  }
  const templateVersion = reason === "idle" ? automaticTemplate(targets, channel) : channelTemplate(targets, channel);
  if (!templateVersion) {
    reportCloudFailure("cloud.update_refused_no_template_version", { userId: computer.user_id, instanceId: computer.instance_id, channel });
    return fail("template_unset", CANT_MAKE_COMPUTER_MESSAGE, 503);
  }
  if (computer.update_state === "updating") return fail("update_in_progress", new CloudUpdateInProgressError().message, 409);
  const { blocked } = await wakeBlocker(env, computer.user_id, now);
  if (blocked) return blocked.response;
  try {
    // Saved with the update: whether this image sends a boot report decides its rollback, whatever the channel says later.
    const expectsReport = automaticTemplate(targets, channel) === templateVersion;
    const started = await startCloudUpdate(env, provider, computer, { reason, target: templateVersion, expectsReport, now });
    return json({ ...started, started: true });
  } catch (error) {
    if (error instanceof CloudUpdateInProgressError) return fail("update_in_progress", error.message, 409);
    throw error;
  }
}

const LANE_READ_FAILED_MESSAGE = "ADE Cloud couldn't read which lane this computer holds, so it didn't delete it. Try again in a moment.";
const NO_LANE_MESSAGE = "ADE Cloud doesn't know a lane on this computer, so there is no lane to keep. Nothing was deleted.";

/**
 * Before a delete that keeps the lane: the lane's facts, the row's first and a
 * live read of the instance's metadata second, saved on the row with the mark
 * that makes its close write the lane's row (in the close's own batch). The
 * live read runs only when the row lacks something; its failure refuses the
 * delete only when the row can't name the lane. A response when the delete
 * must not run.
 */
async function markKeepLane(env: CloudEnv, provider: CloudProvider, computer: ComputerRow, branchRef: string | null): Promise<Response | null> {
  const row = laneFactsOfRow(computer);
  let live: CloudLaneFacts = laneFactsOf(null);
  if (!namesLane(row) || (!branchRef && !row.branch)) {
    try {
      live = laneFactsOf((await provider.getInstance(computer.instance_id)).metadata);
    } catch (error) {
      const gone = error instanceof CloudProviderError && error.status === 404;
      if (!gone) {
        reportCloudFailure("cloud.keep_lane_read_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
        if (!namesLane(row)) return fail("lane_read_failed", LANE_READ_FAILED_MESSAGE, 502);
      }
    }
  }
  const facts = mergeLaneFacts(row, live);
  // The desktop read the branch from the lane just now: it wins over both.
  if (branchRef) facts.branch = branchRef;
  if (!namesLane(facts)) return fail("no_lane", NO_LANE_MESSAGE, 409);
  await markKeepLaneStatement(env, computer, facts, "freed").run();
  return null;
}

async function handleDelete(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, { now, waitUntil }: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const who = shortText(body.who, 200);
  // "Keep the lane on a fresh computer": the lane outlives its computer.
  const keepLane = body.keepLane && typeof body.keepLane === "object" && !Array.isArray(body.keepLane)
    ? body.keepLane as Record<string, unknown>
    : null;
  if (keepLane) {
    const refused = await markKeepLane(env, provider, computer, shortText(keepLane.branchRef, 300));
    if (refused) return refused;
  } else if (computer.lane_keep_reason) {
    // A plain delete keeps no lane, even after an earlier freeing that didn't finish.
    await unmarkKeepLaneStatement(env, computer.instance_id).run();
  }
  try {
    await deleteComputer(env, provider, computer, { who, reason: shortText(body.reason, 200) ?? (keepLane ? "freed" : "user") }, now);
  } catch (error) {
    // Nothing was deleted: the mark goes, so a later close can't keep a lane nobody freed.
    if (keepLane) await unmarkKeepLaneStatement(env, computer.instance_id).run();
    throw error;
  }
  const size = cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
  // An agent's delete names its chat; a person's desktop leaves `who` unset.
  captureCloudAction(env, waitUntil, computer.user_id, { action: "delete", plan: await planIdFor(env, computer.user_id), origin: who ? "agent" : "person", tier: tierOf(size) }, computer.instance_id, now);
  return json({ deleted: true });
}

async function handleExec(request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, { now }: CloudRequestContext): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const command = typeof body.command === "string" ? body.command : "";
  if (!command || command.length > MAX_COMMAND) return badRequest("That command can't be run.");
  const timeoutMs = typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
    ? Math.min(MAX_EXEC_TIMEOUT_MS, Math.max(1_000, Math.round(body.timeoutMs)))
    : undefined;
  // A command wakes a sleeping computer.
  if (!isMeteredStatus(computer.status)) {
    const { blocked } = await wakeBlocker(env, computer.user_id, now);
    if (blocked) return blocked.response;
  }
  return json(await provider.exec(computer.instance_id, command, timeoutMs));
}

async function handleTemplate(env: CloudEnv, provider: CloudProvider): Promise<Response> {
  const templateVersion = await readSetting(env, "template_version");
  if (!templateVersion) return json({ exists: false });
  return json({ exists: await provider.hasTemplate(templateVersion) });
}

async function handleList(env: CloudEnv, userId: string, provider: CloudProvider): Promise<Response> {
  const all = await provider.listInstances();
  const [rows, targets] = await Promise.all([listComputers(env, userId), readUpdateTargets(env)]);
  const owned = new Set<string>();
  const pendingRequestIds = new Map<string, string>();
  const rowById = new Map<string, ComputerRow>();
  for (const row of rows) {
    if (isPendingId(row.instance_id)) {
      if (row.request_id) pendingRequestIds.set(row.request_id, row.instance_id);
    } else {
      owned.add(row.instance_id);
      rowById.set(row.instance_id, row);
    }
  }
  // A create cancelled or lost in flight: the client finds it by its request tag.
  const now = Date.now();
  // The lane each computer holds, kept on its row (a computer made before the row kept it, or a branch named since).
  const laneUpdates = all.flatMap((instance) => {
    const row = rowById.get(instance.id);
    const statement = row ? laneFactsStatement(env, instance.id, row, instance.metadata) : null;
    return statement ? [statement] : [];
  });
  if (laneUpdates.length) await env.DB.batch(laneUpdates);
  for (const instance of all) {
    const pendingId = pendingRequestIds.get(instance.metadata.ade_request_id ?? "");
    if (pendingId && !owned.has(instance.id)) {
      const [adopted] = await env.DB.batch(adoptionStatements(env, { pendingId, instance, machineKey: instance.metadata.ade_machine_key ?? null, now, reason: "create_adopted" }));
      if (adopted?.meta.changes === 1) {
        owned.add(instance.id);
        const pending = rows.find((row) => row.instance_id === pendingId);
        if (pending) rowById.set(instance.id, pending);
      }
    }
  }
  return json({
    data: all
      .filter((instance) => owned.has(instance.id))
      .map((instance) => withUseFacts(withUpdateFacts(instance, rowById.get(instance.id), targets), rowById.get(instance.id))),
  });
}

const instanceRoutes: Record<string, (request: Request, env: CloudEnv, computer: ComputerRow, provider: CloudProvider, ctx: CloudRequestContext) => Promise<Response>> = {
  "POST sleep": (_request, env, computer, provider, { now }) => handleSleepLike(env, computer, provider, now, "user"),
  "POST idle": (_request, env, computer, provider, { now }) => handleSleepLike(env, computer, provider, now, "idle_request"),
  "POST start": handleStart,
  "POST stop": (_request, env, computer, provider, { now }) => handleStop(env, computer, provider, now),
  "POST update": handleUpdate,
  // The computer asks whether it should update itself (its idle step), and reports in after each brain start.
  "GET update-check": async (_request, env, computer, _provider, { now }) => json(updateCheckOf(computer, await readUpdateTargets(env), now)),
  "POST booted": async (request, env, computer, _provider, { now }) => {
    const body = await readJson(request);
    if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    const { sleepWhenIdle } = await recordBootReport(env, computer, shortText(body.adeVersion, 64), now);
    return json({ ok: true, sleepWhenIdle });
  },
  // The computer's own measure of its disk and its last work, sent at its idle step.
  "POST disk-usage": async (request, env, computer, _provider, { now }) => {
    const report = parseDiskUsageReport(await readJson(request), now);
    if (!report) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    await recordDiskUsage(env, computer, report);
    return json({ ok: true });
  },
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
    if (typeof body?.autoSleep !== "boolean") return badRequest(UNREADABLE_REQUEST_MESSAGE);
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
    if (!metadata) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    await provider.setInstanceMetadata(computer.instance_id, metadata);
    const machineKey = metadata.ade_machine_key ?? null;
    const statements: D1PreparedStatement[] = [];
    if (machineKey !== computer.machine_key) {
      statements.push(env.DB.prepare("update cloud_computers set machine_key = ? where instance_id = ?").bind(machineKey, computer.instance_id));
    }
    const lane = laneFactsStatement(env, computer.instance_id, computer, metadata);
    if (lane) statements.push(lane);
    if (statements.length) await env.DB.batch(statements);
    return json({ ok: true });
  },
};

async function routeInstance(request: Request, env: CloudEnv, provider: CloudProvider, userId: string, instanceId: string, action: string | undefined, ctx: CloudRequestContext): Promise<Response> {
  const { now } = ctx;
  if (!INSTANCE_ID.test(instanceId)) return notFound();
  const computer = await ownedComputer(env, userId, instanceId);
  if (!computer) return notFound();
  if (action === undefined) {
    if (request.method === "GET") {
      try {
        const instance = await provider.getInstance(instanceId);
        await recordStatus(env, computer, instance.status, now, "seen");
        await laneFactsStatement(env, instanceId, computer, instance.metadata)?.run();
        return json(withUseFacts(withUpdateFacts(instance, computer, await readUpdateTargets(env)), computer));
      } catch (error) {
        if (error instanceof CloudProviderError && error.status === 404) await markGone(env, computer, now);
        throw error;
      }
    }
    if (request.method === "DELETE") return handleDelete(request, env, computer, provider, ctx);
    return notFound();
  }
  const handler = instanceRoutes[`${request.method} ${action}`];
  return handler ? handler(request, env, computer, provider, ctx) : notFound();
}

/** A timed wake must name the caller's own computer and that computer's own wake address. */
async function refuseForeignWake(request: { text(): Promise<string> }, env: CloudEnv, userId: string): Promise<Response | null> {
  const body = await readJson(request);
  // A malformed body is the wake route's to answer.
  if (typeof body?.instanceId !== "string" || typeof body.url !== "string") return null;
  const instanceId = body.instanceId.trim();
  if (!await ownedComputer(env, userId, instanceId)) return notFound();
  const provider = providerFor(env);
  if (!provider) return noProviderKey();
  const normalized = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();
  let wakeUrl: string | null = null;
  try {
    wakeUrl = (await provider.getInstance(instanceId)).publicPorts.find((port) => port.port === WAKE_PORT)?.url ?? null;
  } catch (error) {
    if (error instanceof CloudProviderError) return fail(error.code, error.message, 502);
    throw error;
  }
  return wakeUrl && normalized(wakeUrl) === normalized(body.url) ? null : badRequest("That isn't this computer's wake address.");
}

const BILLING_PATHS = new Set<string>([CLOUD_PATHS.billingCheckout, CLOUD_PATHS.billingPortal, CLOUD_PATHS.billingExtraHours, CLOUD_PATHS.billingExtraDisk]);
/** The most a person may set as extra disk's monthly limit, in dollars. */
const EXTRA_DISK_LIMIT_MAX_USD = 1000;

/** The billing routes, or null when `path` isn't one of them. */
async function routeBilling(request: Request, url: URL, path: string, env: CloudEnv, userId: string, { now, waitUntil }: CloudRequestContext): Promise<Response | null> {
  if (!BILLING_PATHS.has(path)) return null;
  if (request.method !== "POST") return notFound();
  const offers = cloudOffers(env);
  // Not set up yet: as if it didn't exist.
  if (path === CLOUD_PATHS.billingExtraDisk && !offers.extraDisk) return notFound();
  try {
    if (path === CLOUD_PATHS.billingPortal) return json(await createPortalUrl(env, userId, url.origin, now));
    const body = await readJson(request);
    if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    if (path === CLOUD_PATHS.billingCheckout) {
      // Builds that know one paid plan send no body: that's Plus.
      if (body.plan !== undefined && !(body.plan === "plus" || (body.plan === "pro" && offers.pro))) return badRequest("That plan isn't one ADE Cloud offers.");
      return json(await createCheckoutUrl(env, userId, url.origin, now, isPaidPlanId(body.plan) ? body.plan : undefined, waitUntil));
    }
    if (typeof body.enabled !== "boolean") return badRequest(UNREADABLE_REQUEST_MESSAGE);
    if (path === CLOUD_PATHS.billingExtraDisk) {
      const limit = body.monthlyLimitUsd;
      const limitOk = typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= EXTRA_DISK_LIMIT_MAX_USD;
      if (body.enabled && !limitOk) return badRequest(`Pick a monthly limit from $1 to $${EXTRA_DISK_LIMIT_MAX_USD}.`);
      await setExtraDisk(env, userId, body.enabled ? { enabled: true, monthlyLimitCents: (limit as number) * 100 } : { enabled: false }, now);
      return json(await buildAccountState(env, userId, now));
    }
    await setExtraHours(env, userId, body.enabled, now);
    return json(await buildAccountState(env, userId, now));
  } catch (error) {
    if (error instanceof CloudBillingError) return fail(error.code, error.message, error.status);
    throw error;
  }
}

/**
 * When a request settles the free plan for its computer: `use` for what
 * spends hours (a create or move, a copy, a wake), `read` for the account and
 * referral reads, null for the rest (they need no answer about it).
 */
function freePlanMomentOf(method: string, path: string): "read" | "use" | null {
  if (method === "GET" && (path === CLOUD_PATHS.account || path === CLOUD_PATHS.referrals)) return "read";
  if (method !== "POST") return null;
  if (path === CLOUD_PATHS.instances) return "use";
  const action = instanceRouteOf(path)?.action;
  return action === "start" || action === "fork" ? "use" : null;
}

/** `/cloud/instances/<id>/<action>/<rest...>`, or null for any other path. */
function instanceRouteOf(path: string): { instanceId: string; action: string | undefined; rest: string[] } | null {
  if (!path.startsWith(`${CLOUD_PATHS.instances}/`)) return null;
  const [instanceId = "", action, ...rest] = path.slice(CLOUD_PATHS.instances.length + 1).split("/");
  return { instanceId, action, rest };
}

const CORS_METHODS = "GET, POST, PUT, DELETE";
const CORS_HEADERS = new Set(["authorization", "content-type", "x-ade-correlation-id"]);

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * `/cloud/*` straight from a browser and a phone (C7). CORS is the
 * directory's rule (`handleRequest`): only the hosted web client's exact
 * origin, never `*`; a native caller sends no Origin and passes. Any other
 * Origin is refused before the token, D1 or the provider is touched.
 */
export async function handleCloudRequest(request: Request, env: CloudEnv, waitUntil?: CloudWaitUntil): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true });
  const corsOrigin = requestOrigin && allowedOrigin && requestOrigin === allowedOrigin ? allowedOrigin : null;
  if (request.method === "OPTIONS") {
    if (!corsOrigin) return fail("origin_not_allowed", "This origin can't call ADE Cloud.", 403);
    const wanted = request.headers.get("access-control-request-method")?.toUpperCase() ?? "";
    if (!CORS_METHODS.split(", ").includes(wanted)) return fail("bad_request", "That method isn't allowed here.", 405);
    const requested = (request.headers.get("access-control-request-headers") ?? "")
      .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
    if (requested.some((header) => !CORS_HEADERS.has(header))) return fail("origin_not_allowed", "Those headers aren't allowed.", 403);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": [...CORS_HEADERS].join(", "),
        "access-control-allow-methods": `${CORS_METHODS}, OPTIONS`,
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }
  if (requestOrigin && !corsOrigin) return fail("origin_not_allowed", "This origin can't call ADE Cloud.", 403);
  const response = await routeCloudRequest(request, env, waitUntil);
  return corsOrigin ? withCors(response, corsOrigin) : response;
}

async function routeCloudRequest(request: Request, env: CloudEnv, waitUntil?: CloudWaitUntil): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  // The new computer's join has no account token yet: its one-time code is the proof.
  if (isLaunchJoinRequest(path, request.method)) {
    return providerCall(() => handleLaunchJoin(request, env, path, { provider: providerFor(env), now: Date.now() }));
  }
  // The webhook relay's forward of a cloud automation's delivery: the hook's own signature is the proof.
  if (isAutomationDeliveryRequest(path, request.method)) {
    const now = Date.now();
    const provider = providerFor(env);
    return providerCall(() => handleAutomationDelivery(request, env, path, {
      provider,
      now,
      createComputer: (userId, launchProvider, extras) => createComputer(env, userId, launchProvider, extras, { now, waitUntil }),
    }));
  }
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
      const { blocked } = await wakeBlocker(env, caller.userId, Date.now());
      if (blocked) return blocked.response;
      const refused = await refuseForeignWake(request.clone(), env, caller.userId);
      if (refused) return refused;
    }
    return handleCloudWakeRequest(request, env);
  }

  const provider = providerFor(env);
  const now = Date.now();
  const ctx: CloudRequestContext = { now, waitUntil };
  // One free plan per computer (`freePlan.ts`): settled before the request's own hours check.
  const freePlanMoment = freePlanMomentOf(request.method, path);
  if (freePlanMoment) {
    await settleFreePlanComputer(env, await loadAccount(env, caller.userId, now), readComputerSignal(request), freePlanMoment, ctx);
  }
  if (path === CLOUD_PATHS.account) {
    return request.method === "GET" ? json(await buildAccountState(env, caller.userId, now)) : notFound();
  }
  const referrals = await routeReferrals(request, path, env, caller.userId, ctx);
  if (referrals) return referrals;
  const billing = await routeBilling(request, url, path, env, caller.userId, ctx);
  if (billing) return billing;
  // Saved chats need no provider: they stay readable when the computer can't be.
  if (path === CLOUD_PATHS.chats || path.startsWith(`${CLOUD_PATHS.chats}/`)) {
    return routeSavedChats(request, url, path, env, caller.userId, now);
  }
  // Lanes without a computer are rows only: readable with no provider, like saved chats.
  if (path === CLOUD_PATHS.lanesWithoutComputer || path.startsWith(`${CLOUD_PATHS.lanesWithoutComputer}/`)) {
    return routeLanesWithoutComputer(request, path, env, caller.userId);
  }
  // The server launcher: a launch's record reads with no provider; only the start and a cancel need it.
  if (path === CLOUD_PATHS.launches || path.startsWith(`${CLOUD_PATHS.launches}/`)) {
    const authorization = request.headers.get("authorization");
    return providerCall(() => routeLaunches(request, path, env, caller.userId, {
      provider,
      now,
      createComputer: (userId, launchProvider, extras) => createComputer(env, userId, launchProvider, extras, ctx),
      gitCheck: (origin) => serverGitCheck(env, authorization, origin),
      onProgress: (record) => noteAutomationLaunchProgress(env, record, { now }),
    }));
  }
  // Automations on ADE Cloud: rows only, except a run's start (Run now), which makes a computer.
  if (path === CLOUD_PATHS.automations || path.startsWith(`${CLOUD_PATHS.automations}/`)) {
    return providerCall(() => routeAutomations(request, url, path, env, caller.userId, {
      provider,
      now,
      createComputer: (userId, launchProvider, extras) => createComputer(env, userId, launchProvider, extras, ctx),
    }));
  }
  // The job's rows only; the minute cron does the work.
  if (path === CLOUD_PATHS.projectComputersDelete || path.startsWith(`${CLOUD_PATHS.projectComputersDelete}/`)) {
    return routeProjectComputersDelete(request, path, env, caller.userId, now);
  }
  if (!provider) {
    reportCloudFailure("cloud.no_provider_key");
    return noProviderKey();
  }
  return providerCall(async () => {
    if (path === CLOUD_PATHS.instances) {
      if (request.method === "GET") return handleList(env, caller.userId, provider);
      if (request.method === "POST") return handleCreate(request, env, caller.userId, provider, ctx);
      return notFound();
    }
    if (path.startsWith(`${CLOUD_PATHS.templates}/`) && request.method === "GET") return handleTemplate(env, provider);
    const instanceRoute = instanceRouteOf(path);
    if (instanceRoute) {
      if (instanceRoute.action === "sign-ins") {
        if (!INSTANCE_ID.test(instanceRoute.instanceId)) return notFound();
        const computer = await ownedComputer(env, caller.userId, instanceRoute.instanceId);
        if (!computer) return notFound();
        return routeSignIns(request, computer, instanceRoute.rest, {
          provider,
          isAwake: isMeteredStatus(computer.status),
          isStopped: computer.status === "stopped",
          startStopped: async () => recordStatus(env, computer, await provider.startInstance(computer.instance_id), now, "sign_in"),
          wakeBlocked: async () => (await wakeBlocker(env, caller.userId, now)).blocked?.response ?? null,
        });
      }
      if (instanceRoute.rest.length) return notFound();
      return routeInstance(request, env, provider, caller.userId, instanceRoute.instanceId, instanceRoute.action, ctx);
    }
    return notFound();
  });
}
