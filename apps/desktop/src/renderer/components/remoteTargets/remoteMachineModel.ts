import { extractError } from "../../lib/format";
import type {
  AdeAccountMachine,
  RemoteRuntimeConnectErrorInfo,
  RemoteRuntimeConnectionRoute,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeDiscoveredMachine,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
  RemoteRuntimeTargetRoute,
  RemoteRuntimeTargetRouteSource,
} from "../../../shared/types";
import { isTailnetHostname } from "../../../shared/tailnet";

// ---------------------------------------------------------------------------
// Route identity + discovered-machine helpers (framework-free, unit-tested via
// the panel). Kept in one module so the section model and the connect flow
// agree on how a saved target and a discovered machine map to the same box.
// ---------------------------------------------------------------------------

function normalizeRouteHost(hostname: string | null | undefined): string {
  return hostname?.trim().toLowerCase().replace(/\.$/, "") ?? "";
}

function normalizeRoutePort(port: number | null | undefined): number {
  return port ?? 22;
}

export function routeIdentity(
  hostname: string | null | undefined,
  port: number | null | undefined,
): string | null {
  const host = normalizeRouteHost(hostname);
  if (!host) return null;
  return `${host}:${normalizeRoutePort(port)}`;
}

function discoveredRouteSource(
  machine: RemoteRuntimeDiscoveredMachine,
  hostname: string,
): RemoteRuntimeTargetRouteSource {
  if (
    (machine.runtimeKind ?? "").startsWith("tailscale-peer") ||
    hostname === machine.tailscaleAddress ||
    isTailnetHostname(hostname)
  ) {
    return "tailscale";
  }
  return "bonjour";
}

export function discoveredSshRoutes(
  machine: RemoteRuntimeDiscoveredMachine,
): RemoteRuntimeTargetRoute[] {
  const hostnames = [
    machine.tailscaleAddress,
    machine.primaryRoute,
    machine.hostName,
    ...machine.addresses,
  ];
  const routes: RemoteRuntimeTargetRoute[] = [];
  const seen = new Set<string>();
  for (const value of hostnames) {
    const hostname = value?.trim().replace(/\.$/, "");
    if (!hostname) continue;
    const key = hostname.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({
      hostname,
      port: null,
      source: discoveredRouteSource(machine, hostname),
      lastSucceededAt: null,
    });
  }
  return routes;
}

export function discoveredRoute(
  machine: RemoteRuntimeDiscoveredMachine,
): string | null {
  return (
    machine.tailscaleAddress ??
    machine.primaryRoute ??
    machine.hostName ??
    machine.addresses[0] ??
    null
  );
}

export function discoveredTargetInput(
  machine: RemoteRuntimeDiscoveredMachine,
): RemoteRuntimeTargetInput | null {
  const route = discoveredRoute(machine);
  if (!route) return null;
  return {
    name: machine.machineName,
    hostname: route.replace(/\.$/, ""),
    sshUser: null,
    port: null,
    sshKeyPath: null,
    routes: discoveredSshRoutes(machine),
  };
}

export function targetRouteIdentities(
  target: RemoteRuntimeTarget,
): Set<string> {
  const identities = new Set<string>();
  const primary = routeIdentity(target.hostname, target.port);
  if (primary) identities.add(primary);
  for (const route of target.routes ?? []) {
    const identity = routeIdentity(route.hostname, route.port ?? target.port);
    if (identity) identities.add(identity);
  }
  return identities;
}

function discoveredMachineRouteIdentities(
  machine: RemoteRuntimeDiscoveredMachine,
): Set<string> {
  const identities = new Set<string>();
  for (const route of discoveredSshRoutes(machine)) {
    const identity = routeIdentity(route.hostname, route.port);
    if (identity) identities.add(identity);
  }
  return identities;
}

