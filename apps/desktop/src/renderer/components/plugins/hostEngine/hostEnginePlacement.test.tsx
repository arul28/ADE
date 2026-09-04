/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handlePluginWebviewUiRequest } from "../sockets/pluginWebviewRelay";
import type { PluginWebviewUiRequest } from "../../../../shared/plugins/webviewBridge";
import { HostEngineOverlay } from "./HostEngineOverlay";
import {
  hostEngineAvailable,
  registerHostEngineRenderer,
  resetHostEngines,
  setHostEngineBounds,
} from "./hostEngineStore";

/**
 * The whole placement seam, end to end, with a FAKE GUEST.
 *
 * The three halves were each provable on their own and the seam between them
 * was not: a page can send `hostEngine.place`, the store can hold a placement,
 * and the overlay can paint a rect, and the product can still show nothing
 * because the rail registered no renderer or because the guest's clicks never
 * reached the host component underneath.
 *
 * So these drive the REAL relay entry point with a request shaped exactly like
 * the one a guest sends, and then assert on the DOM the overlay produced. What
 * is deliberately not faked: the store, the overlay, the clamp, and the relay's
 * own refusal message.
 */

const GUEST_KEY = "guest-electron-control";

function placeRequest(
  args: Record<string, unknown>,
  overrides: Partial<PluginWebviewUiRequest> = {},
): PluginWebviewUiRequest {
  return {
    requestId: "req-place",
    guestKey: GUEST_KEY,
    pluginId: "ade-app-control",
    surfaceId: "control",
    placement: "pane",
    verb: "hostEngine.place",
    args,
    ...overrides,
  } as PluginWebviewUiRequest;
}

/** A stand-in for the live picture: it reports the clicks it received. */
function FakeEngine({ onPress }: { onPress: () => void }) {
  return (
    <button type="button" data-testid="engine-picture" onClick={onPress}>
      live picture
    </button>
  );
}

describe("a page placing a host engine", () => {
  beforeEach(() => {
    resetHostEngines();
  });

  afterEach(() => {
    cleanup();
    resetHostEngines();
  });

  it("draws the live picture at the rect the guest asked for", async () => {
    const stop = registerHostEngineRenderer("electron-control", () => <FakeEngine onPress={() => {}} />);
    expect(hostEngineAvailable("electron-control")).toBe(true);

    // The page host measures its own container before any placement can paint.
    setHostEngineBounds(GUEST_KEY, { width: 800, height: 600 });

    const answer = await handlePluginWebviewUiRequest(
      placeRequest({ engineId: "electron-control", rect: { x: 40, y: 24, width: 500, height: 380 } }),
    );
    expect(answer.ok).toBe(true);

    render(<HostEngineOverlay guestKey={GUEST_KEY} />);
    const painted = document.querySelector("[data-host-engine='electron-control']") as HTMLElement | null;
    expect(painted).not.toBeNull();
    expect(painted?.style.left).toBe("40px");
    expect(painted?.style.top).toBe("24px");
    expect(painted?.style.width).toBe("500px");
    expect(painted?.style.height).toBe("380px");
    expect(screen.getByTestId("engine-picture")).toBeTruthy();
    stop();
  });

  it("gives the click to the host component, not to the guest", async () => {
    const pressed = vi.fn();
    const stop = registerHostEngineRenderer("electron-control", () => <FakeEngine onPress={pressed} />);
    setHostEngineBounds(GUEST_KEY, { width: 800, height: 600 });
    await handlePluginWebviewUiRequest(
      placeRequest({ engineId: "electron-control", rect: { x: 0, y: 0, width: 400, height: 300 } }),
    );

    render(<HostEngineOverlay guestKey={GUEST_KEY} />);
    screen.getByTestId("engine-picture").click();
    // The point of the whole design: the pointer lands on host code. A guest
    // that could intercept this would be harvesting clicks meant for a
    // debugger session it does not own.
    expect(pressed).toHaveBeenCalledTimes(1);
    stop();
  });

  it("clamps a rect the page reported larger than the frame it was given", async () => {
    const stop = registerHostEngineRenderer("electron-control", () => <FakeEngine onPress={() => {}} />);
    setHostEngineBounds(GUEST_KEY, { width: 300, height: 200 });
    await handlePluginWebviewUiRequest(
      placeRequest({ engineId: "electron-control", rect: { x: 100, y: 50, width: 900, height: 900 } }),
    );

    render(<HostEngineOverlay guestKey={GUEST_KEY} />);
    const painted = document.querySelector("[data-host-engine='electron-control']") as HTMLElement | null;
    // The page owns its own layout and can report any box it likes; the host
    // owns the frame, so the engine can never reach past ADE's own chrome.
    expect(painted?.style.width).toBe("200px");
    expect(painted?.style.height).toBe("150px");
    stop();
  });

  it("refuses a placement no surface in this window offers", async () => {
    setHostEngineBounds(GUEST_KEY, { width: 800, height: 600 });
    const answer = await handlePluginWebviewUiRequest(
      placeRequest({ engineId: "electron-control", rect: { x: 0, y: 0, width: 400, height: 300 } }),
    );
    // A sentence the page can show, rather than a hole nothing fills.
    expect(answer.ok).toBe(false);
    render(<HostEngineOverlay guestKey={GUEST_KEY} />);
    expect(document.querySelector("[data-host-engine]")).toBeNull();
  });

  it("takes the picture back down when the surface offering it unmounts", async () => {
    const stop = registerHostEngineRenderer("electron-control", () => <FakeEngine onPress={() => {}} />);
    setHostEngineBounds(GUEST_KEY, { width: 800, height: 600 });
    await handlePluginWebviewUiRequest(
      placeRequest({ engineId: "electron-control", rect: { x: 0, y: 0, width: 400, height: 300 } }),
    );

    const view = render(<HostEngineOverlay guestKey={GUEST_KEY} />);
    expect(document.querySelector("[data-host-engine]")).not.toBeNull();

    stop();
    view.rerender(<HostEngineOverlay guestKey={GUEST_KEY} />);
    // Leaving the placement standing would keep a hole open in the page around
    // a component that has gone.
    expect(document.querySelector("[data-host-engine]")).toBeNull();
  });

  it("paints nothing until the page host has measured its own container", async () => {
    const stop = registerHostEngineRenderer("electron-control", () => <FakeEngine onPress={() => {}} />);
    await handlePluginWebviewUiRequest(
      placeRequest({ engineId: "electron-control", rect: { x: 0, y: 0, width: 400, height: 300 } }),
    );

    render(<HostEngineOverlay guestKey={GUEST_KEY} />);
    // Painting the page's own unclamped rect here is the one case where an
    // engine could reach past the frame, so it waits for the measurement.
    expect(document.querySelector("[data-host-engine]")).toBeNull();
    stop();
  });

  it("releases the placement when the guest asks", async () => {
    const stop = registerHostEngineRenderer("electron-control", () => <FakeEngine onPress={() => {}} />);
    setHostEngineBounds(GUEST_KEY, { width: 800, height: 600 });
    await handlePluginWebviewUiRequest(
      placeRequest({ engineId: "electron-control", rect: { x: 0, y: 0, width: 400, height: 300 } }),
    );
    const released = await handlePluginWebviewUiRequest(
      placeRequest({}, { verb: "hostEngine.release" as PluginWebviewUiRequest["verb"], requestId: "req-release" }),
    );
    expect(released.ok).toBe(true);

    render(<HostEngineOverlay guestKey={GUEST_KEY} />);
    expect(document.querySelector("[data-host-engine]")).toBeNull();
    stop();
  });
});
