// ---------------------------------------------------------------------------
// The one model behind ADE Web's pre-project surfaces.
//
// The welcome page and the top bar's connections popover both need the same
// answer to "what machines does this account have, what is each one's real
// reachability, and what projects do we know about on it" — including for
// machines this browser tab has never connected to. That answer merges three
// sources:
//
//   - the account directory (every machine signed in to the account),
//   - this browser's saved pairings (`WebClientEnvironmentRecord`),
//   - the live session pool plus the persisted per-machine catalogs.
//
// Status comes from `accountMachineConnectionState`, not from whether this tab
// happens to hold a socket: a machine with a verified relay route is
// "Available", never "Offline".
// ---------------------------------------------------------------------------

import {
  accountMachineConnectionState,
  accountMachineDisplayName,
} from "../../../shared/accountDirectory";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { RecentProjectSummary } from "../../../shared/types";
import type { SyncMobileProjectSummary } from "../../../shared/types/sync";
import type {
  AdeSyncClientStatus,
  WebClientEnvironmentRecord,
  WebClientMachineCatalogRecord,
} from "../sync";
import { machineCatalogKey } from "./machineIdentity";
import type {
  WebMachineSessionSnapshot,
  WebMachineWorkspaceSnapshot,
} from "./WebMachineSessionManager";

export type WebMachineStatus = "live" | "connecting" | "parked" | "available" | "offline";

export type WebMachineEntry = {
  /** `machineCatalogKey` identity — stable across pairings and reloads. */
  key: string;
  name: string;
  accountMachine: AdeAccountMachine | null;
  environment: WebClientEnvironmentRecord | null;
  session: WebMachineSessionSnapshot | null;
  status: WebMachineStatus;
  statusLabel: string;
  /** Tooltip copy for the status dot. */
  reachability: string;
  /** What the connection is doing right now, when it is doing something. */
  connectStage: string | null;
  projects: SyncMobileProjectSummary[];
  /** True when `projects` came from the persisted cache, not a live catalog. */
  stale: boolean;
  lastSeenAt: string | number | null;
};

/** Account rows share the environment identity when the machine has a device id. */
function accountMachineCatalogKey(machine: AdeAccountMachine): string {
  return machine.deviceId
    ? machineCatalogKey({ hostDeviceId: machine.deviceId })
    : `account:${machine.machineKey}`;
}

/**
 * Every catalog key one row's machine could have been saved under.
 *
 * A row is merged from up to three sources that each key the machine
 * differently — the account row by device id (or machine key), the environment
 * by device id (or env id), the catalog by whichever key was current when it was
 * written. Forgetting a machine by `entry.key` alone therefore left catalogs
 * behind under the other identities, and their projects kept appearing in
 * recents after the machine was removed.
 */
export function webMachineCatalogKeys(machine: WebMachineEntry): string[] {
  const keys = [machine.key];
  if (machine.environment) {
    keys.push(machineCatalogKey(machine.environment));
    keys.push(machineCatalogKey({ envId: machine.environment.envId }));
  }
  if (machine.accountMachine) keys.push(accountMachineCatalogKey(machine.accountMachine));
  return [...new Set(keys.filter(Boolean))];
}

/**
 * Status dot palette for every surface that lists web machines — the
 * connections chip and the welcome page's remote rows.
 *
 * `connecting` is the explicit amber the welcome page also uses as its remote
 * accent; the two had drifted to separate literals of the same colour.
 */
export const WEB_MACHINE_DOT_COLOR: Readonly<Record<WebMachineStatus, string>> = {
  live: "#34D399",
  connecting: "#F59E0B",
  parked: "#7DD3FC",
  available: "rgba(148,163,184,0.85)",
  offline: "rgba(148,163,184,0.45)",
};

const STATUS_ORDER: Record<WebMachineStatus, number> = {
  live: 0,
  connecting: 1,
  parked: 2,
  available: 3,
  offline: 4,
};

/**
 * Status words shared with the desktop's Connections pane
 * (`connectionStateLabel`): "Connected", "Connecting", "Not connected". The
 * internal state is still called `live` — that is the session's lifecycle — but
 * the user-facing word for it is the one the desktop already uses, because a
 * machine being connected is the single thing this list exists to report.
 */
function webMachineStatusLabel(status: WebMachineStatus): string {
  switch (status) {
    case "live":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "parked":
      return "Parked";
    case "available":
      return "Available";
    case "offline":
      return "Offline";
  }
}

/**
 * The real connection lifecycle, surfaced verbatim instead of one anonymous
 * spinner: the transport dials, then authenticates, then the host replays its
 * project catalog, and each of those can be the slow one.
 */
function webConnectStage(status: AdeSyncClientStatus | null): string | null {
  if (!status) return null;
  switch (status.state) {
    case "connecting":
      return status.endpoint ? "Authenticating…" : "Dialing relay…";
    case "reconnecting":
      return "Reconnecting…";
    case "restoring":
      return "Loading projects…";
    case "connected":
      return status.readiness === "ready" ? null : "Loading projects…";
    default:
      return null;
  }
}

export function webMachineLastSeenPhrase(value: string | number | null): string | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function reachabilityCopy(status: WebMachineStatus, lastSeenAt: string | number | null): string {
  switch (status) {
    case "live":
      return "Connected — ADE Web is talking to this machine now";
    case "connecting":
      return "Connecting to this machine…";
    case "parked":
      return "Parked — reconnects when you open a project";
    case "available":
      return "Available — connects when you open a project";
    case "offline": {
      const seen = webMachineLastSeenPhrase(lastSeenAt);
      return seen
        ? `Offline — last seen ${seen}`
        : "Offline — sign in to ADE on this machine to bring it back";
    }
  }
}

