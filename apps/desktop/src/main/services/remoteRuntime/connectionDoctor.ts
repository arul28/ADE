import type {
  DesktopPairedMachineCredentials,
} from "../../../shared/types/pairedRuntime";
import type {
  RemoteRuntimeDoctorCheck,
  RemoteRuntimeDoctorResult,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetRoute,
} from "../../../shared/types/remoteRuntime";
import { buildPairedEndpointCandidates } from "./pairedRuntimeRoutes";
import {
  openPairedSyncConnection,
  type AuthenticatedSyncConnection,
} from "./syncRuntimeTransport";
import {
  buildSshRouteCandidates,
  scanSshHostKeyForTarget,
} from "./sshTransport";

const DEFAULT_DOCTOR_TIMEOUT_MS = 5_000;

export type RemoteRuntimeDoctorDependencies = {
  probePaired?: (
    endpoint: string,
    credentials: DesktopPairedMachineCredentials,
    timeoutMs: number,
  ) => Promise<void>;
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
): Promise<void> {
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

async function checkedProbe(args: {
  route: RemoteRuntimeDoctorCheck["route"];
  endpoint: string;
  timeoutMs: number;
  probe: () => Promise<void>;
}): Promise<RemoteRuntimeDoctorCheck> {
  const startedAt = Date.now();
  try {
    await withTimeout(args.probe(), args.timeoutMs, `${args.route} probe`);
    return {
      route: args.route,
      endpoint: args.endpoint,
      ok: true,
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  } catch (error) {
    return {
      route: args.route,
      endpoint: args.endpoint,
      ok: false,
      error: errorMessage(error),
    };
  }
}

export async function runRemoteRuntimeDoctor(args: {
  target?: RemoteRuntimeTarget | null;
  credentials?: DesktopPairedMachineCredentials | null;
  timeoutMs?: number;
  dependencies?: RemoteRuntimeDoctorDependencies;
}): Promise<RemoteRuntimeDoctorResult> {
  const timeoutMs = Math.max(250, Math.floor(args.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS));
  const checks: Array<Promise<RemoteRuntimeDoctorCheck>> = [];
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

  return { checks: await Promise.all(checks) };
}

