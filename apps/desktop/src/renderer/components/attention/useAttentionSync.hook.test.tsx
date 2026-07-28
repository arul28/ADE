// @vitest-environment jsdom
// React hook integration coverage is kept under a distinct basename so TypeScript
// includes it alongside the transport-only useAttentionSync tests.

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { refreshAttentionSnapshot, useAttentionSync } from "./useAttentionSync";

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

function Harness() {
  useAttentionSync(true);
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

  it("hydrates the account snapshot and reports the visible desktop presence", async () => {
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
          getPreferences: vi.fn(),
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

    render(<Harness />);

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
      expect(getSnapshot).toHaveBeenCalledTimes(1);
      expect(requestRefresh).not.toBeNull();
    });

    await act(async () => {
      requestRefresh?.();
      await Promise.resolve();
    });

    expect(getSnapshot).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      requestRefresh?.();
      await Promise.resolve();
    });

    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });
});
