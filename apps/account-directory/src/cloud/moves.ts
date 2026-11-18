import {
  CLOUD_FORMER_MACHINE_KEYS_METADATA,
  CLOUD_MACHINE_KEY_METADATA,
  KEEP_AWAKE_STATE_COMMAND,
  MOVE_COPY_STATE_COMMAND,
  MOVE_HOLD_MS,
  MOVE_LOG_TAIL_COMMAND,
  MOVE_SERVE_PORT,
  MOVE_TRANSFER_TIMEOUT_MS,
  MOVE_UNPAUSE_COMMAND,
  PROJECTS_LIST_COMMAND,
  agentWorkOf,
  cloudHoldCommand,
  cloudReleaseHoldCommand,
  formerMachineKeysAfterMove,
  moveArchiveUrl,
  moveCopyStateOf,
  pauseAndServeHomeCommand,
  prepareStopCommand,
  readProjectRoots,
  receiveHomeOnceCommand,
  registerProjectsCommand,
} from "./computerCommands";
import { CLOUD_LANE_METADATA, type CloudMoveKind, type CloudMoveList, type CloudMoveRecord, type CloudMoveState, type CloudTierId } from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, UUID_PATTERN, badRequest, fail, json, readJson } from "./http";
import {
  JOB_RECORD_TTL_MS,
  readJob,
  registerJobKind,
  requestJobCancel,
  runCloudJobs,
  runJob,
  type CloudJobDeps,
  type JobContext,
  type JobRow,
  type StepResult,
} from "./jobs";
import { machineLaunchMinVersion, readLaunch, startMachineLaunch } from "./launches";
import { deleteBackupsWithComputer } from "./laneBackups";
import { cloudSizeFor, cloudSizeForTier, isMeteredStatus, type CloudSize } from "./plans";
import { CloudProviderError } from "./provider";
import { deleteComputer, logCloud, ownedComputer, reportCloudFailure, statusChangeStatements, type CloudEnv, type ComputerRow } from "./store";
import { readUpdateChannel } from "./updates";

/**
 * A computer moved to the other kind (Standard ↔ Full), run by the server so
 * it needs no ADE app open (`POST /cloud/instances/:id/move`). The provider
 * can't change a computer's type, so a move makes a new computer of the
 * other kind that only signs in (a `machine` launch), copies the old one's
 * home folder into it, registers its projects, deletes the old one and gives
 * the new one its name. The steps, one or two a cron tick (`jobs.ts`):
 *
 *   wait_idle (timing `idle` only) → make → join → wake → save → serve →
 *   receive → copy → register → delete_source → confirm_delete → rename → done
 *
 * Until the old computer is deleted, a failure (or a cancel, before the copy
 * starts) lets the old computer's ADE start again and deletes the new one.
 * The old computer is never deleted before the copy is in.
 */

export const MOVE_JOB_KIND = "move";

/** The person's sentences when a move refuses. */
const SERVER_MOVE_UNAVAILABLE = "server_move_unavailable";
const SERVER_MOVE_UNAVAILABLE_MESSAGE = "Moving a computer from here needs the next ADE update. Try again after it ships.";

/** How long each wait may last before the move gives up. */
const IDLE_WAIT_MAX_MS = 24 * 60 * 60_000;
const JOIN_WAIT_MAX_MS = 60 * 60_000;
const WAKE_WAIT_MAX_MS = 10 * 60_000;
const DELETE_CONFIRM_MAX_MS = 3 * 60_000;
const DELETE_TRIES = 3;
/** How often each wait looks again. */
const IDLE_POLL_MS = 60_000;
const JOIN_POLL_MS = 10_000;
const APPROVAL_POLL_MS = 5_000;
const WAKE_POLL_MS = 10_000;
const COPY_POLL_MS = 15_000;
const DELETE_RETRY_MS = 30_000;
const DELETE_CONFIRM_POLL_MS = 10_000;
/** Every command the move runs on a computer is bounded. */
const EXEC_MS = 60_000;
const SAVE_EXEC_MS = 90_000;
const SHORT_EXEC_MS = 30_000;
/** The signed link to the old computer's files: long enough for the longest copy. */
const SERVE_LINK_TTL_S = 3_600;

/** A computer's launch still running on it: a move would race its setup. */
const LAUNCH_BUSY_STATES = ["making", "joining", "needs_approval", "joined", "waiting_for_sign_in", "running"];
const LAUNCH_BUSY_WINDOW_MS = 2 * 60 * 60_000;
/** The steps a cancel may still stop: nothing of the old computer is paused yet. */
const CANCELLABLE_STEPS: ReadonlySet<string> = new Set(["wait_idle", "make", "join", "wake", "save"]);
/** The newest records `GET /cloud/moves` answers. */
const LIST_LIMIT = 20;
const LIST_FINISHED_MS = 24 * 60 * 60_000;

