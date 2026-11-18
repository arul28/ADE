import { boundedDisplayText } from "../displayText";
import {
  CLOUD_MACHINE_KEY_METADATA,
  cloudHoldCommand,
  cloudReleaseHoldCommand,
  copiedComputerMetadata,
  handCopyJoinCommand,
} from "./computerCommands";
import { CLOUD_LAUNCH_METADATA, type CloudCopyList, type CloudCopyRecord, type CloudCopyState, type CloudTierId } from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, UUID_PATTERN, badRequest, fail, json, readJson, shortString } from "./http";
import {
  JOB_RECORD_TTL_MS,
  nudgeJob,
  readJob,
  registerJobKind,
  requestJobCancel,
  runJob,
  type CloudJobDeps,
  type JobContext,
  type JobRow,
  type StepResult,
} from "./jobs";
import { bindCopyLaunchStatement, launchCodeStillJoins, machineLaunchMinVersion, openCopyLaunchJoin, prepareCopyLaunch, readLaunch } from "./launches";
import { cloudSizeFor, cloudSizeForTier, type CloudSize } from "./plans";
import { CloudProviderError } from "./provider";
import { deleteComputer, isPendingId, logCloud, ownedComputer, reportCloudFailure, type CloudEnv, type ComputerRow } from "./store";

/**
 * A computer copied into a new one ("a warm copy": the same repos, lanes,
 * installed dependencies and caches), run by the server so it needs no ADE
 * app open (`POST /cloud/instances/:id/copy`). The provider's fork copies the
 * disk; the fork boots signed out as a new machine (the copied-home guard,
 * `hostInstanceGuard.ts`), and signs in through a `machine` launch the server
 * made for it. The fork takes no env, so the server hands it the launch's id
 * and join code over exec, in a one-time file its restarted brain reads and
 * deletes (`handCopyJoinCommand`, `cloudBootLaunch.ts`). The steps, one or
 * two a cron tick (`jobs.ts`):
 *
 *   hold   a running original is held awake (its own brain would sleep it mid-fork);
 *   fork   the provider's fork, with the copy's metadata and its launch's id;
 *   boot   until the fork runs; the original's hold ends;
 *   hand   the fork gets its sign-in, and its brain restarts;
 *   join   until it signed in (an approval link while a person must confirm);
 *   name   the copy's account machine takes its name; done.
 *
 * The original is never changed but for its hold on sleep. A failure or a
 * cancel (until the copy signed in) deletes the fork and its launch.
 */

export const COPY_JOB_KIND = "copy";

const SERVER_COPY_UNAVAILABLE = "server_copy_unavailable";
const SERVER_COPY_UNAVAILABLE_MESSAGE = "Copying a computer from here needs the next ADE update. Try again after it ships.";
const COPY_NEEDS_UPDATE = "copy_needs_update";

/** The original's hold on sleep while it is forked (`cloudHoldCommand`); it expires by itself. */
const COPY_HOLD_MS = 20 * 60_000;
/** How long each wait may last before the copy gives up. */
const SOURCE_WAIT_MAX_MS = 5 * 60_000;
/** A fork of a big disk finishes on its own; a warm full computer took 167 s. */
const FORK_READY_MAX_MS = 15 * 60_000;
/** Past the join's 30 minutes, as long as the launcher waits for a join claimed in its last minute (`failUnjoinedLaunches`). */
const JOIN_GRACE_MS = 15 * 60_000;
/** A fork that hasn't used its code this long after it was handed lost it (its brain stopped before the join): it is handed again, at most `MAX_HANDS` times. */
const REHAND_AFTER_MS = 4 * 60_000;
const MAX_HANDS = 3;
/** How often each wait looks again. */
const SOURCE_POLL_MS = 10_000;
const IN_PROGRESS_POLL_MS = 10_000;
const FORK_POLL_MS = 5_000;
const JOIN_POLL_MS = 5_000;
const APPROVAL_POLL_MS = 5_000;
/** Every command the copy runs on a computer is bounded. */
const EXEC_MS = 60_000;
const SHORT_EXEC_MS = 30_000;
/** The steps a cancel may still stop: the copy hasn't signed in yet. */
const CANCELLABLE_STEPS: ReadonlySet<string> = new Set(["hold", "fork", "boot", "hand", "join"]);
const SOURCE_SETTLING: ReadonlySet<string> = new Set(["starting", "waking", "creating", "updating"]);
const LIST_LIMIT = 20;
const LIST_FINISHED_MS = 24 * 60 * 60_000;
const ORIGINS: ReadonlySet<string> = new Set(["person", "agent", "automation", "mcp"]);

