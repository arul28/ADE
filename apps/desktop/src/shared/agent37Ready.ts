/**
 * Ready machines: a machine prepared for one project (repository cloned, its
 * setup run, its services started, signed in) and kept asleep, so a new chat
 * on it starts in seconds. Asleep it bills only its disk. Starting a chat
 * claims it (wakes it and makes it an ordinary machine of the person's), and
 * ADE prepares the next one.
 *
 * The pool lives on Agent37 itself, in each machine's metadata, so every
 * computer on the account, the brain and the CLI read the same answer.
 */

import type { Agent37CreateStage, Agent37MachineKind, Agent37ShapeId } from "./agent37";

/** The size a new ready machine gets until the person picks one: a 4 vCPU / 8 GB VM runs a Docker stack. */
export const AGENT37_READY_DEFAULT_SHAPE: Agent37ShapeId = "4x8";

/**
 * How long a chat start waits, from the claim, for the woken machine's ADE to
 * come online and take it. Agent 37 answers a wake in about a second; ADE's own
 * reconnect after a long sleep takes longer.
 */
export const AGENT37_READY_WAKE_WAIT_MS = 120_000;

/** `ade chat create --machine agent37:ready`: start the chat on this project's ready machine. */
const AGENT37_READY_MACHINE_SELECTOR = "agent37:ready";

export function isAgent37ReadyMachineSelector(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === AGENT37_READY_MACHINE_SELECTOR;
}

/** Metadata keys on a ready machine. Agent37 replaces metadata on write, so every write keeps the rest. */
export const AGENT37_READY_METADATA = {
  /** The project's git identity (`github.com/owner/repo`). */
  project: "ade_ready_for",
  /** `preparing` → `ready` → `claimed`; or `failed`. */
  state: "ade_ready",
  /** The project's display name, for the machine list. */
  projectName: "ade_ready_name",
  /** Where the project is on the machine. */
  path: "ade_ready_path",
  /** The project's primary lane there: a chat with no lane named starts in it. */
  lane: "ade_ready_lane",
  /** Epoch ms of the claim. */
  claimedAt: "ade_ready_claimed_at",
  /** The claim's own token: only the caller holding it can give the machine back. */
  claimToken: "ade_ready_claim",
  /** Which copy of ADE is preparing it, so that copy knows its own leftovers after a restart. */
  preparedBy: "ade_ready_by",
  /** The ADE release its template installed; a ready machine is replaced when the template moves on. */
  adeVersion: "ade_ready_ade",
} as const;

export type Agent37ReadyMachineState = "preparing" | "ready" | "claimed" | "failed";

export function readAgent37ReadyMachineState(value: string | null | undefined): Agent37ReadyMachineState | null {
  return value === "preparing" || value === "ready" || value === "claimed" || value === "failed" ? value : null;
}

/** What the person chose for one project, kept in the account vault so every computer agrees. */
export type Agent37ReadyProjectSettings = {
  /** The project's git identity (`github.com/owner/repo`); the machine clones it over HTTPS. */
  identity: string;
  projectName: string;
  kind: Agent37MachineKind;
  shape: Agent37ShapeId;
  /**
   * Shell commands run once in the clone before the machine sleeps: install,
   * then start what the project needs (a `docker compose up -d`, a dev
   * server in the background). Empty means clone only.
   */
  setup: string;
  /**
   * The last prepare failed, and nothing is billing for it. Kept with the
   * choice so no computer, and no app restart, pays to try again on its own;
   * Retry or a new choice clears it.
   */
  failure: Agent37ReadyFailure | null;
};

/**
 * A failed prepare. ADE tries again on its own a bounded number of times
 * (`AGENT37_READY_AUTO_RETRY_DELAYS_MS`), then waits for Retry.
 */
export type Agent37ReadyFailure = {
  error: string;
  at: number;
  /** Prepares that failed in a row; 1 for the first. */
  attempts?: number;
  /** When ADE tries again on its own, epoch ms; absent once it stopped trying. */
  retryAt?: number | null;
};

/** The waits before each automatic retry of a failed prepare; after the last, Retry is the person's. */
const AGENT37_READY_AUTO_RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;

/** When a prepare that failed for the `attempts`-th time in a row is tried again, or null for "wait for Retry". */
export function agent37ReadyRetryAt(attempts: number, at: number, retriable: boolean): number | null {
  if (!retriable) return null;
  const delay = AGENT37_READY_AUTO_RETRY_DELAYS_MS[attempts - 1];
  return delay == null ? null : at + delay;
}

/**
 * One project's ready machine, as Settings shows it.
 *
 * - `preparing`: being made and set up (`message` says which step).
 * - `ready`: prepared and asleep; the next chat takes it.
 * - `failed`: the last prepare failed; nothing is billing, Retry starts again.
 * - `waiting`: none yet and none being made (this computer will start one).
 */
export type Agent37ReadyProjectState = "preparing" | "ready" | "failed" | "waiting";

/** What ADE does to make a ready machine, in order. */
export const AGENT37_READY_STEPS = ["make", "sign_in", "clone", "setup", "sleep"] as const;
export type Agent37ReadyStep = (typeof AGENT37_READY_STEPS)[number];

/** The ready-machine step a create's stage belongs to. */
export function agent37ReadyStepOf(stage: Agent37CreateStage): Agent37ReadyStep | null {
  switch (stage) {
    case "creating":
    case "waiting_for_brain":
      return "make";
    case "signing_in":
    case "confirm_in_window":
    case "approve_elsewhere":
    case "joining":
      return "sign_in";
    default:
      return null;
  }
}

export type Agent37ReadyProjectStatus = {
  settings: Agent37ReadyProjectSettings;
  state: Agent37ReadyProjectState;
  /** One plain line. */
  message: string;
  /**
   * The step a machine this computer prepares is on; null while preparing
   * elsewhere (another computer says nothing of its step) or not preparing.
   */
  step: Agent37ReadyStep | null;
  instanceId: string | null;
  machineName: string | null;
  /** When the prepare began, epoch ms, while preparing. */
  startedAt: number | null;
  error: string | null;
};

export type Agent37ReadyStatus = {
  projects: Agent37ReadyProjectStatus[];
  /** Why the list could not be read, or null. */
  error: string | null;
};

/** What claiming a project's ready machine hands back: the machine to start the chat on. */
export type Agent37ReadyClaim = {
  instanceId: string;
  /** Its ADE machine (account row), recorded on it when it joined; a machine without one is never handed out. */
  machineKey: string;
  name: string;
  /** Where the project is on it. */
  projectPath: string | null;
  /** The project's primary lane on it, for a chat that names no lane. */
  laneId: string | null;
  /** How long Agent37 took to answer the wake. */
  wakeMs: number;
  /** Gives this claim back (`release`) while nothing has used the machine. */
  claimToken: string;
};

/** One project's pool, as `ade agent37 ready` reports it (the `agent37.ready_status` action). */
export type Agent37ReadyPoolEntry = {
  identity: string;
  projectName: string;
  /** Whether a computer keeps this project's machine ready (its setting), or only machines are left. */
  keptReady: boolean;
  /** Machines per state: `ready` (asleep, the next chat takes one), `preparing`, `inUse` (claimed), `failed`. */
  ready: number;
  preparing: number;
  inUse: number;
  failed: number;
  /** The last prepare's failure, kept until Retry. */
  failure: string | null;
  machines: Array<{ instanceId: string; name: string | null; state: Agent37ReadyMachineState; status: string }>;
};

export type Agent37ReadyPool = { projects: Agent37ReadyPoolEntry[] };
