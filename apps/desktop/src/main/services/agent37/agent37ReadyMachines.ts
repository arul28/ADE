/**
 * "Keep a cloud machine ready": for each project the person turned it on for,
 * keep one Agent37 machine prepared and asleep, so a new chat on it is working
 * in seconds (the same idea as a prepared seed: the repository cloned, its
 * setup run, its services started, signed in, then frozen).
 *
 * Preparing runs here, in the desktop, because signing a new machine in uses
 * the approval window (`createAgent37Machine`). Claiming does not, and lives
 * in agent37ReadyClaim.ts, which the brain uses too. They agree through
 * Agent37 itself: each machine's metadata says which project it is for and
 * whether it is preparing, ready, claimed or failed, so a claim from the CLI
 * on any computer is seen here on the next pass and the next machine is made.
 *
 *   1. Make the machine from ADE's template and sign it in (the A1 flow),
 *      tagged `preparing` for the project.
 *   2. Hand the box its setup: clone over HTTPS, register the project with
 *      the box's ADE, run the person's setup commands. The template's
 *      entrypoint runs it (`$ADE_HOME/ready/job.sh`), so what it starts is part
 *      of the entrypoint's process tree and survives sleep.
 *   3. Tag it `ready` and put it to sleep. Asleep it bills only its disk.
 *
 * A failure deletes the machine (a half-prepared machine is only a bill) and
 * waits for Retry: ADE never loops on something that costs money. Turning
 * the project off deletes its unclaimed machine. A claimed machine is the
 * person's and is never touched here.
 *
 * Fork vs create: the coordinator measured a fork of a warm VM at 167 s (it
 * copies the disk, boots fresh, and comes up signed out by design) against a
 * 93 s cold bring-up of the same stack, so the next machine is made fresh.
 */

import { randomUUID } from "node:crypto";
import {
  AGENT37_READY_METADATA,
  agent37ReadyRetryAt,
  agent37Shape,
  type Agent37ReadyFailure,
  type Agent37CreateMachineArgs,
  type Agent37CreateMachineResult,
  type Agent37CreateProgress,
  type Agent37ReadyProjectSettings,
  type Agent37ReadyProjectStatus,
  type Agent37ReadyStatus,
} from "../../../shared/agent37";
import type { Agent37Client, Agent37Instance, Agent37Logger } from "./agent37Client";
import { getErrorMessage } from "../shared/utils";
import { agent37ReadyMachinesFor, agent37ReadyStateOf, patchAgent37Metadata } from "./agent37ReadyClaim";
import { AGENT37_MACHINE_KEY_METADATA } from "./agent37Machines";
import { compareUpdateVersions } from "../../../shared/updateVersions";
import { deleteAgent37InstanceConfirmed } from "./agent37PendingCreates";
import {
  agent37ReadyCloneUrl,
  agent37ReadyFolderName,
  normalizeAgent37ReadySettings,
  type Agent37ReadySettingsStore,
} from "./agent37ReadySettings";