function gitOriginUrl(project: SyncMobileProjectSummary): string | null {
  return project.repoOwner && project.repoName
    ? `https://github.com/${project.repoOwner}/${project.repoName}`
    : null;
}

/**
 * One row per physical machine, with the live session (when this tab holds
 * one) and the newest project catalog we can show for it.
 */
export function mergeWebMachines(args: {
  accountMachines: readonly AdeAccountMachine[];
  snapshot: WebMachineWorkspaceSnapshot;
  /** Required: without it every account machine reads as offline. */
  relayBaseUrls: readonly string[];
}): WebMachineEntry[] {
  const { accountMachines, snapshot, relayBaseUrls } = args;
  const catalogsByKey = new Map(
    snapshot.catalogs.map((catalog) => [catalog.machineKey, catalog]),
  );
  const sessionByTargetId = new Map(
    snapshot.sessions.map((session) => [session.targetId, session]),
  );
  const entries = new Map<string, {
    name: string;
    accountMachine: AdeAccountMachine | null;
    environment: WebClientEnvironmentRecord | null;
    session: WebMachineSessionSnapshot | null;
    catalog: WebClientMachineCatalogRecord | null;
  }>();

  const ensure = (key: string) => {
    const existing = entries.get(key);
    if (existing) return existing;
    const created = {
      name: "Unnamed machine",
      accountMachine: null,
      environment: null,
      session: null,
      catalog: catalogsByKey.get(key) ?? null,
    };
    entries.set(key, created);
    return created;
  };

  for (const catalog of snapshot.catalogs) {
    const entry = ensure(catalog.machineKey);
    entry.name = catalog.machineName || entry.name;
  }
  for (const environment of snapshot.environments) {
    const entry = ensure(machineCatalogKey(environment));
    entry.environment = environment;
    entry.name = environment.machineName || entry.name;
    entry.session = sessionByTargetId.get(environment.envId) ?? entry.session;
  }
  // A machine whose environment has no host device id AND whose account row has
  // no device id lands in two rows. There is no key both sides share in that
  // case — `machineKeyUrl` is a relay URL, not an identity — and merging on
  // display name would silently fuse two different machines, which is worse than
  // showing one twice.
  for (const machine of accountMachines) {
    const entry = ensure(accountMachineCatalogKey(machine));
    entry.accountMachine = machine;
    entry.name = accountMachineDisplayName(machine) ?? entry.name;
  }

  return [...entries.entries()]
    .map(([key, entry]): WebMachineEntry => {
      const status = machineStatus(entry, relayBaseUrls);
      const liveProjects = status === "live" ? entry.session?.projects ?? [] : [];
      const live = liveProjects.length > 0;
      const lastSeenAt = entry.accountMachine?.lastSeenAt
        ?? entry.environment?.lastConnectedAt
        ?? null;
      return {
        key,
        name: entry.name,
        accountMachine: entry.accountMachine,
        environment: entry.environment,
        session: entry.session,
        status,
        statusLabel: webMachineStatusLabel(status),
        reachability: reachabilityCopy(status, lastSeenAt),
        connectStage: webConnectStage(entry.session?.status ?? null),
        projects: live ? liveProjects : (entry.catalog?.projects ?? []),
        stale: !live && (entry.catalog?.projects.length ?? 0) > 0,
        lastSeenAt,
      };
    })
    .sort((left, right) => (
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
      || left.name.localeCompare(right.name)
    ));
}

/** What a merged row's dot and label report, in precedence order. */
function machineStatus(
  entry: {
    accountMachine: AdeAccountMachine | null;
    environment: WebClientEnvironmentRecord | null;
    session: WebMachineSessionSnapshot | null;
  },
  relayBaseUrls: readonly string[],
): WebMachineStatus {
  // A session this tab holds is the most direct evidence there is.
  switch (entry.session?.state) {
    case "live":
      return "live";
    case "reconnecting":
      return "connecting";
    case "parked":
      return "parked";
  }
  // Otherwise the account directory knows whether the machine is reachable.
  if (entry.accountMachine) {
    return accountMachineConnectionState(entry.accountMachine, relayBaseUrls) === "available"
      ? "available"
      : "offline";
  }
  // A saved pairing is always dialable; with neither, nothing can be reached.
  return entry.environment ? "available" : "offline";
}

/**
 * Every known project across every known machine, in the shared recents shape
 * so the desktop welcome page can render them unchanged.
 *
 * The machine's identity key stands in for `remote.targetId`: a machine this
 * browser has never dialled has no target id yet, and the welcome page resolves
 * the key back to a machine when the row is opened.
 */
export function webRecentProjects(machines: readonly WebMachineEntry[]): RecentProjectSummary[] {
  const rows: RecentProjectSummary[] = [];
  for (const machine of machines) {
    for (const project of machine.projects) {
      const origin = gitOriginUrl(project);
      rows.push({
        rootPath: project.rootPath ?? `remote:${project.id}`,
        displayName: project.displayName,
        exists: project.isAvailable,
        lastOpenedAt: project.lastOpenedAt ?? "",
        laneCount: project.laneCount,
        kind: "remote",
        gitOriginUrl: origin,
        remote: {
          targetId: machine.key,
          projectId: project.id,
          runtimeName: machine.name,
          hostname: machine.environment?.hostIdentity?.name ?? machine.name,
          gitOriginUrl: origin,
          iconDataUrl: project.iconDataUrl ?? null,
        },
      });
    }
  }
  return rows;
}
