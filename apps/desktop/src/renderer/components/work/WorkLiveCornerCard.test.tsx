/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkLiveCornerCard } from "./WorkLiveCornerCard";
import { useAppStore } from "../../state/appStore";

type BrowserEventListener = (event: unknown) => void;

const browserListeners = new Set<BrowserEventListener>();
const startPreviewStream = vi.fn(async () => ({ tabId: "tab-1", fps: 12, maxWidth: 480, subscribers: 1 }));
const stopPreviewStream = vi.fn(async () => ({ tabId: "tab-1", fps: 12, maxWidth: 480, subscribers: 0 }));

const BROWSER_STATUS = {
  attached: true,
  visible: false,
  activeTabId: "tab-1",
  tabs: [
    {
      id: "tab-1",
      url: "https://example.test/login",
      title: "Sign in",
      ownerChatSessionId: "chat-1",
      recording: null,
      handoff: null,
    },
  ],
};

function emitBrowserEvent(event: unknown): void {
  act(() => {
    for (const listener of browserListeners) listener(event);
  });
}

beforeEach(() => {
  browserListeners.clear();
  startPreviewStream.mockClear();
  stopPreviewStream.mockClear();
  // jsdom has no ResizeObserver; the card sizes itself from one.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {}
    observe(target: Element): void {
      // motion's drag-constraint observer reads `entries`, so a callback with
      // no arguments blows up inside framer-motion rather than in our code.
      this.callback([{ target, contentRect: { width: 900, height: 600 } }], this);
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  // A host big enough for the card to decide it fits.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
  (window as unknown as { ade: unknown }).ade = {
    builtInBrowser: {
      getStatus: vi.fn(async () => BROWSER_STATUS),
      onEvent: (cb: BrowserEventListener) => {
        browserListeners.add(cb);
        return () => browserListeners.delete(cb);
      },
      startPreviewStream,
      stopPreviewStream,
    },
    appControl: { getStatus: vi.fn(async () => ({ activeSession: null })), onEvent: () => () => {} },
    iosSimulator: { getStatus: vi.fn(async () => ({ activeSession: null })), onEvent: () => () => {} },
  };
  useAppStore.setState({ projectBinding: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCard(overrides: Partial<Parameters<typeof WorkLiveCornerCard>[0]> = {}) {
  const onPick = vi.fn();
  const view = render(
    <WorkLiveCornerCard
      active
      laneId="lane-1"
      activeTool="git"
      runtimePin={null}
      onPick={onPick}
      {...overrides}
    />,
  );
  return { ...view, onPick };
}

describe("WorkLiveCornerCard", () => {
  it("shows nothing until a screen tool has actually done something", async () => {
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
    expect(startPreviewStream).not.toHaveBeenCalled();
  });

  it("shows the browser once it reports activity, and subscribes to its frames", async () => {
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });

    const card = await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
    expect(card).toBeTruthy();
    // The lease is held by a chat, so the header says so.
    expect(screen.getByText("agent")).toBeTruthy();
    await waitFor(() => expect(startPreviewStream).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "tab-1", fps: 12 }),
    ));
  });

  it("hands the pane back to the tool when the thumbnail is clicked", async () => {
    const { onPick } = renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });

    fireEvent.click(screen.getByLabelText("Open Browser in the tools pane"));
    expect(onPick).toHaveBeenCalledWith("browser");
  });

  it("captions the last agent action and hides on dismiss", async () => {
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });

    emitBrowserEvent({
      type: "trace",
      tabId: "tab-1",
      entry: {
        id: "trace-1",
        tabId: "tab-1",
        action: "click",
        status: "ok",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 20,
        target: { text: "Sign in" },
      },
    });
    expect(await screen.findByTitle(/click 'Sign in'/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());
    await waitFor(() => expect(stopPreviewStream).toHaveBeenCalled());
  });

  it("stays hidden when the browser is the tool already filling the pane", async () => {
    renderCard({ activeTool: "browser" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
    expect(startPreviewStream).not.toHaveBeenCalled();
  });
});
