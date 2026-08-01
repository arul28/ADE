import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  parseRuntimeLastWedge,
  parseRuntimePublishHealth,
  type RuntimePublishHealth,
} from "../../../desktop/src/shared/adeRuntimeProtocol";
import type {
  SyncAccountDirectoryHealth,
  SyncRouteHealth,
} from "../../../desktop/src/shared/types/sync";
import type {
  BrainLoopWatchdogBreadcrumb,
} from "../services/runtime/brainLoopWatchdog";
import { readBrainLoopWatchdogLastWedge } from "../services/runtime/brainLoopWatchdog";
import { resolveMachineAdeLayout } from "../services/projects/machineLayout";
import { DEFAULT_SYNC_HOST_PORT } from "../services/sync/syncProtocol";
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

export type DoctorCommandOptions = {
  role: "cto" | "orchestrator" | "agent" | "external" | "evaluator";
  socketPath: string | null;
};

export type DoctorMachineRuntimeInfo = {
  version: string | null;
  buildHash: string | null;
  defaultRole: string | null;
  packageChannel: string | null;
  projectRoot: string | null;
  pid: number | null;
  uptimeMs: number | null;
};

type DoctorRpcClient = {
  request(method: string, params?: unknown): Promise<unknown>;
  destroy(): void;
};

export type DoctorCommandDependencies<
  Options extends DoctorCommandOptions = DoctorCommandOptions,
> = {
  resolveMachineRuntimeSocketPath(
    socketPathOverride?: string | null,
  ): Promise<string>;
  connectRuntime(
    socketPath: string,
    timeoutMs: number,
    label?: string,
  ): Promise<DoctorRpcClient>;
  buildInitializeParams(
    options: Options,
    clientName: string,
  ): Record<string, unknown>;
  readMachineRuntimeInfo(value: unknown): DoctorMachineRuntimeInfo;
  resolveExpectedMachineRuntimeBuildHash(): Promise<string | null>;
  machineRuntimeMismatchReason(
    runtimeInfo: DoctorMachineRuntimeInfo,
    expectedBuildHash: string | null,
    expectedDefaultRole: Options["role"],
  ): string | null;
  unwrapActionEnvelope(value: unknown): unknown;
};

export type DoctorCommandResult = {
  ok: boolean;
  checkedAt: string;
  online: boolean;
  rows: DoctorRow[];
  app: DoctorInput["app"];
  brain: DoctorInput["brain"];
  wedge: DoctorInput["wedge"];
  syncPort: number | null;
  portDiagnoses: DoctorInput["portDiagnoses"];
  publishHealth: DoctorInput["publishHealth"];
  relayHealth: DoctorInput["relayHealth"];
  account: DoctorInput["account"];
};

type DoctorBrainProbe = {
  brain: DoctorInput["brain"];
  syncStatus: Record<string, unknown> | null;
  account: DoctorInput["account"];
  runtimeSyncPort: number | null;
  runtimePublishHealth: DoctorInput["publishHealth"];
  runtimeLastWedge: DoctorInput["wedge"];
};

const DOCTOR_BRAIN_DEADLINE_MS = 2_000;
const DOCTOR_ONLINE_DEADLINE_MS = 1_200;
const DAY_MS = 24 * 60 * 60 * 1_000;
const RECENT_PUBLISH_MS = 2 * 60 * 1_000;
const PUBLISH_FAILURE_RED_MS = 2 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function doctorTimeout<T>(
  promise: Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), Math.max(1, deadlineMs));
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function toDoctorPublishHealth(
  health: RuntimePublishHealth | null,
): DoctorInput["publishHealth"] {
  return health
    ? {
        ...health,
        state: health.state.trim() as NonNullable<DoctorInput["publishHealth"]>["state"],
      }
    : null;
}

export function doctorRuntimeStatusFromInitialize(value: unknown): {
  syncPort: number | null;
  publishHealth: DoctorInput["publishHealth"];
  lastWedge: DoctorInput["wedge"];
} {
  const runtimeInfo = isRecord(value) && isRecord(value.runtimeInfo)
    ? value.runtimeInfo
    : {};
  const syncPort = typeof runtimeInfo.syncPort === "number"
    && Number.isInteger(runtimeInfo.syncPort)
    && runtimeInfo.syncPort > 0
    && runtimeInfo.syncPort <= 65_535
    ? runtimeInfo.syncPort
    : null;
  return {
    syncPort,
    publishHealth: toDoctorPublishHealth(
      parseRuntimePublishHealth(runtimeInfo.publishHealth),
    ),
    lastWedge: parseRuntimeLastWedge(runtimeInfo.lastWedge),
  };
}

