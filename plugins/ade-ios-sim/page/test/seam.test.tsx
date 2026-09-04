/**
 * The seam test.
 *
 * The plugin is two programs now: a page that draws, and a child process that
 * holds the `ios_simulator` domain. They are joined by nothing but a list of
 * action ids and their argument shapes — no compiler checks the join, because
 * the page is built separately from the plugin it ships inside and no type
 * crosses the bridge. A third contract crosses in the other direction: the page
 * tells the HOST where to paint, and `hostEngine.place` is the only thing
 * standing between a reserved rect and a live simulator screen.
 *
 * So this test walks the product the way a reader does, against a scripted
 * `window.adePlugin` (`fakeBridge.ts`), and asserts the CALLS and their
 * argument shapes rather than the pixels: an id the page invokes that the fake
 * does not script throws by name, and an argument that drifts fails on the
 * assertion that reads it.
 *
 * The walk: no device → pick a device → pick a launch target → launch → the
 * rect is reserved and placed → Control taps and types → Inspect reads an
 * element → zoom re-places → Preview Lab opens → unmount releases.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SimEntry } from "../src/entries/SimEntry";
import { PageRouter } from "../src/PageRouter";
import {
  FAKE_DEVICE,
  FAKE_DEVICE_ALT,
  FAKE_TARGET,
  FAKE_TARGET_ALT,
  installFakeBridge,
  paneContext,
  uninstallFakeBridge,
  type FakeBridge,
} from "./fakeBridge";

/**
 * jsdom computes no layout, so `getBoundingClientRect` answers zeros and the
 * placer would correctly refuse to place an empty rect.
 *
 * The stub gives the stage a real box, derived from the element's OWN inline
 * size — which is exactly how zoom reaches the host in the product: the page
 * makes the reserved element bigger and the rect follows. A fixed rect would
 * have made the zoom assertion below vacuous.
 */
const BASE_WIDTH = 400;
const BASE_HEIGHT = 800;
const STAGE_TOP = 40;

function stubLayout(): () => void {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      const scale = (raw: string): number =>
        raw.endsWith("%") ? Number.parseFloat(raw) / 100 : 1;
      const width = Math.round(BASE_WIDTH * scale(this.style.width || "100%"));
      const height = Math.round(BASE_HEIGHT * scale(this.style.height || "100%"));
      return {
        x: 0,
        y: STAGE_TOP,
        left: 0,
        top: STAGE_TOP,
        width,
        height,
        right: width,
        bottom: STAGE_TOP + height,
        toJSON: () => ({}),
      } as DOMRect;
    },
  });
  return () => {
    if (original) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", original);
  };
}

let host: FakeBridge;
let restoreLayout: () => void;

beforeEach(() => {
  restoreLayout = stubLayout();
});

afterEach(() => {
  cleanup();
  uninstallFakeBridge();
  restoreLayout();
});

/** The stage element, waited for rather than slept on. */
async function stage(): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = document.querySelector('[data-sim-pane="stage"]');
    if (!found) throw new Error("The stage has not rendered yet.");
    return found as HTMLElement;
  });
}

async function controlSurface(): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = document.querySelector('[data-sim-pane="control-surface"]');
    if (!found) throw new Error("The control surface has not rendered yet.");
    return found as HTMLElement;
  });
}

/** The last `hostEngine.place`, or a failure that names what was missing. */
function lastPlacedRect(): { x: number; y: number; width: number; height: number } {
  const call = host.lastCall("hostEngine.place");
  if (!call) throw new Error("The page never asked the host to paint.");
  return call.args.rect as { x: number; y: number; width: number; height: number };
}

