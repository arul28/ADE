import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import {
  replacePluginPresenceForMachine,
  type PluginPresenceRow,
} from "./pluginTableWriters";

/**
 * Which plugins each machine on the account has installed.
 *
 * Presence looks like a job for the CRR alone — one small table, one row per
 * (machine, plugin) — and as pure CRR it would show the local machine and
 * nothing else. Changeset replication only reaches peers that currently share a
 * sync link with this project's host, which for a multi-machine account is
 * usually one machine at a time. So presence is FAN-OUT PLUS CACHE: the live
 * answer comes from asking the account directory's reachable machines, and the
 * CRR rows are the durable floor beneath it that survives everyone going
 * offline.
 *
 * The fan-out is a PULL, deliberately. The obvious push — machine A sends its
 * rows to B — asks B to trust a payload that names its own author, and a peer
 * that can name itself can overwrite another machine's row. Pulling inverts
 * that: this machine asks the directory who exists, calls each one, and files
 * the answer under the key the DIRECTORY gave for that machine, never under a
 * key the answer claimed for itself. That is the same trust rule the account
 * usage refresh runs on, and the reason the push path here (`nudge`) carries no
 * rows at all — the worst a forged nudge can do is make this machine re-pull.
 *
 * Modeled on `accountUsageLiveRefresh.ts`: reachability filters first, cap
 * applied AFTER them (capping first lets a handful of unpaired machines at the
 * head of the directory listing starve out every machine actually reachable),
 * `Promise.all` with per-machine failure capture so one unreachable machine
 * cannot fail the sweep.
 */

/** Machines contacted per refresh, applied after the reachability filters. */
export const MAX_PRESENCE_FANOUT_MACHINES = 12;
/** Per-machine deadline for one `plugins.presenceList` call. */
export const PRESENCE_FANOUT_TIMEOUT_MS = 5_000;
/** Nudges arriving inside this window collapse into one refresh. */
export const PRESENCE_NUDGE_DEBOUNCE_MS = 1_500;

export type PluginPresenceDirectoryMachine = {
  machineKey: string;
  label?: string | null;
  platform?: string | null;
  online: boolean;
};

export type PluginPresenceRefreshFailure = {
  machineKey: string;
  label: string;
  message: string;
};

export type PluginPresenceRefreshResult = {
  machinesContacted: number;
  rowsWritten: number;
  failures: PluginPresenceRefreshFailure[];
};