export function machineMatchesSavedTarget(
  machine: RemoteRuntimeDiscoveredMachine,
  target: RemoteRuntimeTarget,
): boolean {
  const discovered = discoveredMachineRouteIdentities(machine);
  if (discovered.size === 0) return false;
  const saved = targetRouteIdentities(target);
  for (const identity of discovered) {
    if (saved.has(identity)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Labels + formatting
// ---------------------------------------------------------------------------

export function formatLastSeen(value: number | null): string {
  if (!value) return "Never connected";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Last connection unknown";
  return `Last connected ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function targetConnectionLabel(target: RemoteRuntimeTarget): string {
  const userPrefix = target.sshUser ? `${target.sshUser}@` : "";
  const portSuffix = target.port ? `:${target.port}` : "";
  let defaultHint = "";
  if (!target.sshUser && !target.port) {
    defaultHint = " (SSH defaults)";
  } else if (!target.sshUser) {
    defaultHint = " (default SSH user)";
  } else if (!target.port) {
    defaultHint = " (default port)";
  }
  const targetHostKey = target.hostname.toLowerCase().replace(/\.$/, "");
  const fallbackRoutes = (target.routes ?? []).filter(
    (route) =>
      route.hostname.toLowerCase().replace(/\.$/, "") !== targetHostKey ||
      route.port !== target.port,
  ).length;
  const fallbackHint =
    fallbackRoutes > 0
      ? ` + ${fallbackRoutes} route${fallbackRoutes === 1 ? "" : "s"}`
      : "";
  return `${userPrefix}${target.hostname}${portSuffix}${defaultHint}${fallbackHint}`;
}

export function connectionStateLabel(
  connection: RemoteRuntimeConnectionStatus | null,
  connectedFallback: boolean,
): string {
  if (connection?.state === "connected" || (!connection && connectedFallback))
    return "Connected";
  if (connection?.state === "connecting") return "Connecting";
  if (connection?.state === "error") return "Connection failed";
  return "Not connected";
}

/** True when a discovered machine is a raw SSH peer with no ADE runtime. */
export function isSshOnlyDiscovered(
  machine: RemoteRuntimeDiscoveredMachine,
): boolean {
  return (machine.runtimeKind ?? "").startsWith("tailscale-peer");
}

/**
 * The one-line "what is this" for a discovered machine: ADE services show their
 * project count, raw SSH peers state they are SSH-only and (when known) which
 * OS. Concrete and stateful — not a generic "detected device" blurb.
 */
export function discoveredMachineSummary(
  machine: RemoteRuntimeDiscoveredMachine,
): string {
  if (isSshOnlyDiscovered(machine)) {
    const os = machine.os?.trim();
    return os ? `SSH only · ${os}` : "SSH only";
  }
  const count = machine.projectCount ?? machine.projectIds.length;
  if (count <= 0) return "ADE · no projects";
  return `ADE · ${count} project${count === 1 ? "" : "s"}`;
}

/**
 * A subtle route chip for a connected row, e.g. `tailnet · 4 ms`, `lan · 2 ms`,
 * `relay · 90 ms`, or `ssh · studio.local` when the transport reports no
 * round-trip latency.
 */
export function formatRouteChip(
  route: RemoteRuntimeConnectionRoute | undefined,
): string | null {
  if (!route) return null;
  const detail =
    typeof route.latencyMs === "number" && Number.isFinite(route.latencyMs)
      ? `${Math.round(route.latencyMs)} ms`
      : route.endpoint?.trim() || null;
  return detail ? `${route.kind} · ${detail}` : route.kind;
}

export function formatRemoteTargetError(error: unknown): string {
  const message = extractError(error)
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();

  if (/^(?:read\s+)?ECONNRESET$/i.test(message)) {
    return "SSH server closed the connection before ADE could finish the SSH handshake. Check that Remote Login/sshd is enabled on the remote machine and try again.";
  }

  if (
    /permission denied|all configured authentication methods failed/i.test(
      message,
    )
  ) {
    return "SSH authentication failed. Check the SSH user, key path, and that this key is allowed on the remote machine.";
  }

  if (/host denied|verification failed|host key verification/i.test(message)) {
    return "SSH host-key verification failed. Check that this is the right machine, then update the saved SSH host key or trust the new key when ADE prompts.";
  }

  if (
    /timed out.*handshake|handshake.*timed out|connect.*timed out/i.test(
      message,
    )
  ) {
    return "SSH did not finish connecting. Check that the machine is awake, reachable on Tailscale or LAN, and Remote Login is enabled.";
  }

  if (/ECONNREFUSED/i.test(message)) {
    return "The machine refused the SSH connection. Check the port and make sure Remote Login/sshd is running.";
  }

  if (
    /ENOTFOUND|could not resolve hostname|name or service not known/i.test(
      message,
    )
  ) {
    return "ADE could not resolve that host. Check the hostname, or use the Tailscale 100.x address from discovery.";
  }

  return message || "Remote connection failed.";
}

// ---------------------------------------------------------------------------
// Error card selection
// ---------------------------------------------------------------------------

export type MachineErrorCard = {
  message: string;
  /** Capped, copyable technical detail from a structured error, when present. */
  detail: string | null;
  /** True when the message came straight from a structured `lastErrorInfo`. */
  structured: boolean;
};

/**
 * Chooses what a failed connection should show the user. A structured
 * `lastErrorInfo` wins and is shown verbatim (plain-language message + optional
 * technical detail); otherwise the raw error string is run through the
 * plain-English `formatRemoteTargetError` fallback. Returns null when there is
 * nothing to surface.
 */
export function selectMachineErrorCard(args: {
  errorInfo?: RemoteRuntimeConnectErrorInfo | null;
  rawError?: string | null;
  /** A locally-produced message (e.g. from a thrown connect call). */
  overrideMessage?: string | null;
}): MachineErrorCard | null {
  const { errorInfo, rawError, overrideMessage } = args;
  if (errorInfo?.message) {
    return {
      message: errorInfo.message,
      detail: errorInfo.detail?.trim() ? errorInfo.detail : null,
      structured: true,
    };
  }
  const fallback =
    overrideMessage?.trim() ||
    (rawError ? formatRemoteTargetError(rawError) : null);
  if (!fallback) return null;
  return { message: fallback, detail: null, structured: false };
}

// ---------------------------------------------------------------------------
// Section assignment
// ---------------------------------------------------------------------------

export type MachineSection = "connected" | "available" | "unavailable";

export type SavedMachineRow = {
  kind: "saved";
  id: string;
  target: RemoteRuntimeTarget;
  status: RemoteRuntimeConnectionStatus | null;
  connected: boolean;
  /** Set only for the unavailable section (offline / unsupported). */
  unavailableReason: string | null;
};

export type DiscoveredMachineRow = {
  kind: "discovered";
  id: string;
  machine: RemoteRuntimeDiscoveredMachine;
  unavailableReason: string | null;
};

/**
 * A machine known only through the account directory (#814 Worker) — not saved
 * or discovered locally. Online rows can be adopted+connected via their best
 * reachable endpoint; offline rows grey out with a last-seen + "why offline?".
 */
export type AccountMachineRow = {
  kind: "account";
  id: string;
  machine: AdeAccountMachine;
  /** The saved target this account machine maps to, if any (enables the doctor). */
  matchedTargetId: string | null;
};

export type MachineRow = SavedMachineRow | DiscoveredMachineRow | AccountMachineRow;

export type MachineSections = {
  connected: MachineRow[];
  available: MachineRow[];
  unavailable: MachineRow[];
};

/** Host:port identities advertised by an account machine's reachable endpoints. */
export function accountMachineRouteIdentities(
  machine: AdeAccountMachine,
): Set<string> {
  const identities = new Set<string>();
  for (const endpoint of machine.reachableEndpoints) {
    const host = endpoint.host ?? endpoint.url ?? null;
    const identity = routeIdentity(host, endpoint.port ?? null);
    if (identity) identities.add(identity);
  }
  return identities;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

/** True when an account machine is the same host as a saved target. */
export function accountMachineMatchesTarget(
  machine: AdeAccountMachine,
  target: RemoteRuntimeTarget,
): boolean {
  const machineIds = accountMachineRouteIdentities(machine);
  if (machineIds.size === 0) return false;
  return intersects(machineIds, targetRouteIdentities(target));
}

/** True when an account machine is the same host as a locally-discovered machine. */
export function accountMachineMatchesDiscovered(
  machine: AdeAccountMachine,
  discovered: RemoteRuntimeDiscoveredMachine,
): boolean {
  const machineIds = accountMachineRouteIdentities(machine);
  if (machineIds.size === 0) return false;
  return intersects(machineIds, discoveredMachineRouteIdentities(discovered));
}

/**
 * Splits saved targets and discovered machines into the CONNECTED / AVAILABLE /
 * UNAVAILABLE buckets the panel renders. A discovered machine that is already
 * saved is represented by its saved row only (no duplicate). A saved target
 * that matches an unreachable discovered machine (offline / unsupported OS)
 * inherits that unavailability so it greys out with a concrete reason.
 */
export function assignMachineSections(args: {
  targets: RemoteRuntimeTarget[];
  statusById: Map<string, RemoteRuntimeConnectionStatus>;
  connectedFallbackId: string | null;
  discoveredMachines: RemoteRuntimeDiscoveredMachine[];
  /** Machines from the account directory, merged with saved/discovered. */
  accountMachines?: AdeAccountMachine[];
}): MachineSections {
  const {
    targets,
    statusById,
    connectedFallbackId,
    discoveredMachines,
    accountMachines = [],
  } = args;
  const sections: MachineSections = {
    connected: [],
    available: [],
    unavailable: [],
  };

  const claimedMachineIds = new Set<string>();

  for (const target of targets) {
    const status = statusById.get(target.id) ?? null;
    const connected = status
      ? status.state === "connected"
      : target.id === connectedFallbackId;

    const match = discoveredMachines.find((machine) =>
      machineMatchesSavedTarget(machine, target),
    );
    if (match) claimedMachineIds.add(match.id);

    if (connected) {
      sections.connected.push({
        kind: "saved",
        id: target.id,
        target,
        status,
        connected: true,
        unavailableReason: null,
      });
      continue;
    }

    if (match && match.connectable === false) {
      sections.unavailable.push({
        kind: "saved",
        id: target.id,
        target,
        status,
        connected: false,
        unavailableReason: match.unsupportedReason ?? "Offline",
      });
      continue;
    }

    sections.available.push({
      kind: "saved",
      id: target.id,
      target,
      status,
      connected: false,
      unavailableReason: null,
    });
  }

  for (const machine of discoveredMachines) {
    if (claimedMachineIds.has(machine.id)) continue;
    if (targets.some((target) => machineMatchesSavedTarget(machine, target))) {
      continue;
    }
    if (machine.connectable === false) {
      sections.unavailable.push({
        kind: "discovered",
        id: machine.id,
        machine,
        unavailableReason:
          machine.unsupportedReason ??
          (machine.os?.toLowerCase() === "windows"
            ? "Windows — not supported yet"
            : "Offline"),
      });
      continue;
    }
    sections.available.push({
      kind: "discovered",
      id: machine.id,
      machine,
      unavailableReason: null,
    });
  }

  // Account-directory machines are merged in as a third source. Any that already
  // map to a saved target or a discovered machine are represented by that local
  // row (no duplicate); the rest surface as their own rows — online in
  // AVAILABLE, offline greyed in UNAVAILABLE.
  for (const machine of accountMachines) {
    const matchedTarget = targets.find((target) =>
      accountMachineMatchesTarget(machine, target),
    );
    if (matchedTarget) {
      // A saved target already owns this host; only annotate offline account
      // machines whose target isn't otherwise flagged (rare) — otherwise skip.
      continue;
    }
    if (
      discoveredMachines.some((discovered) =>
        accountMachineMatchesDiscovered(machine, discovered),
      )
    ) {
      continue;
    }
    const row: AccountMachineRow = {
      kind: "account",
      id: `account:${machine.machineKey}`,
      machine,
      matchedTargetId: null,
    };
    if (machine.online) {
      sections.available.push(row);
    } else {
      sections.unavailable.push(row);
    }
  }

  return sections;
}
