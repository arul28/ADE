// @vitest-environment jsdom
// React hook integration coverage is kept under a distinct basename so TypeScript
// includes it alongside the transport-only useActivitySync tests.

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_CONTRACT_VERSION,
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionItem,
  type AttentionSnapshot,
} from "../../../shared/types";
import {
  activityStore,
  resetActivityStoreForTests,
} from "../../state/activityStore";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "../../lib/account";
import {
  refreshActivitySnapshot,
  useActivitySync,
} from "./useActivitySync";

const originalAde = window.ade;
const originalVisibilityState = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

function liveItem(): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id: "live-account-item",
    revision: 4,
    fingerprint: "account-fingerprint",
    kind: "agent",
    eventKind: "agent_running",
    phase: "running",
    machine: {
      machineKey: "studio",
      name: "Studio Mac",
      online: true,
      lastSeenAt: "2026-07-28T14:00:00.000Z",
    },
    project: { projectId: "ade", name: "ADE" },
    provider: "codex",
    title: "Account work",
    preview: "Running across machines",
    privacyPreview: "Agent running",
    destination: { kind: "session", sessionId: "session-account" },
    actions: [],
    occurredAt: "2026-07-28T14:00:00.000Z",
    updatedAt: "2026-07-28T14:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
  };
}

function readySnapshot(
  items: AttentionItem[],
  revision = 1,
): AttentionSnapshot {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    scope: "account",
    availability: {
      state: "ready",
      title: "Account Activity",
      message: "Live across your ADE account.",
      recovery: null,
    },
    streamId: "account:test",
    revision,
    generatedAt: `2026-07-28T14:00:0${revision}.000Z`,
    items,
    tombstones: [],
  };
}

function signedInStatus(userId: string) {
  return {
    signedIn: true as const,
    userId,
    email: null,
    name: null,
    expiresAt: null,
    provider: null,
    imageUrl: null,
  };
}

function Harness({ surfaceVisible = true }: { surfaceVisible?: boolean }) {
  useActivitySync(surfaceVisible);
  return null;
}

function setDocumentVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetActivityStoreForTests();
  publishAccountStatus(SIGNED_OUT_ACCOUNT);
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: originalAde,
  });
  if (originalVisibilityState) {
    Object.defineProperty(document, "visibilityState", originalVisibilityState);
  } else {
    delete (document as unknown as { visibilityState?: string }).visibilityState;
  }
});