type MoveParams = {
  to: CloudMoveKind;
  /** The new computer's size. */
  type: "default" | "vm";
  cpu: number;
  memoryGb: number;
  timing: "now" | "idle";
  save: boolean;
};

type MoveFacts = {
  /** The new computer's name until it takes the old one's. */
  targetName?: string;
  /** The projects on the old computer, read before it is paused. */
  projects?: string[];
  /** Whether the old computer was asleep when the move began (nothing running to stop). */
  sourceWasAsleep?: boolean;
  wakeAskedAt?: number;
  /** Set before the pause: an undo lets the old computer's ADE start again. */
  pausedAt?: number;
  sourceHeld?: boolean;
  copyStartedAt?: number;
  transferMs?: number;
  deleteTries?: number;
  /** What didn't go quite right, for the end's sentence and the log. */
  warnings?: string[];
};

const kindLabel = (to: CloudMoveKind): string => (to === "full" ? "full computer" : "standard computer");
const typeOf = (to: CloudMoveKind): "default" | "vm" => (to === "full" ? "vm" : "default");

function paramsOf(job: JobRow): MoveParams {
  const raw = (job.params_json ? JSON.parse(job.params_json) : {}) as Partial<MoveParams>;
  const to: CloudMoveKind = raw.to === "standard" ? "standard" : "full";
  return {
    to,
    type: raw.type === "vm" || raw.type === "default" ? raw.type : typeOf(to),
    cpu: typeof raw.cpu === "number" ? raw.cpu : 2,
    memoryGb: typeof raw.memoryGb === "number" ? raw.memoryGb : 4,
    timing: raw.timing === "idle" ? "idle" : "now",
    save: raw.save !== false,
  };
}

function factsOf(job: JobRow): MoveFacts {
  try {
    return (job.facts_json ? JSON.parse(job.facts_json) : {}) as MoveFacts;
  } catch {
    return {};
  }
}

const withFacts = (job: JobRow, patch: Partial<MoveFacts>): string => JSON.stringify({ ...factsOf(job), ...patch });
const sourceNameOf = (job: JobRow): string => job.source_name || job.source_instance_id || "the computer";
const sizeOf = (params: MoveParams): CloudSize | null => cloudSizeFor(params.type, params.cpu, params.memoryGb);

/* ---- The record ---- */

