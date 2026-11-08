import { forwardSignalToSentry } from "../../../shared/sentry/logBridge";
import type {
  RemoteRuntimeConnectionAttempt,
  RemoteRuntimeConnectionRoute,
} from "../../../shared/types/remoteRuntime";
import type { PairedRuntimeRouteDiagnostic } from "./pairedRuntimeErrors";
import type { Logger } from "../logging/logger";
import { pairedRuntimeFailureCode } from "./pairedRuntimeRoutes";

/**
 * One record per outage of why this computer could not reach another one. The
 * routes tried, how each ended and how long it took live only on the error
 * otherwise, and that is gone once the next dial replaces it: a failed
 * connection after an update left no way to say what had happened.
 *
 * The first failure of an outage is reported, then one an hour, because a
 * machine that is off for a week fails its dial all week. The Sentry event
 * gets each route's kind and result, never its address; the hosts are only in
 * the local log line, which a report's log tail carries like any other.
 * `device_ref` and `peer_device_ref` are the same two values the other
 * machine's `sync_host.peer_accepted` reports, the other way round.
 */

const REPEAT_REPORT_INTERVAL_MS = 60 * 60 * 1_000;

export type RemoteDialOutcome = "failed" | "recovered";

type RemoteDialTarget = {
  deviceRef: string | null;
  peerDeviceRef: string | null;
  peerVersion: string | null;
  lastConnectedAt: number | null;
};

type Outage = { startedAt: number; failures: number; reportedAt: number | null };

type RemoteDialTelemetryDeps = {
  describeTarget: (targetId: string) => RemoteDialTarget | null;
  logger?: Pick<Logger, "info">;
  onOutcome?: (outcome: RemoteDialOutcome) => void;
};

function summarizeRoutes(attempts: readonly RemoteRuntimeConnectionAttempt[] | undefined): string {
  return (attempts ?? [])
    .map((attempt) => [attempt.kind, attempt.outcome, attempt.failure ?? "", attempt.errorCode ?? "", attempt.durationMs].join(":"))
    .join(" ");
}

export class RemoteDialTelemetry {
  private readonly outagesByTargetId = new Map<string, Outage>();

  constructor(private readonly deps: RemoteDialTelemetryDeps) {}

  noteFailed(targetId: string, error: unknown): void {
    const now = Date.now();
    const existing = this.outagesByTargetId.get(targetId);
    const outage: Outage = existing ?? { startedAt: now, failures: 0, reportedAt: null };
    outage.failures += 1;
    this.outagesByTargetId.set(targetId, outage);
    if (!existing) this.deps.onOutcome?.("failed");
    if (outage.reportedAt != null && now - outage.reportedAt < REPEAT_REPORT_INTERVAL_MS) return;

    const diagnostic = (error as { diagnostic?: PairedRuntimeRouteDiagnostic } | null)?.diagnostic;
    const base = this.commonFields(targetId, outage, now);
    const fields = {
      ...base,
      correlationId: diagnostic?.correlationId ?? null,
      failure: diagnostic?.failure ?? null,
      errorCode: pairedRuntimeFailureCode(error) ?? null,
      errorType: error instanceof Error ? error.name : typeof error,
      routes: summarizeRoutes(diagnostic?.attempts),
      omittedRoutes: diagnostic?.omittedAttemptCount ?? 0,
    };
    this.deps.logger?.info("remote.connect_failed", { ...fields, attempts: diagnostic?.attempts ?? [] });
    forwardSignalToSentry("remote.connect_failed", fields, base.peer_device_ref ?? targetId);
    outage.reportedAt = now;
  }

  noteConnected(targetId: string, route: RemoteRuntimeConnectionRoute | undefined): void {
    const outage = this.outagesByTargetId.get(targetId);
    if (!outage) return;
    this.outagesByTargetId.delete(targetId);
    this.deps.onOutcome?.("recovered");
    const now = Date.now();
    const base = this.commonFields(targetId, outage, now);
    const fields = {
      ...base,
      correlationId: route?.correlationId ?? null,
      routeKind: route?.kind ?? null,
      routes: summarizeRoutes(route?.attempts),
    };
    this.deps.logger?.info("remote.connect_recovered", fields);
    forwardSignalToSentry("remote.connect_recovered", fields, base.peer_device_ref ?? targetId, "info");
  }

  private commonFields(targetId: string, outage: Outage, now: number) {
    const target = this.deps.describeTarget(targetId);
    return {
      device_ref: target?.deviceRef ?? null,
      peer_device_ref: target?.peerDeviceRef ?? null,
      peerVersion: target?.peerVersion ?? null,
      failures: outage.failures,
      outageMs: Math.max(0, now - outage.startedAt),
      sinceLastConnectedMs: target?.lastConnectedAt != null ? Math.max(0, now - target.lastConnectedAt) : null,
      appUptimeMs: Math.round(process.uptime() * 1_000),
    };
  }
}
