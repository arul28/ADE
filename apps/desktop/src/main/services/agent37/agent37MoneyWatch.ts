/** The desktop's money watch for Agent 37 (see `startAgent37MoneyWatch`). */

import { app, Notification } from "electron";
import { formatAgent37Usd } from "../../../shared/agent37";
import type { Agent37Client } from "./agent37Client";
import type { createAgent37Machines } from "./agent37Machines";
import { enableAgent37SleepWherePending } from "./agent37Sleep";

/** How often the money watch reads the workspace: Agent 37 settles compute hourly, so more often shows nothing new. */
const MONEY_WATCH_MS = 10 * 60_000;
/** A wallet that runs out within this, at the current rate, is worth a notification. */
const WALLET_NOTIFY_HOURS = 24;

/**
 * Every ten minutes while a key is saved: turn sleep on for awake ADE boxes
 * still waiting for it (made before ADE managed sleep, or whose ADE just
 * updated), and tell the person once when the wallet is about to run dry or
 * the monthly cap is near or reached. Nothing here wakes a box.
 */
export function startAgent37MoneyWatch(deps: {
  client: () => Promise<Agent37Client | null>;
  machines: ReturnType<typeof createAgent37Machines>;
  logger: { warn(event: string, meta?: Record<string, unknown>): void; info?(event: string, meta?: Record<string, unknown>): void };
  /** Off the boot path: after the startup template check. */
  firstPassDelayMs: number;
}): void {
  /** Boxes whose ADE was too old to keep itself awake: asked again after an hour, not every pass. */
  const tooOldUntil = new Map<string, number>();
  const notified = new Set<string>();
  const notifyOnce = (key: string, title: string, body: string) => {
    if (notified.has(key)) return;
    notified.add(key);
    if (!Notification.isSupported()) return;
    try {
      new Notification({ title, body }).show();
    } catch (error) {
      deps.logger.warn("agent37.money_notification_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const pass = async () => {
    const client = await deps.client().catch(() => null);
    if (!client) return;
    const result = await deps.machines.list();
    if (result.state !== "ok") return;
    const now = Date.now();
    const instances = await client.listInstances().catch((error: unknown) => {
      deps.logger.warn("agent37.money_watch_list_failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    });
    const enabled = await enableAgent37SleepWherePending(client, instances.filter((instance) => {
      const box = result.machines.find((machine) => machine.instanceId === instance.id);
      return box?.madeByAde === true;
    }), {
      logger: deps.logger,
      skip: (instance) => (tooOldUntil.get(instance.id) ?? 0) > now,
    }).catch((error: unknown) => {
      deps.logger.warn("agent37.sleep_pass_failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    });
    for (const { instanceId, result: outcome } of enabled) {
      if (outcome.state === "brain_too_old") tooOldUntil.set(instanceId, now + 60 * 60_000);
    }
    const month = new Date(now).toISOString().slice(0, 7);
    const { spending } = result;
    if (spending.capReached && spending.monthlyCapUsd != null) {
      notifyOnce(`cap:${month}`, "Agent 37 cap reached", `Your machines spent this month's ${formatAgent37Usd(spending.monthlyCapUsd)}. ADE won't make or wake machines until you raise the cap or the month ends.`);
    } else if (spending.capNear && spending.monthlyCapUsd != null && spending.monthSpentUsd != null) {
      notifyOnce(`near:${month}`, "Close to your Agent 37 cap", `${formatAgent37Usd(spending.monthSpentUsd)} of ${formatAgent37Usd(spending.monthlyCapUsd)} spent this month.`);
    }
    const hourly = result.machines.reduce((total, box) => total + ((box.state === "running" || box.state === "starting") ? box.runningHourlyUsd ?? 0 : box.idleHourlyUsd ?? 0), 0);
    if (result.balanceUsd != null && hourly > 0 && result.balanceUsd / hourly < WALLET_NOTIFY_HOURS) {
      notifyOnce(`wallet:${new Date(now).toISOString().slice(0, 10)}`, "Agent 37 wallet is running low",
        `${formatAgent37Usd(result.balanceUsd)} left lasts under a day at this rate. Top it up, or Agent 37 suspends your machines.`);
    }
  };
  const run = () => {
    void pass().catch((error: unknown) => deps.logger.warn("agent37.money_watch_failed", { error: error instanceof Error ? error.message : String(error) }));
  };
  const first = setTimeout(run, deps.firstPassDelayMs);
  first.unref?.();
  const timer = setInterval(run, MONEY_WATCH_MS);
  timer.unref?.();
  app.once("will-quit", () => {
    clearTimeout(first);
    clearInterval(timer);
  });
}
