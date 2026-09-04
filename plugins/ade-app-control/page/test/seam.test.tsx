/**
 * The seam test.
 *
 * The plugin is two programs now: a page that draws, and a child process that
 * holds the CDP session and the runtime pin. They are joined by nothing but a
 * list of action ids and their argument shapes — no compiler checks the join,
 * because the page is built separately from the plugin it ships inside, and no
 * type crosses the bridge.
 *
 * So this test walks the product the way a reader does, against a scripted
 * `window.adePlugin` (`fakeBridge.ts`), and asserts the CALLS rather than the
 * pixels: an id the page invokes that the fake does not script throws by name,
 * and an argument shape that drifts fails on the assertion that reads it. It is
 * deliberately owned by neither half — a page change and a `pageActions.js`
 * change both have to keep it passing.
 *
 * The walk: no session → launch → connect → the rect is reserved and the host
 * engine is placed → click, scroll and type → inspect a point and read the
 * list → unmount and the engine is released.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ControlEntry } from "../src/entries/ControlEntry";
import { PageRouter } from "../src/PageRouter";
import { ENGINE_ID } from "../src/host/engine";
import { installFakeBridge, uninstallFakeBridge, fakeElement, type FakeBridge } from "./fakeBridge";

/**
 * A fresh project root per test.
 *
 * The launch form is stored per project root in the `ui-state` collection, and
 * the fake's collection map lives for the life of one install. A distinct root
 * per test is the same isolation a distinct project gives in the product.
 */
let root = 0;

function paneContext(overrides: Record<string, unknown> = {}) {
  return {
    subject: null,
    surfaceId: "control",
    placement: "pane" as const,
    project: { projectId: `project-${root}`, root: `/repo-${root}`, binding: "local" as const },
    ...overrides,
  };
}

let host: FakeBridge;

beforeEach(() => {
  root += 1;
  host = installFakeBridge();
});

afterEach(() => {
  cleanup();
  uninstallFakeBridge();
});

/** Re-install the fake with a connected session, for the tests past the launch. */
function connected(overrides: Parameters<typeof installFakeBridge>[0] = {}): void {
  uninstallFakeBridge();
  host = installFakeBridge({ ...overrides, connected: true });
}

/** The last rect the page asked the host to paint into. */
function lastPlacement(): { engineId: string; rect: { x: number; y: number; width: number; height: number } } {
  const call = host.lastCall("hostEngine.place");
  if (!call) throw new Error("The page never placed the host engine.");
  return call.args as unknown as { engineId: string; rect: { x: number; y: number; width: number; height: number } };
}