type AgentMaker = "chat" | "automation" | "mcp";

type CopyParams = {
  /** The original. Kept here: the job's `source_instance_id` is let go once the fork runs, so the original is free for another job. */
  sourceInstanceId: string;
  /** The copy's name. */
  name: string;
  type: "default" | "vm";
  cpu: number;
  memoryGb: number;
  madeByChat: string | null;
  madeByAgent: AgentMaker | null;
};

type CopyFacts = {
  /** Set before the hold: an undo lets the original sleep again. */
  sourceHeld?: boolean;
  holdReleased?: boolean;
  forkStartedAt?: number;
  forkMs?: number;
  /** How often the fork was handed its sign-in, and when last. */
  hands?: number;
  handedAt?: number;
  /** Why the copy failed, bare, for an undo that keeps a copy that signed in. */
  failure?: string;
};

function paramsOf(job: JobRow): CopyParams {
  let raw: Partial<CopyParams> = {};
  try {
    raw = (job.params_json ? JSON.parse(job.params_json) : {}) as Partial<CopyParams>;
  } catch {
    raw = {};
  }
  const maker = raw.madeByAgent;
  return {
    sourceInstanceId: typeof raw.sourceInstanceId === "string" ? raw.sourceInstanceId : job.source_instance_id ?? "",
    name: typeof raw.name === "string" && raw.name ? raw.name : "ADE computer",
    type: raw.type === "vm" ? "vm" : "default",
    cpu: typeof raw.cpu === "number" ? raw.cpu : 2,
    memoryGb: typeof raw.memoryGb === "number" ? raw.memoryGb : 4,
    madeByChat: typeof raw.madeByChat === "string" ? raw.madeByChat : null,
    madeByAgent: maker === "chat" || maker === "automation" || maker === "mcp" ? maker : null,
  };
}

function factsOf(job: JobRow): CopyFacts {
  try {
    return (job.facts_json ? JSON.parse(job.facts_json) : {}) as CopyFacts;
  } catch {
    return {};
  }
}

const withFacts = (job: JobRow, patch: Partial<CopyFacts>): string => JSON.stringify({ ...factsOf(job), ...patch });
const sourceNameOf = (job: JobRow): string => job.source_name || paramsOf(job).sourceInstanceId || "the computer";

/* ---- The record ---- */