export type Agent37ReadyKeeperDeps = {
  client: () => Promise<Agent37Client | null>;
  settings: Agent37ReadySettingsStore;
  /** `createAgent37Machine` with this computer's sign-in window and account. */
  createMachine: (
    requestId: string,
    machine: Agent37CreateMachineArgs,
    onProgress: (progress: Agent37CreateProgress) => void,
    options: { signal: AbortSignal; metadata: Record<string, string> },
  ) => Promise<Agent37CreateMachineResult>;
  /** Takes a deleted machine's row off the ADE account. */
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  /**
   * This copy of ADE, stable across restarts and distinct from another copy
   * on the same computer. A machine it was preparing when it quit is its own
   * leftover, deleted on the next pass instead of billing until it goes stale.
   */
  preparerId: string;
  /**
   * The ADE release the template installs, once it is built and current; null
   * while unknown or building. An unclaimed ready machine from another release
   * is replaced, so a ready machine runs the same ADE as the desktop that keeps it.
   */
  templateAdeVersion?: () => string | null;
  onStatus?: (status: Agent37ReadyStatus) => void;
  /** A prepare ended: the machine is ready, or it failed (a cancel is neither). */
  onPrepared?: (outcome: "completed" | "failed") => void;
  logger?: Agent37Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** How often the pool is read while any project keeps a machine ready (a claim elsewhere shows up within this). */
const POOL_PASS_MS = 2 * 60_000;
/** Longer than any setup ADE waits for: a machine still `preparing` after this was left by a quit. */
const PREPARING_STALE_MS = 60 * 60_000;
/** The person's setup: clone, install, pull images, start. A cold Supabase stack took 93 s. */
const SETUP_TIMEOUT_MS = 30 * 60_000;
const SETUP_POLL_MS = 3_000;
/** A template without the job runner never marks the job started; this long means it has none. */
const RUNNER_START_GRACE_MS = 20_000;
const LOG_TAIL_LINES = 6;

/** `'…'` for sh, whatever the text holds. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * The box's setup job. Runs under `sh -e` from the home folder: clone (kept
 * if already there), register the project with the box's ADE so a chat finds
 * it by its origin, wait for Docker on a VM, then the person's commands in the
 * clone.
 */
export function buildAgent37ReadySetupScript(settings: Pick<Agent37ReadyProjectSettings, "identity" | "setup">): string {
  const folder = agent37ReadyFolderName(settings.identity);
  const lines = [
    "set -e",
    `dir="$HOME/${folder}"`,
    `echo "${READY_PATH_MARKER}$dir"`,
    'if [ ! -d "$dir/.git" ]; then',
    `  GIT_TERMINAL_PROMPT=0 git clone ${shellQuote(agent37ReadyCloneUrl(settings.identity))} "$dir"`
      + ' || { echo "ADE couldn\'t clone the repository. A private repository needs a Git sign-in on the machine." >&2; exit 1; }',
    "fi",
    'cd "$dir"',
    'ade projects add "$dir" >/dev/null',
    // Docker starts in the background at boot (VMs only); give it a moment before the setup needs it.
    'if command -v docker >/dev/null 2>&1 && [ "$(uname -r)" != "4.4.0" ]; then',
    '  i=0; until docker info >/dev/null 2>&1 || [ $i -ge 30 ]; do sleep 1; i=$((i+1)); done',
    "fi",
  ];
  const setup = settings.setup.trim();
  if (setup) lines.push(setup);
  return lines.join("\n");
}

/** The line the job prints first: where the clone is. */
const READY_PATH_MARKER = "ADE_READY_PATH=";

/** Writes the job where the entrypoint's runner picks it up, clearing any earlier run. */
function writeJobCommand(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return [
    'jobs="$ADE_HOME/ready"',
    'mkdir -p "$jobs"',
    'rm -f "$jobs/job.started" "$jobs/job.exit" "$jobs/job.log" "$jobs/job.sh"',
    `printf %s ${shellQuote(encoded)} | base64 -d > "$jobs/job.sh.tmp"`,
    'mv "$jobs/job.sh.tmp" "$jobs/job.sh"',
  ].join(" && ");
}

const READ_JOB_COMMAND = [
  'jobs="$ADE_HOME/ready"',
  'printf "started=%s\\n" "$(cat "$jobs/job.started" 2>/dev/null)"',
  'printf "exit=%s\\n" "$(cat "$jobs/job.exit" 2>/dev/null)"',
  `tail -n ${LOG_TAIL_LINES} "$jobs/job.log" 2>/dev/null`,
].join("; ");

type JobRead = { started: boolean; exitCode: number | null; tail: string[] };

function parseJobRead(stdout: string): JobRead {
  const lines = stdout.split("\n");
  const started = /^started=\S+/.test(lines[0] ?? "");
  const exitRaw = /^exit=(\d+)/.exec(lines[1] ?? "")?.[1];
  return {
    started,
    exitCode: exitRaw != null ? Number(exitRaw) : null,
    tail: lines.slice(2).map((line) => line.trimEnd()).filter((line) => line && !line.startsWith(READY_PATH_MARKER)),
  };
}

/**
 * The primary lane on the machine, read from its ADE once the project is
 * registered. Without it a chat there needs `--lane`, so a miss is logged,
 * never fatal.
 */
async function readPrimaryLaneId(
  client: Agent37Client,
  instanceId: string,
  projectPath: string,
  signal: AbortSignal,
  logger: Agent37Logger,
): Promise<string | null> {
  try {
    const answer = await client.exec(instanceId, `cd ${shellQuote(projectPath)} && ade lanes list --json`, { timeoutMs: 30_000, signal });
    const lanes = (JSON.parse(answer.stdout) as { lanes?: Array<{ id?: unknown; laneType?: unknown }> }).lanes ?? [];
    const primary = lanes.find((lane) => lane.laneType === "primary");
    if (typeof primary?.id === "string") return primary.id;
    logger.warn?.("agent37.ready_primary_lane_missing", { instanceId });
  } catch (error) {
    logger.warn?.("agent37.ready_primary_lane_unread", { instanceId, error: getErrorMessage(error) });
  }
  return null;
}

export class Agent37ReadyPrepareCancelled extends Error {
  constructor() {
    super("Stopped: the project no longer keeps a machine ready.");
    this.name = "Agent37ReadyPrepareCancelled";
  }
}

/** The person's setup failed. Its output is shown to them but never logged: it can echo anything. */
class Agent37ReadySetupFailed extends Error {
  constructor(message: string, readonly exitCode: number | null) {
    super(message);
    this.name = "Agent37ReadySetupFailed";
  }
}

type LocalPrepare = {
  controller: AbortController;
  startedAt: number;
  message: string;
  instanceId: string | null;
  machineKey: string | null;
};

/** Why the pass deletes a pool machine, or null to keep it. */
type DiscardReason = "agent37_failed" | "failed" | "unwanted" | "orphaned" | "stale" | "outdated";

export function createAgent37ReadyKeeper(deps: Agent37ReadyKeeperDeps) {
  const logger = deps.logger ?? {};
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const local = new Map<string, LocalPrepare>();
  /**
   * Failed prepares, also kept here: when the choice can't be saved with the
   * failure, this still stops the next pass from paying to try again.
   */
  const failures = new Map<string, Agent37ReadyFailure>();
  let last: Agent37ReadyStatus = { projects: [], error: null };
  let timer: NodeJS.Timeout | null = null;
  let passing: Promise<void> | null = null;
  let passAgain = false;
  let stopped = false;
  /** A delete Agent 37 didn't confirm: keep passing until it does, even with nothing on. */
  let cleanupOwed = false;
  /** Every read-modify-write of the choice, one at a time. */
  let settingsQueue: Promise<unknown> = Promise.resolve();

  const publish = (status: Agent37ReadyStatus) => {
    last = status;
    deps.onStatus?.(status);
  };

  const failureOf = (settings: Agent37ReadyProjectSettings) => settings.failure ?? failures.get(settings.identity) ?? null;
  /** A failure stops new prepares until its automatic retry is due, or for good once ADE stopped retrying. */
  const blockedByFailure = (settings: Agent37ReadyProjectSettings): boolean => {
    const failure = failureOf(settings);
    return failure != null && !(failure.retryAt != null && failure.retryAt <= now());
  };

  const statusFor = (
    settings: Agent37ReadyProjectSettings,
    pool: Agent37Instance[] | null,
  ): Agent37ReadyProjectStatus => {
    const base = { settings, instanceId: null, machineName: null, startedAt: null, error: null };
    const mine = local.get(settings.identity);
    if (mine) {
      return { ...base, state: "preparing", message: mine.message, instanceId: mine.instanceId, startedAt: mine.startedAt };
    }
    const ready = pool?.find((instance) => agent37ReadyStateOf(instance) === "ready") ?? null;
    if (ready) {
      return {
        ...base,
        state: "ready",
        message: `Ready and asleep. The next chat on "${settings.projectName}" starts on it.`,
        instanceId: ready.id,
        machineName: ready.name,
      };
    }
    const elsewhere = pool?.find((instance) => agent37ReadyStateOf(instance) === "preparing") ?? null;
    if (elsewhere) {
      return {
        ...base,
        state: "preparing",
        message: "Being prepared on another of your computers.",
        instanceId: elsewhere.id,
        machineName: elsewhere.name,
        startedAt: elsewhere.created != null ? elsewhere.created * 1000 : null,
      };
    }
    const failure = failureOf(settings);
    if (failure) {
      const minutes = failure.retryAt != null ? Math.max(1, Math.ceil((failure.retryAt - now()) / 60_000)) : null;
      return {
        ...base,
        state: "failed",
        message: minutes != null
          ? `ADE couldn't prepare it, and tries again in about ${minutes} min: ${failure.error}`
          : `ADE couldn't prepare it: ${failure.error}`,
        error: failure.error,
      };
    }
    return { ...base, state: "waiting", message: "ADE will prepare one shortly." };
  };

  const setLocalMessage = (identity: string, message: string, instanceId?: string | null) => {
    const entry = local.get(identity);
    if (!entry) return;
    entry.message = message;
    if (instanceId) entry.instanceId = instanceId;
    publish({
      ...last,
      projects: last.projects.map((project) => (project.settings.identity === identity
        ? { ...project, state: "preparing", message, instanceId: entry.instanceId, startedAt: entry.startedAt }
        : project)),
    });
  };

  /** Deletes a machine ADE made for the pool, and its account row. False when Agent37 didn't confirm. */
  const discard = async (client: Agent37Client, instanceId: string, machineKey: string | null): Promise<boolean> => {
    const gone = await deleteAgent37InstanceConfirmed(client, instanceId, { logger, sleep });
    if (!gone) cleanupOwed = true;
    if (gone && machineKey) {
      await deps.removeAccountMachine(machineKey).catch((error: unknown) => {
        logger.warn?.("agent37.ready_account_row_left", { instanceId, error: getErrorMessage(error) });
      });
    }
    return gone;
  };

  const runSetup = async (client: Agent37Client, settings: Agent37ReadyProjectSettings, instanceId: string, signal: AbortSignal) => {
    const checkCancelled = () => {
      if (signal.aborted) throw new Agent37ReadyPrepareCancelled();
    };
    const write = await client.exec(instanceId, writeJobCommand(buildAgent37ReadySetupScript(settings)), { timeoutMs: 60_000, signal });
    if (write.exitCode !== 0) throw new Error(`ADE couldn't hand the machine its setup (exit ${write.exitCode}).`);
    const began = now();
    let read: JobRead = { started: false, exitCode: null, tail: [] };
    while (read.exitCode == null) {
      checkCancelled();
      if (now() - began > SETUP_TIMEOUT_MS) throw new Error(`the setup didn't finish in ${Math.round(SETUP_TIMEOUT_MS / 60_000)} minutes.`);
      await sleep(SETUP_POLL_MS);
      const answer = await client.exec(instanceId, READ_JOB_COMMAND, { timeoutMs: 30_000, signal }).catch((error: unknown) => {
        if (signal.aborted) throw new Agent37ReadyPrepareCancelled();
        logger.warn?.("agent37.ready_setup_read_failed", { instanceId, error: getErrorMessage(error) });
        return null;
      });
      if (!answer) continue;
      read = parseJobRead(answer.stdout);
      if (!read.started && now() - began > RUNNER_START_GRACE_MS) {
        // Made from a template older than ready machines: nothing on it runs the job.
        throw new Error("the machine's template is too old to run a setup. ADE updates its template on its own; Retry once it's ready.");
      }
      // The step only: the setup's own output is install noise, and it can echo anything.
      if (read.started) setLocalMessage(settings.identity, "Running your setup…");
    }
    if (read.exitCode !== 0) {
      // The last lines say why; the very last is usually the reason, so it is kept whole.
      const tail = read.tail.slice(-2).join(" · ");
      throw new Agent37ReadySetupFailed(`the setup stopped with exit ${read.exitCode}${tail ? `: ${tail.slice(-500)}` : "."}`, read.exitCode);
    }
    const answer = await client.exec(instanceId, `grep -m 1 "^${READY_PATH_MARKER}" "$ADE_HOME/ready/job.log"`, { timeoutMs: 20_000, signal })
      .catch(() => null);
    const projectPath = answer?.stdout.trim().slice(READY_PATH_MARKER.length) || null;
    const laneId = projectPath ? await readPrimaryLaneId(client, instanceId, projectPath, signal, logger) : null;
    return { projectPath, laneId };
  };

  const prepare = async (settings: Agent37ReadyProjectSettings): Promise<void> => {
    const client = await deps.client();
    if (!client) return;
    const shape = agent37Shape(settings.shape);
    if (!shape) return;
    const entry: LocalPrepare = {
      controller: new AbortController(),
      startedAt: now(),
      message: "Making the machine…",
      instanceId: null,
      machineKey: null,
    };
    local.set(settings.identity, entry);
    const { signal } = entry.controller;
    const requestId = randomUUID();
    const suffix = requestId.replace(/-/g, "").slice(0, 4);
    const templateVersion = deps.templateAdeVersion?.() ?? null;
    logger.info?.("agent37.ready_prepare_started", { kind: settings.kind, shape: settings.shape });
    try {
      const created = await deps.createMachine(
        requestId,
        { kind: settings.kind, shape: settings.shape, name: `${settings.projectName} ${suffix}` },
        (progress) => setLocalMessage(settings.identity, progress.message, progress.instanceId ?? null),
        {
          signal,
          metadata: {
            [AGENT37_READY_METADATA.project]: settings.identity,
            [AGENT37_READY_METADATA.state]: "preparing",
            [AGENT37_READY_METADATA.projectName]: settings.projectName,
            [AGENT37_READY_METADATA.preparedBy]: deps.preparerId,
            ...(templateVersion ? { [AGENT37_READY_METADATA.adeVersion]: templateVersion } : {}),
          },
        },
      );
      entry.instanceId = created.instanceId;
      entry.machineKey = created.machineKey;
      if (signal.aborted) throw new Agent37ReadyPrepareCancelled();
      // A chat finds the machine by its ADE machine key; one that never told
      // it is no use as a ready machine.
      if (!created.machineKey) throw new Error("the new machine signed in but didn't say which ADE machine it is.");
      setLocalMessage(settings.identity, `Cloning ${settings.identity}…`, created.instanceId);
      const { projectPath, laneId } = await runSetup(client, settings, created.instanceId, signal);
      if (signal.aborted) throw new Agent37ReadyPrepareCancelled();
      setLocalMessage(settings.identity, "Set up. Putting it to sleep…");
      await patchAgent37Metadata(client, created.instanceId, {
        [AGENT37_READY_METADATA.state]: "ready",
        ...(projectPath ? { [AGENT37_READY_METADATA.path]: projectPath } : {}),
        ...(laneId ? { [AGENT37_READY_METADATA.lane]: laneId } : {}),
        [AGENT37_MACHINE_KEY_METADATA]: created.machineKey,
      });
      try {
        await client.sleepInstance(created.instanceId);
      } catch (error) {
        // Ready, but awake and billing; the next pass tries the sleep again.
        logger.warn?.("agent37.ready_sleep_failed", { instanceId: created.instanceId, error: getErrorMessage(error) });
      }
      logger.info?.("agent37.ready_prepared", { instanceId: created.instanceId, ms: now() - entry.startedAt });
      deps.onPrepared?.("completed");
      // A retry that worked clears the failure it retried.
      if (failureOf(settings)) {
        failures.delete(settings.identity);
        await updateProject(settings.identity, (current) => ({ ...current, failure: null })).catch((writeError: unknown) => {
          logger.warn?.("agent37.ready_failure_not_cleared", { error: getErrorMessage(writeError) });
        });
      }
    } catch (error) {
      const cancelled = signal.aborted || error instanceof Agent37ReadyPrepareCancelled;
      const reason = getErrorMessage(error);
      logger.warn?.("agent37.ready_prepare_failed", {
        instanceId: entry.instanceId,
        cancelled,
        ...(error instanceof Agent37ReadySetupFailed ? { setupExitCode: error.exitCode } : { error: reason }),
      });
      // A machine made for the pool that isn't ready is only a bill.
      // createAgent37Machine already deleted one that never signed in.
      let left = false;
      if (entry.instanceId) {
        left = !(await discard(client, entry.instanceId, entry.machineKey));
      }
      if (!cancelled) {
        // Bounded: ADE tries a couple more times on its own (a flaky setup
        // step, a busy host), never when a machine may still be billing or the
        // template can't run a setup, then waits for Retry.
        const attempts = (failureOf(settings)?.attempts ?? 0) + 1;
        const at = now();
        const retriable = !left && !/template is too old/.test(reason);
        const retryAt = agent37ReadyRetryAt(attempts, at, retriable);
        const failure: Agent37ReadyFailure = {
          error: left
            ? `${reason.replace(/\.$/, "")}. ADE couldn't confirm it deleted the machine (${entry.instanceId}); delete it in your Agent 37 dashboard if it's still there.`
            : reason,
          at,
          attempts,
          retryAt,
        };
        logger.info?.("agent37.ready_prepare_will_retry", { attempts, retrying: retryAt != null });
        failures.set(settings.identity, failure);
        deps.onPrepared?.("failed");
        await updateProject(settings.identity, (current) => ({ ...current, failure })).catch((writeError: unknown) => {
          logger.warn?.("agent37.ready_failure_not_saved", { error: getErrorMessage(writeError) });
        });
      }
    } finally {
      if (local.get(settings.identity) === entry) local.delete(settings.identity);
      schedulePass(0);
    }
  };

  /**
   * Whether a pool machine should go. Never a claimed one (it is the
   * person's). A project turned off deletes its machines only when the
   * account said so, or when the machine is this copy's own: a choice read
   * from this computer alone (signed out, an unreachable vault) is not enough
   * to delete what another computer keeps.
   */
  const discardReason = (
    instance: Agent37Instance,
    pool: { wanted: Set<string>; authoritative: boolean; preparingHere: Set<string>; templateVersion: string | null },
  ): DiscardReason | null => {
    const identity = instance.metadata[AGENT37_READY_METADATA.project];
    const state = agent37ReadyStateOf(instance);
    if (!identity || !state || state === "claimed" || instance.status === "deleted") return null;
    if (pool.preparingHere.has(instance.id) || local.get(identity)?.instanceId === instance.id) return null;
    const ours = instance.metadata[AGENT37_READY_METADATA.preparedBy] === deps.preparerId;
    if (instance.status === "failed") return "agent37_failed";
    if (state === "failed") return "failed";
    if (!pool.wanted.has(identity)) return pool.authoritative || ours ? "unwanted" : null;
    if (state === "preparing" && !local.has(identity)) {
      if (ours) return "orphaned";
      if (instance.created != null && now() - instance.created * 1000 > PREPARING_STALE_MS) return "stale";
    }
    const tag = instance.metadata[AGENT37_READY_METADATA.adeVersion];
    if (state === "ready" && tag && pool.templateVersion && compareUpdateVersions(tag, pool.templateVersion) < 0) return "outdated";
    return null;
  };

  /** Deletes what should go and sleeps ready machines left awake, each re-read first (a claim may have landed). */
  const reconcilePool = async (client: Agent37Client, instances: Agent37Instance[], wanted: Set<string>, authoritative: boolean) => {
    const pool = {
      wanted,
      authoritative,
      preparingHere: new Set([...local.values()].map((entry) => entry.instanceId).filter((id): id is string => id != null)),
      templateVersion: deps.templateAdeVersion?.() ?? null,
    };
    for (const listed of instances) {
      // The list is only a first sieve: what is done is decided on a fresh read.
      if (!discardReason(listed, pool) && (agent37ReadyStateOf(listed) !== "ready" || listed.status !== "running")) continue;
      const instance = await client.getInstance(listed.id).catch((error: unknown) => {
        // Unknown is never acted on; the next pass reads it again.
        logger.warn?.("agent37.ready_reread_failed", { instanceId: listed.id, error: getErrorMessage(error) });
        return null;
      });
      if (!instance) continue;
      const reason = discardReason(instance, pool);
      if (reason) {
        logger.info?.("agent37.ready_machine_discarded", { instanceId: instance.id, reason });
        if (await discard(client, instance.id, instance.metadata[AGENT37_MACHINE_KEY_METADATA] ?? null)) listed.status = "deleted";
      } else if (agent37ReadyStateOf(instance) === "ready" && instance.status === "running") {
        // Ready machines sleep; one left awake (a failed sleep, a released claim) is put back to sleep.
        await client.sleepInstance(instance.id).catch((error: unknown) => {
          logger.warn?.("agent37.ready_sleep_failed", { instanceId: instance.id, error: getErrorMessage(error) });
        });
      }
    }
  };

  /** One read of the choice and the pool: reconcile the pool, start what's missing, publish. */
  const pass = async (): Promise<void> => {
    let read: Awaited<ReturnType<Agent37ReadySettingsStore["read"]>>;
    try {
      read = await deps.settings.read();
    } catch (error) {
      publish({ projects: last.projects, error: `ADE couldn't read which projects keep a machine ready: ${getErrorMessage(error)}` });
      return;
    }
    const { projects, authoritative } = read;
    // Read even with nothing on: a project just turned off still has a machine to delete.
    const client = await deps.client().catch(() => null);
    if (!client) {
      publish({ projects: projects.map((settings) => statusFor(settings, null)), error: projects.length ? "Connect Agent 37 first." : null });
      return;
    }
    let instances: Agent37Instance[];
    try {
      instances = await client.listInstances();
    } catch (error) {
      publish({ projects: projects.map((settings) => statusFor(settings, null)), error: getErrorMessage(error) });
      return;
    }
    cleanupOwed = false;
    const wanted = new Set(projects.map((settings) => settings.identity));
    // Turned off (here or on another computer): stop a local prepare; its own cleanup deletes the machine.
    for (const [identity, entry] of local) {
      if (!wanted.has(identity)) entry.controller.abort();
    }
    await reconcilePool(client, instances, wanted, authoritative);
    for (const settings of projects) {
      const pool = agent37ReadyMachinesFor(instances, settings.identity)
        .filter((instance) => agent37ReadyStateOf(instance) !== "claimed" && instance.status !== "failed");
      if (!pool.length && !local.has(settings.identity) && !blockedByFailure(settings)) {
        void prepare(settings);
      }
    }
    publish({
      projects: projects.map((settings) => statusFor(
        settings,
        agent37ReadyMachinesFor(instances, settings.identity).filter((instance) => instance.status !== "failed"),
      )),
      error: null,
    });
  };

  const runPass = (): Promise<void> => {
    if (passing) {
      passAgain = true;
      return passing;
    }
    passing = (async () => {
      try {
        do {
          passAgain = false;
          await pass();
        } while (passAgain && !stopped);
      } catch (error) {
        logger.warn?.("agent37.ready_pass_failed", { error: getErrorMessage(error) });
      } finally {
        passing = null;
      }
    })();
    return passing;
  };

  function schedulePass(delayMs: number) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runPass().finally(() => {
        // Only keep reading while something is on or a delete is owed; otherwise the passes stop here.
        if (last.projects.length || local.size || cleanupOwed) schedulePass(POOL_PASS_MS);
      });
    }, delayMs);
    timer.unref?.();
  }

  /** Runs one read-modify-write of the choice after any already queued. */
  const withSettings = <T>(work: () => Promise<T>): Promise<T> => {
    const next = settingsQueue.then(work);
    settingsQueue = next.catch(() => undefined);
    return next;
  };

  /** Rewrites one project's entry, if it is still on. */
  const updateProject = (
    identity: string,
    update: (current: Agent37ReadyProjectSettings) => Agent37ReadyProjectSettings,
  ) => withSettings(async () => {
    const { projects } = await deps.settings.read();
    if (!projects.some((entry) => entry.identity === identity)) return;
    await deps.settings.write(projects.map((entry) => (entry.identity === identity ? update(entry) : entry)));
  });

  const writeSettings = async (update: (current: Agent37ReadyProjectSettings[]) => Agent37ReadyProjectSettings[]) => {
    await withSettings(async () => {
      const { projects } = await deps.settings.read();
      await deps.settings.write(update(projects));
    });
    await runPass();
    schedulePass(POOL_PASS_MS);
    return last;
  };

  return {
    /** Starts the first pass after `delayMs`, then every couple of minutes while a project is on. */
    start(delayMs = 0) {
      stopped = false;
      schedulePass(delayMs);
    },
    /** Stops passing and cancels a prepare in flight, which deletes its machine. */
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const entry of local.values()) entry.controller.abort();
    },
    status: () => last,
    /** Reads now (after a claim, or when Settings opens). */
    refresh: async () => {
      await runPass();
      schedulePass(POOL_PASS_MS);
      return last;
    },
    /** Turns it on for a project, or changes its choice. The next machine uses the new choice. */
    setProject: async (raw: Partial<Agent37ReadyProjectSettings>) => {
      const settings = normalizeAgent37ReadySettings(raw);
      if (!settings) throw new Error("This project has no git origin, so a cloud machine can't clone it.");
      // A new choice is a fresh start: any earlier failure is cleared with it.
      failures.delete(settings.identity);
      return await writeSettings((current) => [
        ...current.filter((entry) => entry.identity !== settings.identity),
        { ...settings, failure: null },
      ]);
    },
    /** Turns it off: an unclaimed machine for the project is deleted on the pass that follows. */
    removeProject: async (identity: string) => {
      failures.delete(identity);
      return await writeSettings((current) => current.filter((entry) => entry.identity !== identity));
    },
    /** After a failure: prepare again now. */
    retry: async (identity: string) => {
      failures.delete(identity);
      await updateProject(identity, (current) => ({ ...current, failure: null }));
      await runPass();
      return last;
    },
  };
}

export type Agent37ReadyKeeper = ReturnType<typeof createAgent37ReadyKeeper>;
