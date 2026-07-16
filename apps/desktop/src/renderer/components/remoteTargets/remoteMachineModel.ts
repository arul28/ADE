import { extractError } from "../../lib/format";
import type {
  AdeAccountMachine,
  RemoteRuntimeConnectErrorInfo,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeDiscoveredMachine,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
  RemoteRuntimeTargetRoute,
  RemoteRuntimeTargetRouteSource,
} from "../../../shared/types";
import { isTailnetHostname } from "../../../shared/tailnet";
import {
  accountMachineConnectionState,
  accountMachineEndpointHost,
} from "../../../shared/accountDirectory";
import {
  buildPairingQrPayload,
  encodePairingQrUrl,
} from "../../../shared/pairingQr";
import type {
  SyncAddressCandidate,
  SyncPeerPlatform,
} from "../../../shared/types/sync";

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

function discoveredPlatform(machine: RemoteRuntimeDiscoveredMachine): SyncPeerPlatform {
  const value = machine.os?.trim().toLowerCase() ?? "";
  if (value.includes("darwin") || value.includes("mac")) return "macOS";
  if (value.includes("linux")) return "linux";
  if (value.includes("windows")) return "windows";
  return "unknown";
}

/**
 * Builds the same PIN-gated direct pairing payload a copied link carries, but
 * from an ADE runtime found on LAN/Tailscale. Raw tailnet peers are deliberately
 * excluded: merely appearing in a tailnet is not consent to an SSH setup.
 */
export function discoveredPairingInput(
  machine: RemoteRuntimeDiscoveredMachine,
): string | null {
  const deviceId = machine.hostIdentity?.trim();
  if (!deviceId || isSshOnlyDiscovered(machine) || machine.connectable === false) {
    return null;
  }

  const candidates: SyncAddressCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string | null | undefined) => {
    const host = value?.trim().replace(/\.$/, "");
    if (!host || seen.has(host.toLowerCase())) return;
    if (/^(?:localhost|127(?:\.|$)|::1$)/i.test(host)) return;
    seen.add(host.toLowerCase());
    candidates.push({
      host,
      kind: host === machine.tailscaleAddress || isTailnetHostname(host)
        ? "tailscale"
        : "lan",
    });
  };

  addCandidate(machine.primaryRoute);
  addCandidate(machine.hostName);
  for (const address of machine.addresses) addCandidate(address);
  addCandidate(machine.tailscaleAddress);
  if (candidates.length === 0) return null;

  return encodePairingQrUrl(buildPairingQrPayload({
    connectInfo: {
      hostIdentity: {
        deviceId,
        siteId: "",
        name: machine.machineName,
        platform: discoveredPlatform(machine),
        deviceType: "desktop",
      },
      port: machine.port,
      addressCandidates: candidates,
    },
  }));
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

/**
 * Relative last-seen bucket ("just now", "5m ago", "3h ago", "2d ago"), or
 * null when the machine has never been seen. Callers own the surrounding
 * framing ("Last seen …", "Seen …") so each surface keeps its voice.
 */
export function relativeLastSeenPhrase(lastSeenAt: number | null): string | null {
  if (!lastSeenAt) return null;
  const minutes = Math.floor((Date.now() - lastSeenAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "kind · host" label for an account machine's advertised endpoint. */
export function formatMachineEndpoint(
  endpoint: AdeAccountMachine["reachableEndpoints"][number],
): string {
  const detail = endpoint.host ?? endpoint.url ?? "";
  return detail ? `${endpoint.kind} · ${detail}` : endpoint.kind;
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

/**
 * Host identities advertised by an account machine's reachable endpoints, keyed
 * at the default SSH port. The advertised endpoint port is the ADE service port
 * (e.g. 8787), not an SSH port, so it is deliberately ignored when building the
 * identity — otherwise an account machine would never dedupe against its saved
 * SSH target or a discovered peer (both keyed at :22) and would surface as a
 * duplicate row.
 */
export function accountMachineRouteIdentities(
  machine: AdeAccountMachine,
): Set<string> {
  const identities = new Set<string>();
  for (const endpoint of machine.reachableEndpoints) {
    const host = accountMachineEndpointHost(endpoint);
    const identity = routeIdentity(host, null);
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
  const pairedHostIdentity = target.pairedMachine?.hostIdentity?.trim();
  const pairedMachineKey = target.pairedMachine?.machineKey?.trim();
  if (
    (pairedHostIdentity && machine.deviceId?.trim() === pairedHostIdentity)
    || (pairedMachineKey && machine.machineKey.trim() === pairedMachineKey)
  ) {
    return true;
  }
  const machineIds = accountMachineRouteIdentities(machine);
  if (machineIds.size === 0) return false;
  return intersects(machineIds, targetRouteIdentities(target));
}

/** True when an account machine is the same host as a locally-discovered machine. */
export function accountMachineMatchesDiscovered(
  machine: AdeAccountMachine,
  discovered: RemoteRuntimeDiscoveredMachine,
): boolean {
  if (
    machine.deviceId?.trim()
    && discovered.hostIdentity?.trim() === machine.deviceId.trim()
  ) {
    return true;
  }
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
  /** Keep discovery useful for saved/account dedupe without rendering raw peers. */
  includeDiscoveredRows?: boolean;
}): MachineSections {
  const {
    targets,
    statusById,
    connectedFallbackId,
    discoveredMachines,
    accountMachines = [],
    includeDiscoveredRows = true,
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
    if (!includeDiscoveredRows) continue;
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
      includeDiscoveredRows &&
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
    if (accountMachineConnectionState(machine) === "available") {
      sections.available.push(row);
    } else {
      sections.unavailable.push(row);
    }
  }

  return sections;
}