export async function probeDoctorBrain<Options extends DoctorCommandOptions>(
  options: Options,
  dependencies: DoctorCommandDependencies<Options>,
): Promise<DoctorBrainProbe> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + DOCTOR_BRAIN_DEADLINE_MS;
  const socketPath = await dependencies.resolveMachineRuntimeSocketPath(options.socketPath);
  let client: DoctorRpcClient | null = null;
  try {
    const remaining = () => Math.max(1, deadlineAt - Date.now());
    client = await doctorTimeout(
      dependencies.connectRuntime(socketPath, remaining(), "ADE brain"),
      remaining(),
      "ADE brain connection",
    );
    const initializeResult = await doctorTimeout(
      client.request(
        "ade/initialize",
        dependencies.buildInitializeParams(options, "ade-doctor"),
      ),
      remaining(),
      "ADE brain initialize",
    );
    const runtimeInfo = dependencies.readMachineRuntimeInfo(initializeResult);
    const runtimeStatus = doctorRuntimeStatusFromInitialize(initializeResult);
    const expectedBuildHash = await doctorTimeout(
      dependencies.resolveExpectedMachineRuntimeBuildHash(),
      remaining(),
      "ADE runtime build identity",
    ).catch(() => null);
    const mismatchReason = dependencies.machineRuntimeMismatchReason(
      runtimeInfo,
      expectedBuildHash,
      options.role,
    );
    const [syncResult, accountResult] = await doctorTimeout(
      Promise.allSettled([
        client.request("sync.getStatus", { includeTransferReadiness: false }),
        client.request("account.call", { action: "status", args: {} }),
      ]),
      remaining(),
      "ADE brain health reads",
    ).catch((error): [
      PromiseRejectedResult,
      PromiseRejectedResult,
    ] => {
      const reason = error instanceof Error ? error : new Error(String(error));
      return [
        { status: "rejected", reason },
        { status: "rejected", reason },
      ];
    });
    const syncStatus = syncResult.status === "fulfilled" && isRecord(syncResult.value)
      ? syncResult.value
      : null;
    const accountValue = accountResult.status === "fulfilled"
      ? dependencies.unwrapActionEnvelope(accountResult.value)
      : null;
    const accountStatus = isRecord(accountValue) ? accountValue : null;
    return {
      brain: {
        running: true,
        version: runtimeInfo.version,
        buildHash: runtimeInfo.buildHash,
        pid: runtimeInfo.pid,
        uptimeMs: runtimeInfo.uptimeMs,
        mismatchReason,
        error: null,
      },
      syncStatus,
      account: {
        signedIn: typeof accountStatus?.signedIn === "boolean" ? accountStatus.signedIn : null,
        source: asString(accountStatus?.source),
        error: accountResult.status === "rejected"
          ? accountResult.reason instanceof Error
            ? accountResult.reason.message
            : String(accountResult.reason)
          : accountStatus
            ? null
            : "Account status unavailable.",
      },
      runtimeSyncPort: runtimeStatus.syncPort,
      runtimePublishHealth: runtimeStatus.publishHealth,
      runtimeLastWedge: runtimeStatus.lastWedge,
    };
  } catch (error) {
    return {
      brain: {
        running: false,
        version: null,
        buildHash: null,
        pid: null,
        uptimeMs: null,
        mismatchReason: null,
        error: error instanceof Error ? error.message : String(error),
      },
      syncStatus: null,
      account: {
        signedIn: null,
        source: null,
        error: "Brain unavailable.",
      },
      runtimeSyncPort: null,
      runtimePublishHealth: null,
      runtimeLastWedge: null,
    };
  } finally {
    try {
      client?.destroy();
    } catch {}
  }
}

export function resolveDefaultDesktopAppName(): string {
  const explicit = process.env.ADE_DESKTOP_APP_NAME?.trim();
  if (explicit) return explicit;
  const channel = process.env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase();
  if (channel === "alpha") return "ADE Alpha";
  if (channel === "beta") return "ADE Beta";
  return "ADE";
}

export function readInstalledDesktopVersion(
  appPaths?: string[],
): { version: string | null; path: string | null } {
  if (process.platform !== "darwin" && !appPaths) {
    return { version: null, path: null };
  }
  const explicitPath = process.env.ADE_DESKTOP_APP_PATH?.trim();
  const preferredName = resolveDefaultDesktopAppName();
  const candidates = appPaths ?? [
    ...(explicitPath ? [explicitPath] : []),
    `/Applications/${preferredName}.app`,
    "/Applications/ADE.app",
    "/Applications/ADE Beta.app",
    "/Applications/ADE Alpha.app",
  ];
  for (const appPath of Array.from(new Set(candidates))) {
    const infoPlist = path.join(appPath, "Contents", "Info.plist");
    if (!fs.existsSync(infoPlist)) continue;
    try {
      const raw = fs.readFileSync(infoPlist, "utf8");
      const xmlMatch = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i.exec(raw);
      if (xmlMatch?.[1]?.trim()) {
        return { version: xmlMatch[1].trim(), path: appPath };
      }
    } catch {
      // Binary plists are handled by plutil below.
    }
    const result = spawnSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlist],
      { encoding: "utf8", timeout: 500 },
    );
    const version = typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (result.status === 0 && version) {
      return { version, path: appPath };
    }
  }
  return { version: null, path: null };
}

