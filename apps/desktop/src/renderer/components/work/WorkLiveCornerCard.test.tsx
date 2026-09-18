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
import {
  floatWorkLiveCardForChat,
  readChatCompanionUiState,
  resetChatCompanionUiStateCacheForTests,
} from "../chat/chatCompanionUiState";

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

const APP_CONTROL_SESSION = { id: "app-1", status: "connected", label: "Playground", chatSessionId: null };

/** One screencast frame, the 30fps feed that used to count as "activity". */
function appControlFrame() {
  return { type: "frame", frame: { mimeType: "image/jpeg", data: "AAAA", width: 288, height: 180 } };
}

/** jsdom does not decode images; report a natural size and fire `load`. */
function loadImage(image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(image);
}

beforeEach(() => {
  browserListeners.clear();
  appControlListeners.clear();
  startPreviewStream.mockClear();
  stopPreviewStream.mockClear();
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
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
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
  vi.restoreAllMocks();
});

function renderCard(overrides: Partial<Parameters<typeof WorkLiveCornerCard>[0]> = {}) {
  const onPick = vi.fn();
  const props = {
    active: true,
    laneId: "lane-1" as string | null,
    activeTool: "git" as Parameters<typeof WorkLiveCornerCard>[0]["activeTool"],
    chatSessionId: "chat-1" as string | null,
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

  it("does not show a tab owned by a different chat", async () => {
    renderCard({ chatSessionId: "chat-2" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
    expect(startPreviewStream).not.toHaveBeenCalled();
  });

  it("paints a preview frame that arrives through the provider's fan-out", async () => {
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

    await waitFor(() => {
      const live = card.querySelector("img");
      expect(live?.getAttribute("src")).toBe(frame);
    });
  });

  it("never starts a browser feed for a pane with no tab", async () => {
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({
      type: "status",
      status: { ...BROWSER_STATUS, activeTabId: null, tabs: [] },
    });

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

describe("WorkLiveCornerCard obstructions", () => {
  it("stops watching an obstruction once it leaves the DOM", async () => {
    const observed: Element[] = [];
    const unobserved: Element[] = [];
    const notifiers: (() => void)[] = [];
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {
        notifiers.push(() => {
          this.callback([{ target: document.body, contentRect: { width: 900, height: 600 } }], this);
        });
      }
      observe(target: Element): void {
        observed.push(target);
        this.callback([{ target, contentRect: { width: 900, height: 600 } }], this);
      }
      unobserve(target: Element): void { unobserved.push(target); }
      disconnect(): void {}
    };

    const { container } = render(
      <NativeToolFeedsProvider active runtimePin={null}>
        <div data-testid="obstruction-slot"><div data-chat-composer-wrapper="" /></div>
        <WorkLiveCornerCard
          active
          laneId="lane-1"
          activeTool="git"
          chatSessionId="chat-1"
          runtimePin={null}
          onPick={vi.fn()}
        />
      </NativeToolFeedsProvider>,
    );

    const composer = container.querySelector("[data-chat-composer-wrapper]");
    expect(composer, "the composer the card measures against").toBeTruthy();
    await waitFor(() => expect(observed).toContain(composer));
    expect(unobserved).not.toContain(composer);

    act(() => { composer?.remove(); });
    act(() => { for (const notify of notifiers) notify(); });
    await waitFor(() => expect(unobserved).toContain(composer));
    expect(unobserved).toEqual([composer]);
  });
});

describe("WorkLiveCornerCard placement", () => {
  it("restores a persisted position instead of always parking bottom-right", async () => {
    seedProject();
    useAppStore.setState({
      workViewByProject: {
        [PROJECT_ROOT]: { workLiveCardPosition: { xPct: 0.5, yPct: 0.25 } } as never,
      },
    });
    const { card } = await showCard();
    expect(card.style.left).toBe("306px");
    expect(card.style.top).toBe(`${0.25 * (600 - 180)}px`);
    expect(card.style.width).toBe("288px");
    expect(card.style.height).toBe("180px");
  });

  it("contains a portrait frame rather than cropping it, and follows its aspect", async () => {
    seedProject();
    const { card } = await showCard();
    // Before any frame, the tool's default landscape aspect.
    expect(card.style.height).toBe("180px");

    const live = card.querySelector("img") as HTMLImageElement;
    expect(live.style.objectFit).toBe("contain");
    expect(live.style.objectPosition).toBe("");

    // A portrait page decodes: the card grows to the picture, uncropped.
    loadImage(live, 390, 844);
    await waitFor(() => expect(card.style.height).not.toBe("180px"));
    expect(Number.parseInt(card.style.height, 10)).toBeGreaterThan(180);
    expect(live.style.objectFit).toBe("contain");
    expect(live.style.objectPosition).toBe("");
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

  it("resizes by width, persists it, and keeps the aspect", async () => {
    seedProject();
    const { card } = await showCard();
    const handle = card.querySelector("[data-live-card-resize]") as HTMLElement;
    expect(handle).toBeTruthy();

    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: 100, button: 0 }));
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientX: 180, button: 0 }));
    fireEvent(handle, new MouseEvent("pointerup", { bubbles: true, clientX: 180, button: 0 }));

    await waitFor(() => expect(card.style.width).toBe("368px"));
    // Landscape aspect is locked: 288x180 -> 368x230.
    expect(card.style.height).toBe("230px");
    expect(useAppStore.getState().workViewByProject[PROJECT_ROOT]?.workLiveCardWidth).toBe(368);
  });
});

describe("WorkLiveCornerCard dismissal", () => {
  it("remembers the close per chat and survives a remount", async () => {
    seedProject();
    const { unmount } = await showCard();

    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());

    // Stored against the chat, keyed by the session that was showing.
    expect(readChatCompanionUiState("chat-1").workLiveCardClosedByTool.browser).toBe("tab-1");

    // Re-reading the same status after a remount is not a new session.
    unmount();
    renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: BROWSER_STATUS });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();
  });

  it("keeps a dismissal scoped to its own chat", async () => {
    seedProject();
    // An unowned tab belongs to every chat, so the only thing being tested is
    // that the close is remembered per chat.
    const unowned = makeBuiltInBrowserStatus({
      visible: false,
      activeTabId: "tab-1",
      tabs: [
        makeBuiltInBrowserTab({
          id: "tab-1",
          url: "https://example.test/login",
          title: "Sign in",
          ownerChatSessionId: null,
        }),
      ],
    });
    const view = renderCard();
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: unowned });
    await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());
    view.unmount();

    renderCard({ chatSessionId: "chat-2" });
    await waitFor(() => expect(browserListeners.size).toBeGreaterThan(0));
    emitBrowserEvent({ type: "status", status: unowned });
    expect(await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 })).toBeTruthy();
  });

  it("stays closed through new frames, then reopens for a new session key", async () => {
    seedProject();
    const { card } = await showCard();
    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());
    expect(card).toBeTruthy();

    // A frame is not a new session.
    emitBrowserEvent({
      type: "preview-frame",
      tabId: "tab-1",
      dataUrl: "data:image/jpeg;base64,bmV3",
      width: 480,
      height: 300,
      capturedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByLabelText("Browser live preview")).toBeNull();

    // A NEW tab id is a new session, and may show again.
    const nextStatus = makeBuiltInBrowserStatus({
      visible: false,
      activeTabId: "tab-2",
      tabs: [
        makeBuiltInBrowserTab({
          id: "tab-2",
          url: "https://example.test/next",
          title: "Next",
          ownerChatSessionId: "chat-1",
        }),
      ],
    });
    emitBrowserEvent({ type: "status", status: nextStatus });
    expect(await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 })).toBeTruthy();
  });

  it("reopens a closed card when the chat floats the tool", async () => {
    seedProject();
    await showCard();
    fireEvent.click(screen.getByLabelText("Hide the Browser preview"));
    await waitFor(() => expect(screen.queryByLabelText("Browser live preview")).toBeNull());

    act(() => { floatWorkLiveCardForChat("chat-1", "browser"); });
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

    for (let i = 0; i < 20; i += 1) emitAppControlEvent(appControlFrame());
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(screen.queryByLabelText("App Control live preview")).toBeNull();
  });

  it("stays dismissed when the same session reports activity", async () => {
    await showAppControlCard();
    fireEvent.click(screen.getByLabelText("Hide the App Control preview"));
    await waitFor(() => expect(screen.queryByLabelText("App Control live preview")).toBeNull());

    // A status refresh — even with a new trace id — is not a new session.
    emitAppControlEvent({
      type: "session-updated",
      session: { ...APP_CONTROL_SESSION, lastTraceEntryId: "trace-9" },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByLabelText("App Control live preview")).toBeNull();
  });

  it("shows again for a new App Control session id", async () => {
    await showAppControlCard();
    fireEvent.click(screen.getByLabelText("Hide the App Control preview"));
    await waitFor(() => expect(screen.queryByLabelText("App Control live preview")).toBeNull());

    emitAppControlEvent({
      type: "session-started",
      session: { ...APP_CONTROL_SESSION, id: "app-2", label: "Playground 2" },
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
      x: 0, y: 0, left: 0, top: 0, right: 288, bottom: 180, width: 288, height: 180,
      toJSON: () => ({}),
    });

    scrubTo(card, 0);
    expect(await screen.findByTitle(/Clicked 'Sign in'/)).toBeTruthy();

    scrubTo(card, 288);
    expect(await screen.findByTitle(/Typed 'Email'/)).toBeTruthy();

    fireEvent.pointerLeave(card);
    expect(await screen.findByTitle(/Typed 'Email'/)).toBeTruthy();
  });

  it("offers no scrubbing until there are two frames to scrub between", async () => {
    seedProject();
    const { card } = await showCard();
    emitBrowserEvent(traceEvent("trace-1", "click", "Sign in"));
    card.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 288, bottom: 180, width: 288, height: 180,
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
    seedProject();
    const { card } = await showCard();
    emitBrowserEvent(traceEvent("trace-1", "click", "Sign in"));
    emitBrowserEvent(traceEvent("trace-2", "fill", "Email"));
    await screen.findByTitle(/Typed 'Email'/);

    const strip = () => card.querySelector<HTMLElement>("[aria-hidden='true'].absolute.bottom-0");
    expect(strip()).toBeNull();

    card.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 288, bottom: 180, width: 288, height: 180,
      toJSON: () => ({}),
    });
    scrubTo(card, 144);
    await waitFor(() => expect(strip()).not.toBeNull());
    expect(strip()?.style.height).toBe("2px");

    fireEvent.pointerLeave(card);
    await waitFor(() => expect(strip()).toBeNull());
  });
});

