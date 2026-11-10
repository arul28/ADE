/**
 * The few seams between the sign-in sync (one per brain process) and the
 * services of each project runtime. Kept in a module with no runtime
 * imports, so the chat service reads the gate without loading the sync
 * service, and a process with no sync (the desktop main, a dev brain) pays
 * one null check.
 *
 * P6 (the Claude pass) builds on these seams: a check before a Claude turn
 * (`providerLoginGate.register`), a hook on each pass (`onProviderLoginPass`),
 * a part of the status (`registerProviderLoginStatusPart`), and a restart
 * limited to some accounts (`restartProviderRuntimesWhenIdle` with
 * `instanceIds`).
 */

import type { ProviderLoginProvider, ProviderLoginStatusParts } from "../../../shared/types/providerLogins";

type Gate = (provider: string) => Promise<void>;

let gate: Gate | null = null;
/** Checks before a turn for a provider the carry table does not handle (P6: Claude). */
const beforeTurnChecks = new Map<string, Set<Gate>>();

/** The sync installs the gate on a cloud computer only; everywhere else it stays null. */
export function installProviderLoginGate(next: Gate | null): void {
  gate = next;
}

/**
 * Add a check that runs before each turn and each CLI start of `provider`,
 * after the sign-in sync's own gate, and only where that gate is installed (a
 * cloud computer with the sync on). The check owns its time limit; a
 * rejection is swallowed, so a check can never stop a turn. Returns the call
 * that removes it. Also reachable as `providerLoginGate.register`.
 */
export function registerProviderLoginGate(provider: string, beforeTurn: Gate): () => void {
  const id = provider.trim().toLowerCase();
  let checks = beforeTurnChecks.get(id);
  if (!checks) {
    checks = new Set();
    beforeTurnChecks.set(id, checks);
  }
  checks.add(beforeTurn);
  return () => {
    const current = beforeTurnChecks.get(id);
    current?.delete(beforeTurn);
    if (current && !current.size) beforeTurnChecks.delete(id);
  };
}

async function runGate(provider: string, base: Gate, extra: Set<Gate> | undefined): Promise<void> {
  await base(provider).catch(() => undefined);
  for (const check of [...(extra ?? [])]) await check(provider).catch(() => undefined);
}

/**
 * Before a provider starts or resumes a turn, or a CLI session starts: a
 * promise when a gate or a registered check applies, else null, so the caller
 * does not even await. It never throws.
 */
export const providerLoginGate = Object.assign(
  (provider: string): Promise<void> | null => {
    // No installed gate (every computer but a cloud computer with the sync on): nothing runs, not even a registered check.
    if (!gate) return null;
    return runGate(provider, gate, beforeTurnChecks.get(provider.trim().toLowerCase()));
  },
  { register: registerProviderLoginGate },
);

export type ProviderLoginRestartOptions = {
  /**
   * Only the chats whose resolved provider account id is in this list (Claude
   * and Codex accounts). Pooled processes, which belong to no account, are
   * left alone. Without it, every chat of the provider and its pooled
   * processes.
   */
  instanceIds?: readonly string[];
};

export type ProviderLoginRuntimeHooks = {
  /** End the provider's idle processes now and busy ones after their turn (`agentChatService`). */
  restartProviderRuntimesWhenIdle(provider: string, options?: ProviderLoginRestartOptions): void;
  /** Tell this runtime's clients the sign-ins changed (`provider_logins_changed`). */
  notifyChanged(): void;
};

const runtimes = new Set<ProviderLoginRuntimeHooks>();

/** Each project runtime of the brain registers once; the returned call unregisters it. */
export function registerProviderLoginRuntime(hooks: ProviderLoginRuntimeHooks): () => void {
  runtimes.add(hooks);
  return () => {
    runtimes.delete(hooks);
  };
}

export function restartProviderRuntimesWhenIdle(provider: string, options?: ProviderLoginRestartOptions): void {
  for (const hooks of [...runtimes]) {
    try {
      hooks.restartProviderRuntimesWhenIdle(provider, options);
    } catch {
      // One runtime's failure must not keep the others on the old login.
    }
  }
}

export function notifyProviderLoginsChanged(): void {
  for (const hooks of [...runtimes]) {
    try {
      hooks.notifyChanged();
    } catch {
      // A client that misses one event reads the status again on its next open.
    }
  }
}

// ── each pass of the process-wide sync ──────────────────────────────────

export type ProviderLoginPassInfo = {
  accountUserId: string;
  cloudComputer: boolean;
  /** The providers this pass looked at, or null for all. */
  providers: ProviderLoginProvider[] | null;
  /** "all_off" when the off switch for all is on: nothing was captured (apply still ran on cloud). */
  captureOff: "all_off" | null;
};

type PassListener = (info: ProviderLoginPassInfo) => void | Promise<void>;
const passListeners = new Set<PassListener>();

/**
 * Hear the end of each pass of the brain's sign-in sync. A pass runs only
 * for a signed-in account with ADE Cloud (no ADE Cloud, no tick, no pass
 * here): on each vault tick (30 s) that reads "ready", when ADE Cloud access
 * starts, on a person's write, and in the gate before a turn. The listener
 * is not awaited, and its failure is its own.
 */
export function onProviderLoginPass(listener: PassListener): () => void {
  passListeners.add(listener);
  return () => {
    passListeners.delete(listener);
  };
}

export function notifyProviderLoginPass(info: ProviderLoginPassInfo): void {
  for (const listener of [...passListeners]) {
    try {
      void Promise.resolve(listener(info)).catch(() => undefined);
    } catch {
      // A listener's failure never stops the pass or the other listeners.
    }
  }
}

// ── parts of the status that other packages add (P6: `claudePasses`) ────

type StatusPart = (args: { provider: ProviderLoginProvider | null }) => ProviderLoginStatusParts | Promise<ProviderLoginStatusParts>;
const statusParts = new Set<StatusPart>();

/** Add fields to every `provider_logins.status` answer. Returns the call that removes it. */
export function registerProviderLoginStatusPart(part: StatusPart): () => void {
  statusParts.add(part);
  return () => {
    statusParts.delete(part);
  };
}

/** The fields every registered part adds. A part that fails adds nothing. */
export async function readProviderLoginStatusParts(provider: ProviderLoginProvider | null): Promise<ProviderLoginStatusParts> {
  let merged: ProviderLoginStatusParts = {};
  for (const part of [...statusParts]) {
    try {
      merged = { ...merged, ...(await part({ provider })) };
    } catch {
      // The rest of the status still answers.
    }
  }
  return merged;
}