export type PluginPresenceServiceDeps = {
  db: Pick<AdeDb, "run" | "runChanged" | "get" | "all">;
  /** This machine's account key. Presence rows it authors are keyed by this. */
  localMachineKey: () => string;
  /** Plugins installed on this machine right now. */
  listLocalPlugins: () => PluginPresenceRow[] | Promise<PluginPresenceRow[]>;
  /** Account directory listing. Returns null when the directory is unavailable. */
  listMachines: () => Promise<PluginPresenceDirectoryMachine[] | null>;
  /** Paired target id for a directory machine key, or null when unpaired. */
  resolveTargetIdForMachineKey: (machineKey: string) => string | null;
  /**
   * Whether a paired target is connected right now. Calling a disconnected
   * target spends its automatic-reconnect budget, and ten failures stop ADE
   * reconnecting to it at all — which would take remote projects, lanes, and
   * chat down with it. A presence refresh never gets to spend that.
   */
  isTargetConnected?: (targetId: string) => boolean;
  callMachineMethod: <T>(
    targetId: string,
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<T>;
  logger?: {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => number;
  maxMachines?: number;
  timeoutMs?: number;
  nudgeDebounceMs?: number;
};

/** Remote command a machine calls to read another machine's presence rows. */
export const PLUGIN_PRESENCE_LIST_ACTION = "plugins.presenceList";
/** Remote command a machine calls to tell peers its install state changed. */
export const PLUGIN_PRESENCE_SYNC_ACTION = "plugins.presenceSync";

export type PluginPresenceListResult = {
  plugins: PluginPresenceRow[];
};

function isPresenceRow(value: unknown): value is PluginPresenceRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.pluginId === "string" && row.pluginId.trim().length > 0;
}

/** Normalize an untrusted peer response into rows safe to store. */
function normalizePresenceResponse(value: unknown): PluginPresenceRow[] | null {
  if (!value || typeof value !== "object") return null;
  const plugins = (value as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return null;
  const rows: PluginPresenceRow[] = [];
  for (const entry of plugins) {
    if (!isPresenceRow(entry)) continue;
    const row = entry as unknown as Record<string, unknown>;
    rows.push({
      pluginId: String(row.pluginId).trim(),
      version: typeof row.version === "string" ? row.version : "",
      enabled: row.enabled !== false,
      displayName: typeof row.displayName === "string" ? row.displayName : "",
      icon: typeof row.icon === "string" ? row.icon : "",
      accent: typeof row.accent === "string" ? row.accent : "",
    });
  }
  return rows;
}

export type PluginPresenceService = {
  /** Write this machine's own rows, then tell reachable machines to re-pull. */
  publishLocalPresence(): Promise<void>;
  /** Pull presence from every reachable directory machine and store it. */
  refreshFromDirectory(): Promise<PluginPresenceRefreshResult>;
  /** Handle an inbound `plugins.presenceSync` nudge (debounced re-pull). */
  onPeerPresenceChanged(): void;
  /** Answer an inbound `plugins.presenceList` with this machine's own rows. */
  listLocalPresence(): Promise<PluginPresenceListResult>;
  dispose(): void;
};

// Late-bound handle, same seam as `pluginInstallServiceRef`: the remote-command
// registrar is built with the sync host, long before anything can construct a
// presence service, so it resolves this at call time instead. Unbound is a
// normal state (a build without the plugin host) and answers "unavailable".
let currentPresenceService: PluginPresenceService | null = null;

export function setPluginPresenceService(service: PluginPresenceService | null): void {
  currentPresenceService = service;
}

export function getPluginPresenceService(): PluginPresenceService | null {
  return currentPresenceService;
}

export function createPluginPresenceService(deps: PluginPresenceServiceDeps): PluginPresenceService {
  const now = deps.now ?? (() => Date.now());
  const maxMachines = deps.maxMachines ?? MAX_PRESENCE_FANOUT_MACHINES;
  const timeoutMs = deps.timeoutMs ?? PRESENCE_FANOUT_TIMEOUT_MS;
  const nudgeDebounceMs = deps.nudgeDebounceMs ?? PRESENCE_NUDGE_DEBOUNCE_MS;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshInFlight: Promise<PluginPresenceRefreshResult> | null = null;
  let disposed = false;

  const labelFor = (machine: PluginPresenceDirectoryMachine): string =>
    machine.label?.trim() || machine.machineKey;

  async function reachableTargets(): Promise<Array<{ machine: PluginPresenceDirectoryMachine; targetId: string }>> {
    const selfKey = deps.localMachineKey();
    let machines: PluginPresenceDirectoryMachine[] | null;
    try {
      machines = await deps.listMachines();
    } catch (error) {
      deps.logger?.warn?.("plugin.presence.list_machines_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    if (!machines) return [];
    const candidates: Array<{ machine: PluginPresenceDirectoryMachine; targetId: string }> = [];
    for (const machine of machines) {
      if (candidates.length >= maxMachines) break;
      if (machine.machineKey === selfKey || !machine.online) continue;
      const targetId = deps.resolveTargetIdForMachineKey(machine.machineKey);
      if (!targetId) continue;
      if (deps.isTargetConnected && !deps.isTargetConnected(targetId)) continue;
      candidates.push({ machine, targetId });
    }
    return candidates;
  }

  async function runRefresh(): Promise<PluginPresenceRefreshResult> {
    const result: PluginPresenceRefreshResult = {
      machinesContacted: 0,
      rowsWritten: 0,
      failures: [],
    };
    const candidates = await reachableTargets();
    result.machinesContacted = candidates.length;
    if (candidates.length === 0) return result;
    const nowIso = new Date(now()).toISOString();
    await Promise.all(candidates.map(async ({ machine, targetId }) => {
      try {
        const response = await deps.callMachineMethod<unknown>(
          targetId,
          PLUGIN_PRESENCE_LIST_ACTION,
          {},
          { timeoutMs },
        );
        const rows = normalizePresenceResponse(response);
        if (!rows) {
          // A machine on a build without plugin support answers with something
          // this cannot read. Leave its stored rows alone rather than deleting
          // them: "I could not ask" is not "it has no plugins".
          result.failures.push({
            machineKey: machine.machineKey,
            label: labelFor(machine),
            message: "This computer is on an older version of ADE",
          });
          return;
        }
        // Directory identity over payload: the rows are filed under the key the
        // directory gave for the machine we called, never under one the answer
        // named for itself.
        result.rowsWritten += replacePluginPresenceForMachine(
          deps.db,
          machine.machineKey,
          rows,
          nowIso,
        );
      } catch (error) {
        result.failures.push({
          machineKey: machine.machineKey,
          label: labelFor(machine),
          message: "Couldn't reach this computer",
        });
        deps.logger?.debug?.("plugin.presence.machine_refresh_failed", {
          machineKey: machine.machineKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));
    return result;
  }

  async function refreshFromDirectory(): Promise<PluginPresenceRefreshResult> {
    if (disposed) return { machinesContacted: 0, rowsWritten: 0, failures: [] };
    // Collapse concurrent refreshes. Install changes arrive in bursts (an
    // install emits one, its enable emits another), and each sweep is N remote
    // calls — overlapping them multiplies the calls without sharpening the answer.
    if (refreshInFlight) return await refreshInFlight;
    refreshInFlight = runRefresh().finally(() => {
      refreshInFlight = null;
    });
    return await refreshInFlight;
  }

  async function listLocalPresence(): Promise<PluginPresenceListResult> {
    return { plugins: await deps.listLocalPlugins() };
  }

  return {
    async publishLocalPresence() {
      if (disposed) return;
      const plugins = await deps.listLocalPlugins();
      replacePluginPresenceForMachine(
        deps.db,
        deps.localMachineKey(),
        plugins,
        new Date(now()).toISOString(),
      );
      const candidates = await reachableTargets();
      // The nudge carries no rows — see the header. Failures are logged and
      // dropped: a machine that misses a nudge still converges on its own
      // refresh, and presence is never worth surfacing an error for.
      await Promise.all(candidates.map(async ({ machine, targetId }) => {
        try {
          await deps.callMachineMethod(targetId, PLUGIN_PRESENCE_SYNC_ACTION, {}, { timeoutMs });
        } catch (error) {
          deps.logger?.debug?.("plugin.presence.nudge_failed", {
            machineKey: machine.machineKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }));
    },
    refreshFromDirectory,
    onPeerPresenceChanged() {
      if (disposed || nudgeTimer) return;
      nudgeTimer = setTimeout(() => {
        nudgeTimer = null;
        void refreshFromDirectory().catch(() => undefined);
      }, nudgeDebounceMs);
      nudgeTimer.unref?.();
    },
    listLocalPresence,
    dispose() {
      disposed = true;
      if (nudgeTimer) {
        clearTimeout(nudgeTimer);
        nudgeTimer = null;
      }
    },
  };
}
