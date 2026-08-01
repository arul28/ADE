// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_CONTRACT_VERSION,
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionItem,
  type AttentionPhase,
} from "../../shared/types";
import { attentionStore, resetAttentionStoreForTests } from "../state/attentionStore";
import { useAppStore } from "../state/appStore";

const listSessionsCached = vi.fn(async () => [] as unknown[]);
const invalidateSessionListCache = vi.fn();
const summarizeTerminalAttention = vi.fn(() => ({
  runningCount: 0,
  activeCount: 0,
  needsAttentionCount: 0,
  indicator: "none" as const,
  byLaneId: {},
}));

vi.mock("../lib/sessionListCache", () => ({
  listSessionsCached: (...args: unknown[]) => listSessionsCached(...(args as [])),
  invalidateSessionListCache: (...args: unknown[]) =>
    invalidateSessionListCache(...(args as [])),
}));
vi.mock("../lib/terminalAttention", () => ({
  summarizeTerminalAttention: (...args: unknown[]) =>
    summarizeTerminalAttention(...(args as [])),
}));

const { useAppWideSessionAttention } = await import("./useAppWideSessionAttention");

const originalAde = window.ade;
let setDockBadgeCount: ReturnType<typeof vi.fn>;
const noopUnsubscribe = () => {};

function needsYouItem(id: string, phase: AttentionPhase = "needs_you"): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id,
    revision: 1,
    fingerprint: `fingerprint-${id}`,
    kind: "agent",
    eventKind: "agent_needs_you",
    phase,
    machine: { machineKey: "studio", name: "Studio Mac", online: true, lastSeenAt: null },
    project: { projectId: "ade", name: "ADE" },
    title: id,
    preview: "preview",
    privacyPreview: "private preview",
    destination: { kind: "session", sessionId: id },
    actions: [],
    occurredAt: "2026-08-01T11:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
  };
}

function readyAccountFeed(items: AttentionItem[]): void {
  attentionStore.setState({
    itemsById: Object.fromEntries(items.map((item) => [item.id, item])),
    availability: {
      state: "ready",
      title: "Account Activity",
      message: "Live across your ADE account.",
      recovery: null,
    },
  });
}

function useAccountScope(): void {
  attentionStore.setState({
    preferences: {
      ...DEFAULT_ATTENTION_PREFERENCES,
      account: { ...DEFAULT_ATTENTION_PREFERENCES.account, dockBadgeScope: "account" },
    },
  });
}

function Probe() {
  useAppWideSessionAttention();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setDockBadgeCount = vi.fn(async () => {});
  summarizeTerminalAttention.mockReturnValue({
    runningCount: 0,
    activeCount: 0,
    needsAttentionCount: 2,
    indicator: "none" as const,
    byLaneId: {},
  });
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: {
      ...(originalAde ?? {}),
      app: { setDockBadgeCount },
      pty: { onData: () => noopUnsubscribe, onExit: () => noopUnsubscribe },
      agentChat: { onEvent: () => noopUnsubscribe },
      sessions: { onChanged: () => noopUnsubscribe },
    },
  });
  useAppStore.setState({
    showWelcome: false,
    project: { rootPath: "/repo/ade" } as never,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetAttentionStoreForTests();
  useAppStore.setState({ showWelcome: true, project: null });
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: originalAde,
  });
});

async function flushInitialRefresh(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(3_000);
    await Promise.resolve();
  });
}

describe("useAppWideSessionAttention dock badge scope", () => {
  it("badges this machine's sessions by default", async () => {
    readyAccountFeed([needsYouItem("a"), needsYouItem("b"), needsYouItem("c")]);
    render(<Probe />);
    await flushInitialRefresh();

    await waitFor(() => expect(setDockBadgeCount).toHaveBeenCalledWith(2));
  });

  it("badges the whole account's needs-you tier once the setting is flipped", async () => {
    useAccountScope();
    readyAccountFeed([needsYouItem("a"), needsYouItem("b"), needsYouItem("c")]);
    render(<Probe />);
    await flushInitialRefresh();

    await waitFor(() => expect(setDockBadgeCount).toHaveBeenCalledWith(3));
  });

  it("counts the hidden CTO thread on top of the account tier", async () => {
    useAccountScope();
    readyAccountFeed([needsYouItem("a")]);
    useAppStore.setState({ ctoAttention: { awaitingInput: true } as never });
    render(<Probe />);
    await flushInitialRefresh();

    await waitFor(() => expect(setDockBadgeCount).toHaveBeenCalledWith(2));
    useAppStore.setState({ ctoAttention: { awaitingInput: false } as never });
  });

  /**
   * A snapshot that has not landed knows nothing about the other machines, so
   * "0 account-wide" would be a claim the data cannot support. Degrade to the
   * local count instead of blanking the badge.
   */
  it("falls back to the local count while the account feed is not ready", async () => {
    useAccountScope();
    attentionStore.setState({
      itemsById: { a: needsYouItem("a"), b: needsYouItem("b"), c: needsYouItem("c") },
      availability: {
        state: "degraded",
        title: "Account Activity is reconnecting",
        message: "Retry to restore live updates.",
        recovery: "retry",
      },
    });
    render(<Probe />);
    await flushInitialRefresh();

    await waitFor(() => expect(setDockBadgeCount).toHaveBeenCalledWith(2));
  });

  it("follows the account feed as it changes, without a session refresh", async () => {
    useAccountScope();
    readyAccountFeed([needsYouItem("a")]);
    render(<Probe />);
    await flushInitialRefresh();
    await waitFor(() => expect(setDockBadgeCount).toHaveBeenCalledWith(1));

    act(() => {
      readyAccountFeed([needsYouItem("a"), needsYouItem("b")]);
    });

    await waitFor(() => expect(setDockBadgeCount).toHaveBeenCalledWith(2));
  });

  it("keeps badging the account when no project is open", async () => {
    useAccountScope();
    readyAccountFeed([needsYouItem("a"), needsYouItem("b")]);
    useAppStore.setState({ showWelcome: true });
    render(<Probe />);

    await waitFor(() => expect(setDockBadgeCount).toHaveBeenCalledWith(2));
  });

  it("clears the badge when no project is open and the scope is local", async () => {
    readyAccountFeed([needsYouItem("a"), needsYouItem("b")]);
    useAppStore.setState({ showWelcome: true });
    render(<Probe />);

    await waitFor(() => expect(setDockBadgeCount).toHaveBeenCalledWith(0));
  });
});
