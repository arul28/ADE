import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppleDeviceLeases } from "./appleDeviceLease";

/**
 * The turn agents sharing one lane's device take. The contract callers rely
 * on: the line is first come, first served; a lease nobody renews lapses and
 * the device passes on; and only the holder ever sees its token.
 */
describe("createAppleDeviceLeases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T08:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands the device on in the order agents asked, and keeps each token to its holder", async () => {
    const leases = createAppleDeviceLeases();
    const first = await leases.acquire({ key: "lane", holder: "a" });
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("setup: a should hold the device");

    // A second agent asking without waiting is told who has it, not the token.
    const busy = await leases.acquire({ key: "lane", holder: "b" });
    expect(busy).toMatchObject({ acquired: false, current: { holder: "a" } });
    expect(JSON.stringify(busy)).not.toContain(first.token);
    expect(JSON.stringify(leases.status("lane"))).not.toContain(first.token);

    const second = leases.acquire({ key: "lane", holder: "b", waitMs: 60_000 });
    const third = leases.acquire({ key: "lane", holder: "c", waitMs: 60_000 });
    expect(leases.status("lane").queued).toBe(2);

    // A stale or foreign token cannot release someone else's turn.
    expect(leases.release({ key: "lane", token: "not-the-token" })).toEqual({ released: false });
    expect(leases.release({ key: "lane", token: first.token })).toEqual({ released: true });
    const b = await second;
    expect(b).toMatchObject({ acquired: true, holder: "b" });
    if (!b.acquired) throw new Error("b should hold the device");
    expect(leases.status("lane")).toMatchObject({ held: true, current: { holder: "b" }, queued: 1 });

    leases.release({ key: "lane", token: b.token });
    await expect(third).resolves.toMatchObject({ acquired: true, holder: "c" });
    leases.dispose();
  });

  it("passes a lapsed lease to the next in line, and the same holder renews instead of queueing", async () => {
    const leases = createAppleDeviceLeases();
    const held = await leases.acquire({ key: "lane", holder: "a", ttlMs: 10_000 });
    expect(held.acquired).toBe(true);

    // Asking again renews: still a's, same token, later expiry.
    vi.advanceTimersByTime(5_000);
    const renewed = await leases.acquire({ key: "lane", holder: "a", ttlMs: 10_000 });
    expect(renewed).toMatchObject({ acquired: true, renewed: true, holder: "a" });
    if (!held.acquired || !renewed.acquired) throw new Error("a should hold the device");
    expect(renewed.token).toBe(held.token);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(held.expiresAt));

    // a never lets go. b, waiting, gets the device when the lease lapses,
    // without waiting out its own minute.
    const waiting = leases.acquire({ key: "lane", holder: "b", waitMs: 60_000 });
    await vi.advanceTimersByTimeAsync(10_100);
    await expect(waiting).resolves.toMatchObject({ acquired: true, holder: "b" });
    expect(leases.status("lane").current?.holder).toBe("b");
    leases.dispose();
  });

  it("answers a waiter whose wait runs out with who still has the device", async () => {
    const leases = createAppleDeviceLeases();
    await leases.acquire({ key: "lane", holder: "a", ttlMs: 60_000 });
    const waiting = leases.acquire({ key: "lane", holder: "b", waitMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(waiting).resolves.toMatchObject({ acquired: false, current: { holder: "a" }, queued: 0 });
    // Gave up means out of line: nobody is left waiting.
    expect(leases.status("lane")).toMatchObject({ held: true, queued: 0 });
    // A different lane's device is its own line.
    await expect(leases.acquire({ key: "other", holder: "b" })).resolves.toMatchObject({ acquired: true });
    leases.dispose();
  });
});
