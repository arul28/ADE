/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkLiveCornerCard } from "./WorkLiveCornerCard";
import { NativeToolFeedsProvider } from "../terminals/NativeToolFeedsContext";
import { useAppStore } from "../../state/appStore";
import type { BuiltInBrowserStatus, BuiltInBrowserTab } from "../../../shared/types";
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
    // 900-wide host, 320-wide card: half of the 580px of travel. The browser's
    // card is 320×200, so the vertical span is 600 - 200.
    expect(card.style.left).toBe("290px");
    expect(card.style.top).toBe(`${0.25 * (600 - 200)}px`);
    expect(card.style.width).toBe("320px");
    expect(card.style.height).toBe("200px");
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
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 200, width: 320, height: 200,
      toJSON: () => ({}),
    });

    // Left edge is the oldest of the two remembered actions.
    scrubTo(card, 0);
    expect(await screen.findByTitle(/Clicked 'Sign in'/)).toBeTruthy();

    // Right edge is the newest.
    scrubTo(card, 320);
    expect(await screen.findByTitle(/Typed 'Email'/)).toBeTruthy();

    fireEvent.pointerLeave(card);
    expect(await screen.findByTitle(/Typed 'Email'/)).toBeTruthy();
  });

  it("offers no scrubbing until there are two frames to scrub between", async () => {
    seedProject();
    const { card } = await showCard();
    emitBrowserEvent(traceEvent("trace-1", "click", "Sign in"));
    card.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 200, width: 320, height: 200,
      toJSON: () => ({}),
    });
    scrubTo(card, 130);
    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.getByTitle(/Clicked 'Sign in'/)).toBeTruthy();
  });

  it("activates the tool when the card's chrome is clicked, but not its ×", async () => {
    seedProject();
    const { card, onPick } = await showCard();
    fireEvent.click(card.querySelector("[data-live-card-pill]") as HTMLElement);
    expect(onPick).toHaveBeenCalledWith("browser");

    onPick.mockClear();
    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps the scrub strip out of the layout until the pointer is on the card", async () => {
    // The strip overlays the media's bottom 2px. Reserving a row for it would
    // shrink the picture by 1% for a control that is invisible 99% of the time.
    seedProject();
    const { card } = await showCard();
    emitBrowserEvent(traceEvent("trace-1", "click", "Sign in"));
    emitBrowserEvent(traceEvent("trace-2", "fill", "Email"));
    await screen.findByTitle(/Typed 'Email'/);

    const strip = () => card.querySelector<HTMLElement>("[aria-hidden='true'].absolute.bottom-0");
    expect(strip()).toBeNull();

    card.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 200, width: 320, height: 200,
      toJSON: () => ({}),
    });
    scrubTo(card, 160);
    await waitFor(() => expect(strip()).not.toBeNull());
    expect(strip()?.style.height).toBe("2px");

    fireEvent.pointerLeave(card);
    await waitFor(() => expect(strip()).toBeNull());
  });
});

