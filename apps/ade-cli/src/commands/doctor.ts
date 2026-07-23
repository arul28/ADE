import type {
  SyncAccountDirectoryHealth,
  SyncRouteHealth,
} from "../../../desktop/src/shared/types/sync";
import type {
  BrainLoopWatchdogBreadcrumb,
} from "../services/runtime/brainLoopWatchdog";
import type {
  SyncListenerPortDiagnosis,
} from "../services/sync/sharedSyncListener";

export type DoctorRowStatus = "ok" | "warn" | "fail";

export type DoctorRow = {
  key:
    | "app"
    | "brain"
    | "wedge"
    | "sync_port"
    | "publish"
    | "relay"
    | "account";
  label: string;
  status: DoctorRowStatus;
  detail: string;
};

export type DoctorBrainInput = {
  running: boolean;
  version: string | null;
  buildHash: string | null;
  pid: number | null;
  uptimeMs: number | null;
  mismatchReason: string | null;
  error: string | null;
};

export type DoctorPublishHealth = Pick<
  SyncAccountDirectoryHealth,
  "state" | "failingSinceMs" | "lastLegDurations"
> & Partial<Pick<SyncAccountDirectoryHealth, "lastSuccessAt" | "skipReason">>;

export type DoctorInput = {
  nowMs: number;
  app: {
    installedVersion: string | null;
    latestKnownVersion: string | null;
    path: string | null;
    online: boolean;
  };
  brain: DoctorBrainInput;
  wedge: BrainLoopWatchdogBreadcrumb | null;
  syncPort: number | null;
  portDiagnoses: SyncListenerPortDiagnosis[];
  publishHealth: DoctorPublishHealth | null;
  relayHealth: (SyncRouteHealth["relay"] & {
    relayEndToEndVerifiedAt?: string | null;
    relayEndToEndFailure?: string | null;
  }) | null;
  account: {
    signedIn: boolean | null;
    source: string | null;
    error: string | null;
  };
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const RECENT_PUBLISH_MS = 2 * 60 * 1_000;
const PUBLISH_FAILURE_RED_MS = 2 * 60 * 1_000;

function normalizedVersionParts(value: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+){0,3})/.exec(value.trim());
  return match ? match[1]!.split(".").map((part) => Number.parseInt(part, 10)) : null;
}

