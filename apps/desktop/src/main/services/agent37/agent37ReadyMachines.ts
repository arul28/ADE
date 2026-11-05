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
  agent37Shape,
  isAgent37MachineKind,
  type Agent37CreateMachineArgs,
  type Agent37CreateMachineResult,
  type Agent37CreateProgress,
  type Agent37ReadyProjectSettings,
  type Agent37ReadyProjectStatus,
  type Agent37ReadyStatus,
} from "../../../shared/agent37";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type { Agent37Client, Agent37Instance } from "./agent37Client";
import { agent37ReadyMachinesFor, agent37ReadyStateOf, patchAgent37Metadata } from "./agent37ReadyClaim";
import { AGENT37_MACHINE_KEY_METADATA } from "./agent37Machines";
import { deleteAgent37InstanceConfirmed } from "./agent37PendingCreates";

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
};

/** The account vault item that holds every project's choice. */
export const AGENT37_READY_VAULT_KEY = "agent37-ready";

export type Agent37ReadySettingsStore = {
  /** Throws when the account vault can't be read: unknown is never "no projects". */
  read(): Promise<Agent37ReadyProjectSettings[]>;
  write(projects: Agent37ReadyProjectSettings[]): Promise<void>;
};

export type Agent37ReadyKeeperDeps = {
  client: () => Promise<Agent37Client | null>;
  settings: Agent37ReadySettingsStore;
  /** `createAgent37Machine` with this computer's sign-in window and account. */
  createMachine: (
    requestId: string,
    machine: Agent37CreateMachineArgs,
    onProgress: (progress: Agent37CreateProgress) => void,
    signal: AbortSignal,
    metadata: Record<string, string>,
  ) => Promise<Agent37CreateMachineResult>;
  /** Takes a deleted machine's row off the ADE account. */
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  onStatus?: (status: Agent37ReadyStatus) => void;
  logger?: Logger;
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
/** A template without the job runner never marks the job started. */
const RUNNER_START_GRACE_MS = 20_000;
const LOG_TAIL_LINES = 6;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `'…'` for sh, whatever the text holds. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** The project's identity on every computer and machine: its origin, normalized (`github.com/owner/repo`). */
export function agent37ReadyIdentity(originUrl: string | null | undefined): string | null {
  return normalizeGitRemoteIdentity(originUrl);
}

/**
 * What a machine with no SSH keys can clone: the identity over HTTPS. A
 * private repository needs a Git sign-in on the machine; the setup log says so.
 */
export function agent37ReadyCloneUrl(identity: string): string {
  return `https://${identity}.git`;
}

/** A folder name for the clone: the repository's last path part, made safe. */
function cloneFolderName(identity: string): string {
  const last = identity.split("/").filter(Boolean).pop() ?? "project";
  return last.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "project";
}

/**
 * The box's setup job. Runs under `sh -e` from the home folder: clone (kept
 * if already there), register the project with the box's ADE so a chat finds
 * it by its origin, then the person's commands in the clone.
 */
export function buildAgent37ReadySetupScript(settings: Pick<Agent37ReadyProjectSettings, "identity" | "setup">): string {
  const folder = cloneFolderName(settings.identity);
  return [
    "set -e",
    `dir="$HOME/${folder}"`,
    `echo "ADE_READY_PATH=$dir"`,
    'if [ ! -d "$dir/.git" ]; then',
    `  GIT_TERMINAL_PROMPT=0 git clone ${shellQuote(agent37ReadyCloneUrl(settings.identity))} "$dir"`
      + ' || { echo "ADE couldn\'t clone the repository. A private repository needs a Git sign-in on the machine." >&2; exit 1; }',
    "fi",
    'cd "$dir"',
    'ade projects add "$dir" >/dev/null',
    settings.setup.trim(),
    'echo "ADE_READY_DONE"',
  ].filter(Boolean).join("\n");
}

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

/** For a template without the runner: the same job, started over exec (it may not survive a sleep on a box). */
const START_JOB_OVER_EXEC = [
  'jobs="$ADE_HOME/ready"',
  '[ -f "$jobs/job.started" ] && exit 0',
  'date +%s > "$jobs/job.started"',
  'nohup setsid sh -c \'cd "$HOME" && sh "$1/job.sh" > "$1/job.log" 2>&1 < /dev/null; echo $? > "$1/job.exit"\' sh "$jobs" > /dev/null 2>&1 &',
].join("; ");

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
    tail: lines.slice(2).map((line) => line.trimEnd()).filter(Boolean),
  };
}