export function moveRecordOf(job: JobRow): CloudMoveRecord {
  const params = paramsOf(job);
  const facts = factsOf(job);
  const finished = job.state === "done" || job.state === "failed" || job.state === "cancelled";
  return {
    moveId: job.job_id,
    sourceInstanceId: job.source_instance_id ?? "",
    sourceName: sourceNameOf(job),
    targetInstanceId: job.target_instance_id,
    to: params.to,
    sizeId: sizeOf(params)?.tier ?? null,
    state: job.state as CloudMoveState,
    message: job.message ?? "",
    approvalUrl: job.state === "needs_approval" ? job.approval_url : null,
    error: job.state === "failed" ? job.error : null,
    sourceDeleted: job.source_deleted == null ? null : job.source_deleted === 1,
    targetMachineKey: job.target_machine_key,
    sourceMachineKey: job.source_machine_key,
    projects: facts.projects ?? [],
    cancellable: !finished && job.cancel_requested_at == null && CANCELLABLE_STEPS.has(job.step),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

/* ---- The steps ---- */

const copyingMessage = (job: JobRow, to: CloudMoveKind) => `Copying ${sourceNameOf(job)}'s files to the new ${kindLabel(to)}…`;

/** The old computer's row, or null when it left the account mid-move (`SOURCE_GONE`). */
async function sourceOf(env: CloudEnv, job: JobRow): Promise<ComputerRow | null> {
  return job.source_instance_id ? await ownedComputer(env, job.user_id, job.source_instance_id) : null;
}

const SOURCE_GONE: StepResult = { kind: "fail", error: "it's no longer on your account." };

/** A command on a computer, its answer or null when it couldn't run (the caller decides what that means). */
async function tryExec(ctx: JobContext, instanceId: string, command: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string } | null> {
  try {
    return await ctx.provider.exec(instanceId, command, timeoutMs);
  } catch (error) {
    logCloud("cloud.move_exec_failed", { instanceId, code: error instanceof CloudProviderError ? error.code : "unknown" });
    return null;
  }
}

async function waitIdle(env: CloudEnv, job: JobRow, ctx: JobContext, params: MoveParams): Promise<StepResult> {
  const source = await sourceOf(env, job);
  if (!source) return SOURCE_GONE;
  const next: StepResult = { kind: "next", step: "make", patch: { state: "making", message: `Making the new ${kindLabel(params.to)}…` } };
  const instance = await ctx.provider.getInstance(source.instance_id);
  if (instance.status !== "running") return next;
  const read = await tryExec(ctx, source.instance_id, KEEP_AWAKE_STATE_COMMAND, SHORT_EXEC_MS);
  // Unreadable counts as busy, as the desktop's own wait reads it.
  if (read && agentWorkOf(read.stdout) === "idle") return next;
  if (ctx.now - job.created_at > IDLE_WAIT_MAX_MS) return { kind: "fail", error: "the agent didn't finish within a day. Move it now, or try again later." };
  return { kind: "wait", delayMs: IDLE_POLL_MS };
}

async function make(env: CloudEnv, job: JobRow, ctx: JobContext, params: MoveParams): Promise<StepResult> {
  const source = await sourceOf(env, job);
  if (!source) return SOURCE_GONE;
  const size = sizeOf(params);
  if (!size || !job.target_launch_id) return { kind: "fail", error: "that size isn't one ADE Cloud offers." };
  const instance = await ctx.provider.getInstance(source.instance_id);
  const sourceKey = job.source_machine_key ?? instance.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null;
  // The lane moves with its computer: pickers, the dashboard and a later delete read it from here with no wake.
  const metadata: Record<string, string> = {};
  for (const key of Object.values(CLOUD_LANE_METADATA)) {
    const value = instance.metadata[key];
    if (typeof value === "string" && value) metadata[key] = value;
  }
  metadata.ade_moved_from = source.instance_id;
  metadata.ade_move_id = job.job_id;
  metadata.ade_made_by = "person";
  const formerKeys = formerMachineKeysAfterMove(instance.metadata, sourceKey);
  if (formerKeys) metadata[CLOUD_FORMER_MACHINE_KEYS_METADATA] = formerKeys;
  const targetName = factsOf(job).targetName ?? `${sourceNameOf(job).slice(0, 40)} (${params.to === "full" ? "Full" : "Standard"})`;
  const answer = await startMachineLaunch(env, job.user_id, {
    launchId: job.target_launch_id,
    size,
    name: targetName,
    channel: readUpdateChannel(source.channel),
    moveFromInstanceId: source.instance_id,
    metadata,
  }, {
    provider: ctx.provider,
    now: ctx.now,
    createComputer: ctx.deps.createComputer,
  });
  const body = await answer.json().catch(() => null) as { instanceId?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  if (answer.status === 409 && body?.error?.code === "create_in_progress") return { kind: "wait", delayMs: JOIN_POLL_MS };
  if (!answer.ok) {
    const why = typeof body?.error?.message === "string" ? body.error.message : "ADE Cloud couldn't make the new computer.";
    return { kind: "fail", error: why };
  }
  const instanceId = typeof body?.instanceId === "string" ? body.instanceId : null;
  if (!instanceId) return { kind: "wait", delayMs: JOIN_POLL_MS };
  return {
    kind: "next",
    step: "join",
    patch: {
      target_instance_id: instanceId,
      state: "joining",
      message: `Signing in the new ${kindLabel(params.to)}…`,
      facts_json: withFacts(job, { targetName, sourceWasAsleep: !isMeteredStatus(source.status) }),
    },
  };
}

async function join(env: CloudEnv, job: JobRow, ctx: JobContext, params: MoveParams): Promise<StepResult> {
  const launch = job.target_launch_id ? await readLaunch(env, job.target_launch_id) : null;
  if (!launch) return { kind: "fail", error: "the new computer's launch is gone." };
  if (launch.state === "failed" || launch.state === "cancelled") return { kind: "fail", error: "the new computer didn't sign in." };
  const started = job.step_started_at ?? job.created_at;
  if (ctx.now - started > JOIN_WAIT_MAX_MS) return { kind: "fail", error: "the new computer didn't sign in in time." };
  if (launch.state === "needs_approval") {
    return {
      kind: "wait",
      delayMs: APPROVAL_POLL_MS,
      patch: { state: "needs_approval", approval_url: launch.approval_url, message: "Approve the new computer's sign-in to go on." },
    };
  }
  if (launch.state !== "done") {
    return { kind: "wait", delayMs: JOIN_POLL_MS, patch: { state: "joining", approval_url: null, message: `Signing in the new ${kindLabel(params.to)}…` } };
  }
  // Signed in: its account key is on its row (the brain wrote it before it reported done).
  const target = job.target_instance_id ? await ownedComputer(env, job.user_id, job.target_instance_id) : null;
  if (!target) return { kind: "fail", error: "the new computer is gone." };
  let machineKey = target.machine_key;
  if (!machineKey) machineKey = (await ctx.provider.getInstance(target.instance_id)).metadata[CLOUD_MACHINE_KEY_METADATA] ?? null;
  if (!machineKey) return { kind: "wait", delayMs: JOIN_POLL_MS };
  // Its brain, idle until the copy lands, must not put it to sleep meanwhile.
  await tryExec(ctx, target.instance_id, cloudHoldCommand("move", MOVE_HOLD_MS), SHORT_EXEC_MS);
  return {
    kind: "next",
    step: "wake",
    patch: { target_machine_key: machineKey, approval_url: null, state: "copying", message: `Getting ${sourceNameOf(job)} ready to copy…` },
  };
}

async function wake(env: CloudEnv, job: JobRow, ctx: JobContext, params: MoveParams): Promise<StepResult> {
  const source = await sourceOf(env, job);
  if (!source) return SOURCE_GONE;
  const facts = factsOf(job);
  const instance = await ctx.provider.getInstance(source.instance_id);
  if (instance.status !== source.status) {
    const statements = statusChangeStatements(env, source, instance.status, ctx.now, "move");
    if (statements.length) await env.DB.batch(statements);
  }
  if (instance.status === "running") {
    // Its own brain must not sleep it before the pause.
    await tryExec(ctx, source.instance_id, cloudHoldCommand("move", MOVE_HOLD_MS), SHORT_EXEC_MS);
    const save = params.save && !facts.sourceWasAsleep;
    return {
      kind: "next",
      step: save ? "save" : "serve",
      patch: { facts_json: withFacts(job, { sourceHeld: true }), message: save ? `Saving ${sourceNameOf(job)}'s chats…` : copyingMessage(job, params.to) },
    };
  }
  if (instance.status === "failed") return { kind: "fail", error: "it didn't wake up." };
  const started = job.step_started_at ?? ctx.now;
  if (ctx.now - started > WAKE_WAIT_MAX_MS) return { kind: "fail", error: "it didn't wake up in time." };
  const waking = instance.status === "starting" || instance.status === "waking" || instance.status === "creating";
  if (!waking && facts.wakeAskedAt == null) {
    // Noted first: a tick that dies after the ask doesn't ask twice.
    await ctx.save({ facts_json: withFacts(job, { wakeAskedAt: ctx.now }) });
    const status = await ctx.provider.startInstance(source.instance_id);
    const statements = statusChangeStatements(env, source, status, ctx.now, "move");
    if (statements.length) await env.DB.batch(statements);
    return { kind: "wait", delayMs: WAKE_POLL_MS, patch: { facts_json: withFacts(job, { wakeAskedAt: ctx.now }), message: `Waking ${sourceNameOf(job)}…` } };
  }
  return { kind: "wait", delayMs: WAKE_POLL_MS, patch: { message: `Waking ${sourceNameOf(job)}…` } };
}

async function save(job: JobRow, ctx: JobContext, params: MoveParams): Promise<StepResult> {
  const facts = factsOf(job);
  // Stops what still runs and writes the saved chat copy, so the chats read the same while it moves.
  const ran = await tryExec(ctx, job.source_instance_id!, prepareStopCommand(null), SAVE_EXEC_MS);
  const warnings = ran?.exitCode === 0 ? facts.warnings : [...(facts.warnings ?? []), "save"];
  return { kind: "next", step: "serve", patch: { facts_json: withFacts(job, { warnings }), message: copyingMessage(job, params.to) } };
}

async function serve(job: JobRow, ctx: JobContext, params: MoveParams): Promise<StepResult> {
  const sourceId = job.source_instance_id!;
  let facts = factsOf(job);
  if (!facts.projects) {
    // Read while its ADE still runs; the pause below stops it.
    const listed = await tryExec(ctx, sourceId, PROJECTS_LIST_COMMAND, EXEC_MS);
    if (!listed) throw new Error("ADE couldn't read the old computer's projects.");
    facts = { ...facts, projects: readProjectRoots(listed.stdout) };
  }
  // Noted before the pause: whatever happens next, an undo lets its ADE start again.
  facts = { ...facts, pausedAt: facts.pausedAt ?? ctx.now };
  await ctx.save({ facts_json: JSON.stringify(facts) });
  const paused = await ctx.provider.exec(sourceId, pauseAndServeHomeCommand(MOVE_SERVE_PORT), EXEC_MS);
  if (!/started/.test(paused.stdout)) return { kind: "fail", error: "the old computer didn't start handing its files over." };
  return { kind: "next", step: "receive", patch: { facts_json: JSON.stringify(facts), message: copyingMessage(job, params.to) } };
}

async function receive(job: JobRow, ctx: JobContext): Promise<StepResult> {
  // The link is made here and handed straight to the new computer: never kept, never logged.
  const signed = await ctx.provider.signedUrl(job.source_instance_id!, { port: MOVE_SERVE_PORT, ttlSeconds: SERVE_LINK_TTL_S });
  const facts = factsOf(job);
  const copyStartedAt = facts.copyStartedAt ?? ctx.now;
  await ctx.save({ facts_json: withFacts(job, { copyStartedAt }) });
  const started = await ctx.provider.exec(job.target_instance_id!, `${cloudHoldCommand("move", MOVE_HOLD_MS)}\n${receiveHomeOnceCommand(moveArchiveUrl(signed.url))}`, EXEC_MS);
  if (!/started/.test(started.stdout)) return { kind: "fail", error: "the new computer didn't start copying the files." };
  return { kind: "next", step: "copy", delayMs: COPY_POLL_MS, patch: { facts_json: withFacts(job, { copyStartedAt }) } };
}

async function copy(job: JobRow, ctx: JobContext): Promise<StepResult> {
  const facts = factsOf(job);
  const started = facts.copyStartedAt ?? job.step_started_at ?? ctx.now;
  const read = await tryExec(ctx, job.target_instance_id!, MOVE_COPY_STATE_COMMAND, SHORT_EXEC_MS);
  const state = read ? moveCopyStateOf(read.stdout) : { kind: "running" as const };
  // The pull never started (the answer to its start was lost before it ran): start it again.
  if (state.kind === "not_started") return { kind: "next", step: "receive" };
  if (state.kind === "running") {
    if (ctx.now - started > MOVE_TRANSFER_TIMEOUT_MS) return { kind: "fail", error: "copying the files took too long." };
    return { kind: "wait", delayMs: COPY_POLL_MS };
  }
  if (state.code !== 0) {
    const tail = (await tryExec(ctx, job.target_instance_id!, MOVE_LOG_TAIL_COMMAND, SHORT_EXEC_MS))?.stdout.trim() ?? "";
    return { kind: "fail", error: `copying the files failed (exit ${state.code})${tail ? `: ${tail.slice(-300)}` : "."}` };
  }
  const transferMs = Math.max(0, ctx.now - started);
  logCloud("cloud.move_copied", { jobId: job.job_id, sourceId: job.source_instance_id, instanceId: job.target_instance_id, transferMs });
  return { kind: "next", step: "register", patch: { facts_json: withFacts(job, { transferMs }), state: "finishing", message: "Finishing the move…" } };
}

async function register(job: JobRow, ctx: JobContext): Promise<StepResult> {
  const facts = factsOf(job);
  const targetId = job.target_instance_id!;
  let warnings = facts.warnings;
  if (facts.projects?.length) {
    const added = await tryExec(ctx, targetId, registerProjectsCommand(facts.projects), EXEC_MS);
    if (!added || /^failed /m.test(added.stdout)) warnings = [...(warnings ?? []), "projects"];
  }
  // The move's work on the new computer is done: it may sleep when idle again.
  await tryExec(ctx, targetId, cloudReleaseHoldCommand("move"), SHORT_EXEC_MS);
  return { kind: "next", step: "delete_source", patch: { state: "finishing", facts_json: withFacts(job, { warnings }) } };
}

/** The old computer is kept (its delete failed): its ADE starts again, and the move is done without it gone. */
async function keepSource(job: JobRow, ctx: JobContext, params: MoveParams): Promise<StepResult> {
  await tryExec(ctx, job.source_instance_id!, `${MOVE_UNPAUSE_COMMAND}\n${cloudReleaseHoldCommand("move")}`, SHORT_EXEC_MS);
  reportCloudFailure("cloud.move_source_left", { jobId: job.job_id, sourceId: job.source_instance_id });
  return {
    kind: "end",
    patch: {
      state: "done",
      source_deleted: 0,
      message: `Moved ${sourceNameOf(job)} to a ${kindLabel(params.to)}. The old computer couldn't be deleted, so it's still there. Delete it from its card.`,
    },
  };
}

async function deleteSource(env: CloudEnv, job: JobRow, ctx: JobContext, params: MoveParams): Promise<StepResult> {
  const source = job.source_instance_id ? await ownedComputer(env, job.user_id, job.source_instance_id) : null;
  if (!source) return { kind: "next", step: "confirm_delete", patch: { source_deleted: 1 } };
  const facts = factsOf(job);
  try {
    await deleteComputer(env, ctx.provider, source, { who: "move", reason: "moved" }, ctx.now);
  } catch (error) {
    const tries = (facts.deleteTries ?? 0) + 1;
    logCloud("cloud.move_source_delete_failed", { jobId: job.job_id, tries, code: error instanceof CloudProviderError ? error.code : "unknown" });
    if (tries >= DELETE_TRIES) return await keepSource(job, ctx, params);
    return { kind: "wait", delayMs: DELETE_RETRY_MS, patch: { facts_json: withFacts(job, { deleteTries: tries }) } };
  }
  // Its backups go with its machine key; the lane's stay (the new computer holds the lane now).
  await deleteBackupsWithComputer(env, source, false).catch((error: unknown) =>
    reportCloudFailure("cloud.move_backups_left", { jobId: job.job_id, message: error instanceof Error ? error.message : "unknown" }));
  return { kind: "next", step: "confirm_delete", patch: { source_deleted: 1 } };
}

async function confirmDelete(job: JobRow, ctx: JobContext): Promise<StepResult> {
  const next: StepResult = { kind: "next", step: "rename" };
  try {
    const instance = await ctx.provider.getInstance(job.source_instance_id!);
    if (instance.status === "deleted" || instance.status === "deleting") return next;
  } catch (error) {
    if (error instanceof CloudProviderError && error.status === 404) return next;
    throw error;
  }
  const started = job.step_started_at ?? ctx.now;
  if (ctx.now - started > DELETE_CONFIRM_MAX_MS) {
    // The provider took the delete; its row here is closed. Logged for the owner, never a failed move.
    reportCloudFailure("cloud.move_source_delete_unconfirmed", { jobId: job.job_id, sourceId: job.source_instance_id });
    return next;
  }
  await ctx.provider.deleteInstance(job.source_instance_id!).catch(() => undefined);
  return { kind: "wait", delayMs: DELETE_CONFIRM_POLL_MS };
}

async function rename(env: CloudEnv, job: JobRow, ctx: JobContext, params: MoveParams): Promise<StepResult> {
  const name = sourceNameOf(job);
  const targetId = job.target_instance_id!;
  let renamed = true;
  try {
    await ctx.provider.setInstanceName(targetId, name);
    await env.DB.prepare("update cloud_computers set name = ? where instance_id = ?").bind(name, targetId).run();
  } catch (error) {
    renamed = false;
    logCloud("cloud.move_rename_failed", { jobId: job.job_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
  }
  if (job.target_machine_key) {
    await env.DB.prepare("update machines set custom_name = ? where user_id = ? and machine_key = ?").bind(name, job.user_id, job.target_machine_key).run();
  }
  const facts = factsOf(job);
  logCloud("cloud.machine_moved", { jobId: job.job_id, sourceId: job.source_instance_id, instanceId: targetId, to: params.to, transferMs: facts.transferMs ?? null, warnings: facts.warnings ?? [], renamed });
  const notes = [
    facts.warnings?.includes("projects") ? " Some projects didn't open there; add them again in ADE." : "",
    renamed ? "" : ` It's named ${facts.targetName ?? "the new computer"} for now.`,
  ].join("");
  return { kind: "end", patch: { state: "done", message: `Moved ${name} to a ${kindLabel(params.to)}.${notes}` } };
}

async function runMoveStep(env: CloudEnv, job: JobRow, ctx: JobContext): Promise<StepResult> {
  const params = paramsOf(job);
  switch (job.step) {
    case "wait_idle": return await waitIdle(env, job, ctx, params);
    case "make": return await make(env, job, ctx, params);
    case "join": return await join(env, job, ctx, params);
    case "wake": return await wake(env, job, ctx, params);
    case "save": return await save(job, ctx, params);
    case "serve": return await serve(job, ctx, params);
    case "receive": return await receive(job, ctx);
    case "copy": return await copy(job, ctx);
    case "register": return await register(job, ctx);
    case "delete_source": return await deleteSource(env, job, ctx, params);
    case "confirm_delete": return await confirmDelete(job, ctx);
    case "rename": return await rename(env, job, ctx, params);
    default: return { kind: "fail", error: "ADE Cloud lost track of this move." };
  }
}

/** The sentence's end once the undo ran: what is left as it was. */
function asWasSentence(job: JobRow): string {
  const name = sourceNameOf(job);
  return job.target_instance_id ? `${name} is as it was, and the new computer was deleted.` : `${name} is as it was.`;
}

/**
 * Undoes a move that stopped before its old computer was deleted: lets the
 * old computer's ADE start again, ends the new computer's launch, deletes the
 * new computer (its account machine row goes with it). False while a delete
 * still has to be tried again.
 */
async function undoMove(env: CloudEnv, job: JobRow, ctx: JobContext): Promise<boolean> {
  if (job.source_deleted === 1) return true;
  const facts = factsOf(job);
  if (job.source_instance_id && (facts.pausedAt != null || facts.sourceHeld)) {
    // The entrypoint clears a pause two hours old by itself, so one this misses comes back on its own.
    await tryExec(ctx, job.source_instance_id, `${MOVE_UNPAUSE_COMMAND}\n${cloudReleaseHoldCommand("move")}`, SHORT_EXEC_MS);
  }
  let targetId = job.target_instance_id;
  if (job.target_launch_id) {
    // Closed first: a create still in flight for it deletes what it made, and its computer's reports are refused.
    const launch = await env.DB.prepare(`
      update cloud_launches set state = 'cancelled', approval_url = null, sign_in_json = null, updated_at = ?
      where launch_id = ? and state not in ('done', 'cancelled', 'failed') returning instance_id
    `).bind(ctx.now, job.target_launch_id).first<{ instance_id: string | null }>();
    targetId = targetId ?? launch?.instance_id ?? (await readLaunch(env, job.target_launch_id))?.instance_id ?? null;
  }
  if (!targetId) return true;
  const target = await ownedComputer(env, job.user_id, targetId);
  if (!target) return true;
  try {
    await deleteComputer(env, ctx.provider, target, { who: "move", reason: "move_failed" }, ctx.now);
    return true;
  } catch (error) {
    logCloud("cloud.move_target_delete_failed", { jobId: job.job_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    return false;
  }
}

registerJobKind(MOVE_JOB_KIND, {
  run: runMoveStep,
  failed: (job, error) => {
    // A refusal's own sentence ("That size isn't…") reads on after the colon; ADE's name keeps its capital.
    const why = /^ADE\b/.test(error) ? error : `${error.charAt(0).toLowerCase()}${error.slice(1)}`;
    const sentence = `ADE couldn't move ${sourceNameOf(job)}: ${/[.!?…]$/.test(why) ? why : `${why}.`} ${asWasSentence(job)}`;
    return { state: "failed", message: sentence, error: sentence, approval_url: null };
  },
  undo: (env, job, ctx) => undoMove(env, job, ctx),
  cancellable: (step) => CANCELLABLE_STEPS.has(step),
  cancelled: (job) => ({ state: "cancelled", message: `The move was cancelled. ${sourceNameOf(job)} is as it was.`, approval_url: null }),
});

/* ---- The routes ---- */

/** What the move route needs from routes.ts (passed in, so neither module imports the other). */
export type MoveRouteDeps = CloudJobDeps & {
  now: number;
  waitUntil?: (promise: Promise<unknown>) => void;
  /** The plan's and the account's rules for a move of `source` to `size`: hours, disk, the owner's limits. */
  refusal: (source: ComputerRow, size: CloudSize) => Promise<Response | null>;
};

const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value.trim().toLowerCase());

async function liveMoveOf(env: CloudEnv, sourceId: string): Promise<JobRow | null> {
  return await env.DB.prepare("select * from cloud_jobs where kind = ? and source_instance_id = ? and state not in ('done', 'failed', 'cancelled') limit 1")
    .bind(MOVE_JOB_KIND, sourceId).first<JobRow>();
}

/** The size a move makes: the one asked for (of the new kind), else the same CPU and memory, else the smallest. */
function moveSizeOf(source: ComputerRow, to: CloudMoveKind, sizeId: unknown, resources: unknown): CloudSize | string {
  const type = typeOf(to);
  if (sizeId != null) {
    const asked = cloudSizeForTier(sizeId as CloudTierId);
    if (!asked) return "That size isn't one ADE Cloud offers.";
    if (asked.type !== type) return `That size isn't a ${kindLabel(to)}'s.`;
    return asked;
  }
  if (resources != null) {
    const shape = typeof resources === "object" ? resources as { cpu?: unknown; memoryGb?: unknown } : {};
    return cloudSizeFor(type, shape.cpu, shape.memoryGb) ?? `That size isn't a ${kindLabel(to)}'s.`;
  }
  return cloudSizeFor(type, source.cpu, source.memory_gb) ?? cloudSizeFor(type, 2, 4)!;
}

/** `POST /cloud/instances/:id/move`. */
export async function handleMoveStart(request: Request, env: CloudEnv, source: ComputerRow, deps: MoveRouteDeps): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  if (!isUuid(body.moveId)) return badRequest("A move needs a move id (a UUID).");
  const moveId = body.moveId.trim().toLowerCase();
  const { now } = deps;
  // The same move again answers what it is, before any rule: it is not a new move.
  const existing = await readJob(env, moveId);
  if (existing) {
    if (existing.user_id !== source.user_id || existing.kind !== MOVE_JOB_KIND || existing.source_instance_id !== source.instance_id) {
      return badRequest("That move id can't be used.");
    }
    return json(moveRecordOf(existing), 200);
  }
  if (body.origin != null && body.origin !== "person") {
    return fail("person_only", "Only you can move a computer to the other kind. Ask in ADE.", 403);
  }
  const to = body.to === "full" || body.to === "standard" ? body.to : null;
  if (!to) return badRequest("Move it to a standard or a full computer.");
  const timing = body.timing == null ? "now" : body.timing === "now" || body.timing === "idle" ? body.timing : null;
  if (!timing) return badRequest("That timing isn't one ADE knows.");
  if (body.save != null && typeof body.save !== "boolean") return badRequest(UNREADABLE_REQUEST_MESSAGE);
  if (!(await machineLaunchMinVersion(env))) return fail(SERVER_MOVE_UNAVAILABLE, SERVER_MOVE_UNAVAILABLE_MESSAGE, 409);
  if ((source.type === "vm" ? "vm" : "default") === typeOf(to)) {
    return fail("already_that_kind", `It's already a ${kindLabel(to)}. Use Resize to change its size.`, 409);
  }
  const size = moveSizeOf(source, to, body.sizeId, body.resources);
  if (typeof size === "string") return badRequest(size);
  // One move of a computer at a time: a second ask answers the one already running.
  const running = await liveMoveOf(env, source.instance_id);
  if (running) return json(moveRecordOf(running), 200);
  const launching = await env.DB.prepare(`
    select 1 as busy from cloud_launches where instance_id = ? and state in (${LAUNCH_BUSY_STATES.map(() => "?").join(", ")}) and updated_at > ? limit 1
  `).bind(source.instance_id, ...LAUNCH_BUSY_STATES, now - LAUNCH_BUSY_WINDOW_MS).first();
  if (launching) return fail("computer_busy", "This computer is still being set up. Try again when its lane has started.", 409);
  const refused = await deps.refusal(source, size);
  if (refused) return refused;
  if (!deps.provider) return fail("unavailable", "ADE Cloud can't move a computer right now. Try again soon.", 503);

  const params: MoveParams = { to, type: size.type === "vm" ? "vm" : "default", cpu: size.cpu, memoryGb: size.memoryGb, timing, save: body.save !== false };
  const firstStep = timing === "idle" ? "wait_idle" : "make";
  const message = timing === "idle" ? `Waiting for ${source.name ?? source.instance_id}'s agents to finish…` : `Making the new ${kindLabel(to)}…`;
  try {
    await env.DB.prepare(`
      insert into cloud_jobs (job_id, kind, user_id, source_instance_id, source_name, source_machine_key, target_launch_id, params_json, state, step, message,
        facts_json, next_at, created_at, updated_at, expires_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, 'making', ?, ?, '{}', ?, ?, ?, ?)
    `).bind(
      moveId, MOVE_JOB_KIND, source.user_id, source.instance_id, source.name ?? source.instance_id, source.machine_key, crypto.randomUUID(),
      JSON.stringify(params), firstStep, message, now, now, now, now + JOB_RECORD_TTL_MS,
    ).run();
  } catch (error) {
    // Another ask for this computer got in first (one live job per computer), or the same id did.
    const winner = await readJob(env, moveId) ?? await liveMoveOf(env, source.instance_id);
    if (winner && winner.user_id === source.user_id) return json(moveRecordOf(winner), 200);
    throw error;
  }
  logCloud("cloud.move_started", { userId: source.user_id, jobId: moveId, sourceId: source.instance_id, to, timing });
  // The first step right after the answer; the minute cron runs it otherwise (and every later one).
  if (deps.waitUntil) deps.waitUntil(runJob(env, moveId, deps, { fromRequest: true }).catch(() => undefined));
  return json(moveRecordOf((await readJob(env, moveId))!), 201);
}

/** `GET /cloud/moves`, `GET /cloud/moves/:id`, `DELETE /cloud/moves/:id`. Rows only, but a cancel. */
export async function routeMoves(request: Request, path: string, env: CloudEnv, userId: string, deps: Pick<MoveRouteDeps, "now" | "waitUntil" | "provider" | "createComputer">): Promise<Response> {
  const notFound = () => fail("not_found", "ADE Cloud has no such move.", 404);
  if (path === "/cloud/moves") {
    if (request.method !== "GET") return notFound();
    const rows = (await env.DB.prepare(`
      select * from cloud_jobs where user_id = ? and kind = ? and (state not in ('done', 'failed', 'cancelled') or updated_at > ?)
      order by created_at desc limit ?
    `).bind(userId, MOVE_JOB_KIND, deps.now - LIST_FINISHED_MS, LIST_LIMIT).all<JobRow>()).results ?? [];
    return json({ moves: rows.map(moveRecordOf) } satisfies CloudMoveList);
  }
  const moveId = path.slice("/cloud/moves/".length);
  if (!isUuid(moveId)) return notFound();
  const job = await readJob(env, moveId.toLowerCase());
  if (!job || job.user_id !== userId || job.kind !== MOVE_JOB_KIND) return notFound();
  if (request.method === "GET") return json(moveRecordOf(job));
  if (request.method !== "DELETE") return notFound();
  if (job.state === "cancelled") return json(moveRecordOf(job));
  if (job.state === "done" || job.state === "failed" || !CANCELLABLE_STEPS.has(job.step)) {
    return fail("move_started", "The copy already started, so the move can't be cancelled now.", 409);
  }
  await requestJobCancel(env, job.job_id, deps.now);
  // The cancel is done by the runner at the step's end: right away when no step runs now.
  if (deps.provider) await runJob(env, job.job_id, { provider: deps.provider, createComputer: deps.createComputer }, { fromRequest: true });
  return json(moveRecordOf((await readJob(env, job.job_id))!));
}

/** The minute cron's share of moves (and every later job kind). */
export async function runCloudMoves(env: CloudEnv, deps: CloudJobDeps): Promise<number> {
  return await runCloudJobs(env, deps);
}
