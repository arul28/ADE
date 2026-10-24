import { nowIso } from "../shared/utils";
import { addSentryBreadcrumb, captureProblem } from "../../../shared/sentry/capture";
import { forwardLogToSentry } from "../../../shared/sentry/logBridge";

export type ProviderRuntimeHealthState = "ready" | "auth-failed" | "runtime-failed";
export type ProviderRuntimeHealthProvider =
  | "claude"
  | "codex"
  | "cursor"
  | "pi"
  | "muse"
  | "qwen"
  | "kimi"
  | "grok"
  | "copilot"
  | "devin"
  | "antigravity";

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
  reportHealthTransition(previous ?? null, next);
}

/** Providers whose runtime failure this process already sent to Sentry. */
const reportedRuntimeFailures = new Set<ProviderRuntimeHealthProvider>();

/**
 * A provider that stops working is the failure users notice first and report
 * least: the chat just says it cannot start. The app shows every transition.
 * Sentry gets the first runtime failure per provider per process, as a
 * warning: most are the machine (a CLI that will not start there, a probe
 * that timed out) rather than ADE, and a provider that flaps on one machine
 * was an error event, and an alert, each time. Later ones are Sentry Logs.
 * A recovery leaves a breadcrumb. Auth failures are only logged, since
 * signing out is not a bug.
 */
function reportHealthTransition(previous: ProviderRuntimeHealth | null, next: ProviderRuntimeHealth): void {
  if (next.state === "ready") {
    if (previous && previous.state !== "ready") {
      addSentryBreadcrumb("provider", `${next.provider} recovered`, { from: previous.state });
    }
    return;
  }
  // Signed out is the user's state, not a defect: a Sentry Log, not an issue.
  if (next.state === "auth-failed") {
    forwardLogToSentry("warn", `provider.${next.provider}.auth_failed`, { message: next.message ?? null });
    return;
  }
  if (reportedRuntimeFailures.has(next.provider)) {
    forwardLogToSentry("warn", `provider.${next.provider}.runtime_failed`, { message: next.message ?? null });
    return;
  }
  reportedRuntimeFailures.add(next.provider);
  captureProblem(`Provider ${next.provider} ${next.state}: ${next.message ?? "no message"}`, {
    tags: { provider: next.provider, "provider.state": next.state },
    fingerprint: ["provider", next.provider, next.state],
    level: "warning",
  });
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
