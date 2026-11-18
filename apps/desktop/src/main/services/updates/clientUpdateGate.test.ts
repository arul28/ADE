import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { quit: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));

import { createClientUpdateGateService } from "./clientUpdateGate";
import { createClientMinimumReader } from "../../../shared/clientMinimumReader";
import { CLIENT_MINIMUM_FRESH_MS, type ClientUpdateGateState } from "../../../shared/clientUpdateGate";
import type { AutoUpdateSnapshot } from "../../../shared/types";

// Nobody may stay behind the update screen once the account server stops
// answering: the gate's one timer must come due when the last answer goes
// stale, and that read (failing) must open it.
describe("createClientUpdateGateService", () => {
  it("a blocked computer that goes offline is let through when its answer goes stale", async () => {
    let now = 5_000_000;
    let online = true;
    const timer: { pending: { run: () => void; at: number } | null } = { pending: null };
    const reader = createClientMinimumReader({
      nowMs: () => now,
      fetchBody: async () => {
        if (!online) throw new Error("offline");
        return { desktop: { stable: "1.2.131", beta: null }, ios: {}, links: {}, updatedAt: null };
      },
    });
    const snapshot = { status: "idle", currentVersion: "1.2.130", latestKnownVersion: "1.2.131", version: null, latestByTrack: { stable: "1.2.131", beta: null } } as unknown as AutoUpdateSnapshot;
    const service = createClientUpdateGateService({
      currentVersion: "1.2.130",
      canSelfUpdate: true,
      platform: "darwin",
      arch: "arm64",
      autoUpdate: { getSnapshot: () => snapshot, onStateChange: () => () => undefined },
      directoryBaseUrl: () => "https://account.example",
      logger: { info: () => undefined, warn: () => undefined },
      reader,
      nowMs: () => now,
      setTimer: (run, ms) => {
        timer.pending = { run, at: now + ms };
        return { cancel: () => { timer.pending = null; } };
      },
    });
    const nextChange = () => new Promise<ClientUpdateGateState>((resolve) => {
      const off = service.onChange((state) => {
        off();
        resolve(state);
      });
    });

    const answeredAt = now;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    expect((await nextChange()).self.required).toBe(true);

    // Offline from here. A focus read an hour later fails too, and moves the
    // 3-hour reads off the 12-hour mark (4 h, 7 h, 10 h, then 13 h).
    online = false;
    now += 60 * 60_000;
    service.noteWindowFocus();
    await settle();
    expect(service.getState().self.required).toBe(true);

    for (let reads = 0; reads < 8 && service.getState().self.required && timer.pending; reads += 1) {
      const due = timer.pending;
      now = due.at;
      due.run();
      await settle();
    }
    expect(service.getState().self.required).toBe(false);
    // Opened when the answer went stale, not at the next 3-hour read.
    expect(now - answeredAt).toBeLessThan(CLIENT_MINIMUM_FRESH_MS + 60_000);
    service.dispose();
  });
});
