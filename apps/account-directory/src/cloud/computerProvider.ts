/**
 * The one `CloudProvider` every caller holds (`createComputerProvider`): each
 * call goes to Agent 37's Linux computers (`provider.ts`) or to a DAEX Cloud
 * Mac (`macProvider.ts`) by the computer's id and row.
 */

import { CLOUD_MAC_SHAPE, type CloudComputerAction } from "./contract";
import type { CloudWaitUntil } from "./analytics";
import { macReaches } from "./macSwitch";
import { looksLikeMacId } from "./macNomac";
import {
  createMac,
  deleteMac,
  execMac,
  listMacInstances,
  macInstanceOf,
  macMetadataOf,
  macRowOf,
  macUnavailableError,
  macUnsupportedError,
  startMac,
  stopMac,
  syncMac,
} from "./macProvider";
import { CloudProviderError, createCloudProvider, type CloudProvider } from "./provider";
import type { CloudEnv, ComputerRow } from "./store";

/**
 * The one `CloudProvider` every caller holds: each call goes to Agent 37 or
 * to the Mac by the computer's id (a Mac id is `mac` + 32 hex and its row
 * says `nomac`; an id of that shape with any other row is Agent 37's). A
 * create goes by its type. Null with neither key set.
 */
export function createComputerProvider(env: CloudEnv, fetcher: typeof fetch = fetch, options: { waitUntil?: CloudWaitUntil } = {}): CloudProvider | null {
  const linuxKey = env.AGENT37_API_KEY?.trim();
  const hasMac = Boolean(env.NOMAC_API_KEY?.trim());
  if (!linuxKey && !hasMac) return null;
  const linux = linuxKey ? createCloudProvider(linuxKey, fetcher) : null;
  const noLinux = (): never => {
    throw new CloudProviderError("DAEX Cloud can't do that right now. Try again in a moment.", "no_provider_key", 503);
  };
  const L = (): CloudProvider => linux ?? noLinux();
  const rows = new Map<string, Promise<ComputerRow | null>>();
  const macOf = (id: string): Promise<ComputerRow | null> => {
    if (!hasMac || !looksLikeMacId(id)) return Promise.resolve(null);
    let found = rows.get(id);
    if (!found) {
      found = macRowOf(env, id);
      rows.set(id, found);
    }
    return found;
  };
  // Every write changes the row: the next call reads it again.
  const fresh = async (id: string): Promise<ComputerRow | null> => {
    rows.delete(id);
    return macOf(id);
  };
  const refuse = (action: CloudComputerAction) => async (id: string, ..._rest: unknown[]) => {
    if (await macOf(id)) throw macUnsupportedError(action);
    return null;
  };

  const router: CloudProvider = {
    async listInstances() {
      const [linuxList, macs] = await Promise.all([linux ? linux.listInstances() : Promise.resolve([]), hasMac ? listMacInstances(env) : Promise.resolve([])]);
      return [...linuxList, ...macs];
    },
    async getInstance(id) {
      const row = await fresh(id);
      if (!row) return L().getInstance(id);
      // A client's read answers with the row (the tick's state); a boot it finds due runs after the answer, or at the tick.
      await syncMac(env, row, Date.now(), "seen", options.waitUntil ?? null);
      return macInstanceOf((await fresh(id)) ?? row);
    },
    async createInstance(input) {
      if ((input.type as string) === "mac") {
        if (!hasMac) noLinux();
        return createMac(env, input);
      }
      return L().createInstance(input);
    },
    async deleteInstance(id) {
      const row = await fresh(id);
      if (!row) return L().deleteInstance(id);
      await deleteMac(env, row, Date.now());
      rows.delete(id);
    },
    async sleepInstance(id) {
      const row = await fresh(id);
      if (!row) return L().sleepInstance(id);
      const status = await stopMac(env, row, Date.now(), "sleep");
      rows.delete(id);
      return status;
    },
    async startInstance(id) {
      const row = await fresh(id);
      if (!row) return L().startInstance(id);
      // Every wake path ends here (a person's start, the queue, timed and event wakes): a hidden Mac never starts.
      if (!await macReaches(env, row.user_id)) throw macUnavailableError();
      const status = await startMac(env, row, Date.now());
      rows.delete(id);
      return status;
    },
    async stopInstance(id) {
      const row = await fresh(id);
      if (!row) return L().stopInstance(id);
      const status = await stopMac(env, row, Date.now(), "stop");
      rows.delete(id);
      return status;
    },
    async updateInstance(id, template) {
      await refuse("update")(id);
      return L().updateInstance(id, template);
    },
    async resizeInstance(id, resources) {
      await refuse("resize")(id);
      return L().resizeInstance(id, resources);
    },
    async createBackup(id) {
      await refuse("backup")(id);
      return L().createBackup(id);
    },
    async setAutoSleep(id, policy) {
      // A Mac always stops when its work stops: nothing to set.
      if (await macOf(id)) return;
      return L().setAutoSleep(id, policy);
    },
    async addPublicPort(id, input) {
      await refuse("public_ports")(id);
      return L().addPublicPort(id, input);
    },
    async forkInstance(id, input) {
      await refuse("copy")(id);
      return L().forkInstance(id, input);
    },
    async signedUrl(id, input) {
      await refuse("signed_url")(id);
      return L().signedUrl(id, input);
    },
    async setInstanceName(id, name) {
      // The name lives on the row (the route writes it); NoMac keeps none.
      if (await macOf(id)) return;
      return L().setInstanceName(id, name);
    },
    async setInstanceMetadata(id, metadata) {
      const row = await fresh(id);
      if (!row) return L().setInstanceMetadata(id, metadata);
      // Merged, as the launch's own keys (`ade_launch_id`, `ade_request_id`) must outlive a later write of the machine key.
      await env.DB.prepare("update cloud_computers set mac_metadata_json = ? where instance_id = ?")
        .bind(JSON.stringify({ ...macMetadataOf(row), ...metadata }), id).run();
      rows.delete(id);
    },
    async setNetworkPolicy(id, policy) {
      const row = await fresh(id);
      if (!row) return L().setNetworkPolicy(id, policy);
      // NoMac has no network switch: a block stops the Mac, and a blocked account can't start one.
      if (policy === "deny-all") await stopMac(env, row, Date.now(), "blocked");
      rows.delete(id);
    },
    usage: (window) => (linux ? linux.usage(window) : Promise.resolve({ instances: [] })),
    async instanceEvents(id) {
      if (await macOf(id)) return [];
      return L().instanceEvents(id);
    },
    billing: () => L().billing(),
    hasTemplate: (name) => L().hasTemplate(name),
    async instanceHealth(id) {
      if (await macOf(id)) return null;
      return L().instanceHealth(id);
    },
    async instanceMetrics(id) {
      if (await macOf(id)) return { diskBytes: null, memoryBytes: null, limits: { diskBytes: CLOUD_MAC_SHAPE.driveGb * 1e9, memoryBytes: CLOUD_MAC_SHAPE.memoryGb * 1e9 } };
      return L().instanceMetrics(id);
    },
    async exec(id, command, timeoutMs) {
      const row = await fresh(id);
      if (!row) return L().exec(id, command, timeoutMs);
      return execMac(env, row, command, timeoutMs);
    },
  };
  return router;
}
