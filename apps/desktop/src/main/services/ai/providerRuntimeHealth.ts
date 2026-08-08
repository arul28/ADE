import { nowIso } from "../shared/utils";

export type ProviderRuntimeHealthState = "ready" | "auth-failed" | "runtime-failed";
export type ProviderRuntimeHealthProvider = "claude" | "codex" | "cursor" | "pi";

export type ProviderRuntimeHealth = {
  provider: ProviderRuntimeHealthProvider;
  state: ProviderRuntimeHealthState;
  message: string | null;
  checkedAt: string;
};

const providerHealth = new Map<ProviderRuntimeHealthProvider, ProviderRuntimeHealth>();
let providerHealthVersion = 0;

function setProviderRuntimeHealth(next: ProviderRuntimeHealth): void {
  const previous = providerHealth.get(next.provider);
  if (
    previous
    && previous.state === next.state
    && previous.message === next.message
  ) {
    providerHealth.set(next.provider, {
      ...previous,
      checkedAt: next.checkedAt,
    });
    return;
  }
  providerHealth.set(next.provider, next);
  providerHealthVersion += 1;
}

export function reportProviderRuntimeReady(provider: ProviderRuntimeHealthProvider): void {
  setProviderRuntimeHealth({
    provider,
    state: "ready",
    message: null,
    checkedAt: nowIso(),
  });
}

export function reportProviderRuntimeAuthFailure(
  provider: ProviderRuntimeHealthProvider,
  message: string,
): void {
  setProviderRuntimeHealth({
    provider,
    state: "auth-failed",
    message: message.trim() || null,
    checkedAt: nowIso(),
  });
}

export function reportProviderRuntimeFailure(
  provider: ProviderRuntimeHealthProvider,
  message: string,
): void {
  setProviderRuntimeHealth({
    provider,
    state: "runtime-failed",
    message: message.trim() || null,
    checkedAt: nowIso(),
  });
}

export function getProviderRuntimeHealth(
  provider: ProviderRuntimeHealthProvider,
): ProviderRuntimeHealth | null {
  return providerHealth.get(provider) ?? null;
}

export function getProviderRuntimeHealthVersion(): number {
  return providerHealthVersion;
}

export function resetProviderRuntimeHealth(provider?: ProviderRuntimeHealthProvider): void {
  if (provider) {
    if (!providerHealth.has(provider)) return;
    providerHealth.delete(provider);
    providerHealthVersion += 1;
    return;
  }
  if (providerHealth.size === 0) return;
  providerHealth.clear();
  providerHealthVersion += 1;
}
