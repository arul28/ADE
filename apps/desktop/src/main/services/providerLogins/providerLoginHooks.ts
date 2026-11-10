/**
 * The few seams between the sign-in sync (one per brain process) and the
 * services of each project runtime. Kept in a module with no imports, so the
 * chat service reads the gate without loading the sync service, and a
 * process with no sync (the desktop main, a dev brain) pays one null check.
 */

type Gate = (provider: string) => Promise<void>;

let gate: Gate | null = null;

/** The sync installs the gate on a cloud computer only; everywhere else it stays null. */
export function installProviderLoginGate(next: Gate | null): void {
  gate = next;
}

/**
 * Before a provider starts or resumes a turn, or a CLI session starts: the
 * gate's promise on a cloud computer, else null, so the caller does not even
 * await. The gate never throws and never blocks longer than its own limit.
 */
export function providerLoginGate(provider: string): Promise<void> | null {
  return gate ? gate(provider) : null;
}

export type ProviderLoginRuntimeHooks = {
  /** End the provider's idle processes now and busy ones after their turn (`agentChatService`). */
  restartProviderRuntimesWhenIdle(provider: string): void;
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

export function restartProviderRuntimesWhenIdle(provider: string): void {
  for (const hooks of [...runtimes]) {
    try {
      hooks.restartProviderRuntimesWhenIdle(provider);
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