/** `signedIn`: the copy's launch is done, so the copy is a computer of the account and is never cancelled. */
export function copyRecordOf(job: JobRow, signedIn = false): CloudCopyRecord {
  const params = paramsOf(job);
  const finished = job.state === "done" || job.state === "failed" || job.state === "cancelled";
  return {
    copyId: job.job_id,
    sourceInstanceId: params.sourceInstanceId,
    sourceName: sourceNameOf(job),
    name: params.name,
    targetInstanceId: job.target_instance_id,
    sizeId: cloudSizeFor(params.type, params.cpu, params.memoryGb)?.tier ?? null,
    state: job.state as CloudCopyState,
    message: job.message ?? "",
    approvalUrl: job.state === "needs_approval" ? job.approval_url : null,
    error: job.state === "failed" ? job.error : null,
    targetMachineKey: job.target_machine_key,
    cancellable: !finished && !signedIn && job.cancel_requested_at == null && CANCELLABLE_STEPS.has(job.step),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

/** Whether the copy's launch is done: from then on the copy is a computer of the account, kept whatever the job does next. */
async function copySignedIn(env: CloudEnv, job: JobRow): Promise<boolean> {
  return job.target_launch_id ? (await readLaunch(env, job.target_launch_id))?.state === "done" : false;
}

/* ---- The steps ---- */

async function sourceOf(env: CloudEnv, job: JobRow, params: CopyParams): Promise<ComputerRow | null> {
  return params.sourceInstanceId ? await ownedComputer(env, job.user_id, params.sourceInstanceId) : null;
}

const SOURCE_GONE: StepResult = { kind: "fail", error: "it's no longer on your account." };

/** A command on a computer, its answer or null when it couldn't run (the caller decides what that means). Never logs the command. */
async function tryExec(ctx: JobContext, instanceId: string, command: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string } | null> {
  try {
    return await ctx.provider.exec(instanceId, command, timeoutMs);
  } catch (error) {
    logCloud("cloud.copy_exec_failed", { instanceId, code: error instanceof CloudProviderError ? error.code : "unknown" });
    return null;
  }
}

const joiningMessage = (params: CopyParams) => `Signing in ${params.name}…`;

async function hold(env: CloudEnv, job: JobRow, ctx: JobContext, params: CopyParams): Promise<StepResult> {
  const source = await sourceOf(env, job, params);
  if (!source) return SOURCE_GONE;
  const instance = await ctx.provider.getInstance(source.instance_id);
  const next: StepResult = { kind: "next", step: "fork", patch: { message: `Copying ${sourceNameOf(job)} on ADE Cloud…` } };
  if (instance.status === "running") {
    // Noted before the hold: whatever happens next, an undo lets it sleep again.
    const facts = withFacts(job, { sourceHeld: true });
    await ctx.save({ facts_json: facts });
    await tryExec(ctx, source.instance_id, cloudHoldCommand("copy", COPY_HOLD_MS), SHORT_EXEC_MS);
    return { ...next, patch: { ...next.patch, facts_json: facts } };
  }
  if (instance.status === "sleeping" || instance.status === "stopped") return next;
  if (SOURCE_SETTLING.has(instance.status) && ctx.now - job.created_at <= SOURCE_WAIT_MAX_MS) return { kind: "wait", delayMs: SOURCE_POLL_MS };
  return { kind: "fail", error: `it is ${instance.status}; ADE Cloud copies a computer that is running, asleep or stopped.` };
}

async function fork(env: CloudEnv, job: JobRow, ctx: JobContext, params: CopyParams): Promise<StepResult> {
  const source = await sourceOf(env, job, params);
  if (!source) return SOURCE_GONE;
  if (!ctx.deps.forkComputer) throw new Error("ADE Cloud can't copy a computer right now.");
  const launchId = job.target_launch_id;
  if (!launchId) return { kind: "fail", error: "ADE Cloud lost track of this copy." };
  const size = cloudSizeFor(params.type, params.cpu, params.memoryGb);
  const ready = await prepareCopyLaunch(env, job.user_id, launchId, {
    sizeId: size?.tier ?? null, type: params.type, name: params.name, copiedFrom: source.instance_id,
  }, ctx.now);
  if (!ready) return { kind: "fail", error: "ADE Cloud can't sign a copy in right now. Try again soon." };
  const instance = await ctx.provider.getInstance(source.instance_id);
  const metadata = copiedComputerMetadata(instance.metadata, {
    ade_copied_from: source.instance_id,
    ...(params.madeByChat ? { ade_made_by_chat: params.madeByChat } : {}),
    ...(params.madeByAgent ? { ade_made_by_agent: params.madeByAgent } : {}),
    // The join checks that the fork's own record names its launch.
    [CLOUD_LAUNCH_METADATA.launchId]: launchId,
    // The same id as the launch: a step run again finds the fork it made.
    ade_request_id: launchId,
  });
  const forkStartedAt = factsOf(job).forkStartedAt ?? ctx.now;
  const outcome = await ctx.deps.forkComputer(source, ctx.provider, {
    body: { name: params.name, resources: { cpu: params.cpu, memory: params.memoryGb }, metadata },
    onMade: (made) => [bindCopyLaunchStatement(env, launchId, made.id, Date.now())],
  });
  if (outcome.kind === "in_progress") return { kind: "wait", delayMs: IN_PROGRESS_POLL_MS };
  if (outcome.kind === "refused") {
    const body = await outcome.response.json().catch(() => null) as { error?: { message?: unknown } } | null;
    return { kind: "fail", error: typeof body?.error?.message === "string" ? body.error.message : "ADE Cloud couldn't copy the computer." };
  }
  if (outcome.kind === "replayed") await bindCopyLaunchStatement(env, launchId, outcome.instance.id, ctx.now).run();
  logCloud("cloud.copy_forked", { jobId: job.job_id, sourceId: source.instance_id, instanceId: outcome.instance.id, replay: outcome.kind === "replayed" });
  return {
    kind: "next",
    step: "boot",
    patch: {
      target_instance_id: outcome.instance.id,
      message: "ADE Cloud is copying the disk. A big one takes a few minutes…",
      facts_json: withFacts(job, { forkStartedAt }),
    },
  };
}

async function boot(job: JobRow, ctx: JobContext, params: CopyParams): Promise<StepResult> {
  const targetId = job.target_instance_id!;
  let status: string;
  let reason: string | null = null;
  try {
    const instance = await ctx.provider.getInstance(targetId);
    status = instance.status;
    reason = instance.statusReason?.message ?? null;
  } catch (error) {
    if (error instanceof CloudProviderError && error.status === 404) return { kind: "fail", error: "the copy is gone." };
    throw error;
  }
  const facts = factsOf(job);
  if (status === "running") {
    // The fork is whole: the original may sleep when idle again.
    if (facts.sourceHeld && !facts.holdReleased) await tryExec(ctx, params.sourceInstanceId, cloudReleaseHoldCommand("copy"), SHORT_EXEC_MS);
    const forkMs = Math.max(0, ctx.now - (facts.forkStartedAt ?? job.created_at));
    return {
      kind: "next",
      step: "hand",
      // The original is let go: another move, free or copy of it may start now.
      patch: { source_instance_id: null, state: "joining", message: joiningMessage(params), facts_json: withFacts(job, { holdReleased: true, forkMs }) },
    };
  }
  if (status === "failed") return { kind: "fail", error: `ADE Cloud couldn't make the copy${reason ? `: ${reason}` : "."}` };
  if (ctx.now - (job.step_started_at ?? ctx.now) > FORK_READY_MAX_MS) return { kind: "fail", error: "ADE Cloud didn't finish making the copy in time." };
  return { kind: "wait", delayMs: FORK_POLL_MS };
}

async function hand(env: CloudEnv, job: JobRow, ctx: JobContext, params: CopyParams): Promise<StepResult> {
  const targetId = job.target_instance_id!;
  const launchId = job.target_launch_id!;
  const opened = await openCopyLaunchJoin(env, launchId, targetId, ctx.now);
  if (opened.kind === "signed_in") return { kind: "next", step: "join" };
  if (opened.kind === "closed") return { kind: "fail", error: "the copy's sign-in ended before it joined." };
  const hands = (factsOf(job).hands ?? 0) + 1;
  const facts = withFacts(job, { hands, handedAt: ctx.now });
  // Noted first: a hand whose answer is lost still counts.
  await ctx.save({ facts_json: facts });
  let ran: { stdout: string } | null = null;
  try {
    // The code goes to this one exec and nowhere else: never logged, never kept.
    ran = await ctx.provider.exec(targetId, handCopyJoinCommand(launchId, opened.code), EXEC_MS);
  } catch (error) {
    logCloud("cloud.copy_hand_failed", { jobId: job.job_id, instanceId: targetId, code: error instanceof CloudProviderError ? error.code : "unknown" });
  }
  if (!ran || !/\bhanded\b/.test(ran.stdout)) throw new Error("The copy didn't take its sign-in.");
  logCloud("cloud.copy_handed", { jobId: job.job_id, instanceId: targetId, hands });
  return { kind: "next", step: "join", patch: { facts_json: facts, state: "joining", message: joiningMessage(params) } };
}

async function join(env: CloudEnv, job: JobRow, ctx: JobContext, params: CopyParams): Promise<StepResult> {
  const launch = job.target_launch_id ? await readLaunch(env, job.target_launch_id) : null;
  if (!launch) return { kind: "fail", error: "the copy's sign-in is gone." };
  if (launch.state === "failed" || launch.state === "cancelled") return { kind: "fail", error: "the copy didn't sign in." };
  if (launch.state !== "done" && launch.join_expires_at != null && ctx.now > launch.join_expires_at + JOIN_GRACE_MS) {
    return { kind: "fail", error: "the copy didn't sign in in time." };
  }
  if (launch.state === "needs_approval") {
    return {
      kind: "wait",
      delayMs: APPROVAL_POLL_MS,
      patch: { state: "needs_approval", approval_url: launch.approval_url, message: "Approve the copy's sign-in to go on." },
    };
  }
  if (launch.state !== "done") {
    const facts = factsOf(job);
    // The brain that read the code stopped before it joined, or after it used the code and before it signed in
    // (nothing claimed for a while): the same code again, in the same window, while the join still takes it.
    if (launch.state === "joining" && facts.handedAt != null && ctx.now - facts.handedAt > REHAND_AFTER_MS
      && (launch.join_used_at == null || ctx.now - launch.join_used_at > REHAND_AFTER_MS)
      && (facts.hands ?? 1) < MAX_HANDS && await launchCodeStillJoins(env, launch)) {
      return { kind: "next", step: "hand" };
    }
    return { kind: "wait", delayMs: JOIN_POLL_MS, patch: { state: "joining", approval_url: null, message: joiningMessage(params) } };
  }
  // Signed in: its account key is on its row (the brain wrote it before it reported done).
  const target = job.target_instance_id ? await ownedComputer(env, job.user_id, job.target_instance_id) : null;
  if (!target) return { kind: "fail", error: "the copy is gone." };
  let machineKey = target.machine_key;
  if (!machineKey) machineKey = (await ctx.provider.getInstance(target.instance_id)).metadata[CLOUD_MACHINE_KEY_METADATA] ?? null;
  if (!machineKey) return { kind: "wait", delayMs: JOIN_POLL_MS };
  return { kind: "next", step: "name", patch: { target_machine_key: machineKey, approval_url: null, state: "joining", message: `Finishing ${params.name}…` } };
}

async function name(env: CloudEnv, job: JobRow, params: CopyParams): Promise<StepResult> {
  const targetId = job.target_instance_id!;
  // The fork was made with the name; the brain names its machine row for its host, so the account's row takes the copy's name.
  await env.DB.prepare("update cloud_computers set name = ? where instance_id = ? and user_id = ?").bind(params.name, targetId, job.user_id).run();
  if (job.target_machine_key) {
    await env.DB.prepare("update machines set custom_name = ? where user_id = ? and machine_key = ?").bind(params.name, job.user_id, job.target_machine_key).run();
  }
  const facts = factsOf(job);
  logCloud("cloud.machine_copied", { jobId: job.job_id, sourceId: params.sourceInstanceId, instanceId: targetId, forkMs: facts.forkMs ?? null, hands: facts.hands ?? 0 });
  return { kind: "end", patch: { state: "done", message: `Copied ${sourceNameOf(job)} into ${params.name}.` } };
}

async function runCopyStep(env: CloudEnv, job: JobRow, ctx: JobContext): Promise<StepResult> {
  const params = paramsOf(job);
  switch (job.step) {
    case "hold": return await hold(env, job, ctx, params);
    case "fork": return await fork(env, job, ctx, params);
    case "boot": return await boot(job, ctx, params);
    case "hand": return await hand(env, job, ctx, params);
    case "join": return await join(env, job, ctx, params);
    case "name": return await name(env, job, params);
    default: return { kind: "fail", error: "ADE Cloud lost track of this copy." };
  }
}

/**
 * Undoes a copy that stopped before it signed in: the original's hold ends,
 * the copy's launch closes (a join after it is refused), and the fork is
 * deleted (its account machine row goes with it). A fork the provider made
 * whose reservation isn't adopted yet is waited for (the minute tick adopts
 * it by its tag), so it is never left behind. False while there is more to do.
 *
 * A copy whose launch is done (it signed in, even during this cancel) is a
 * computer of the account: it is kept, and the record says so.
 */
async function undoCopy(env: CloudEnv, job: JobRow, ctx: JobContext, why: "failed" | "cancelled"): Promise<boolean> {
  const params = paramsOf(job);
  const facts = factsOf(job);
  if (facts.sourceHeld && !facts.holdReleased && params.sourceInstanceId) {
    // The hold expires by itself, so one this misses ends on its own.
    await tryExec(ctx, params.sourceInstanceId, cloudReleaseHoldCommand("copy"), SHORT_EXEC_MS);
  }
  let targetId = job.target_instance_id;
  if (job.target_launch_id) {
    const launch = await env.DB.prepare(`
      update cloud_launches set state = 'cancelled', approval_url = null, sign_in_json = null, updated_at = ?
      where launch_id = ? and state not in ('done', 'cancelled', 'failed') returning instance_id
    `).bind(ctx.now, job.target_launch_id).first<{ instance_id: string | null }>();
    // Nothing closed: the launch was over already, maybe signed in a moment ago.
    const over = launch ? null : await readLaunch(env, job.target_launch_id);
    if (over?.state === "done") {
      await keepSignedInCopy(env, job, ctx, why);
      return true;
    }
    targetId = targetId ?? launch?.instance_id ?? over?.instance_id ?? null;
    if (!targetId) {
      const reserved = await env.DB.prepare("select instance_id from cloud_computers where user_id = ? and request_id = ? and deleted_at is null limit 1")
        .bind(job.user_id, job.target_launch_id).first<{ instance_id: string }>();
      if (reserved && isPendingId(reserved.instance_id)) return false;
      targetId = reserved?.instance_id ?? null;
    }
  }
  if (!targetId) return true;
  const target = await ownedComputer(env, job.user_id, targetId);
  if (!target) return true;
  try {
    await deleteComputer(env, ctx.provider, target, { who: "copy", reason: why === "cancelled" ? "copy_cancelled" : "copy_failed" }, ctx.now);
    return true;
  } catch (error) {
    logCloud("cloud.copy_target_delete_failed", { jobId: job.job_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    return false;
  }
}

/** Why a copy failed, as one clause ending in a stop. */
function failureClause(error: string): string {
  const why = /^ADE\b/.test(error) ? error : `${error.charAt(0).toLowerCase()}${error.slice(1)}`;
  return /[.!?…]$/.test(why) ? why : `${why}.`;
}

/**
 * A copy that signed in before its job stopped: kept, never deleted. A cancel
 * that came too late finishes it (named, done, its machine key on the record);
 * a failure after the sign-in stays failed and says the copy was kept.
 */
async function keepSignedInCopy(env: CloudEnv, job: JobRow, ctx: JobContext, why: "failed" | "cancelled"): Promise<void> {
  const params = paramsOf(job);
  const source = sourceNameOf(job);
  const target = job.target_instance_id ? await ownedComputer(env, job.user_id, job.target_instance_id) : null;
  const machineKey = job.target_machine_key ?? target?.machine_key ?? null;
  logCloud("cloud.copy_kept_signed_in", { jobId: job.job_id, instanceId: job.target_instance_id, why });
  if (why === "cancelled") {
    if (job.target_instance_id) await name(env, { ...job, target_machine_key: machineKey }, params);
    await ctx.save({
      state: "done",
      message: `${params.name} had already signed in, so the copy wasn't cancelled. Delete it from its card if you don't want it.`,
      ...(machineKey ? { target_machine_key: machineKey } : {}),
    });
    return;
  }
  const sentence = `ADE couldn't finish copying ${source}: ${failureClause(factsOf(job).failure ?? "something went wrong")} ${params.name} had already signed in, so ADE kept it. ${source} is as it was.`;
  await ctx.save({ message: sentence, error: sentence, ...(machineKey ? { target_machine_key: machineKey } : {}) });
}

registerJobKind(COPY_JOB_KIND, {
  run: runCopyStep,
  failed: (job, error) => {
    const tail = job.target_instance_id ? `${sourceNameOf(job)} is as it was, and the copy was deleted.` : `${sourceNameOf(job)} is as it was.`;
    const sentence = `ADE couldn't copy ${sourceNameOf(job)}: ${failureClause(error)} ${tail}`;
    // The bare reason, for an undo that keeps a copy that signed in meanwhile.
    return { state: "failed", message: sentence, error: sentence, approval_url: null, facts_json: withFacts(job, { failure: error }) };
  },
  undo: undoCopy,
  cancellable: (step) => CANCELLABLE_STEPS.has(step),
  cancelled: (job) => ({ state: "cancelled", message: `The copy was cancelled. ${sourceNameOf(job)} is as it was.`, approval_url: null }),
});

/* ---- The routes ---- */

/** What the copy route needs from routes.ts (passed in, so neither module imports the other). */
export type CopyRouteDeps = CloudJobDeps & {
  now: number;
  waitUntil?: (promise: Promise<unknown>) => void;
  /** The copy's own rules for a fork of `source` with this body (`forkRefusal`: hours, disk, limits, size); null when it may start. */
  refusal: (source: ComputerRow, forkBody: Record<string, unknown>) => Promise<Response | null>;
};

const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value.trim().toLowerCase());

/** Whether ADE version `have` is at least `need` (`1.2.131`, `1.2.131-beta.3`: a prerelease comes before its release). Unreadable is no. */
export function adeVersionAtLeast(have: string, need: string): boolean {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(value.trim());
    return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.split(".") ?? null } : null;
  };
  const a = parse(have);
  const b = parse(need);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]!;
  }
  if (!a.pre) return true;
  if (!b.pre) return false;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return false;
    if (y === undefined) return true;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    return numeric ? Number(x) > Number(y) : x > y;
  }
  return true;
}