describe("WorkLiveCornerCard chrome", () => {
  /** The 8px resting dot: the only chrome the card shows until you hover it. */
  function restDot(card: HTMLElement): HTMLElement | null {
    return card.querySelector<HTMLElement>("[data-live-card-status]");
  }

  async function showTab(overrides: Partial<BuiltInBrowserTab>) {
    seedProject();
    const status = makeBuiltInBrowserStatus({
      visible: false,
      activeTabId: "tab-1",
      tabs: [
        makeBuiltInBrowserTab({
          id: "tab-1",
          url: "https://example.test/login",
          title: "Sign in",
          ownerChatSessionId: "chat-1",
          ...overrides,
        }),
      ],
    });
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status });
    return screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
  }

  it("rests as a dot and keeps every control in the hover pill", async () => {
    seedProject();
    const { card } = await showCard();

    const dot = restDot(card);
    expect(dot?.dataset.liveCardStatus).toBe("idle");
    // Hidden by hover rather than by a render, so a 12fps feed costs nothing.
    expect(dot?.className).toContain("group-hover:opacity-0");
    expect(dot?.className).toContain("h-2");

    // The × lives in the pill and nowhere else.
    const pill = card.querySelector("[data-live-card-pill]");
    expect(pill?.contains(screen.getByLabelText("Hide the Browser preview"))).toBe(true);
    expect(pill?.className).toContain("h-8");
    expect(pill?.className).toContain("group-hover:opacity-100");
    // The pill is the drag handle; the picture underneath is not.
    expect(pill?.className).toContain("cursor-grab");
    // …and it carries the name and the last-action caption.
    expect(pill?.textContent).toContain("Browser");
    expect(pill?.textContent).toContain("Sign in");
  });

  it("turns the dot red while the tab is recording", async () => {
    const card = await showTab({ recording: { startedAt: new Date().toISOString(), fps: 30 } });
    const dot = restDot(card);
    expect(dot?.dataset.liveCardStatus).toBe("recording");
    // Red is the one state the dot must survive a reduced-motion setting for.
    expect(dot?.className).toContain("ade-status-pulse");
    expect(dot?.className).toContain("motion-reduce:animate-none");
  });

  it("turns the dot amber while a handoff waits, and names it in the pill", async () => {
    const card = await showTab({
      handoff: {
        reason: "Sign in to staging",
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestedByChatSessionId: null,
        requestedByLaneId: null,
        startedAtOrigin: null,
        previousOwner: { laneId: null, chatSessionId: null },
      },
    });
    expect(restDot(card)?.dataset.liveCardStatus).toBe("handoff");
    // The dot can only say "amber"; the reason itself waits in the pill.
    expect(restDot(card)?.title).toBe("Sign in to staging");
    const chip = card.querySelector("[data-live-card-pill] [title='Sign in to staging']");
    expect(chip?.textContent).toBe("Needs you");
  });
});

describe("WorkLiveCornerCard tool switching", () => {
  it("keeps painting frames after the card has swapped source tools once", async () => {
    // `AnimatePresence` defaults to `mode="sync"`, so the OUTGOING card's ref
    // callback fires with `null` AFTER the incoming card has already claimed
    // the ref. A naive `ref={(node) => { imageRef.current = node; }}` therefore
    // ends every tool switch with a null image ref, and the live thumbnail
    // never painted again for the life of the pane — while "Live", the feed
    // subscription and every other assertion in this file stayed green.
    seedProject();
    renderCard({ activeTool: "git" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    await waitFor(() => expect(appControlListeners.size).toBeGreaterThan(0));

    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    const first = await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
    const firstFrame = "data:image/jpeg;base64,Zmlyc3Q=";
    emitBrowserEvent({
      type: "preview-frame",
      tabId: "tab-1",
      dataUrl: firstFrame,
      width: 480,
      height: 300,
      capturedAt: new Date().toISOString(),
    });
    await waitFor(() => expect(first.querySelector("img")?.getAttribute("src")).toBe(firstFrame));

    // App Control becomes the newest active tool: the browser card exits and
    // the App Control card enters, both mounted at once for the crossfade.
    emitAppControlEvent({ type: "session-started", session: APP_CONTROL_SESSION });
    await screen.findByLabelText("App Control live preview", {}, { timeout: 3_000 });

    // …and the browser becomes newest again.
    emitBrowserEvent({
      type: "status",
      status: { ...BROWSER_STATUS, tabs: [{ ...BROWSER_STATUS.tabs[0]!, title: "Signed in" }] },
    });
    await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
    // Let the crossfade finish so only the incoming card is left holding the ref.
    await waitFor(
      () => expect(screen.queryByLabelText("App Control live preview")).toBeNull(),
      { timeout: 3_000 },
    );

    const secondFrame = "data:image/jpeg;base64,c2Vjb25k";
    emitBrowserEvent({
      type: "preview-frame",
      tabId: "tab-1",
      dataUrl: secondFrame,
      width: 480,
      height: 300,
      capturedAt: new Date().toISOString(),
    });
    await waitFor(() => {
      const live = screen.getByLabelText("Browser live preview").querySelector("img");
      expect(live?.getAttribute("src")).toBe(secondFrame);
    });
  });
});
