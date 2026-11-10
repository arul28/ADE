import { nowIso } from "../shared/utils";
import { addSentryBreadcrumb, captureProblem } from "../../../shared/sentry/capture";
import { isExpectedOutcomeText } from "../../../shared/sentry/expectedFailure";
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

/** What a failure report carries beyond the health row: never shown, never part of its identity. */
export type ProviderRuntimeFailureDetail = {
  /** The provider process's last stderr lines, already scrubbed and bounded. */
  stderrTail?: string | null;
  /** Counts and closed values about the process that failed (alive, bytes written, age). No free text. */
  startup?: Record<string, number | boolean | string | null> | null;
};

function setProviderRuntimeHealth(next: ProviderRuntimeHealth, detail?: ProviderRuntimeFailureDetail): void {
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
  reportHealthTransition(previous ?? null, next, detail);
}

/**
 * What kind of failure a runtime message names, from a closed list. One
 * provider fails for unrelated reasons (a refused flag, a missing session, a
 * spawn the machine could not do), and each is its own Sentry issue. The
 * message itself can hold paths and ids, so only the kind is a key.
 */
const RUNTIME_FAILURE_KINDS: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
  ["root-refused", /\bcannot be used with root\b/i],
  // Before `session-missing`: an ACP method name can start with `session/`.
  ["method-missing", /\bmethod not found\b|\(-32601\)/i],
  ["session-missing", /\bno conversation found\b|\bsession\b.*\bnot found\b/i],
  ["turn-active", /\bturn already active\b/i],
  ["owned-elsewhere", /\balready owned by another\b/i],
  ["timeout", /\bdid not answer within\b|\btimed out\b/i],
  ["spawn-failed", /\bfailed to spawn\b|\bcould not start\b/i],
  // Node's `spawn <path> EAGAIN`: the path can hold spaces (a Windows Program
  // Files path), and Windows can say `UNKNOWN`. Case-sensitive, so a word such
  // as "error" is not a code.
  ["spawn-failed", /\bspawn\b.*\b(?:E[A-Z]{2,}|UNKNOWN)\b/],
  ["exited", /\bexited with code\b/i],
];

/** ADE's own ACP timeout names the method it sent (`ACP session/new did not answer within …`). */
const ACP_TIMEOUT_METHOD = /\bACP ([a-z_]+(?:\/[a-z_]+)?) did not answer within\b/i;

function runtimeFailureKind(message: string | null): string {
  const text = message ?? "";
  const kind = RUNTIME_FAILURE_KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
  if (kind !== "timeout") return kind;
  const method = ACP_TIMEOUT_METHOD.exec(text)?.[1]?.toLowerCase();
  return method ? `timeout:${method}` : kind;
}

/** Provider and failure kinds this process already sent to Sentry. */
const reportedRuntimeFailures = new Set<string>();

/**
 * A provider that stops working is the failure users notice first and report
 * least: the chat just says it cannot start. The app shows every transition.
 * Sentry gets the first runtime failure of each kind per provider per
 * process, as a warning: most are the machine (a CLI that will not start
 * there, a probe that timed out) rather than ADE, and a provider that flaps
 * on one machine was an error event, and an alert, each time. Later ones are
 * Sentry Logs.
 * A recovery leaves a breadcrumb. Auth failures are only logged, since
 * signing out is not a bug.
 */
function reportHealthTransition(
  previous: ProviderRuntimeHealth | null,
  next: ProviderRuntimeHealth,
  detail?: ProviderRuntimeFailureDetail,
): void {
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
  const kind = runtimeFailureKind(next.message);
  const reportKey = `${next.provider}:${kind}`;
  const stderrTail = detail?.stderrTail?.trim() || null;
  const startup = detail?.startup ?? null;
  const extra = { ...(stderrTail ? { stderrTail } : {}), ...(startup ? { startup } : {}) };
  // A refusal the provider gave on purpose (a plan without Cloud Agents) is an
  // answer the user sees, like every other expected outcome: a log, not an issue.
  if (reportedRuntimeFailures.has(reportKey) || isExpectedOutcomeText(next.message ?? "")) {
    forwardLogToSentry("warn", `provider.${next.provider}.runtime_failed`, {
      message: next.message ?? null,
      kind,
      ...extra,
    });
    return;
  }
  reportedRuntimeFailures.add(reportKey);
  captureProblem(`Provider ${next.provider} ${next.state}: ${next.message ?? "no message"}`, {
    tags: { provider: next.provider, "provider.state": next.state, "provider.failure": kind },
    fingerprint: ["provider", next.provider, next.state, kind],
    level: "warning",
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
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
  detail?: ProviderRuntimeFailureDetail,
): void {
  setProviderRuntimeHealth({
    provider,
    state: "runtime-failed",
    message: message.trim() || null,
    checkedAt: nowIso(),
  }, detail);
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
