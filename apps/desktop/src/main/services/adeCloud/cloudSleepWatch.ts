/** The desktop's sleep watch for cloud machines (see `startCloudSleepWatch`). */

import { app } from "electron";
import type { CloudProvider } from "./cloudProvider";
import { CLOUD_MACHINE_KEY_METADATA } from "./cloudMachines";
import { enableCloudSleepWherePending } from "./cloudSleep";

const SLEEP_WATCH_MS = 10 * 60_000;

/**
 * Every ten minutes while this account has ADE Cloud: turn sleep on for awake
 * ADE boxes still waiting for it (made before ADE managed sleep, or whose ADE
 * just updated). Nothing here wakes a box.
 */
export function startCloudSleepWatch(deps: {
  client: () => Promise<CloudProvider | null>;
  logger: { warn(event: string, meta?: Record<string, unknown>): void; info?(event: string, meta?: Record<string, unknown>): void };
  /** Off the boot path. */
  firstPassDelayMs: number;
}): void {
  /** Boxes whose ADE was too old to keep itself awake: asked again after an hour, not every pass. */
  const tooOldUntil = new Map<string, number>();
  const pass = async () => {
    const client = await deps.client().catch(() => null);
    if (!client) return;
    const now = Date.now();
    const instances = await client.listInstances().catch((error: unknown) => {
      deps.logger.warn("cloud.sleep_watch_list_failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    });
    const enabled = await enableCloudSleepWherePending(client, instances.filter((instance) =>
      instance.metadata.created_by === "ade" || Boolean(instance.metadata[CLOUD_MACHINE_KEY_METADATA])), {
      logger: deps.logger,
      skip: (instance) => (tooOldUntil.get(instance.id) ?? 0) > now,
    }).catch((error: unknown) => {
      deps.logger.warn("cloud.sleep_pass_failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    });
    for (const { instanceId, result: outcome } of enabled) {
      if (outcome.state === "brain_too_old") tooOldUntil.set(instanceId, now + 60 * 60_000);
    }
  };
  const run = () => {
    void pass().catch((error: unknown) => deps.logger.warn("cloud.sleep_watch_failed", { error: error instanceof Error ? error.message : String(error) }));
  };
  const first = setTimeout(run, deps.firstPassDelayMs);
  first.unref?.();
  const timer = setInterval(run, SLEEP_WATCH_MS);
  timer.unref?.();
  app.once("will-quit", () => {
    clearTimeout(first);
    clearInterval(timer);
  });
}
