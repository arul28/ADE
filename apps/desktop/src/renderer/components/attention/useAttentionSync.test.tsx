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
  materializeAttentionNotchSnapshot,
  refreshAttentionSnapshot,
  useAttentionSync,
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
      items: [runningItem],
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
    })).toEqual({
      enabled: true,
      revealMode: "click",
      expandedPanelEnabled: false,
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
});