/** The copy's size: the one asked for (of the original's kind), else the original's CPU and memory. */
function copySizeOf(source: ComputerRow, sizeId: unknown, resources: unknown): CloudSize | string {
  const type = source.type === "vm" ? "vm" : "default";
  const kind = type === "vm" ? "full computer" : "standard computer";
  if (sizeId != null) {
    const asked = cloudSizeForTier(sizeId as CloudTierId);
    if (!asked) return "That size isn't one ADE Cloud offers.";
    if (asked.type !== type) return `A copy is a ${kind}, like the original. Use Move to change its kind.`;
    return asked;
  }
  if (resources != null) {
    const shape = typeof resources === "object" ? resources as { cpu?: unknown; memoryGb?: unknown } : {};
    return cloudSizeFor(type, shape.cpu, shape.memoryGb) ?? `That size isn't a ${kind}'s.`;
  }
  return cloudSizeFor(type, source.cpu, source.memory_gb) ?? "That size isn't one ADE Cloud offers.";
}

/** `POST /cloud/instances/:id/copy`. */
export async function handleCopyStart(request: Request, env: CloudEnv, source: ComputerRow, deps: CopyRouteDeps): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  if (!isUuid(body.copyId)) return badRequest("A copy needs a copy id (a UUID).");
  const copyId = body.copyId.trim().toLowerCase();
  const { now } = deps;
  // The same copy again answers what it is, before any rule: it is not a new copy.
  const existing = await readJob(env, copyId);
  if (existing) {
    if (existing.user_id !== source.user_id || existing.kind !== COPY_JOB_KIND || paramsOf(existing).sourceInstanceId !== source.instance_id) {
      return badRequest("That copy id can't be used.");
    }
    return json(copyRecordOf(existing), 200);
  }
  const origin = body.origin == null ? "person" : typeof body.origin === "string" && ORIGINS.has(body.origin) ? body.origin : null;
  if (!origin) return badRequest("That origin isn't one ADE knows.");
  if (body.name != null && typeof body.name !== "string") return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const madeByChat = body.madeByChat == null ? null : shortString(body.madeByChat, 128);
  if (body.madeByChat != null && !madeByChat) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  // A computer that can't read its sign-in file can't join: copies wait for the same switch as moves.
  const minVersion = await machineLaunchMinVersion(env);
  if (!minVersion) return fail(SERVER_COPY_UNAVAILABLE, SERVER_COPY_UNAVAILABLE_MESSAGE, 409);
  const sourceName = source.name ?? source.instance_id;
  // The fork runs the original's ADE: one older than the switch's never reads the file.
  if (source.ade_version && !adeVersionAtLeast(source.ade_version, minVersion)) {
    return fail(COPY_NEEDS_UPDATE, `${sourceName} runs an older ADE than a copy from here needs. Update it, then copy it again.`, 409);
  }
  const size = copySizeOf(source, body.sizeId, body.resources);
  if (typeof size === "string") return badRequest(size);
  const madeByAgent: AgentMaker | null = origin === "person" ? null : origin === "agent" ? "chat" : origin as AgentMaker;
  const madeBy: Record<string, string> = {
    ...(madeByChat ? { ade_made_by_chat: madeByChat } : {}),
    ...(madeByAgent ? { ade_made_by_agent: madeByAgent } : {}),
  };
  const refused = await deps.refusal(source, { resources: { cpu: size.cpu, memory: size.memoryGb }, metadata: madeBy });
  if (refused) return refused;
  if (!deps.provider) return fail("unavailable", "ADE Cloud can't copy a computer right now. Try again soon.", 503);
  if (!env.CLOUD_LAUNCH_JOIN_KEY?.trim()) {
    reportCloudFailure("cloud.launch_join_key_missing");
    return fail("unavailable", "ADE Cloud can't copy a computer right now. Try again soon.", 503);
  }

  const params: CopyParams = {
    sourceInstanceId: source.instance_id,
    name: boundedDisplayText(body.name, 60) ?? boundedDisplayText(`${sourceName} copy`, 60) ?? "ADE computer copy",
    type: size.type === "vm" ? "vm" : "default",
    cpu: size.cpu,
    memoryGb: size.memoryGb,
    madeByChat,
    madeByAgent,
  };
  try {
    await env.DB.prepare(`
      insert into cloud_jobs (job_id, kind, user_id, source_instance_id, source_name, source_machine_key, target_launch_id, params_json, state, step, message,
        facts_json, next_at, created_at, updated_at, expires_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, 'copying', 'hold', ?, '{}', ?, ?, ?, ?)
    `).bind(
      copyId, COPY_JOB_KIND, source.user_id, source.instance_id, sourceName, source.machine_key, crypto.randomUUID(),
      JSON.stringify(params), `Copying ${sourceName} on ADE Cloud…`, now, now, now, now + JOB_RECORD_TTL_MS,
    ).run();
  } catch (error) {
    // The same id got in first, or another job holds this computer (one live job per computer).
    const winner = await readJob(env, copyId);
    if (winner && winner.user_id === source.user_id) return json(copyRecordOf(winner), 200);
    if (/UNIQUE/i.test(error instanceof Error ? error.message : "")) {
      return fail("computer_busy", "Something else is changing this computer. Wait for it to finish, then try again.", 409);
    }
    throw error;
  }
  logCloud("cloud.copy_started", { userId: source.user_id, jobId: copyId, sourceId: source.instance_id, origin });
  // The first step right after the answer; the minute cron runs it otherwise (and every later one).
  if (deps.waitUntil) deps.waitUntil(runJob(env, copyId, deps, { fromRequest: true }).catch(() => undefined));
  return json(copyRecordOf((await readJob(env, copyId))!), 201);
}

