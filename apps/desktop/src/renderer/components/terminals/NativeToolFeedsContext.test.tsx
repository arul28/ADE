/* @vitest-environment jsdom */

/**
 * The provider exists for one measurable reason: two consumers must not mean
 * two subscription sets. These tests count the reads rather than asserting on
 * rendered prose, because the defect they guard against — the corner card and
 * the tools pane each mounting `useNativeToolSessions` — was completely
 * invisible on screen.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NativeToolFeedsProvider,
  useNativeToolFeedHandlers,
  useNativeToolFeeds,
} from "./NativeToolFeedsContext";
import { makeBuiltInBrowserStatus } from "../chat/__fixtures__/builtInBrowserStatus";
import { useAppStore } from "../../state/appStore";

type Listener = (event: unknown) => void;

const browserListeners = new Set<Listener>();
const appControlListeners = new Set<Listener>();
const iosListeners = new Set<Listener>();

const browserGetStatus = vi.fn(async () => makeBuiltInBrowserStatus({ activeTabId: null, tabs: [] }));
const appControlGetStatus = vi.fn(async () => ({ activeSession: null }));
const iosGetStatus = vi.fn(async () => ({ activeSession: null }));
const browserOnEvent = vi.fn((listener: Listener) => {
  browserListeners.add(listener);
  return () => browserListeners.delete(listener);
});
const appControlOnEvent = vi.fn((listener: Listener) => {
  appControlListeners.add(listener);
  return () => appControlListeners.delete(listener);
});
const iosOnEvent = vi.fn((listener: Listener) => {
  iosListeners.add(listener);
  return () => iosListeners.delete(listener);
});

beforeEach(() => {
  browserListeners.clear();
  appControlListeners.clear();
  iosListeners.clear();
  browserGetStatus.mockClear();
  appControlGetStatus.mockClear();
  iosGetStatus.mockClear();
  browserOnEvent.mockClear();
  appControlOnEvent.mockClear();
  iosOnEvent.mockClear();
  Object.defineProperty(window.navigator, "platform", { configurable: true, value: "MacIntel" });
  (window as unknown as { ade?: unknown }).ade = {
    builtInBrowser: { getStatus: browserGetStatus, onEvent: browserOnEvent },
    appControl: { getStatus: appControlGetStatus, onEvent: appControlOnEvent },
    iosSimulator: { getStatus: iosGetStatus, onEvent: iosOnEvent },
  };
  useAppStore.setState({ projectBinding: null } as never);
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

/** A consumer that records what it was handed and what it was told. */
function Consumer({ name, seen }: { name: string; seen: Map<string, unknown[]> }) {
  const feeds = useNativeToolFeeds();
  useNativeToolFeedHandlers({
    onBrowserEvent: (event) => {
      const events = seen.get(name) ?? [];
      events.push(event);
      seen.set(name, events);
    },
  });
  return <div data-testid={name}>{feeds.browserStatus ? "browser" : "empty"}</div>;
}

describe("NativeToolFeedsProvider", () => {
  it("opens one subscription set for two consumers", async () => {
    const seen = new Map<string, unknown[]>();
    render(
      <NativeToolFeedsProvider active runtimePin={null}>
        <Consumer name="pane" seen={seen} />
        <Consumer name="card" seen={seen} />
      </NativeToolFeedsProvider>,
    );

    await waitFor(() => expect(browserOnEvent).toHaveBeenCalledTimes(1));
    // Two consumers, one read and one live subscription per feed. Before the
    // provider this was two of each.
    expect(browserGetStatus).toHaveBeenCalledTimes(1);
    expect(browserListeners.size).toBe(1);
    expect(appControlGetStatus).toHaveBeenCalledTimes(1);
    expect(appControlListeners.size).toBe(1);
    expect(iosGetStatus).toHaveBeenCalledTimes(1);
    expect(iosListeners.size).toBe(1);
  });

  it("fans one event out to every registered consumer", async () => {
    const seen = new Map<string, unknown[]>();
    render(
      <NativeToolFeedsProvider active runtimePin={null}>
        <Consumer name="pane" seen={seen} />
        <Consumer name="card" seen={seen} />
      </NativeToolFeedsProvider>,
    );
    await waitFor(() => expect(browserListeners.size).toBe(1));

    const event = { type: "status", status: makeBuiltInBrowserStatus({}) };
    for (const listener of browserListeners) listener(event);

    expect(seen.get("pane")).toEqual([event]);
    expect(seen.get("card")).toEqual([event]);
  });

  it("delivers the settled status to a consumer that registered before the first read", async () => {
    const settled = vi.fn();
    function SettledConsumer() {
      useNativeToolFeedHandlers({ onBrowserStatusSettled: settled });
      useNativeToolFeeds();
      return null;
    }
    render(
      <NativeToolFeedsProvider active runtimePin={null}>
        <SettledConsumer />
      </NativeToolFeedsProvider>,
    );

    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  });

  it("reads nothing while the page is inactive", async () => {
    const seen = new Map<string, unknown[]>();
    render(
      <NativeToolFeedsProvider active={false} runtimePin={null}>
        <Consumer name="pane" seen={seen} />
      </NativeToolFeedsProvider>,
    );

    await Promise.resolve();
    expect(browserGetStatus).not.toHaveBeenCalled();
    expect(appControlGetStatus).not.toHaveBeenCalled();
    expect(iosGetStatus).not.toHaveBeenCalled();
  });

  it("refuses to hand out feeds without an owner", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    function Orphan() {
      useNativeToolFeeds();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/NativeToolFeedsProvider/);
    error.mockRestore();
  });

  it("refuses to accept handlers without an owner, rather than dropping them", () => {
    // The dangerous half: registering outside the provider used to be a silent
    // no-op, so the consumer got no error and no events, and the symptom (a
    // corner card that stops repainting) points nowhere near the missing
    // provider.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    function OrphanHandler() {
      useNativeToolFeedHandlers({ onBrowserEvent: () => {} });
      return null;
    }
    expect(() => render(<OrphanHandler />)).toThrow(/NativeToolFeedsProvider/);
    error.mockRestore();
  });
});
