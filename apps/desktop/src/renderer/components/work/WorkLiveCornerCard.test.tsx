/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkLiveCornerCard } from "./WorkLiveCornerCard";
import { NativeToolFeedsProvider } from "../terminals/NativeToolFeedsContext";
import { useAppStore } from "../../state/appStore";
import type { BuiltInBrowserStatus } from "../../../shared/types";
import {
  makeBuiltInBrowserStatus,
  makeBuiltInBrowserTab,
} from "../chat/__fixtures__/builtInBrowserStatus";

type BrowserEventListener = (event: unknown) => void;

const browserListeners = new Set<BrowserEventListener>();
const appControlListeners = new Set<BrowserEventListener>();
const startPreviewStream = vi.fn(async () => ({ tabId: "tab-1", fps: 12, maxWidth: 480, subscribers: 1 }));
const stopPreviewStream = vi.fn(async () => ({ tabId: "tab-1", fps: 12, maxWidth: 480, subscribers: 0 }));

const BROWSER_STATUS: BuiltInBrowserStatus = makeBuiltInBrowserStatus({
  visible: false,
  activeTabId: "tab-1",
  tabs: [
    makeBuiltInBrowserTab({
      id: "tab-1",
      url: "https://example.test/login",
      title: "Sign in",
      ownerChatSessionId: "chat-1",
    }),
  ],
});

function emitBrowserEvent(event: unknown): void {
  act(() => {
    for (const listener of browserListeners) listener(event);
  });
}

function emitAppControlEvent(event: unknown): void {
  act(() => {
    for (const listener of appControlListeners) listener(event);
  });
}

const APP_CONTROL_SESSION = { status: "connected", label: "Playground", chatSessionId: null };

/** One screencast frame, the 30fps feed that used to count as "activity". */
function appControlFrame() {
  return { type: "frame", frame: { mimeType: "image/jpeg", data: "AAAA" } };
}

beforeEach(() => {
  browserListeners.clear();
  appControlListeners.clear();
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
    appControl: {
      getStatus: vi.fn(async () => ({ activeSession: null })),
      onEvent: (cb: BrowserEventListener) => {
        appControlListeners.add(cb);
        return () => appControlListeners.delete(cb);
      },
      getTrace: vi.fn(async () => ({ entries: [] })),
    },
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
  const props = {
    active: true,
    laneId: "lane-1" as string | null,
    activeTool: "git" as Parameters<typeof WorkLiveCornerCard>[0]["activeTool"],
    runtimePin: null,
    onPick,
    ...overrides,
  };
  // The feeds come from the page's provider in production; the card opens no
  // subscriptions of its own, so the test has to supply the same owner.
  const view = render(
    <NativeToolFeedsProvider active={props.active} runtimePin={props.runtimePin}>
      <WorkLiveCornerCard {...props} />
    </NativeToolFeedsProvider>,
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
    // The lease is held by a chat, so the title reads "Browser · agent".
    expect(screen.getByText("· agent")).toBeTruthy();
    await waitFor(() => expect(startPreviewStream).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "tab-1", fps: 12 }),
    ));
  });

  it("paints a preview frame that arrives through the provider's fan-out", async () => {
    // The regression this covers: the card opens no subscriptions of its own,
    // so a `preview-frame` reaches its `<img>` only if the provider fans the
    // event out to the handler set the card registered. When that fan-out was
    // broken the card still said "Live" and still called `startPreviewStream`
    // — it just never repainted, which is invisible to every other assertion
    // here.
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    const card = await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
    await waitFor(() => expect(startPreviewStream).toHaveBeenCalled());

    const frame = "data:image/jpeg;base64,ZnJhbWUtb25l";
    emitBrowserEvent({
      type: "preview-frame",
      tabId: "tab-1",
      dataUrl: frame,
      width: 480,
      height: 300,
      capturedAt: new Date().toISOString(),
    });

    // Painted through one rAF, so the assertion has to wait for it.
    await waitFor(() => {
      const live = card.querySelector("img");
      expect(live?.getAttribute("src")).toBe(frame);
    });
  });

  it("never starts a browser feed for a pane with no tab", async () => {
    // A browser whose last tab just closed still reports status, and the card
    // still comes up for it. Asking that pane for frames is asking it to
    // capture nothing, which is where the screenshot path used to throw on
    // every tick.
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({
      type: "status",
      status: { ...BROWSER_STATUS, activeTabId: null, tabs: [] },
    });

    // Give the feed effect every chance to fire before asserting it did not.
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    expect(startPreviewStream).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
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
    expect(await screen.findByTitle(/Clicked 'Sign in'/)).toBeTruthy();

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

/* ── Placement, dismissal and scrubbing ──────────────────────────────────── */

const PROJECT_ROOT = "/p/live-card";

function seedProject(): void {
  useAppStore.setState({
    project: { rootPath: PROJECT_ROOT } as never,
    projectBinding: null,
    workViewByProject: {},
    laneWorkViewByScope: {},
  });
}

function traceEvent(id: string, action: string, text: string) {
  return {
    type: "trace",
    tabId: "tab-1",
    entry: {
      id,
      tabId: "tab-1",
      action,
      status: "ok",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 12,
      target: { text },
    },
  };
}

/**
 * jsdom has no PointerEvent constructor, so `fireEvent.pointerMove` drops
 * `clientX` — which is the only thing the scrubber reads. A MouseEvent named
 * `pointermove` carries it and React dispatches it to `onPointerMove` all the
 * same.
 */
function scrubTo(card: HTMLElement, clientX: number): void {
  fireEvent(card, new MouseEvent("pointermove", { bubbles: true, clientX, clientY: 10 }));
}

async function showCard(overrides: Partial<Parameters<typeof WorkLiveCornerCard>[0]> = {}) {
  const view = renderCard(overrides);
  await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
  emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
  const card = await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
  return { ...view, card };
}

describe("WorkLiveCornerCard placement", () => {
  it("restores a persisted position instead of always parking bottom-right", async () => {
    seedProject();
    useAppStore.setState({
      workViewByProject: {
        [PROJECT_ROOT]: { workLiveCardPosition: { xPct: 0.5, yPct: 0.25 } } as never,
      },
    });
    const { card } = await showCard();
    // 900-wide host, 260-wide card: half of the 640px of travel.
    expect(card.style.left).toBe("320px");
    expect(card.style.top).toBe(`${0.25 * (600 - 211)}px`);
  });

  it("clamps a stored position that would hang outside the column", async () => {
    seedProject();
    useAppStore.setState({
      workViewByProject: {
        [PROJECT_ROOT]: { workLiveCardPosition: { xPct: 0, yPct: 0 } } as never,
      },
    });
    const { card } = await showCard();
    expect(card.style.left).toBe("12px");
    expect(card.style.top).toBe("12px");
  });
});

describe("WorkLiveCornerCard dismissal", () => {
  it("persists the dismissal for the lane and survives a remount", async () => {
    seedProject();
    const { unmount } = await showCard();

    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());

    const stamp = useAppStore.getState()
      .laneWorkViewByScope[`${PROJECT_ROOT}::lane-1`]?.workLiveCardDismissed?.browser;
    expect(typeof stamp).toBe("number");

    // Re-reading the same status after a remount is not "new activity", so the
    // card must stay closed rather than popping back the moment you navigate.
    unmount();
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
  });

  it("keeps a dismissal scoped to its own lane", async () => {
    seedProject();
    const { unmount } = await showCard();
    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());
    unmount();

    renderCard({ laneId: "lane-2" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    expect(await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 })).toBeTruthy();
  });
});

