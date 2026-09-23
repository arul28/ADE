/* @vitest-environment jsdom */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type * as ThreeModule from "three";

/**
 * The model is parsed once per process, and each instance owns what dispose
 * destroys.
 *
 * Measured before this cache existed: ten mounts in one session, each fetching
 * 2.4 MB, parsing 427 accessors and decoding 17 WebP images, and each
 * abandoned load logging 17 `Couldn't load texture blob:` errors as it was torn
 * down — 170 in one log, exactly 17 x 10.
 */
const parses = vi.hoisted(() => ({ count: 0 }));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof ThreeModule>();
  class SpyRenderer {
    outputColorSpace: unknown = null;
    setDrawingBufferSize() {}
    render() {}
    dispose() {}
    forceContextLoss() {}
  }
  return { ...actual, WebGLRenderer: SpyRenderer };
});

/** A body whose screen mesh `createImportedBody` can find. */
function makeScene(): THREE.Group {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 2, 0.1);
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array(geometry.attributes.position!.count * 2), 2),
  );
  const screen = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  screen.name = "device-screen";
  group.add(screen);
  const shell = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.1, 0.2), new THREE.MeshStandardMaterial());
  shell.name = "shell";
  group.add(shell);
  return group;
}

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    // The real loader's plugin hook; the view registers one to load textures
    // through an <img>.
    register() {
      return this;
    }
    async parseAsync() {
      parses.count += 1;
      return { scene: makeScene() };
    }
  },
}));

const { AppleDevice3DView } = await import("./AppleDevice3DView");
const { __testClearAppleModelCache } = await import("./appleDeviceModelLoader");

function renderView(onReady: () => void) {
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
      onReady={onReady}
    />,
  );
}

describe("Apple 3D model cache", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    parses.count = 0;
    __testClearAppleModelCache();
    fetchSpy = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("fetches and parses once, however many times the view mounts", async () => {
    const first = vi.fn();
    const one = renderView(first);
    await waitFor(() => expect(first).toHaveBeenCalled());
    one.unmount();

    const second = vi.fn();
    const two = renderView(second);
    await waitFor(() => expect(second).toHaveBeenCalled());
    two.unmount();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(parses.count).toBe(1);
  });

  it("the template survives an instance being disposed, so the next mount still gets a body", async () => {
    // The safety property, asserted through observable behaviour.
    // `disposeImportedSubtree` disposes geometries and materials, so if the
    // cache handed out shared ones the FIRST unmount would destroy the
    // template and the second mount would report unavailable instead of ready.
    // Textures are shared on purpose: no dispose path touches them.
    const first = vi.fn();
    const firstUnavailable = vi.fn();
    const one = render(
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
        onReady={first}
        onUnavailable={firstUnavailable}
      />,
    );
    await waitFor(() => expect(first).toHaveBeenCalled());
    one.unmount();

    const second = vi.fn();
    const secondUnavailable = vi.fn();
    const two = render(
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
        onReady={second}
        onUnavailable={secondUnavailable}
      />,
    );
    await waitFor(() => expect(second).toHaveBeenCalled());

    expect(secondUnavailable).not.toHaveBeenCalled();
    expect(parses.count).toBe(1);
    two.unmount();
  });
});
