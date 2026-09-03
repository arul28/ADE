/**
 * jsdom gaps the ported components rely on.
 *
 * Nothing here fakes the bridge — the seam test scripts that itself, so a
 * component that reached for a host verb the test did not script fails loudly
 * rather than finding a helpful stub.
 *
 * The two React Flow gaps are the reason this file is longer than Linear's.
 * jsdom has no layout: every element measures 0×0 and no `ResizeObserver` ever
 * fires. React Flow decides its viewport from exactly those two things and
 * renders no node into a zero-sized pane, so without these the canvas mounts and
 * draws nothing — which would make every assertion about a node vacuously fail.
 * Both stubs report one fixed desktop-sized box; neither changes what the page
 * does, only that it has somewhere to draw.
 */

const VIEWPORT = { width: 1280, height: 800 };

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }

  // Fires once per observed element, which is what React Flow's own
  // `useResizeObserver` waits for before it will place a node.
  window.ResizeObserver = class {
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element): void {
      const entry = {
        target,
        contentRect: { ...VIEWPORT, top: 0, left: 0, right: VIEWPORT.width, bottom: VIEWPORT.height, x: 0, y: 0 },
        borderBoxSize: [{ inlineSize: VIEWPORT.width, blockSize: VIEWPORT.height }],
        contentBoxSize: [{ inlineSize: VIEWPORT.width, blockSize: VIEWPORT.height }],
        devicePixelContentBoxSize: [{ inlineSize: VIEWPORT.width, blockSize: VIEWPORT.height }],
      } as unknown as ResizeObserverEntry;
      // Asynchronous, like the real one: a synchronous callback inside `observe`
      // runs during React's commit and warns about a state update while
      // rendering.
      queueMicrotask(() => this.callback([entry], this as unknown as ResizeObserver));
    }

    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;

  const measured = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function boundingRect(this: Element): DOMRect {
    const rect = measured.call(this);
    if (rect.width > 0 || rect.height > 0) return rect;
    return {
      ...VIEWPORT,
      top: 0,
      left: 0,
      right: VIEWPORT.width,
      bottom: VIEWPORT.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  if (!window.DOMMatrixReadOnly) {
    // React Flow reads the pane's transform through this to convert screen
    // coordinates into flow coordinates.
    class StubMatrix {
      m22 = 1;
      constructor(readonly transform?: string) {
        const scale = transform ? Number.parseFloat(transform.split(/[(,]/)[1] ?? "1") : 1;
        this.m22 = Number.isFinite(scale) ? scale : 1;
      }
    }
    (window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = StubMatrix;
  }
}