/** `GET /cloud/copies`, `GET /cloud/copies/:id` (a watched copy runs its due step after the answer), `DELETE /cloud/copies/:id` (cancel). */
export async function routeCopies(request: Request, path: string, env: CloudEnv, userId: string, deps: Omit<CopyRouteDeps, "refusal">): Promise<Response> {
  const notFound = () => fail("not_found", "ADE Cloud has no such copy.", 404);
  if (path === "/cloud/copies") {
    if (request.method !== "GET") return notFound();
    const rows = (await env.DB.prepare(`
      select * from cloud_jobs where user_id = ? and kind = ? and (state not in ('done', 'failed', 'cancelled') or updated_at > ?)
      order by created_at desc limit ?
    `).bind(userId, COPY_JOB_KIND, deps.now - LIST_FINISHED_MS, LIST_LIMIT).all<JobRow>()).results ?? [];
    return json({ copies: rows.map((row) => copyRecordOf(row)) } satisfies CloudCopyList);
  }
  const copyId = path.slice("/cloud/copies/".length);
  if (!isUuid(copyId)) return notFound();
  const job = await readJob(env, copyId.toLowerCase());
  if (!job || job.user_id !== userId || job.kind !== COPY_JOB_KIND) return notFound();
  if (request.method === "GET") {
    nudgeJob(env, job, deps, deps.waitUntil, deps.now);
    return json(copyRecordOf(job, await copySignedIn(env, job)));
  }
  if (request.method !== "DELETE") return notFound();
  // Over without a copy: nothing is left to cancel.
  if (job.state === "cancelled" || job.state === "failed") return json(copyRecordOf(job));
  // Signed in (its launch is done, though the job may not have seen it yet): a computer of the account now.
  if (job.state === "done" || !CANCELLABLE_STEPS.has(job.step) || await copySignedIn(env, job)) {
    return fail("copy_signed_in", "The copy already signed in, so it can't be cancelled now. Delete it from its card if you don't want it.", 409);
  }
  await requestJobCancel(env, job.job_id, deps.now);
  // The cancel is done by the runner at the step's end: right away when no step runs now.
  if (deps.provider) await runJob(env, job.job_id, deps, { fromRequest: true });
  return json(copyRecordOf((await readJob(env, job.job_id))!));
}
