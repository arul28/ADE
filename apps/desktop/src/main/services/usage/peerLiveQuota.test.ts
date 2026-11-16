import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageAccount } from "../../../shared/types/usage";
import { createPeerLiveQuota } from "./peerLiveQuota";

const studioQuota = (count: number) => ({
  machineKey: "studio",
  label: "studio",
  windows: [],
  accounts: [{
    id: "claude:x",
    provider: "claude",
    email: "a@example.com",
    login: "ok",
    machines: [{ label: "studio" }],
    resetCredits: { availableCount: count },
  } satisfies UsageAccount],
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPeerLiveQuota", () => {
  it("never lets a pull that started before a spend bring the spent credit back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const onChanged = vi.fn();
    const store = createPeerLiveQuota({ logger: { warn: vi.fn() }, localMachineKey: () => "laptop", timeoutMs: 1_000, onChanged });
    const credits = () => store.get("studio")?.accounts[0]?.resetCredits?.availableCount;

    store.set(studioQuota(2), 999_000);
    expect(credits()).toBe(2);

    // A pull starts, the user spends one credit there, then the pull answers
    // with the count it read before the spend.
    const pullStartedAt = Date.now();
    vi.advanceTimersByTime(10);
    store.forgetResetCredits("studio", "claude:x");
    expect(credits()).toBeUndefined();
    expect(onChanged).toHaveBeenCalledTimes(1);
    store.set(studioQuota(2), pullStartedAt);
    expect(credits()).toBeUndefined();

    // A pull that started after the spend is the new truth.
    vi.advanceTimersByTime(10);
    store.set(studioQuota(1), Date.now());
    expect(credits()).toBe(1);

    // The other feed's older pull can still finish last; the newer count stands.
    store.set(studioQuota(2), pullStartedAt);
    expect(credits()).toBe(1);
  });
});
