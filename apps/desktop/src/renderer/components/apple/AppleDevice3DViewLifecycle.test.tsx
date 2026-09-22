/* @vitest-environment jsdom */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ThreeModule from "three";

/**
 * The GPU context ledger.
 *
 * A browser lends out a fixed number of WebGL contexts — Chromium 16 — and
 * silently takes the oldest back when a seventeenth is asked for. The round-4
 * symptom was the pane announcing "3D view needs WebGL" on a window where 3D
 * had been working minutes earlier: every remount had built a renderer and
 * none had given one back. This file is the ledger, so a leak fails here
 * rather than after twenty minutes of use.
 */
const contexts = vi.hoisted(() => ({
  created: 0,
  disposed: 0,
  lost: 0,
  live: 0,
  max: 0,
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof ThreeModule>();
  class SpyRenderer {
    outputColorSpace: unknown = null;
    constructor() {
      contexts.created += 1;
      contexts.live += 1;
      contexts.max = Math.max(contexts.max, contexts.live);
    }
    setDrawingBufferSize() {}
    render() {}
    dispose() {
      contexts.disposed += 1;
      contexts.live = Math.max(0, contexts.live - 1);
    }
    forceContextLoss() {
      contexts.lost += 1;
    }
  }
  return { ...actual, WebGLRenderer: SpyRenderer };
});

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    parseAsync() {
      return new Promise(() => {});
    }
  },
}));

const { AppleDevice3DView } = await import("./AppleDevice3DView");

function renderView() {
  return render(
    <AppleDevice3DView
      screenCanvas={null}
      frameVersion={0}
      family="iphone"
      deviceTypeName="iPhone 17 Pro"
      orientation="portrait"
      screenPixelSize={{ width: 1_179, height: 2_556 }}
      devicePointSize={{ width: 393, height: 852 }}
      interactive
      resetNonce={0}
      onDeviceInput={vi.fn()}
    />,
  );
}

beforeEach(() => {
  contexts.created = 0;
  contexts.disposed = 0;
  contexts.lost = 0;
  contexts.live = 0;
  contexts.max = 0;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  // The model fetch never resolves: this file is about the renderer, not the body.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppleDevice3DView renderer lifecycle", () => {
  it("gives every GPU context back on unmount", async () => {
    for (let i = 0; i < 6; i++) {
      const view = renderView();
      // The runtime is imported dynamically, so the renderer exists a tick later.
      await act(async () => {});
      view.unmount();
      await act(async () => {});
    }
    expect(contexts.created).toBe(6);
    expect(contexts.disposed).toBe(6);
    // `forceContextLoss` is what actually releases the GPU side; `dispose`
    // alone leaves the context alive until GC gets round to it.
    expect(contexts.lost).toBe(6);
    // And never more than one alive at a time, which is the property that
    // matters: six mounts must not mean six live contexts.
    expect(contexts.max).toBe(1);
  });

  it("removes the context-lost listener BEFORE it forces the loss", async () => {
    const unavailable = vi.fn();
    const view = render(
      <AppleDevice3DView
        screenCanvas={null}
        frameVersion={0}
        family="iphone"
        deviceTypeName="iPhone 17 Pro"
        orientation="portrait"
        screenPixelSize={{ width: 1_179, height: 2_556 }}
      devicePointSize={{ width: 393, height: 852 }}
        interactive
        resetNonce={0}
        onDeviceInput={vi.fn()}
        onUnavailable={unavailable}
      />,
    );
    await act(async () => {});
    const canvas = view.container.querySelector("canvas") as HTMLCanvasElement;
    view.unmount();
    await act(async () => {});
    // The unmount's own `forceContextLoss` must not read as "this window has
    // no WebGL" — that false alarm is what sent a working pane to flat.
    canvas.dispatchEvent(new Event("webglcontextlost"));
    await act(async () => {});
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("does not build a second renderer for Reset view", async () => {
    const view = renderView();
    await act(async () => {});
    expect(contexts.created).toBe(1);
    for (let nonce = 1; nonce <= 4; nonce++) {
      view.rerender(
        <AppleDevice3DView
          screenCanvas={null}
          frameVersion={0}
          family="iphone"
          deviceTypeName="iPhone 17 Pro"
          orientation="portrait"
          screenPixelSize={{ width: 1_179, height: 2_556 }}
      devicePointSize={{ width: 393, height: 852 }}
          interactive
          resetNonce={nonce}
          onDeviceInput={vi.fn()}
        />,
      );
      await act(async () => {});
    }
    expect(contexts.created).toBe(1);
    expect(contexts.live).toBe(1);
  });
});