describe("WorkLiveCornerCard chrome", () => {
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
    expect(dot?.className).toContain("group-hover:opacity-0");
    expect(dot?.className).toContain("h-2");

    const pill = card.querySelector("[data-live-card-pill]");
    expect(pill?.contains(screen.getByLabelText("Hide the Browser preview"))).toBe(true);
    expect(pill?.className).toContain("h-8");
    expect(pill?.className).toContain("group-hover:opacity-100");
    expect(pill?.className).toContain("cursor-grab");
    expect(pill?.textContent).toContain("Sign in");
    expect(pill?.textContent).not.toContain("Browser");
    expect(card.className).toContain("select-none");
  });

  it("leads the pill with the page and follows it with the last action", async () => {
    const card = await showTab({ title: null });
    const pill = card.querySelector("[data-live-card-pill]");
    expect(pill?.textContent).toContain("example.test");
    expect(pill?.textContent).not.toContain("https://");

    emitBrowserEvent(traceEvent("trace-1", "stopFindInPage", ""));
    await waitFor(() => expect(pill?.textContent).toContain("Closed find"));
    const text = pill?.textContent ?? "";
    expect(text.indexOf("example.test")).toBeLessThan(text.indexOf("Closed find"));
  });

  it("rests on a neutral dot rather than on the tool's own hue", async () => {
    const card = await showTab({});
    const dot = restDot(card);
    expect(dot?.dataset.liveCardStatus).toBe("idle");
    expect(dot?.getAttribute("style") ?? "").not.toContain("#22d3ee");
    expect(dot?.className).toContain("bg-fg/25");
  });

  it("turns the dot red while the tab is recording", async () => {
    const card = await showTab({ recording: { startedAt: new Date().toISOString(), fps: 30 } });
    const dot = restDot(card);
    expect(dot?.dataset.liveCardStatus).toBe("recording");
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
    expect(restDot(card)?.title).toBe("Sign in to staging");
    const chip = card.querySelector("[data-live-card-pill] [title='Sign in to staging']");
    expect(chip?.textContent).toBe("Needs you");
  });
});

describe("WorkLiveCornerCard tool switching", () => {
  it("keeps painting frames after the card has swapped source tools once", async () => {
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

    emitAppControlEvent({ type: "session-started", session: APP_CONTROL_SESSION });
    await screen.findByLabelText("App Control live preview", {}, { timeout: 3_000 });

    emitBrowserEvent({
      type: "status",
      status: { ...BROWSER_STATUS, tabs: [{ ...BROWSER_STATUS.tabs[0]!, title: "Signed in" }] },
    });
    await screen.findByLabelText("Browser live preview", {}, { timeout: 3_000 });
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
