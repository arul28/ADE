import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { syncDeviceTelemetryRef } from "../../../../desktop/src/main/services/analytics/machineTelemetryId";
import { forwardSignalToSentry } from "../../../../desktop/src/shared/sentry/logBridge";
import type { SyncHelloErrorPayload, SyncHelloPayload } from "../../../../desktop/src/shared/types/sync";

/**
 * The dialed machine's half of a connection problem, matched to the dialer's
 * `remote.connect_failed` by `device_ref` and `peer_device_ref`, which that
 * side reports the other way round. Both hello ingresses report here: the
 * project host and the brain's fallback, which answers while no project is
 * open, as it is right after a restart.
 *
 * A rejected hello can come from anyone who reaches the port, so nothing from
 * it is logged unbounded. Reporting never gets in the way of the handshake.
 */

type HelloTelemetryInput = {
  logger: Pick<Logger, "info" | "warn">;
  hello: SyncHelloPayload;
  transportOrigin: string | null | undefined;
  /** Read only when a report is made; it can touch the device table. */
  hostDeviceId: () => string;
};

function helloFields({ hello, transportOrigin, hostDeviceId }: HelloTelemetryInput) {
  const deviceType: unknown = hello.peer.deviceType;
  return {
    authKind: hello.auth?.kind ?? null,
    transportOrigin: transportOrigin ?? null,
    deviceType: typeof deviceType === "string" ? deviceType.slice(0, 32) : "invalid",
    peerAppVersion: hello.peer.appVersion?.slice(0, 48) ?? null,
    host_uptime_ms: Math.round(process.uptime() * 1_000),
    device_ref: syncDeviceTelemetryRef(hostDeviceId()),
    peer_device_ref: syncDeviceTelemetryRef(hello.peer.deviceId),
  };
}

function reportSafely(input: HelloTelemetryInput, report: () => void): void {
  try {
    report();
  } catch (error) {
    input.logger.warn("sync_host.hello_telemetry_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function reportHelloRejected(input: HelloTelemetryInput, code: SyncHelloErrorPayload["code"]): void {
  reportSafely(input, () => {
    input.logger.warn("sync_host.hello_rejected", { code, ...helloFields(input) });
  });
}

export function reportPeerAccepted(input: HelloTelemetryInput): void {
  if (input.hello.peer.deviceType !== "desktop" || input.hello.peer.connectionPurpose === "probe") return;
  reportSafely(input, () => {
    const fields = helloFields(input);
    input.logger.info("sync_host.peer_accepted", fields);
    forwardSignalToSentry("sync_host.peer_accepted", fields, fields.peer_device_ref ?? "unknown", "info");
  });
}