export function compareDoctorVersions(left: string, right: string): number | null {
  const leftParts = normalizedVersionParts(left);
  const rightParts = normalizedVersionParts(right);
  if (!leftParts || !rightParts) return null;
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function compactDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatUptime(ms: number | null): string {
  return ms == null ? "" : ` · uptime ${compactDuration(ms)}`;
}

function slowestPublishLeg(
  health: DoctorPublishHealth,
): { leg: keyof DoctorPublishHealth["lastLegDurations"]; durationMs: number } | null {
  let slowest: ReturnType<typeof slowestPublishLeg> = null;
  for (const [leg, rawDuration] of Object.entries(health.lastLegDurations) as Array<
    [keyof DoctorPublishHealth["lastLegDurations"], number | null]
  >) {
    if (rawDuration == null || (slowest && rawDuration <= slowest.durationMs)) continue;
    slowest = { leg, durationMs: rawDuration };
  }
  return slowest;
}

function publishLegDetail(health: DoctorPublishHealth): string {
  const slowest = slowestPublishLeg(health);
  return slowest
    ? ` · slow leg: ${slowest.leg} (${(slowest.durationMs / 1_000).toFixed(1)}s)`
    : "";
}

function appRow(input: DoctorInput["app"]): DoctorRow {
  if (!input.installedVersion) {
    return {
      key: "app",
      label: "App",
      status: "warn",
      detail: "ADE desktop was not found on disk.",
    };
  }
  if (!input.latestKnownVersion) {
    return {
      key: "app",
      label: "App",
      status: "ok",
      detail: `installed ${input.installedVersion} · latest not checked${input.online ? " (unavailable)" : " (use --online)"}`,
    };
  }
  const comparison = compareDoctorVersions(input.installedVersion, input.latestKnownVersion);
  return {
    key: "app",
    label: "App",
    status: comparison != null && comparison < 0 ? "warn" : "ok",
    detail: `installed ${input.installedVersion} · latest ${input.latestKnownVersion}`,
  };
}

function brainRow(input: DoctorBrainInput): DoctorRow {
  if (!input.running) {
    return {
      key: "brain",
      label: "Brain",
      status: "fail",
      detail: input.error ? `not responding · ${input.error}` : "not responding",
    };
  }
  const identity = [
    input.version ? `version ${input.version}` : "version unknown",
    input.pid ? `pid ${input.pid}` : "pid unknown",
  ].join(" · ");
  return {
    key: "brain",
    label: "Brain",
    status: input.mismatchReason ? "fail" : "ok",
    detail: input.mismatchReason
      ? `${identity} · ${input.mismatchReason}${formatUptime(input.uptimeMs)}`
      : `${identity}${formatUptime(input.uptimeMs)}`,
  };
}

function wedgeRow(
  wedge: BrainLoopWatchdogBreadcrumb | null,
  nowMs: number,
): DoctorRow {
  if (!wedge) {
    return {
      key: "wedge",
      label: "Wedge history",
      status: "ok",
      detail: "no recovered wedge recorded",
    };
  }
  const timestampMs = Date.parse(wedge.ts);
  const ageMs = Number.isFinite(timestampMs) ? Math.max(0, nowMs - timestampMs) : null;
  return {
    key: "wedge",
    label: "Wedge history",
    status: ageMs != null && ageMs <= DAY_MS ? "warn" : "ok",
    detail: `${wedge.lastCommand} blocked ${compactDuration(wedge.blockedMs)} · ${
      ageMs == null ? wedge.ts : `${compactDuration(ageMs)} ago`
    }`,
  };
}

function syncPortRow(input: DoctorInput): DoctorRow {
  if (input.syncPort == null) {
    return {
      key: "sync_port",
      label: "Sync port",
      status: input.brain.running ? "fail" : "warn",
      detail: input.brain.running ? "brain did not report a bound sync port" : "unavailable while brain is down",
    };
  }
  if (input.syncPort === 8787) {
    return {
      key: "sync_port",
      label: "Sync port",
      status: "ok",
      detail: "bound on 8787",
    };
  }
  const holders = input.portDiagnoses.flatMap((diagnosis) =>
    diagnosis.holders.map((holder) =>
      `${diagnosis.port}: pid ${holder.pid}${holder.command ? ` ${holder.command}` : ""}`,
    ),
  );
  return {
    key: "sync_port",
    label: "Sync port",
    status: "warn",
    detail: `bound on ${input.syncPort} instead of 8787${
      holders.length ? ` · base holders: ${holders.join("; ")}` : " · first three base ports have no visible holders"
    }`,
  };
}

function publishRow(
  health: DoctorPublishHealth | null,
  nowMs: number,
): DoctorRow {
  if (!health) {
    return {
      key: "publish",
      label: "Publish health",
      status: "warn",
      detail: "account-directory health unavailable",
    };
  }
  const failingForMs = health.failingSinceMs == null
    ? null
    : Math.max(0, nowMs - health.failingSinceMs);
  if (failingForMs != null && failingForMs >= PUBLISH_FAILURE_RED_MS) {
    return {
      key: "publish",
      label: "Publish health",
      status: "fail",
      detail: `failing for ${compactDuration(failingForMs)} · ${health.state}${publishLegDetail(health)}`,
    };
  }
  if (health.state === "published") {
    const successAgeMs = health.lastSuccessAt == null
      ? null
      : Math.max(0, nowMs - health.lastSuccessAt);
    if (successAgeMs != null && successAgeMs <= RECENT_PUBLISH_MS) {
      return {
        key: "publish",
        label: "Publish health",
        status: "ok",
        detail: `published ${compactDuration(successAgeMs)} ago${publishLegDetail(health)}`,
      };
    }
  }
  return {
    key: "publish",
    label: "Publish health",
    status: "warn",
    detail: failingForMs == null
      ? `${health.state}${health.skipReason ? ` · ${health.skipReason}` : ""}`
      : `failing for ${compactDuration(failingForMs)} · ${health.state}${publishLegDetail(health)}`,
  };
}

function relayRow(relay: DoctorInput["relayHealth"]): DoctorRow {
  if (!relay) {
    return {
      key: "relay",
      label: "Relay",
      status: "warn",
      detail: "route health unavailable",
    };
  }
  if (relay.enabled !== true) {
    return {
      key: "relay",
      label: "Relay",
      status: "warn",
      detail: relay.skipReason ?? "disabled",
    };
  }
  const failure = relay.relayEndToEndFailure
    ?? relay.skipReason
    ?? relay.lastControlError
    ?? null;
  const healthy = relay.relayControlConnected === true
    && relay.relayBridgeValidated === true
    && Boolean(relay.relayEndToEndVerifiedAt)
    && !failure;
  return {
    key: "relay",
    label: "Relay",
    status: healthy ? "ok" : "fail",
    detail: healthy
      ? `reachable · verified ${relay.relayEndToEndVerifiedAt}`
      : failure ?? "relay route is not fully validated",
  };
}

function accountRow(account: DoctorInput["account"]): DoctorRow {
  if (account.signedIn === true) {
    return {
      key: "account",
      label: "Account",
      status: "ok",
      detail: `signed in${account.source ? ` · ${account.source}` : ""}`,
    };
  }
  return {
    key: "account",
    label: "Account",
    status: "warn",
    detail: account.error ?? (account.signedIn === false ? "signed out" : "status unavailable"),
  };
}

export function evaluateDoctorRows(input: DoctorInput): DoctorRow[] {
  return [
    appRow(input.app),
    brainRow(input.brain),
    wedgeRow(input.wedge, input.nowMs),
    syncPortRow(input),
    publishRow(input.publishHealth, input.nowMs),
    relayRow(input.relayHealth),
    accountRow(input.account),
  ];
}
