// @vitest-environment jsdom
// React hook integration coverage is kept under a distinct basename so TypeScript
// includes it alongside the transport-only useAttentionSync tests.

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_CONTRACT_VERSION,
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionItem,
  type AttentionNotchSettings,
  type AttentionSnapshot,
} from "../../../shared/types";
import {
  attentionStore,
  resetAttentionStoreForTests,
} from "../../state/attentionStore";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "../../lib/account";
import {
  attentionNotchSettingsFromPreferences,
  attentionNotchSnapshotSignature,
  attentionToastForTransition,
  materializeAttentionNotchSnapshot,
  refreshAttentionSnapshot,
  useAttentionSync,
  MAX_NOTCH_PROJECTION_ITEMS,
  TOAST_ITEM_COOLDOWN_MS,
  TOAST_MIN_INTERVAL_MS,
} from "./useAttentionSync";

const originalAde = window.ade;
const originalVisibilityState = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

const runningItem: AttentionItem = {
  contractVersion: 1,
  id: "agent-running",
  revision: 2,
  fingerprint: "running:2",
  kind: "agent",
  eventKind: "agent_running",
  phase: "running",
  machine: {
    machineKey: "machine-1",
    name: "MacBook Pro",
    online: true,
    lastSeenAt: null,
  },
  project: {
    projectId: "project-1",
    name: "ADE",
    rootPath: "/projects/ADE",
  },
  title: "Running",
  preview: "Implementing Attention",
  privacyPreview: "Agent is working",
  destination: {
    kind: "session",
    sessionId: "session-1",
  },
  actions: [],
  occurredAt: "2026-07-28T12:00:00.000Z",
  updatedAt: "2026-07-28T12:00:01.000Z",
  seenAt: null,
  dismissedAt: null,
  expiresAt: null,
};

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