describe("useActivitySync", () => {
  it("keeps the last-known items as degraded when refresh fails", async () => {
    publishAccountStatus({
      signedIn: true,
      userId: "user-refresh-failure",
      email: null,
      name: null,
      expiresAt: null,
      provider: null,
      imageUrl: null,
    });
    let shouldFail = false;
    const getSnapshot = vi.fn(async (): Promise<AttentionSnapshot> => {
      if (shouldFail) throw new Error("relay offline");
      return {
        contractVersion: ATTENTION_CONTRACT_VERSION,
        scope: "account",
        availability: {
          state: "ready",
          title: "Account Activity",
          message: "Live across your ADE account.",
          recovery: null,
        },
        streamId: "account:last-known",
        revision: 7,
        generatedAt: "2026-07-28T14:01:00.000Z",
        items: [liveItem()],
        tombstones: [],
      };
    });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(originalAde ?? {}),
        attention: {
          getSnapshot,
          acknowledge: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences: vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES),
          putPreferences: vi.fn(),
        },
      },
    });

    render(<Harness />);

    await waitFor(() => expect(activityStore.getState().itemsById["live-account-item"]).toBeTruthy());
    shouldFail = true;
    await act(async () => {
      await refreshActivitySnapshot();
    });
    await waitFor(() => expect(activityStore.getState().availability).toMatchObject({
      state: "degraded",
      recovery: "retry",
    }));
    expect(activityStore.getState().snapshotScope).toBe("account");
    expect(activityStore.getState().itemsById["live-account-item"]).toBeTruthy();
    expect(activityStore.getState().syncStatus).toBe("error");
  });

  it("times out a wedged snapshot as retryable degradation and allows a later refresh", async () => {
    vi.useFakeTimers();
    const getSnapshot = vi.fn()
      .mockImplementationOnce(() => new Promise<AttentionSnapshot>(() => {}))
      .mockResolvedValueOnce({
        contractVersion: ATTENTION_CONTRACT_VERSION,
        scope: "machine",
        revision: 1,
        generatedAt: "2026-07-28T14:01:00.000Z",
        items: [],
        tombstones: [],
      } satisfies AttentionSnapshot);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(originalAde ?? {}),
        attention: {
          getSnapshot,
          acknowledge: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences: vi.fn(),
          putPreferences: vi.fn(),
        },
      },
    });

    const timedOutRefresh = refreshActivitySnapshot();
    expect(activityStore.getState().syncStatus).toBe("syncing");

    await vi.advanceTimersByTimeAsync(75_000);
    await timedOutRefresh;

    expect(activityStore.getState()).toMatchObject({
      syncStatus: "error",
      syncError: "Activity took too long to respond. Retry to restore live updates.",
      availability: {
        state: "degraded",
        recovery: "retry",
      },
    });

    await refreshActivitySnapshot();

    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(activityStore.getState()).toMatchObject({
      syncStatus: "ready",
      syncError: null,
      revision: 1,
    });
  });

  it("uses relaxed hidden presence cadence and sends immediately when visible again", async () => {
    vi.useFakeTimers();
    setDocumentVisibility("visible");
    const signedInStatus = {
      signedIn: true,
      userId: "user-presence-cadence",
      email: null,
      name: null,
      expiresAt: null,
      provider: null,
      imageUrl: null,
    } satisfies Parameters<typeof publishAccountStatus>[0];
    const reportPresence = vi.fn(async () => undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(originalAde ?? {}),
        attention: {
          getSnapshot: vi.fn(async (): Promise<AttentionSnapshot> => ({
            contractVersion: ATTENTION_CONTRACT_VERSION,
            scope: "account",
            revision: 0,
            generatedAt: "2026-07-28T14:01:00.000Z",
            items: [],
            tombstones: [],
          })),
          acknowledge: vi.fn(),
          reportPresence,
          getPreferences: vi.fn(),
          putPreferences: vi.fn(),
        },
        account: {
          ...(originalAde?.account ?? {}),
          status: vi.fn(async () => signedInStatus),
        },
      },
    });
    publishAccountStatus(signedInStatus);

    // A presence send resolves the device identity before it POSTs, so the
    // clock has to advance with microtasks flushed between timers.
    const advancePresenceTimers = async (durationMs: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(durationMs);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });
    };
    render(<Harness />);
    await advancePresenceTimers(0);
    const mountPresenceCount = reportPresence.mock.calls.length;
    expect(mountPresenceCount).toBeGreaterThan(0);

    await advancePresenceTimers(30_000);
    expect(reportPresence).toHaveBeenCalledTimes(mountPresenceCount + 1);
    await advancePresenceTimers(30_000);
    expect(reportPresence).toHaveBeenCalledTimes(mountPresenceCount + 2);

    act(() => {
      setDocumentVisibility("hidden");
    });
    await advancePresenceTimers(30_000);
    expect(reportPresence).toHaveBeenCalledTimes(mountPresenceCount + 2);
    await advancePresenceTimers(90_000);
    expect(reportPresence).toHaveBeenCalledTimes(mountPresenceCount + 3);

    act(() => {
      setDocumentVisibility("visible");
    });
    await advancePresenceTimers(0);
    expect(reportPresence).toHaveBeenCalledTimes(mountPresenceCount + 4);
  });

  it("keeps an in-flight account A preference fetch out of account B's store", async () => {
    publishAccountStatus({
      signedIn: true,
      userId: "account-a",
      email: null,
      name: null,
      expiresAt: null,
      provider: null,
      imageUrl: null,
    });
    let resolveAccountAPreferences:
      ((preferences: typeof DEFAULT_ATTENTION_PREFERENCES) => void) | null = null;
    const accountAPreferences = {
      ...DEFAULT_ATTENTION_PREFERENCES,
      account: {
        ...DEFAULT_ATTENTION_PREFERENCES.account,
        hideDetails: false,
        celebrationsEnabled: true,
        soundsEnabled: true,
      },
    };
    const accountBPreferences = {
      ...DEFAULT_ATTENTION_PREFERENCES,
      account: {
        ...DEFAULT_ATTENTION_PREFERENCES.account,
        hideDetails: false,
        celebrationsEnabled: false,
        soundsEnabled: false,
      },
    };
    const getPreferences = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof DEFAULT_ATTENTION_PREFERENCES>((resolve) => {
        resolveAccountAPreferences = resolve;
      }))
      .mockResolvedValue(accountBPreferences);
    const accountAItem = liveItem();
    const accountBItem = {
      ...liveItem(),
      id: "account-b-item",
      fingerprint: "account-b-fingerprint",
      machine: {
        ...liveItem().machine,
        machineKey: "account-b-machine",
        accountMachineKey: "canonical-account-b",
        deviceId: "device-account-b",
      },
      destination: { kind: "session" as const, sessionId: "session-account-b" },
    };
    const getSnapshot = vi.fn()
      .mockResolvedValueOnce({
        contractVersion: ATTENTION_CONTRACT_VERSION,
        streamId: "stream-a",
        revision: 1,
        generatedAt: "2026-07-28T14:01:00.000Z",
        items: [accountAItem],
        tombstones: [],
      } satisfies AttentionSnapshot)
      .mockResolvedValue({
        contractVersion: ATTENTION_CONTRACT_VERSION,
        streamId: "stream-b",
        revision: 1,
        generatedAt: "2026-07-28T14:02:00.000Z",
        items: [accountBItem],
        tombstones: [],
      } satisfies AttentionSnapshot);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(originalAde ?? {}),
        attention: {
          getSnapshot,
          acknowledge: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences,
          putPreferences: vi.fn(),
        },
      },
    });

    render(<Harness />);
    await waitFor(() => expect(getPreferences).toHaveBeenCalledTimes(1));

    await act(async () => {
      publishAccountStatus({
        signedIn: true,
        userId: "account-b",
        email: null,
        name: null,
        expiresAt: null,
        provider: null,
        imageUrl: null,
      });
    });

    await waitFor(() => {
      expect(activityStore.getState().itemsById["account-b-item"]).toBeTruthy();
      expect(activityStore.getState().preferences?.account.soundsEnabled).toBe(false);
    });

    await act(async () => {
      resolveAccountAPreferences?.(accountAPreferences);
      await Promise.resolve();
    });
    expect(activityStore.getState().preferences?.account.soundsEnabled).toBe(false);
  });

  it("requests incremental snapshots from the latest account cursor", async () => {
    const current = liveItem();
    activityStore.setState({
      revision: 9,
      itemsById: { [current.id]: current },
    });
    const getSnapshot = vi.fn(async (): Promise<AttentionSnapshot> => ({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      revision: 10,
      generatedAt: "2026-07-28T14:02:00.000Z",
      items: [],
      tombstones: [],
    }));
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(originalAde ?? {}),
        attention: {
          getSnapshot,
          acknowledge: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences: vi.fn(),
          putPreferences: vi.fn(),
        },
      },
    });

    await refreshActivitySnapshot();

    expect(getSnapshot).toHaveBeenCalledWith(9, null);
    expect(activityStore.getState().itemsById[current.id]).toBe(current);
    expect(activityStore.getState().revision).toBe(10);
  });

  it("hydrates the account snapshot and reports a visible surface as presence", async () => {
    publishAccountStatus({
      signedIn: true,
      userId: "user-account-snapshot",
      email: null,
      name: null,
      expiresAt: null,
      provider: null,
      imageUrl: null,
    });
    const snapshot: AttentionSnapshot = {
      contractVersion: ATTENTION_CONTRACT_VERSION,
      revision: 9,
      generatedAt: "2026-07-28T14:01:00.000Z",
      items: [liveItem()],
      tombstones: [],
    };
    const getSnapshot = vi.fn(async () => snapshot);
    const reportPresence = vi.fn(async () => undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(originalAde ?? {}),
        attention: {
          getSnapshot,
          acknowledge: vi.fn(),
          reportPresence,
          getPreferences: vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES),
          putPreferences: vi.fn(),
        },
        account: {
          ...(originalAde?.account ?? {}),
          status: vi.fn(async () => ({
            signedIn: true,
            userId: "user-account-snapshot",
            email: null,
            name: null,
            expiresAt: null,
            provider: null,
            imageUrl: null,
          })),
          getLocalMachineIdentity: vi.fn(async () => ({
            machineKey: "studio",
            deviceId: "desktop-device",
          })),
          listMachines: vi.fn(async () => ({
            state: "ok",
            machines: [{
              machineKey: "studio",
              deviceId: "desktop-device",
              name: "Studio Mac",
              platform: "macOS",
              deviceType: "desktop",
              reachableEndpoints: [],
              lastSeenAt: Date.now(),
              online: true,
            }],
            message: null,
          })),
        },
      },
    });

    render(<Harness surfaceVisible />);

    await waitFor(() => {
      expect(getSnapshot).toHaveBeenCalledWith(0, null);
      expect(activityStore.getState().itemsById["live-account-item"]).toBeTruthy();
    });
    await waitFor(() => {
      expect(reportPresence).toHaveBeenCalled();
      const calls = reportPresence.mock.calls as unknown as Array<[{
        deviceId: string;
        deviceName: string;
        ambientSurfaceVisible: boolean;
        visibleItemIds: string[];
      }]>;
      expect(calls.some(([presence]) =>
        presence.deviceId === "desktop-device"
        && presence.deviceName === "Studio Mac"
        && presence.ambientSurfaceVisible
        && presence.visibleItemIds.includes("live-account-item")
      )).toBe(true);
    });
  });
});
