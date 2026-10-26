import type {
  DesktopPairedMachineCredentials,
} from "../../../shared/types/pairedRuntime";
import type {
  RemoteRuntimeDoctorCheck,
  RemoteRuntimeDoctorResult,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetRoute,
} from "../../../shared/types/remoteRuntime";
import {
  buildPairedEndpointCandidates,
  classifyPairedRuntimeFailure,
} from "./pairedRuntimeRoutes";
import type {
  RemoteRuntimeDoctorFailure,
  RemoteRuntimeHostStall,
} from "../../../shared/types/remoteRuntime";
import { hostStallFromHello } from "../../../shared/connectionDiagnosis";
import {
  openPairedSyncConnection,
  type AuthenticatedSyncConnection,
} from "./syncRuntimeTransport";
import {
  buildSshRouteCandidates,
  scanSshHostKeyForTarget,
} from "./sshTransport";

const DEFAULT_DOCTOR_TIMEOUT_MS = 5_000;

/** What a successful paired probe learned from the machine's handshake. */
type PairedProbeResult = { hostStall: RemoteRuntimeHostStall | null } | void;

export type RemoteRuntimeDoctorDependencies = {
  probePaired?: (
    endpoint: string,
    credentials: DesktopPairedMachineCredentials,
    timeoutMs: number,
  ) => Promise<PairedProbeResult>;
  probeSsh?: (
    target: RemoteRuntimeTarget,
    route: RemoteRuntimeTargetRoute,
    timeoutMs: number,
  ) => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sshEndpoint(route: RemoteRuntimeTargetRoute, fallbackPort: number | null): string {
  const host = route.hostname.includes(":") && !route.hostname.startsWith("[")
    ? `[${route.hostname}]`
    : route.hostname;
  return `${host}:${route.port ?? fallbackPort ?? 22}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function defaultPairedProbe(
  endpoint: string,
  credentials: DesktopPairedMachineCredentials,
  timeoutMs: number,
): Promise<PairedProbeResult> {
  let connection: AuthenticatedSyncConnection | null = null;
  try {
    connection = await openPairedSyncConnection({
      endpoint,
      credentials,
      connectTimeoutMs: timeoutMs,
      authTimeoutMs: timeoutMs,
    });
    if (connection.hello.features?.rpcChannel !== true) {
      throw new Error("The host does not advertise runtime RPC support.");
    }
    if (connection.hello.features?.portForward !== true) {
      throw new Error("The host does not advertise port-forward support.");
    }
    return { hostStall: hostStallFromHello(connection.hello, Date.now()) };
  } finally {
    connection?.close(1000, "Connection doctor probe finished.");
  }
}

async function defaultSshProbe(
  target: RemoteRuntimeTarget,
  route: RemoteRuntimeTargetRoute,
  timeoutMs: number,
): Promise<void> {
  await scanSshHostKeyForTarget({
    ...target,
    hostname: route.hostname,
    port: route.port ?? target.port,
    routes: [],
  }, {
    env: {
      ...process.env,
      ADE_REMOTE_SSH_CONNECT_TIMEOUT_MS: String(timeoutMs),
    },
  });
}

/** The relay's close code for "no host is connected for that machine". */
const RELAY_CLOSE_HOST_OFFLINE = 4501;

/**
 * Which part of the path failed, from the error's structure first and its
 * text last. A relay that answers and says the machine is not connected is a
 * different problem (the machine) from a relay this computer cannot resolve
 * (this computer's network).
 */
export function classifyDoctorFailure(
  route: RemoteRuntimeDoctorCheck["route"],
  error: unknown,
): RemoteRuntimeDoctorFailure {
  const record = error && typeof error === "object" ? error as { closeCode?: unknown; code?: unknown } : null;
  if (record?.closeCode === RELAY_CLOSE_HOST_OFFLINE) return "host_offline";
  const message = errorMessage(error);
  const errno = typeof record?.code === "string" ? record.code : "";
  if (errno === "ENETUNREACH" || errno === "ENETDOWN" || /\bENET(?:UNREACH|DOWN)\b/.test(message)) {
    return "no_network";
  }
  // A LAN or tailnet name that does not resolve is that machine missing from
  // the network. The relay's public name not resolving is this computer's DNS.
  if (route === "relay" && (/\b(?:ENOTFOUND|EAI_AGAIN)\b|getaddrinfo/.test(message) || errno === "ENOTFOUND" || errno === "EAI_AGAIN")) {
    return "no_network";
  }
  return classifyPairedRuntimeFailure(error);
}

async function checkedProbe(args: {
  route: RemoteRuntimeDoctorCheck["route"];
  endpoint: string;
  timeoutMs: number;
  probe: () => Promise<PairedProbeResult>;
}): Promise<RemoteRuntimeDoctorCheck & { hostStall?: RemoteRuntimeHostStall | null }> {
  const startedAt = Date.now();
  try {
    const result = await withTimeout(args.probe(), args.timeoutMs, `${args.route} probe`);
    return {
      route: args.route,
      endpoint: args.endpoint,
      ok: true,
      latencyMs: Math.max(0, Date.now() - startedAt),
      ...(result?.hostStall ? { hostStall: result.hostStall } : {}),
    };
  } catch (error) {
    return {
      route: args.route,
      endpoint: args.endpoint,
      ok: false,
      error: errorMessage(error),
      failure: classifyDoctorFailure(args.route, error),
    };
  }
}

const FAILURE_LABEL_ORDER: readonly RemoteRuntimeDoctorFailure[] = [
  "pairing",
  "authentication",
  "identity",
  "capability",
  "protocol",
  "host_offline",
  "no_network",
  "timeout",
  "unreachable",
  "superseded",
  "unknown",
];

const ROUTE_NAMES: Record<RemoteRuntimeDoctorCheck["route"], string> = {
  lan: "your local network",
  tailnet: "Tailscale",
  relay: "ADE's relay",
  ssh: "SSH",
};

/**
 * One sentence over every route, and the one thing to do. A route that
 * worked wins: the machine is reachable, and the failed routes only matter
 * as a note (a LAN address is expected to fail away from home).
 */
export function diagnoseDoctorChecks(
  checks: readonly RemoteRuntimeDoctorCheck[],
  machineNameValue: string | null | undefined,
): NonNullable<RemoteRuntimeDoctorResult["diagnosis"]> | undefined {
  if (checks.length === 0) return undefined;
  const machine = machineNameValue?.trim() || "That computer";
  const working = checks.filter((check) => check.ok);
  if (working.length > 0) {
    const via = [...new Set(working.map((check) => ROUTE_NAMES[check.route]))].join(" and ");
    return { tone: "success", title: `${machine} is reachable through ${via}.` };
  }
  const seen = new Set(checks.map((check) => check.failure ?? "unknown"));
  const failure = FAILURE_LABEL_ORDER.find((entry) => seen.has(entry)) ?? "unknown";
  switch (failure) {
    case "pairing":
      return { tone: "danger", title: `${machine} says this device's pairing is out of date.`, fix: "Pair it again." };
    case "authentication":
      return {
        tone: "danger",
        title: "The relay would not vouch for this device.",
        fix: `Sign in to the same ADE account here and on ${machine}, then test again.`,
      };
    case "identity":
      return {
        tone: "warning",
        title: `A different computer answered at ${machine}'s saved address.`,
        fix: "Test again. If it keeps happening, pair the machine again.",
      };
    case "capability":
    case "protocol":
      return {
        tone: "warning",
        title: `${machine} is running a different version of ADE that can't take this connection.`,
        fix: `Update ADE on ${machine} (or here, if this computer is older), then test again.`,
      };
    case "host_offline":
      return {
        tone: "danger",
        title: `${machine} isn't connected to ADE's relay.`,
        fix: `Make sure ${machine} is awake, online, and ADE is open there. If it is, open Connections on ${machine} and press Check to see what's blocking it.`,
      };
    case "no_network":
      return {
        tone: "danger",
        title: "This computer can't reach the internet.",
        fix: "Check this computer's Wi-Fi or network, then test again.",
      };
    case "timeout":
      return {
        tone: "danger",
        title: `${machine} didn't answer in time.`,
        fix: `It may be overloaded, asleep, or on a slow network. Test again in a moment.`,
      };
    default:
      return {
        tone: "danger",
        title: `Nothing answered at ${machine}'s addresses.`,
        fix: seen.has("unreachable") && !checks.some((check) => check.route === "relay")
          ? `It may be asleep or off, or ADE may be stopped there. Away from its network? Sign in to ADE on both computers so they can connect through the relay.`
          : `It may be asleep or off, or ADE may be stopped there.`,
      };
  }
}