describe("WorkLiveCornerCard App Control dismissal", () => {
  async function showAppControlCard() {
    seedProject();
    const view = renderCard({ activeTool: "browser" });
    await waitFor(() => expect(appControlListeners.size).toBeGreaterThan(0));
    emitAppControlEvent({ type: "session-started", session: APP_CONTROL_SESSION });
    const card = await screen.findByLabelText("App Control live preview", {}, { timeout: 3_000 });
    return { ...view, card };
  }

  it("stays dismissed while the screencast keeps painting", async () => {
    await showAppControlCard();
    fireEvent.click(screen.getByLabelText("Hide the App Control preview"));
    await waitFor(() => expect(screen.queryByLabelText("App Control live preview")).toBeNull());

    // The panel's screencast runs for the life of the session, independent of
    // this card. Counting its frames as activity made the × unusable: the next
    // frame arrived ~33ms later and the card came back 500ms after that.
    for (let i = 0; i < 20; i += 1) emitAppControlEvent(appControlFrame());
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(screen.queryByLabelText("App Control live preview")).toBeNull();
  });

  it("comes back when the session actually does something", async () => {
    await showAppControlCard();
    fireEvent.click(screen.getByLabelText("Hide the App Control preview"));
    await waitFor(() => expect(screen.queryByLabelText("App Control live preview")).toBeNull());

    emitAppControlEvent({
      type: "session-updated",
      session: { ...APP_CONTROL_SESSION, lastTraceEntryId: "trace-9" },
    });
    expect(await screen.findByLabelText("App Control live preview", {}, { timeout: 3_000 })).toBeTruthy();
  });
});

describe("WorkLiveCornerCard scrubbing", () => {
  it("shows the hovered frame's caption and snaps back to live on leave", async () => {
    seedProject();
    const { card } = await showCard();
    emitBrowserEvent(traceEvent("trace-1", "click", "Sign in"));
    emitBrowserEvent(traceEvent("trace-2", "fill", "Email"));
    expect(await screen.findByTitle(/Typed 'Email'/)).toBeTruthy();

    card.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 260, bottom: 211, width: 260, height: 211,
      toJSON: () => ({}),
    });

    // Left edge is the oldest of the two remembered actions.
    scrubTo(card, 0);
    expect(await screen.findByTitle(/Clicked 'Sign in'/)).toBeTruthy();

    // Right edge is the newest.
    scrubTo(card, 260);
    expect(await screen.findByTitle(/Typed 'Email'/)).toBeTruthy();

    fireEvent.pointerLeave(card);
    expect(await screen.findByTitle(/Typed 'Email'/)).toBeTruthy();
  });

  it("offers no scrubbing until there are two frames to scrub between", async () => {
    seedProject();
    const { card } = await showCard();
    emitBrowserEvent(traceEvent("trace-1", "click", "Sign in"));
    card.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 260, bottom: 211, width: 260, height: 211,
      toJSON: () => ({}),
    });
    scrubTo(card, 130);
    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.getByTitle(/Clicked 'Sign in'/)).toBeTruthy();
  });

  it("activates the tool when the card's chrome is clicked, but not its ×", async () => {
    seedProject();
    const { card, onPick } = await showCard();
    fireEvent.click(card.querySelector("header") as HTMLElement);
    expect(onPick).toHaveBeenCalledWith("browser");

    onPick.mockClear();
    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    expect(onPick).not.toHaveBeenCalled();
  });
});
