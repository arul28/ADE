import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./helpers";

/**
 * The cleanup cron's Sentry monitor sees a tick finish only if the closing
 * check-in leaves before Cloudflare ends the invocation. Cloudflare ends it
 * once the handler and every `waitUntil` promise settle, and cancels any fetch
 * still running then; the fake runtime below does the same. A closing
 * check-in sent outside the invocation (as `Sentry.withMonitor` did) is cut
 * off, and the monitor reads every tick as a timeout.
 */
describe("cleanup cron monitor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers each tick's closing ok check-in before the invocation ends", async () => {
    let invocationEnded = false;
    const delivered: Array<{ monitor: string; status: string }> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      // A real network round trip: the send is in flight across a timer tick.
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (invocationEnded) throw new Error("The script will never generate a response.");
      for (const line of String(init?.body ?? "").split("\n")) {
        if (!line.includes('"monitor_slug"')) continue;
        const item = JSON.parse(line) as { monitor_slug: string; status: string };
        delivered.push({ monitor: item.monitor_slug, status: item.status });
      }
      return new Response("{}", { status: 200 });
    });
    const env = makeEnv({
      SENTRY_DSN: "https://public@o1.ingest.sentry.io/1",
      SENTRY_ENVIRONMENT: "production",
    } as never);

    for (let tick = 0; tick < 3; tick += 1) {
      invocationEnded = false;
      const pending: Promise<unknown>[] = [];
      await worker.scheduled(
        { scheduledTime: Date.now(), cron: "* * * * *" } as ScheduledEvent,
        env,
        { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext,
      );
      // Settle everything registered, including work registered while settling.
      for (let settled = 0; settled < pending.length; settled = pending.length) {
        await Promise.allSettled(pending.slice(settled));
      }
      invocationEnded = true;
    }

    expect(delivered).toHaveLength(3);
    expect(delivered.every((checkIn) => checkIn.monitor === "account-directory-cleanup")).toBe(true);
    expect(delivered.map((checkIn) => checkIn.status)).toEqual(["ok", "ok", "ok"]);
  });
});