async function readLatestDesktopVersionOnline(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCTOR_ONLINE_DEADLINE_MS);
  try {
    const { fetchAdeLatestRelease } = await import(
      "../../../desktop/src/main/services/github/adeReleaseFeed"
    );
    const release = await doctorTimeout(
      fetchAdeLatestRelease({
        fetchImpl: ((input: string, init?: RequestInit) =>
          fetch(input, { ...init, signal: controller.signal })) as never,
      }),
      DOCTOR_ONLINE_DEADLINE_MS,
      "Latest release check",
    );
    return release?.version ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readLatestKnownDesktopVersionFromDisk(runtimeDir: string): string | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runtimeDir, "update-status.json"), "utf8"),
    ) as Record<string, unknown>;
    return asString(parsed.version);
  } catch {
    return null;
  }
}

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
      holders.length
        ? ` · base holders: ${holders.join("; ")}`
        // "No visible holders" reads as "the ports are free", which is exactly
        // the wrong conclusion: the holder is usually tailscaled, and it runs
        // as root so this probe cannot see it. Point at the check that can.
        : " · no holders visible to this user (a root-owned holder such as"
          + " tailscaled is invisible here — check `tailscale serve status`"
          + " and `netstat -an -p tcp`)"
    }${
      // The usual cause is ADE's own stranded `tailscale serve` entries from
      // earlier runs. The host now reclaims those on its next publish, so the
      // fix is a brain restart, not 60-odd manual `serve --tcp=N off` calls.
      holders.length ? "" : " · ADE reclaims its own stale serve entries on the"
        + " next publish; `ade brain restart` should return it to 8787"
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
  // Suppression outranks every other failure: while another ADE process owns
  // this machine's relay slot, nothing downstream can succeed and no other
  // reason tells the user what to do about it.
  const failure = (relay.relayControlSuppressed === true
    ? relay.relayControlSuppressedReason ?? "Relay control is suppressed."
    : null)
    ?? relay.relayEndToEndFailure
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

export async function runDoctorCommand<Options extends DoctorCommandOptions>(
  online: boolean,
  options: Options,
  dependencies: DoctorCommandDependencies<Options>,
): Promise<DoctorCommandResult> {
  const nowMs = Date.now();
  const layout = resolveMachineAdeLayout();
  const diskLatestKnownVersion = readLatestKnownDesktopVersionFromDisk(layout.runtimeDir);
  const [installedApp, latestKnownVersion, brainProbe] = await Promise.all([
    Promise.resolve(readInstalledDesktopVersion()),
    online
      ? readLatestDesktopVersionOnline().then((version) => version ?? diskLatestKnownVersion)
      : Promise.resolve(diskLatestKnownVersion),
    probeDoctorBrain(options, dependencies),
  ]);
  const syncRouteHealth = brainProbe.syncStatus && isRecord(brainProbe.syncStatus.routeHealth)
    ? brainProbe.syncStatus.routeHealth
    : null;
  const listener = syncRouteHealth && isRecord(syncRouteHealth.listener)
    ? syncRouteHealth.listener
    : null;
  const syncPort = typeof listener?.port === "number" && Number.isInteger(listener.port)
    ? listener.port
    : brainProbe.runtimeSyncPort;
  const rawPublishHealth = syncRouteHealth && isRecord(syncRouteHealth.accountDirectory)
    ? syncRouteHealth.accountDirectory
    : null;
  const publishHealth = rawPublishHealth
    ? toDoctorPublishHealth(parseRuntimePublishHealth(rawPublishHealth))
    : brainProbe.runtimePublishHealth;
  const relayHealth = syncRouteHealth && isRecord(syncRouteHealth.relay)
    ? syncRouteHealth.relay as DoctorInput["relayHealth"]
    : null;
  let portDiagnoses: DoctorInput["portDiagnoses"] = [];
  if (brainProbe.brain.running && syncPort != null && syncPort !== DEFAULT_SYNC_HOST_PORT) {
    const { inspectSyncListenerPort } = await import("../services/sync/sharedSyncListener");
    portDiagnoses = await Promise.all([
      inspectSyncListenerPort(DEFAULT_SYNC_HOST_PORT),
      inspectSyncListenerPort(DEFAULT_SYNC_HOST_PORT + 1),
      inspectSyncListenerPort(DEFAULT_SYNC_HOST_PORT + 2),
    ]);
  }
  const wedge = readBrainLoopWatchdogLastWedge(layout.runtimeDir)
    ?? brainProbe.runtimeLastWedge;
  const input: DoctorInput = {
    nowMs,
    app: {
      installedVersion: installedApp.version,
      latestKnownVersion,
      path: installedApp.path,
      online,
    },
    brain: brainProbe.brain,
    wedge,
    syncPort,
    portDiagnoses,
    publishHealth,
    relayHealth,
    account: brainProbe.account,
  };
  const rows = evaluateDoctorRows(input);
  return {
    ok: !rows.some((row) => row.status === "fail"),
    checkedAt: new Date(nowMs).toISOString(),
    online,
    rows,
    app: input.app,
    brain: input.brain,
    wedge,
    syncPort,
    portDiagnoses,
    publishHealth,
    relayHealth,
    account: input.account,
  };
}