function Harness({ surfaceVisible = true }: { surfaceVisible?: boolean }) {
  useAttentionSync(surfaceVisible);
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
  resetAttentionStoreForTests();
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

describe("useAttentionSync", () => {
  it("applies privacy settings before publishing the first native snapshot", async () => {
    publishAccountStatus({
      signedIn: true,
      userId: "user-settings-order",
      email: null,
      name: null,
      expiresAt: null,
      provider: null,
      imageUrl: null,
    });
    const calls: string[] = [];
    const updateSettings = vi.fn(async () => {
      calls.push("settings");
    });
    const publishSnapshot = vi.fn(async () => {
      calls.push("snapshot");
    });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(originalAde ?? {}),
        attention: {
          getSnapshot: vi.fn(async (): Promise<AttentionSnapshot> => ({
            contractVersion: ATTENTION_CONTRACT_VERSION,
            revision: 0,
            generatedAt: "2026-07-28T14:01:00.000Z",
            items: [],
            tombstones: [],
          })),
          acknowledge: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences: vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES),
          putPreferences: vi.fn(),
        },
        account: {
          ...(originalAde?.account ?? {}),
          status: vi.fn(async () => ({
            signedIn: true,
            userId: "user-settings-order",
            email: null,
            name: null,
            expiresAt: null,
            provider: null,
            imageUrl: null,
          })),
        },
        attentionNotch: {
          publishSnapshot,
          updateSettings,
          setVisible: vi.fn(),
          reanchor: vi.fn(),
          onAcknowledgeRequested: vi.fn(() => () => {}),
        },
      },
    });

    render(<Harness />);

    await waitFor(() => expect(publishSnapshot).toHaveBeenCalled());
    expect(calls.slice(0, 2)).toEqual(["settings", "snapshot"]);
  });

  it("starts the notch and hydrates machine-local work on a signed-out cold launch", async () => {
    const machineSnapshot: AttentionSnapshot = {
      contractVersion: ATTENTION_CONTRACT_VERSION,
      scope: "machine",
      availability: {
        state: "signed_out",
        title: "This machine only",
        message: "Sign in to combine Attention across every ADE machine.",
        recovery: "sign_in",
      },
      streamId: "machine:studio",
      revision: 3,
      generatedAt: "2026-07-28T14:01:00.000Z",
      items: [liveItem()],
      tombstones: [],
    };
    const getSnapshot = vi.fn(async () => machineSnapshot);
    const updateSettings = vi.fn(async () => undefined);
    const publishSnapshot = vi.fn(async () => undefined);
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
        attentionNotch: {
          publishSnapshot,
          updateSettings,
          onAcknowledgeRequested: vi.fn(() => () => {}),
        },
      },
    });

    render(<Harness />);

    await waitFor(() => expect(getSnapshot).toHaveBeenCalledWith(0, null));
    await waitFor(() => expect(publishSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "machine",
        availability: expect.objectContaining({ state: "signed_out" }),
        items: [expect.objectContaining({ id: "live-account-item" })],
      }),
    ));
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      enabled: expect.any(Boolean),
      hideDetails: true,
    }));
  });

  it("persists presentation settings changed from the native context menu", async () => {
    window.localStorage.clear();
    let settingsChanged:
      ((settings: AttentionNotchSettings) => void) | null = null;
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(originalAde ?? {}),
        attention: {
          getSnapshot: vi.fn(async (): Promise<AttentionSnapshot> => ({
            contractVersion: ATTENTION_CONTRACT_VERSION,
            scope: "machine",
            revision: 0,
            generatedAt: "2026-07-28T14:01:00.000Z",
            items: [],
            tombstones: [],
          })),
          acknowledge: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences: vi.fn(),
          putPreferences: vi.fn(),
        },
        attentionNotch: {
          publishSnapshot: vi.fn(async () => undefined),
          updateSettings: vi.fn(async () => undefined),
          onAcknowledgeRequested: vi.fn(() => () => {}),
          onSettingsChanged: vi.fn((callback) => {
            settingsChanged = callback;
            return () => {};
          }),
        },
      },
    });

    render(<Harness />);
    await waitFor(() => expect(settingsChanged).not.toBeNull());
    act(() => {
      settingsChanged?.({
        enabled: false,
        revealMode: "click",
        expandedPanelEnabled: false,
        automaticRevealEnabled: false,
        tickerEnabled: false,
        preferredDisplayId: null,
        hideDetails: true,
        celebrationsEnabled: true,
        soundsEnabled: false,
      });
    });

    expect(window.localStorage.getItem("ade:attention:notch-enabled")).toBe("false");
    expect(window.localStorage.getItem("ade:attention:notch-reveal-mode")).toBe("click");
    expect(window.localStorage.getItem("ade:attention:notch-expanded-panel")).toBe("false");
  });

  it("publishes a degraded last-known snapshot when refresh fails", async () => {
    publishAccountStatus({
      signedIn: true,
      userId: "user-refresh-failure",
      email: null,
      name: null,
      expiresAt: null,
      provider: null,
      imageUrl: null,
    });
    const publishSnapshot = vi.fn(async () => undefined);
    let shouldFail = false;
    const getSnapshot = vi.fn(async (): Promise<AttentionSnapshot> => {
      if (shouldFail) throw new Error("relay offline");
      return {
        contractVersion: ATTENTION_CONTRACT_VERSION,
        scope: "account",
        availability: {
          state: "ready",
          title: "Account Attention",
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
        attentionNotch: {
          publishSnapshot,
          updateSettings: vi.fn(),
          onAcknowledgeRequested: vi.fn(() => () => {}),
        },
      },
    });

    render(<Harness />);

    await waitFor(() => expect(attentionStore.getState().itemsById["live-account-item"]).toBeTruthy());
    shouldFail = true;
    await act(async () => {
      await refreshAttentionSnapshot();
    });
    await waitFor(() => expect(attentionStore.getState().availability).toMatchObject({
      state: "degraded",
      recovery: "retry",
    }));
    await waitFor(() => expect(publishSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "account",
        availability: expect.objectContaining({ state: "degraded" }),
        items: [expect.objectContaining({ id: "live-account-item" })],
      }),
    ));
    expect(attentionStore.getState().syncStatus).toBe("error");
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

    const timedOutRefresh = refreshAttentionSnapshot();
    expect(attentionStore.getState().syncStatus).toBe("syncing");

    await vi.advanceTimersByTimeAsync(75_000);
    await timedOutRefresh;

    expect(attentionStore.getState()).toMatchObject({
      syncStatus: "error",
      syncError: "Attention took too long to respond. Retry to restore live updates.",
      availability: {
        state: "degraded",
        recovery: "retry",
      },
    });

    await refreshAttentionSnapshot();

    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(attentionStore.getState()).toMatchObject({
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

  it("keeps an in-flight account A preference fetch out of account B's notch stream", async () => {
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
    const events: string[] = [];
    const updateSettings = vi.fn(async (settings: AttentionNotchSettings) => {
      const label = settings.hideDetails
        ? "fail-closed"
        : settings.soundsEnabled
          ? "account-a"
          : "account-b";
      events.push(`settings:${label}`);
    });
    const publishSnapshot = vi.fn(async (snapshot: AttentionSnapshot) => {
      events.push(`snapshot:${snapshot.streamId ?? "none"}`);
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
          getPreferences,
          putPreferences: vi.fn(),
        },
        attentionNotch: {
          publishSnapshot,
          updateSettings,
          setVisible: vi.fn(),
          reanchor: vi.fn(),
          onAcknowledgeRequested: vi.fn(() => () => {}),
        },
      },
    });

    render(<Harness />);
    await waitFor(() => expect(getPreferences).toHaveBeenCalledTimes(1));
    events.length = 0;

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
      expect(publishSnapshot.mock.calls.some(
        ([snapshot]) => snapshot.streamId === "stream-b",
      )).toBe(true);
    });
    const firstAccountBSnapshot = events.indexOf("snapshot:stream-b");
    expect(firstAccountBSnapshot).toBeGreaterThan(0);
    expect(events.slice(0, firstAccountBSnapshot)).toContain("settings:fail-closed");
    expect(events).toContain("settings:account-b");

    const settingsCallsBeforeLateAccountA = updateSettings.mock.calls.length;
    await act(async () => {
      resolveAccountAPreferences?.(accountAPreferences);
      await Promise.resolve();
    });
    expect(updateSettings).toHaveBeenCalledTimes(settingsCallsBeforeLateAccountA);
    expect(events).not.toContain("settings:account-a");
  });

  it("requests incremental snapshots from the latest account cursor", async () => {
    const current = liveItem();
    attentionStore.setState({
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

    await refreshAttentionSnapshot();

    expect(getSnapshot).toHaveBeenCalledWith(9, null);
    expect(attentionStore.getState().itemsById[current.id]).toBe(current);
    expect(attentionStore.getState().revision).toBe(10);
  });

  it("hydrates the account snapshot and counts a running native notch as visible presence", async () => {
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
        attentionNotch: {
          ...(originalAde?.attentionNotch ?? {}),
          getHealth: vi.fn(async () => ({
            state: "running",
            title: "ADE Notch is active",
            message: "Showing account activity in the menu bar.",
            recovery: null,
            surface: "menu_bar",
          })),
          publishSnapshot: vi.fn(async () => undefined),
          updateSettings: vi.fn(async () => undefined),
          onAcknowledgeRequested: vi.fn(() => () => {}),
          onRefreshRequested: vi.fn(() => () => {}),
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

    render(<Harness surfaceVisible={false} />);

    await waitFor(() => {
      expect(getSnapshot).toHaveBeenCalledWith(0, null);
      expect(attentionStore.getState().itemsById["live-account-item"]).toBeTruthy();
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

  it("keeps refreshing the native notch snapshot while ADE is hidden", async () => {
    publishAccountStatus({
      signedIn: true,
      userId: "user-background-notch",
      email: null,
      name: null,
      expiresAt: null,
      provider: null,
      imageUrl: null,
    });
    const getSnapshot = vi.fn(async (): Promise<AttentionSnapshot> => ({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      streamId: "account-background",
      revision: getSnapshot.mock.calls.length,
      generatedAt: "2026-07-28T14:05:00.000Z",
      items: [],
      tombstones: [],
    }));
    let requestRefresh: (() => void) | null = null;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
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
        attentionNotch: {
          publishSnapshot: vi.fn(),
          updateSettings: vi.fn(),
          onAcknowledgeRequested: vi.fn(() => () => {}),
          onRefreshRequested: vi.fn((callback: () => void) => {
            requestRefresh = callback;
            return () => {};
          }),
        },
      },
    });

    render(<Harness />);
    await waitFor(() => {
      expect(getSnapshot).toHaveBeenCalled();
      expect(requestRefresh).not.toBeNull();
    });
    const hiddenRefreshBaseline = getSnapshot.mock.calls.length;

    await act(async () => {
      requestRefresh?.();
      await Promise.resolve();
    });

    expect(getSnapshot).toHaveBeenCalledTimes(hiddenRefreshBaseline + 1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      requestRefresh?.();
      await Promise.resolve();
    });

    expect(getSnapshot).toHaveBeenCalledTimes(hiddenRefreshBaseline + 1);
  });
});

describe("Attention Notch renderer bridge", () => {
  beforeEach(() => resetAttentionStoreForTests());

  it("materializes the merged renderer state rather than forwarding a delta", () => {
    attentionStore.setState({
      revision: 8,
      generatedAt: "2026-07-28T12:00:02.000Z",
      itemsById: { [runningItem.id]: runningItem },
    });
    expect(materializeAttentionNotchSnapshot()).toEqual({
      contractVersion: 1,
      scope: "machine",
      availability: {
        state: "signed_out",
        title: "This machine only",
        message: "Sign in to combine Attention across every ADE machine.",
        recovery: "sign_in",
      },
      streamId: null,
      revision: 8,
      generatedAt: "2026-07-28T12:00:02.000Z",
      // `recentActivity` is dropped from the projection; `runningItem` has none.
      items: [runningItem],
      itemsTruncated: false,
      counts: {
        needsYou: 0,
        working: 1,
        done: 0,
        total: 1,
        machinesOnline: 1,
        machinesTotal: 1,
      },
      tombstones: [],
    });
  });

  it("maps account privacy, celebration, sound, and local presentation settings", () => {
    expect(attentionNotchSettingsFromPreferences({
      ...DEFAULT_ATTENTION_PREFERENCES,
      account: {
        ...DEFAULT_ATTENTION_PREFERENCES.account,
        hideDetails: true,
        celebrationsEnabled: false,
        soundsEnabled: false,
      },
    }, true, {
      revealMode: "click",
      expandedPanelEnabled: false,
      automaticRevealEnabled: false,
      tickerEnabled: true,
    })).toEqual({
      enabled: true,
      revealMode: "click",
      expandedPanelEnabled: false,
      automaticRevealEnabled: false,
      tickerEnabled: true,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: false,
      soundsEnabled: false,
    });
  });

  it("invalidates the native snapshot signature for routing and availability changes", () => {
    const base: AttentionSnapshot = {
      contractVersion: 1,
      scope: "account",
      availability: {
        state: "ready",
        title: "Account Attention",
        message: "Live across your ADE account.",
        recovery: null,
      },
      streamId: "account-stream",
      revision: 8,
      generatedAt: "2026-07-28T12:00:02.000Z",
      items: [runningItem],
      tombstones: [],
    };
    const routingChanged = {
      ...base,
      items: [{
        ...runningItem,
        machine: {
          ...runningItem.machine,
          accountMachineKey: "canonical-machine-1",
          deviceId: "device-machine-1",
          name: "MacBook Pro · Remote",
          online: false,
          lastSeenAt: "2026-07-28T12:05:00.000Z",
        },
      }],
    };
    const availabilityChanged = {
      ...base,
      availability: {
        state: "degraded" as const,
        title: "Account Attention is reconnecting",
        message: "Last-known work remains available.",
        recovery: "retry" as const,
      },
    };

    expect(attentionNotchSnapshotSignature(routingChanged))
      .not.toBe(attentionNotchSnapshotSignature(base));
    expect(attentionNotchSnapshotSignature(availabilityChanged))
      .not.toBe(attentionNotchSnapshotSignature(base));
    expect(routingChanged.items[0]?.machine.accountMachineKey)
      .toBe("canonical-machine-1");
  });

  it("publishes a bounded, priority-ordered projection with full-set counts", () => {
    const itemsById: Record<string, AttentionItem> = {};
    // 60 ambient rows plus 5 that need you: more than the projection carries,
    // so the ordering and the counts both have to be doing real work.
    for (let index = 0; index < 60; index += 1) {
      const id = `working-${String(index).padStart(3, "0")}`;
      itemsById[id] = {
        ...runningItem,
        id,
        fingerprint: `${id}:1`,
        preview: `x`.repeat(400),
        recentActivity: ["Read package.json", "Ran tests"],
      };
    }
    for (let index = 0; index < 5; index += 1) {
      const id = `needs-${index}`;
      itemsById[id] = {
        ...runningItem,
        id,
        fingerprint: `${id}:1`,
        eventKind: "agent_needs_you",
        phase: "needs_you",
        activityTier: "signal",
      };
    }
    attentionStore.setState({
      revision: 9,
      generatedAt: "2026-07-28T12:00:02.000Z",
      itemsById,
    });

    const snapshot = materializeAttentionNotchSnapshot();
    expect(snapshot.items).toHaveLength(MAX_NOTCH_PROJECTION_ITEMS);
    expect(snapshot.itemsTruncated).toBe(true);
    // Needs-you first, always: the slice is the top of Activity's own order.
    expect(snapshot.items.slice(0, 5).map((entry) => entry.id).sort()).toEqual([
      "needs-0",
      "needs-1",
      "needs-2",
      "needs-3",
      "needs-4",
    ]);
    for (const entry of snapshot.items) {
      expect(entry.preview.length).toBeLessThanOrEqual(160);
      expect(entry).not.toHaveProperty("recentActivity");
    }
    // The store's own objects must be untouched by the projection.
    expect(attentionStore.getState().itemsById["working-000"]?.preview).toHaveLength(400);
    expect(attentionStore.getState().itemsById["working-000"]?.recentActivity)
      .toHaveLength(2);
    // Counts describe the whole account, not the 48 rows that travelled.
    expect(snapshot.counts).toEqual({
      needsYou: 5,
      working: 60,
      done: 0,
      total: 65,
      machinesOnline: 1,
      machinesTotal: 1,
    });
  });

  it("republishes when only the counts changed", () => {
    const base = materializeAttentionNotchSnapshot();
    expect(attentionNotchSnapshotSignature({
      ...base,
      counts: {
        needsYou: 1,
        working: 0,
        done: 0,
        total: 1,
        machinesOnline: 1,
        machinesTotal: 1,
      },
    })).not.toBe(attentionNotchSnapshotSignature({ ...base, counts: undefined }));
  });
});

describe("Attention Notch toast decisions", () => {
  const signalItem: AttentionItem = {
    ...runningItem,
    id: "agent-needs-you",
    eventKind: "agent_needs_you",
    phase: "needs_you",
    activityTier: "signal",
    title: "Approve the command",
    preview: "rm -rf ./build",
    privacyPreview: "Agent needs your attention",
  };

  const decide = (
    overrides: Partial<Parameters<typeof attentionToastForTransition>[0]> = {},
  ) => attentionToastForTransition({
    items: [signalItem],
    previousPhases: new Map([[signalItem.id, "running"]]),
    lastToastAtByItem: new Map(),
    lastToastAt: 0,
    availabilityState: "ready",
    automaticRevealEnabled: true,
    hideDetails: false,
    now: 1_000_000,
    ...overrides,
  });

  it("fires once on a phase transition and never on first sighting", () => {
    expect(decide()).toMatchObject({
      itemId: "agent-needs-you",
      eventKind: "agent_needs_you",
      treatment: "alert",
      title: "Approve the command",
      subtitle: "rm -rf ./build",
    });
    expect(decide({ previousPhases: new Map() })).toBeNull();
    // Same phase twice is not a transition.
    expect(decide({
      previousPhases: new Map([[signalItem.id, "needs_you"]]),
    })).toBeNull();
  });

  it("holds an item quiet for ten minutes after its own toast", () => {
    const lastToastAtByItem = new Map([[signalItem.id, 1_000_000 - 60_000]]);
    expect(decide({ lastToastAtByItem })).toBeNull();
    expect(decide({
      lastToastAtByItem,
      now: 1_000_000 - 60_000 + TOAST_ITEM_COOLDOWN_MS,
    })).not.toBeNull();
  });

  it("rate-limits the account to one toast per five seconds", () => {
    expect(decide({ lastToastAt: 1_000_000 - (TOAST_MIN_INTERVAL_MS - 1) })).toBeNull();
    expect(decide({ lastToastAt: 1_000_000 - TOAST_MIN_INTERVAL_MS })).not.toBeNull();
  });

  it("emits only the highest-priority transition in a burst, and drops the rest", () => {
    const failed: AttentionItem = {
      ...signalItem,
      id: "agent-failed",
      eventKind: "agent_failed",
      phase: "failed",
      activityTier: "signal",
      title: "Build failed",
    };
    const toast = decide({
      items: [failed, signalItem],
      previousPhases: new Map([
        [failed.id, "running"],
        [signalItem.id, "running"],
      ]),
    });
    // needs_you outranks failed in ATTENTION_PHASE_PRIORITY.
    expect(toast?.itemId).toBe(signalItem.id);
  });

  it("stays silent when suppressed", () => {
    expect(decide({ automaticRevealEnabled: false })).toBeNull();
    expect(decide({ availabilityState: "degraded" })).toBeNull();
    expect(decide({ availabilityState: null })).toBeNull();
    // Ambient rows never interrupt, however much they change.
    expect(decide({
      items: [{ ...signalItem, activityTier: "ambient" }],
    })).toBeNull();
    expect(decide({
      items: [{ ...signalItem, seenAt: "2026-07-28T12:00:00.000Z" }],
    })).toBeNull();
    expect(decide({
      items: [{ ...signalItem, dismissedAt: "2026-07-28T12:00:00.000Z" }],
    })).toBeNull();
  });

  it("uses privacy copy when hide-details is on", () => {
    expect(decide({ hideDetails: true })).toMatchObject({
      title: "Agent update",
      subtitle: "Agent needs your attention",
    });
    expect(decide({
      hideDetails: true,
      items: [{ ...signalItem, kind: "pull_request", destination: {
        kind: "pull_request",
        number: 42,
        tab: "overview",
      } }],
    })).toMatchObject({ title: "Pull request update" });
  });

  it("maps a merge to the celebration treatment", () => {
    expect(decide({
      items: [{
        ...signalItem,
        kind: "pull_request",
        eventKind: "pr_merged",
        phase: "merged",
        activityTier: "signal",
        destination: { kind: "pull_request", number: 42, tab: "overview" },
      }],
      previousPhases: new Map([[signalItem.id, "merge_ready"]]),
    })).toMatchObject({ treatment: "celebration" });
  });
});

