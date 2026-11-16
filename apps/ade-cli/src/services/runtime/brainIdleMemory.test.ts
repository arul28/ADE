import type { AdeRuntime } from "../../bootstrap";
import { afterEach, describe, expect, it, vi } from "vitest";

import { noteUserClientClosed, noteUserClientOpened } from "./brainIdleMemory";

/**
 * The brain's unattended release (`brainIdleMemory.ts`): while no desktop
 * window and no other machine is connected, a pass asks every open project to
 * give back the provider processes of finished chats.
 *
 * What this pins is the switch, not the pass's internals: it runs while nobody
 * is connected, it keeps looking while a project is open (a scheduled wake or
 * a webhook can start a chat with no client attached), and a window that opens
 * stops it. The per-chat keep/release rules are the service's, pinned against
 * `releaseUnattendedRuntimes` in `agentChatServiceLifecycle.test.ts`.
 */
describe("unattended agent release", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs while nobody is connected and stops when a window opens", async () => {
    vi.useFakeTimers();
    const releaseUnattendedRuntimes = vi.fn(() => ({ released: 0, kept: 0 }));
    const runtime = {
      agentChatService: { releaseUnattendedRuntimes },
    } as unknown as AdeRuntime;
    const sources = { listRuntimes: vi.fn(() => [runtime]) };

    noteUserClientClosed("desktop", sources);
    // The documented delay: a window that reloads or a phone that reconnects
    // comes back before any of this runs.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(releaseUnattendedRuntimes).toHaveBeenCalled();
    // The 30 s window is the product's promise to the person: a finished chat
    // hands its provider process back 30 s after the last client leaves.
    expect(releaseUnattendedRuntimes).toHaveBeenLastCalledWith(30_000);

    // A project stays open with nobody attached, so the pass keeps looking:
    // a chat started later by a scheduled wake gets the same release.
    const passesWhileUnattended = releaseUnattendedRuntimes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(releaseUnattendedRuntimes.mock.calls.length).toBeGreaterThan(passesWhileUnattended);

    // A window opens. Nobody can finish a chat without a client, and the pass
    // must not keep waking the brain for it.
    noteUserClientOpened("desktop");
    const passesWhenTheWindowOpened = releaseUnattendedRuntimes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(releaseUnattendedRuntimes.mock.calls.length).toBe(passesWhenTheWindowOpened);

    // It leaves again and the pass resumes.
    noteUserClientClosed("desktop", sources);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(releaseUnattendedRuntimes.mock.calls.length).toBeGreaterThan(passesWhenTheWindowOpened);
  });
});