describe("the page and the plugin agree on every verb", () => {
  it("walks pick-device, pick-target, launch, place, control, inspect, zoom, preview and release", async () => {
    host = installFakeBridge();
    const view = render(<SimEntry context={paneContext()} />);

    /* ── No device yet: the first three reads are the child's ─────────── */

    await waitFor(() => {
      expect(host.callsTo("invoke:pageStatus").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("invoke:pageDevices").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageLaunchTargets").length).toBeGreaterThan(0);
    });
    // Nothing is running, so nothing is reserved and nothing is painted.
    expect(host.callsTo("hostEngine.place")).toHaveLength(0);
    expect(await screen.findByText("No simulator running")).toBeTruthy();

    /* ── Pick a device ────────────────────────────────────────────────── */

    const devicePicker = screen.getByLabelText("Simulator device") as HTMLSelectElement;
    fireEvent.change(devicePicker, { target: { value: FAKE_DEVICE_ALT.udid } });
    await waitFor(() => {
      const last = host.lastCall("invoke:pageLaunchTargets");
      expect(last?.args).toEqual({ deviceUdid: FAKE_DEVICE_ALT.udid });
    });
    // The choice is remembered in the plugin's own collection, not localStorage.
    await waitFor(() => {
      expect(host.collections.get("ui-state/sim:%2Frepo")).toMatchObject({
        deviceUdid: FAKE_DEVICE_ALT.udid,
      });
    });

    /* ── Pick a launch target ─────────────────────────────────────────── */

    const targetPicker = screen.getByLabelText("Launch target") as HTMLSelectElement;
    fireEvent.change(targetPicker, { target: { value: FAKE_TARGET_ALT.id } });
    await waitFor(() => {
      expect(host.collections.get("ui-state/sim:%2Frepo")).toMatchObject({
        targetId: FAKE_TARGET_ALT.id,
      });
    });

    /* ── Launch, then the stream, then the rect ───────────────────────── */

    fireEvent.click(screen.getByText("Launch"));
    await waitFor(() => {
      const launch = host.lastCall("invoke:pageLaunch");
      expect(launch?.args).toEqual({
        deviceUdid: FAKE_DEVICE_ALT.udid,
        targetId: FAKE_TARGET_ALT.id,
      });
    });
    await waitFor(() => {
      const stream = host.lastCall("invoke:pageStartStream");
      expect(stream?.args).toEqual({ deviceUdid: FAKE_DEVICE_ALT.udid, fps: 60 });
    });

    await stage();
    await waitFor(() => {
      const place = host.lastCall("hostEngine.place");
      expect(place).toBeTruthy();
      // The engine id is the plugin's own builtin surface, and it is the one
      // word the host switches on.
      expect(place?.args.engineId).toBe("simulator");
    });
    expect(lastPlacedRect()).toEqual({
      x: 0,
      y: STAGE_TOP,
      width: BASE_WIDTH,
      height: BASE_HEIGHT,
    });

    /* ── Control mode: a tap and a keystroke ──────────────────────────── */

    const surface = await controlSurface();
    fireEvent.pointerDown(surface, { clientX: 120, clientY: 240 });
    fireEvent.pointerUp(surface, { clientX: 120, clientY: 240 });
    await waitFor(() => {
      const tap = host.lastCall("invoke:pageTap");
      // Guest-relative: the stage sits 40px down, so the device point is not
      // the client point, and getting that wrong is a tap in the wrong place.
      expect(tap?.args).toEqual({
        deviceUdid: FAKE_DEVICE_ALT.udid,
        x: 120,
        y: 240 - STAGE_TOP,
      });
    });

    fireEvent.keyDown(surface, { key: "a" });
    await waitFor(() => {
      expect(host.lastCall("invoke:pageTypeText")?.args).toEqual({
        deviceUdid: FAKE_DEVICE_ALT.udid,
        text: "a",
      });
    });

    // A pointer that travelled is a drag, not a tap.
    fireEvent.pointerDown(surface, { clientX: 40, clientY: 100 });
    fireEvent.pointerUp(surface, { clientX: 300, clientY: 500 });
    await waitFor(() => {
      expect(host.lastCall("invoke:pageDrag")?.args).toEqual({
        deviceUdid: FAKE_DEVICE_ALT.udid,
        fromX: 40,
        fromY: 100 - STAGE_TOP,
        toX: 300,
        toY: 500 - STAGE_TOP,
      });
    });

    /* ── Inspect mode: one element ────────────────────────────────────── */

    fireEvent.click(screen.getByText("Inspect"));
    const inspectSurface = await controlSurface();
    fireEvent.pointerDown(inspectSurface, { clientX: 80, clientY: 300 });
    fireEvent.pointerUp(inspectSurface, { clientX: 80, clientY: 300 });
    await waitFor(() => {
      expect(host.lastCall("invoke:pageSelectPoint")?.args).toEqual({
        deviceUdid: FAKE_DEVICE_ALT.udid,
        x: 80,
        y: 300 - STAGE_TOP,
      });
    });
    // The selected element is drawn in its own row — scoped, because the status
    // line below it names the same element and an unscoped query finds both.
    await waitFor(() => {
      const row = document.querySelector('[data-sim-pane="selection"]');
      expect(row?.textContent).toContain("Continue");
      expect(row?.textContent).toContain("Sources/ContentView.swift:42");
    });

    /* ── Zoom: a bigger reserved rect, and a second place ─────────────── */

    const placesBeforeZoom = host.callsTo("hostEngine.place").length;
    fireEvent.click(screen.getByLabelText("Zoom in simulator view"));
    await waitFor(() => {
      expect(host.callsTo("hostEngine.place").length).toBeGreaterThan(placesBeforeZoom);
    });
    expect(lastPlacedRect()).toEqual({
      x: 0,
      y: STAGE_TOP,
      width: Math.round(BASE_WIDTH * 1.25),
      height: Math.round(BASE_HEIGHT * 1.25),
    });

    /* ── Preview Lab: the stage is released, the three reads run ──────── */

    fireEvent.click(screen.getByText("Preview"));
    await waitFor(() => {
      expect(host.callsTo("hostEngine.release").length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageEnsurePreviewWorkspace").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("invoke:pagePreviewTargets").length).toBeGreaterThan(0);
    expect(host.callsTo("invoke:pageResolvePreviewMatch").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("Render"));
    await waitFor(() => {
      expect(host.lastCall("invoke:pageRenderPreview")?.args).toMatchObject({
        sourceFilePath: "Sources/ContentView.swift",
        previewDefinitionIndexInFile: 0,
        tabIdentifier: "tab-1",
      });
    });

    fireEvent.click(await screen.findByText("Open Xcode"));
    await waitFor(() => {
      expect(host.lastCall("ui.openPathInEditor")?.args).toEqual({
        rootPath: "/repo",
        relativePath: "Ade.xcodeproj",
        target: "default",
      });
    });

    /* ── Back to the simulator, so the unmount release is a real one ──── */

    // Deliberate: leaving Preview mode already released, and `release` is
    // idempotent, so unmounting from there would assert nothing. The reader
    // ends where they started, with the host painting again.
    fireEvent.click(screen.getByText("Simulator"));
    const placesBeforeReturn = host.callsTo("hostEngine.place").length;
    await waitFor(() => {
      expect(host.callsTo("hostEngine.place").length).toBeGreaterThan(placesBeforeReturn - 1);
      expect(host.placedRect).not.toBeNull();
    });

    /* ── Unmount: the host stops painting ─────────────────────────────── */

    const releasesBefore = host.callsTo("hostEngine.release").length;
    act(() => {
      view.unmount();
    });
    await waitFor(() => {
      expect(host.callsTo("hostEngine.release").length).toBeGreaterThan(releasesBefore);
    });
    expect(host.placedRect).toBeNull();
  });

  it("degrades to a message, not a throw, when the host has no engine", async () => {
    host = installFakeBridge({ live: true, withoutHostEngine: true });
    render(<SimEntry context={paneContext()} />);

    // The pane still draws, and the sentence names what is missing rather than
    // showing an empty black box a reader would read as a crashed simulator.
    expect(await screen.findByText(/cannot paint the live simulator screen/i)).toBeTruthy();
    expect(host.callsTo("hostEngine.place")).toHaveLength(0);
    // And the rest of the seam still works: the reads ran.
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStatus").length).toBeGreaterThan(0);
    });
  });

  it("shows the ownership card and takes the session over through the child", async () => {
    host = installFakeBridge({ ownedByOtherChat: true });
    render(<SimEntry context={paneContext()} />);

    expect(await screen.findByText(/In use by/)).toBeTruthy();
    // Owned by someone else means nothing is placed: the page is drawing the
    // card in the box the engine would otherwise own.
    expect(host.callsTo("hostEngine.place")).toHaveLength(0);

    fireEvent.click(screen.getByText("Take over"));
    await waitFor(() => {
      expect(host.lastCall("invoke:pageAttachChat")?.args).toEqual({
        chatSessionId: "chat-1",
        takeOver: true,
      });
    });
  });

  it("confirms through the host before stopping, and never with window.confirm", async () => {
    host = installFakeBridge({ live: true });
    render(<SimEntry context={paneContext()} />);

    fireEvent.click(await screen.findByTitle("Stop the running simulator"));
    await waitFor(() => {
      expect(host.lastCall("ui.confirm")?.args).toMatchObject({
        title: "Stop the simulator?",
        destructive: true,
      });
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStopStream").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("invoke:pageShutdown").length).toBeGreaterThan(0);
  });

  it("hides Open Xcode on a host with no editor verb", async () => {
    host = installFakeBridge({ live: true, withoutEditor: true });
    render(<SimEntry context={paneContext()} />);

    fireEvent.click(await screen.findByText("Preview"));
    await waitFor(() => {
      expect(host.callsTo("invoke:pageEnsurePreviewWorkspace").length).toBeGreaterThan(0);
    });
    // A control that would silently do nothing is not drawn at all.
    expect(screen.queryByText("Open Xcode")).toBeNull();
    // The docs row is still there, because `openDeeplink` is not optional.
    fireEvent.click(screen.getByText("Setup docs"));
    await waitFor(() => {
      expect(host.lastCall("openDeeplink")?.args.url).toContain("developer.apple.com");
    });
  });

  it("routes an unknown surfaceId to the pane rather than to an error page", async () => {
    host = installFakeBridge();
    render(<PageRouter context={paneContext({ surfaceId: "a-surface-this-build-has-never-heard-of" })} />);
    expect(await screen.findByLabelText("Simulator device")).toBeTruthy();
  });

  it("re-reads the status when the child publishes a change", async () => {
    host = installFakeBridge();
    render(<SimEntry context={paneContext()} />);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStatus").length).toBeGreaterThan(0);
    });
    const before = host.callsTo("invoke:pageStatus").length;
    act(() => {
      host.emit("changed", { kind: "collection", collection: "status" });
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStatus").length).toBeGreaterThan(before);
    });
  });
});