describe("the page and the plugin agree on every verb", () => {
  it("walks launch, stop, connect, the reserved rect, click, scroll, type and inspect", async () => {
    // ── No session ──────────────────────────────────────────────────────────
    // The pane opens with exactly one read: the status. Everything else — the
    // targets, the snapshot — is gated on a session that does not exist yet.
    render(<ControlEntry context={paneContext()} />);

    await waitFor(() => {
      expect(host.callsTo("invoke:pageStatus").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("invoke:pageTargets")).toHaveLength(0);
    expect(host.session).toBeNull();

    // ── The rect is reserved before anything is running ─────────────────────
    // Deliberately not gated on a session: the host engine draws its own "no
    // session yet" state, and a placement that only appeared after a connect
    // would flash an empty box in its place.
    await waitFor(() => {
      expect(host.callsTo("hostEngine.place").length).toBeGreaterThan(0);
    });
    const placed = lastPlacement();
    expect(placed.engineId).toBe(ENGINE_ID);
    expect(placed.engineId).toBe("electron-control");
    expect(placed.rect.width).toBeGreaterThan(0);
    expect(placed.rect.height).toBeGreaterThan(0);
    expect(Object.keys(placed.rect).sort()).toEqual(["height", "width", "x", "y"]);

    // ── Launch ──────────────────────────────────────────────────────────────
    fireEvent.change(screen.getByLabelText("Electron Control launch command"), {
      target: { value: "pnpm dev" },
    });
    fireEvent.click(screen.getByLabelText("Launch Electron Control command"));

    await waitFor(() => {
      expect(host.callsTo("invoke:pageLaunch").length).toBe(1);
    });
    // The launch argument shape is the contract `pageActions.js:pageLaunch`
    // reads. A drift here is the bug this test exists to catch.
    expect(host.lastCall("invoke:pageLaunch")!.args).toMatchObject({
      command: "pnpm dev",
      projectRoot: `/repo-${root}`,
      cwd: null,
      laneId: null,
      chatSessionId: null,
    });
    // And the form was remembered in the plugin's own collection, not in a
    // guest `sessionStorage` that dies with the placement.
    await waitFor(() => {
      expect(host.callsTo("collections.put").length).toBeGreaterThan(0);
    });
    expect(host.lastCall("collections.put")!.args.collection).toBe("ui-state");

    // The launch answered a starting session, so the pane redraws as active and
    // the status is re-read rather than trusted from the mutation alone.
    const stop = await screen.findByLabelText("Stop Electron Control session");

    // ── Stop, and the launch row comes back ─────────────────────────────────
    fireEvent.click(stop);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStop").length).toBe(1);
    });
    await screen.findByLabelText("CDP port");

    // ── Connect ─────────────────────────────────────────────────────────────
    fireEvent.change(screen.getByLabelText("CDP port"), { target: { value: "9222" } });
    fireEvent.click(screen.getByTitle("Connect to a running Electron app via CDP"));

    await waitFor(() => {
      expect(host.callsTo("invoke:pageConnect").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageConnect")!.args).toMatchObject({
      cdpPort: 9222,
      projectRoot: `/repo-${root}`,
      laneId: null,
      chatSessionId: null,
    });

    // A connected session brings the window picker with it.
    await waitFor(() => {
      expect(host.callsTo("invoke:pageTargets").length).toBeGreaterThan(0);
    });
    const picker = await screen.findByLabelText("Switch the controlled window");
    expect(within(picker as HTMLElement).getAllByRole("option")).toHaveLength(2);

    fireEvent.change(picker, { target: { value: "target-b" } });
    await waitFor(() => {
      expect(host.lastCall("invoke:pageAttachTarget")!.args).toEqual({ targetId: "target-b" });
    });

    // ── The typed coordinate is NOT drawn where the host can paint ──────────
    // A click on the engine's picture is a click, a wheel is a scroll and a
    // hover inspects, so an x/y field and a Click button beside a live app
    // would be a worse copy of what is already under the reader's pointer.
    // Their no-engine walk is the degradation test below.
    expect(screen.queryByLabelText("Viewport x")).toBeNull();
    expect(screen.queryByLabelText("Click the app")).toBeNull();
    expect(screen.queryByLabelText("Scroll the app")).toBeNull();
    // Mode goes with them: it selects which verb a click becomes, and the
    // engine owns the click.
    expect(screen.queryByRole("button", { name: "Inspect" })).toBeNull();

    // ── Type ────────────────────────────────────────────────────────────────
    fireEvent.change(screen.getByLabelText("Text to type into the focused app element"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByLabelText("Type into focused app element"));

    await waitFor(() => {
      expect(host.callsTo("invoke:pageTypeText").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageTypeText")!.args).toEqual({ text: "hello" });
    // A successful type refreshes the DOM snapshot, exactly as the compiled
    // pane did — and the snapshot read carries the project root.
    await waitFor(() => {
      expect(host.callsTo("invoke:pageSnapshot").length).toBeGreaterThan(0);
    });
    expect(host.lastCall("invoke:pageSnapshot")!.args).toEqual({ projectRoot: `/repo-${root}` });

    // ── Read the list the snapshot filled ───────────────────────────────────
    // The list is the page's, and it is fed by the snapshot the type step just
    // refreshed — not by a coordinate the reader typed. Pointing at an element
    // is the engine's gesture now.
    const list = await screen.findByTestId("inspect-list");
    await waitFor(() => {
      expect(within(list).getByText("Save")).toBeTruthy();
    });
    expect(within(list).getByText("#save")).toBeTruthy();
    expect(within(list).getByText(/testId=save-button/)).toBeTruthy();

    // The selected element's source is a press, and the plugin verb takes a
    // relative path plus an editor id — not `file:line` stuffed into `target`.
    const source = await screen.findByTitle("Open this element's source in ADE");
    fireEvent.click(source);
    await waitFor(() => {
      expect(host.callsTo("ui.openPathInEditor").length).toBe(1);
    });
    expect(host.lastCall("ui.openPathInEditor")!.args).toEqual({
      rootPath: `/repo-${root}`,
      relativePath: "src/App.tsx",
      target: "default",
    });
  });

  it("releases the host engine on unmount", async () => {
    const view = render(<ControlEntry context={paneContext()} />);
    await waitFor(() => {
      expect(host.callsTo("hostEngine.place").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("hostEngine.release")).toHaveLength(0);

    view.unmount();

    await waitFor(() => {
      expect(host.callsTo("hostEngine.release").length).toBeGreaterThan(0);
    });
  });

  it("does not re-place an engine whose rect has not moved", async () => {
    render(<ControlEntry context={paneContext()} />);
    await waitFor(() => {
      expect(host.callsTo("hostEngine.place").length).toBe(1);
    });

    // A resize the layout did not actually move. The compiled pane paid this
    // cost as a `requestAnimationFrame` per frame; the page must coalesce it,
    // because every one of these is an IPC round trip.
    for (let index = 0; index < 5; index += 1) {
      fireEvent(window, new Event("resize"));
    }
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    expect(host.callsTo("hostEngine.place")).toHaveLength(1);
  });

  it("degrades to a message on a host with no engine, and still drives the app", async () => {
    uninstallFakeBridge();
    host = installFakeBridge({ engine: false, connected: true });

    render(<ControlEntry context={paneContext()} />);

    // The sentence, not a throw.
    await waitFor(() => {
      expect(screen.getByText(/cannot draw the live app view/i)).toBeTruthy();
    });
    expect(host.callsTo("hostEngine.place")).toHaveLength(0);

    // And every input verb still reaches the child, which is the whole claim:
    // a host with no picture is still a working Electron Control.
    fireEvent.change(screen.getByLabelText("Viewport x"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Viewport y"), { target: { value: "64" } });
    fireEvent.click(screen.getByLabelText("Click the app"));
    await waitFor(() => {
      expect(host.callsTo("invoke:pageClick").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageClick")!.args).toEqual({
      x: 120,
      y: 64,
      coordinateSpace: "viewport",
    });

    fireEvent.change(screen.getByLabelText("Scroll amount"), { target: { value: "-240" } });
    fireEvent.click(screen.getByLabelText("Scroll the app"));
    await waitFor(() => {
      expect(host.callsTo("invoke:pageScroll").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageScroll")!.args).toEqual({
      x: 120,
      y: 64,
      deltaX: 0,
      deltaY: -240,
      coordinateSpace: "viewport",
    });

    // Mode is the page's again here, because the click is.
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    fireEvent.click(await screen.findByLabelText("Inspect point"));
    await waitFor(() => {
      expect(host.callsTo("invoke:pageInspectPoint").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageInspectPoint")!.args).toEqual({
      projectRoot: `/repo-${root}`,
      x: 120,
      y: 64,
      coordinateSpace: "viewport",
      includeScreenshot: false,
    });
  });

  it("draws the blockers card from the status, not from a prop", async () => {
    uninstallFakeBridge();
    host = installFakeBridge({ connected: true, disabledReason: "This lane does not own the app." });

    render(<ControlEntry context={paneContext()} />);

    await waitFor(() => {
      expect(screen.getByText("This lane does not own the app.")).toBeTruthy();
    });
    // The compiled pane took this as `controlDisabledReason` from whichever
    // chat mounted it. A page has no props, so it has to arrive with the status.
    expect(host.callsTo("invoke:pageStatus").length).toBeGreaterThan(0);
  });

  it("shows a refusal as a banner rather than throwing", async () => {
    // No engine: the banner is raised by the page's own Click, which is the
    // only place a click exists on a host that cannot paint the picture.
    connected({ engine: false });
    host.setAction("pageClick", () => ({ ok: false, message: "The renderer is not accepting input." }));

    render(<ControlEntry context={paneContext()} />);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStatus").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByLabelText("Click the app"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("The renderer is not accepting input.");
    });
  });

  it("attaches a selected element to the chat through one call", async () => {
    connected({ engine: false, elements: [fakeElement()] });
    render(<ControlEntry context={paneContext()} />);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStatus").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    fireEvent.click(await screen.findByLabelText("Attach point context"));
    await waitFor(() => {
      expect(host.callsTo("invoke:pageSelectPoint").length).toBe(1);
    });
    // The compiled pane did the crop, the temp-attachment save and two callback
    // props in the renderer. One call now, and the child holds the frame.
    await waitFor(() => {
      expect(host.callsTo("invoke:pageAttachContext").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageAttachContext")!.args).toMatchObject({
      item: { kind: "app_control_element", id: "context-1" },
    });
    // Twice on purpose: the banner says what happened, and the chip beside the
    // Attach button stays as the acknowledgement the compiled pane also kept.
    expect(await screen.findAllByText(/Inserted Save context/)).toHaveLength(2);
  });

  it("draws the source line inert when the host cannot open an editor", async () => {
    connected({ engine: false, withoutEditor: true });
    render(<ControlEntry context={paneContext()} />);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStatus").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    fireEvent.click(await screen.findByLabelText("Inspect point"));
    await waitFor(() => {
      expect(screen.getByTestId("source-inert").textContent).toContain("src/App.tsx");
    });
    expect(screen.queryByTitle("Open this element's source in ADE")).toBeNull();
    expect(host.callsTo("ui.openPathInEditor")).toHaveLength(0);
  });

  it("routes an unknown surface id to the control pane rather than an error page", async () => {
    render(<PageRouter context={paneContext({ surfaceId: "a-surface-this-build-does-not-know" })} />);
    await waitFor(() => {
      expect(screen.getByLabelText("Electron Control launch command")).toBeTruthy();
    });
  });
});