export class Agent37ReadyPrepareCancelled extends Error {
  constructor() {
    super("Stopped: the project no longer keeps a machine ready.");
    this.name = "Agent37ReadyPrepareCancelled";
  }
}

/** The person's choice, checked: anything the renderer or vault hands in passes through here. */
export function normalizeAgent37ReadySettings(raw: Partial<Agent37ReadyProjectSettings> | null | undefined): Agent37ReadyProjectSettings | null {
  const identity = agent37ReadyIdentity(raw?.identity ?? raw?.originUrl ?? null);
  if (!identity || !raw) return null;
  const kind = isAgent37MachineKind(raw.kind) ? raw.kind : "vm";
  const shape = agent37Shape(raw.shape)?.id ?? "4x8";
  return {
    identity,
    originUrl: typeof raw.originUrl === "string" && raw.originUrl.trim() ? raw.originUrl.trim() : agent37ReadyCloneUrl(identity),
    projectName: (typeof raw.projectName === "string" ? raw.projectName : "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60)
      || cloneFolderName(identity),
    kind,
    shape,
    setup: typeof raw.setup === "string" ? raw.setup.replace(/\r\n/g, "\n").slice(0, 8_000) : "",
  };
}

type LocalPrepare = {
  controller: AbortController;
  startedAt: number;
  message: string;
  instanceId: string | null;
  machineKey: string | null;
};

export function createAgent37ReadyKeeper(deps: Agent37ReadyKeeperDeps) {
  const logger = deps.logger ?? {};
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const local = new Map<string, LocalPrepare>();
  /** The last failed prepare per project; cleared by Retry or new settings. Never retried on its own. */
  const failures = new Map<string, { error: string; at: number }>();
  let last: Agent37ReadyStatus = { projects: [], error: null };
  let timer: NodeJS.Timeout | null = null;
  let passing: Promise<void> | null = null;
  let passAgain = false;
  let stopped = false;

  const publish = (status: Agent37ReadyStatus) => {
    last = status;
    deps.onStatus?.(status);
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
    const failure = failures.get(settings.identity);
    if (failure) {
      return { ...base, state: "failed", message: `ADE couldn't prepare it: ${failure.error}`, error: failure.error };
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
    if (gone && machineKey) {
      await deps.removeAccountMachine(machineKey).catch((error: unknown) => {
        logger.warn?.("agent37.ready_account_row_left", { instanceId, error: errorText(error) });
      });
    }
    return gone;
  };

  const runSetup = async (client: Agent37Client, settings: Agent37ReadyProjectSettings, instanceId: string, signal: AbortSignal) => {
    const checkCancelled = () => {
      if (signal.aborted) throw new Agent37ReadyPrepareCancelled();
    };
    const write = await client.exec(instanceId, writeJobCommand(buildAgent37ReadySetupScript(settings)), { timeoutMs: 60_000, signal });
    if (write.exitCode !== 0) throw new Error(`ADE couldn't hand the machine its setup (${write.stderr.trim() || `exit ${write.exitCode}`}).`);
    const began = now();
    let fellBack = false;
    let read: JobRead = { started: false, exitCode: null, tail: [] };
    while (read.exitCode == null) {
      checkCancelled();
      if (now() - began > SETUP_TIMEOUT_MS) throw new Error(`the setup didn't finish in ${Math.round(SETUP_TIMEOUT_MS / 60_000)} minutes.`);
      await sleep(SETUP_POLL_MS);
      const answer = await client.exec(instanceId, READ_JOB_COMMAND, { timeoutMs: 30_000, signal }).catch((error: unknown) => {
        if (signal.aborted) throw new Agent37ReadyPrepareCancelled();
        logger.warn?.("agent37.ready_setup_read_failed", { instanceId, error: errorText(error) });
        return null;
      });
      if (!answer) continue;
      read = parseJobRead(answer.stdout);
      if (!read.started && !fellBack && now() - began > RUNNER_START_GRACE_MS) {
        // An older template without the runner: start the job over exec.
        fellBack = true;
        logger.warn?.("agent37.ready_runner_missing", { instanceId });
        await client.exec(instanceId, START_JOB_OVER_EXEC, { timeoutMs: 30_000, signal });
      }
      const latest = read.tail.filter((line) => !line.startsWith("ADE_READY_")).pop();
      if (read.started) setLocalMessage(settings.identity, latest ? `Running setup: ${latest.slice(0, 120)}` : "Running setup…");
    }
    if (read.exitCode !== 0) {
      const tail = read.tail.filter((line) => !line.startsWith("ADE_READY_")).slice(-3).join(" · ");
      throw new Error(`the setup stopped with exit ${read.exitCode}${tail ? `: ${tail.slice(0, 300)}` : "."}`);
    }
    const pathAnswer = await client.exec(instanceId, 'sed -n "s/^ADE_READY_PATH=//p" "$ADE_HOME/ready/job.log" | head -n 1', { timeoutMs: 20_000, signal })
      .catch(() => null);
    return pathAnswer?.stdout.trim() || null;
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
    failures.delete(settings.identity);
    const { signal } = entry.controller;
    const requestId = randomUUID();
    const suffix = requestId.replace(/-/g, "").slice(0, 4);
    logger.info?.("agent37.ready_prepare_started", { kind: settings.kind, shape: settings.shape });
    try {
      const created = await deps.createMachine(
        requestId,
        { kind: settings.kind, shape: settings.shape, name: `${settings.projectName} ${suffix}` },
        (progress) => setLocalMessage(settings.identity, progress.message, progress.instanceId ?? null),
        signal,
        {
          [AGENT37_READY_METADATA.project]: settings.identity,
          [AGENT37_READY_METADATA.state]: "preparing",
          [AGENT37_READY_METADATA.projectName]: settings.projectName,
        },
      );
      entry.instanceId = created.instanceId;
      entry.machineKey = created.machineKey;
      if (signal.aborted) throw new Agent37ReadyPrepareCancelled();
      setLocalMessage(settings.identity, `Cloning ${settings.identity}…`, created.instanceId);
      const projectPath = await runSetup(client, settings, created.instanceId, signal);
      if (signal.aborted) throw new Agent37ReadyPrepareCancelled();
      setLocalMessage(settings.identity, "Set up. Putting it to sleep…");
      await patchAgent37Metadata(client, created.instanceId, {
        [AGENT37_READY_METADATA.state]: "ready",
        ...(projectPath ? { [AGENT37_READY_METADATA.path]: projectPath } : {}),
        ...(created.machineKey ? { [AGENT37_MACHINE_KEY_METADATA]: created.machineKey } : {}),
      });
      try {
        await client.sleepInstance(created.instanceId);
      } catch (error) {
        // Ready, but awake and billing; the next pass tries the sleep again.
        logger.warn?.("agent37.ready_sleep_failed", { instanceId: created.instanceId, error: errorText(error) });
      }
      logger.info?.("agent37.ready_prepared", { instanceId: created.instanceId, ms: now() - entry.startedAt });
    } catch (error) {
      const cancelled = signal.aborted || error instanceof Agent37ReadyPrepareCancelled;
      const reason = errorText(error);
      logger.warn?.("agent37.ready_prepare_failed", { instanceId: entry.instanceId, cancelled, error: reason });
      // A machine made for the pool that isn't ready is only a bill.
      // createAgent37Machine already deleted one that never signed in.
      let left = false;
      if (entry.instanceId) {
        left = !(await discard(client, entry.instanceId, entry.machineKey));
      }
      if (!cancelled) {
        failures.set(settings.identity, {
          error: left
            ? `${reason.replace(/\.$/, "")}. ADE couldn't confirm it deleted the machine (${entry.instanceId}); delete it in your Agent 37 dashboard if it's still there.`
            : reason,
          at: now(),
        });
      }
    } finally {
      if (local.get(settings.identity) === entry) local.delete(settings.identity);
      schedulePass(0);
    }
  };

  /** One read of settings and pool: start what's missing, sleep what's awake, delete what's no longer wanted. */
  const pass = async (): Promise<void> => {
    let projects: Agent37ReadyProjectSettings[];
    try {
      projects = await deps.settings.read();
    } catch (error) {
      publish({ projects: last.projects, error: `ADE couldn't read which projects keep a machine ready: ${errorText(error)}` });
      return;
    }
    const client = projects.length || local.size ? await deps.client().catch(() => null) : null;
    if (!client) {
      publish({ projects: projects.map((settings) => statusFor(settings, null)), error: projects.length ? "Connect Agent 37 first." : null });
      return;
    }
    let instances: Agent37Instance[];
    try {
      instances = await client.listInstances();
    } catch (error) {
      publish({ projects: projects.map((settings) => statusFor(settings, null)), error: errorText(error) });
      return;
    }
    const wanted = new Set(projects.map((settings) => settings.identity));
    // Turned off (here or on another computer): stop a local prepare, delete an unclaimed machine.
    for (const [identity, entry] of local) {
      if (!wanted.has(identity)) entry.controller.abort();
    }
    for (const instance of instances) {
      const identity = instance.metadata[AGENT37_READY_METADATA.project];
      const state = agent37ReadyStateOf(instance);
      if (!identity || !state || state === "claimed" || instance.status === "deleted") continue;
      const stale = state === "preparing" && !local.has(identity)
        && instance.created != null && now() - instance.created * 1000 > PREPARING_STALE_MS;
      if (!wanted.has(identity) || state === "failed" || stale) {
        if (local.get(identity)?.instanceId === instance.id) continue;
        logger.info?.("agent37.ready_machine_discarded", { instanceId: instance.id, state, wanted: wanted.has(identity), stale });
        await discard(client, instance.id, instance.metadata[AGENT37_MACHINE_KEY_METADATA] ?? null);
        instance.status = "deleted";
        continue;
      }
      if (state === "ready" && instance.status === "running") {
        // Ready machines sleep; one left awake (a failed sleep, a released claim) is put back to sleep.
        await client.sleepInstance(instance.id).catch((error: unknown) => {
          logger.warn?.("agent37.ready_sleep_failed", { instanceId: instance.id, error: errorText(error) });
        });
      }
    }
    for (const settings of projects) {
      const pool = agent37ReadyMachinesFor(instances, settings.identity)
        .filter((instance) => agent37ReadyStateOf(instance) !== "claimed");
      if (!pool.length && !local.has(settings.identity) && !failures.has(settings.identity)) {
        void prepare(settings);
      }
    }
    publish({
      projects: projects.map((settings) => statusFor(settings, agent37ReadyMachinesFor(instances, settings.identity))),
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
        logger.warn?.("agent37.ready_pass_failed", { error: errorText(error) });
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
        // Only keep reading while something is on; a pass with nothing to do stops here.
        if (last.projects.length || local.size) schedulePass(POOL_PASS_MS);
      });
    }, delayMs);
    timer.unref?.();
  }

  const writeSettings = async (update: (current: Agent37ReadyProjectSettings[]) => Agent37ReadyProjectSettings[]) => {
    const current = await deps.settings.read();
    await deps.settings.write(update(current));
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
      failures.delete(settings.identity);
      return await writeSettings((current) => [
        ...current.filter((entry) => entry.identity !== settings.identity),
        settings,
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
      await runPass();
      return last;
    },
  };
}

export type Agent37ReadyKeeper = ReturnType<typeof createAgent37ReadyKeeper>;

/** The vault item's shape. A damaged item reads as no projects (logged), so it can never wedge the keeper. */
export function parseAgent37ReadySettings(raw: string | null | undefined, logger?: Logger): Agent37ReadyProjectSettings[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; projects?: unknown };
    if (parsed?.v !== 1 || !Array.isArray(parsed.projects)) return [];
    const out: Agent37ReadyProjectSettings[] = [];
    for (const entry of parsed.projects) {
      const settings = normalizeAgent37ReadySettings(entry as Partial<Agent37ReadyProjectSettings>);
      if (settings && !out.some((existing) => existing.identity === settings.identity)) out.push(settings);
    }
    return out;
  } catch (error) {
    logger?.warn?.("agent37.ready_settings_unreadable", { reason: error instanceof SyntaxError ? "invalid_json" : "unreadable" });
    return [];
  }
}

export function serializeAgent37ReadySettings(projects: Agent37ReadyProjectSettings[]): string {
  return JSON.stringify({ v: 1, projects });
}