export async function runRemoteRuntimeDoctor(args: {
  target?: RemoteRuntimeTarget | null;
  credentials?: DesktopPairedMachineCredentials | null;
  timeoutMs?: number;
  dependencies?: RemoteRuntimeDoctorDependencies;
  machineName?: string | null;
}): Promise<RemoteRuntimeDoctorResult> {
  const timeoutMs = Math.max(250, Math.floor(args.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS));
  const checks: Array<Promise<RemoteRuntimeDoctorCheck & { hostStall?: RemoteRuntimeHostStall | null }>> = [];
  const pairedProbe = args.dependencies?.probePaired ?? defaultPairedProbe;
  const sshProbe = args.dependencies?.probeSsh ?? defaultSshProbe;

  if (args.credentials) {
    for (const candidate of buildPairedEndpointCandidates({
      endpoints: args.credentials.endpoints,
      relayUrl: args.credentials.relayUrl,
      endpointStates: args.credentials.endpointStates,
    })) {
      checks.push(checkedProbe({
        route: candidate.kind,
        endpoint: candidate.endpoint,
        timeoutMs,
        probe: () => pairedProbe(candidate.endpoint, args.credentials!, timeoutMs),
      }));
    }
  }

  if (args.target) {
    for (const route of buildSshRouteCandidates(args.target)) {
      checks.push(checkedProbe({
        route: "ssh",
        endpoint: sshEndpoint(route, args.target.port),
        timeoutMs,
        probe: () => sshProbe(args.target!, route, timeoutMs),
      }));
    }
  }

  const settled = await Promise.all(checks);
  const hostStall = settled.find((check) => check.hostStall)?.hostStall ?? null;
  const plainChecks: RemoteRuntimeDoctorCheck[] = settled.map(({ hostStall: _hostStall, ...check }) => check);
  const machineName = args.machineName
    ?? args.target?.name
    ?? args.credentials?.hostIdentity?.name
    ?? null;
  const diagnosis = diagnoseDoctorChecks(plainChecks, machineName);
  return {
    checks: plainChecks,
    ...(diagnosis ? { diagnosis } : {}),
    ...(hostStall ? { hostStall } : {}),
  };
}

