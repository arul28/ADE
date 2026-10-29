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
    if (!first.acquired || !first.token) throw new Error("setup: a should hold the device");

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
    if (!b.acquired || !b.token) throw new Error("b should hold the device");
    expect(leases.status("lane")).toMatchObject({ held: true, current: { holder: "b" }, queued: 1 });

    leases.release({ key: "lane", token: b.token });
    await expect(third).resolves.toMatchObject({ acquired: true, holder: "c" });
    leases.dispose();
  });

  it("passes a lapsed lease to the next in line, and the same holder renews instead of queueing", async () => {
    const leases = createAppleDeviceLeases();
    const held = await leases.acquire({ key: "lane", holder: "a", ttlMs: 10_000 });
    expect(held.acquired).toBe(true);

    // Asking again by name (an older CLI) renews: still a's, later expiry. The
    // name is no proof of holding the turn, so the answer withholds its token.
    vi.advanceTimersByTime(5_000);
    const renewed = await leases.acquire({ key: "lane", holder: "a", ttlMs: 10_000 });
    expect(renewed).toMatchObject({ acquired: true, renewed: true, holder: "a", token: null });
    if (!held.acquired || !renewed.acquired || !held.token) throw new Error("a should hold the device");
    expect(JSON.stringify(renewed)).not.toContain(held.token);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(held.expiresAt));

    // a never lets go. b, waiting, gets the device when the lease lapses,
    // without waiting out its own minute.
    const waiting = leases.acquire({ key: "lane", holder: "b", waitMs: 60_000 });
    await vi.advanceTimersByTimeAsync(10_100);
    await expect(waiting).resolves.toMatchObject({ acquired: true, holder: "b" });
    expect(leases.status("lane").current?.holder).toBe("b");
    leases.dispose();
  });

  it("tells two agents of one chat apart by token: the second queues, and only each token renews or releases its own turn", async () => {
    const leases = createAppleDeviceLeases();
    // Subagents of one chat share the chat id as their holder name.
    const first = await leases.acquire({ key: "lane", holder: "chat", distinct: true });
    if (!first.acquired || !first.token) throw new Error("setup: the first agent should hold the device");
    await expect(leases.acquire({ key: "lane", holder: "chat", distinct: true }))
      .resolves.toMatchObject({ acquired: false, sameHolder: true, current: { holder: "chat" } });
    const second = leases.acquire({ key: "lane", holder: "chat", distinct: true, waitMs: 60_000 });

    // The first agent's token renews its own turn; the line still waits.
    await expect(leases.acquire({ key: "lane", holder: "chat", distinct: true, token: first.token }))
      .resolves.toMatchObject({ acquired: true, renewed: true, token: first.token });
    expect(leases.status("lane").queued).toBe(1);

    expect(leases.release({ key: "lane", token: first.token })).toEqual({ released: true });
    const got = await second;
    if (!got.acquired || !got.token) throw new Error("the second agent should hold the device now");
    expect(got.token).not.toBe(first.token);
    // The first agent's stale token cannot free the second's turn.
    expect(leases.release({ key: "lane", token: first.token })).toEqual({ released: false });
    expect(leases.status("lane").held).toBe(true);
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

  it("takes a waiter whose caller went away out of line, so the next caller gets the device", async () => {
    const leases = createAppleDeviceLeases();
    const held = await leases.acquire({ key: "lane", holder: "a" });
    if (!held.acquired || !held.token) throw new Error("setup: a should hold the device");
    const killed = new AbortController();
    const gone = leases.acquire({ key: "lane", holder: "b", waitMs: 60_000, signal: killed.signal });
    const next = leases.acquire({ key: "lane", holder: "c", waitMs: 60_000 });
    expect(leases.status("lane").queued).toBe(2);

    killed.abort();
    await expect(gone).resolves.toMatchObject({ acquired: false });
    expect(leases.status("lane").queued).toBe(1);
    leases.release({ key: "lane", token: held.token });
    await expect(next).resolves.toMatchObject({ acquired: true, holder: "c" });
    leases.dispose();
  });

  it("ends a chat's turns and its places in line when the chat ends, under any holder name", async () => {
    const leases = createAppleDeviceLeases();
    await leases.acquire({ key: "lane", holder: "ui-agent", chat: "chat-1", distinct: true });
    await leases.acquire({ key: "lane\u0000ipad", holder: "chat-1", distinct: true });
    const ownWaiter = leases.acquire({ key: "lane", holder: "checker", chat: "chat-1", distinct: true, waitMs: 60_000 });
    const other = leases.acquire({ key: "lane", holder: "b", chat: "chat-2", distinct: true, waitMs: 60_000 });
    expect(leases.heldByChat("lane", "chat-1")).toBe(true);

    expect(leases.endChat("chat-1")).toBe(2);
    await expect(ownWaiter).rejects.toThrow(/ended/);
    await expect(other).resolves.toMatchObject({ acquired: true, holder: "b" });
    expect(leases.status("lane\u0000ipad").held).toBe(false);
    leases.dispose();
  });

  it("answers every waiter when the brain stops", async () => {
    const leases = createAppleDeviceLeases();
    await leases.acquire({ key: "lane", holder: "a" });
    const waiting = leases.acquire({ key: "lane", holder: "b", waitMs: 60_000 });
    leases.dispose();
    await expect(waiting).rejects.toThrow(/stopping/);
  });

  it("finds which of a lane's devices a token holds, and only within the keys asked", async () => {
    const leases = createAppleDeviceLeases();
    const onIpad = await leases.acquire({ key: "lane\u0000ipad", holder: "a", distinct: true });
    if (!onIpad.acquired || !onIpad.token) throw new Error("setup: a should hold the iPad");
    const inLane = (key: string) => key === "lane" || key.startsWith("lane\u0000");
    expect(leases.keyOfToken(onIpad.token, inLane)).toBe("lane\u0000ipad");
    expect(leases.keyOfToken(onIpad.token, (key) => key === "other-lane")).toBeNull();
    expect(leases.keyOfToken("not-the-token", inLane)).toBeNull();
    leases.dispose();
  });
});
