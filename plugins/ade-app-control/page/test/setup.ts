/**
 * jsdom gaps the ported chrome relies on.
 *
 * Nothing here fakes the bridge — the seam test scripts that itself, so a
 * component that reached for a host verb the test did not script fails loudly
 * rather than finding a helpful stub.
 */

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
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  /**
   * A box with a size in it.
   *
   * jsdom runs no layout, so every `getBoundingClientRect` is zeros — and the
   * reserved rect is the ONE measurement in this page that a zero would make
   * meaningless rather than merely untested: `host/engine.ts` refuses to place
   * an engine smaller than eight pixels, exactly so a mid-layout read never
   * becomes a one-pixel live view. Without a size here the seam test would prove
   * that the guard works and nothing about the placement.
   *
   * The numbers are arbitrary and the test never asserts them; what it asserts
   * is that a rect with a positive width and height reached `hostEngine.place`
   * under the right engine id.
   */
  const ENGINE_TEST_RECT = { x: 12, y: 40, width: 640, height: 360 };
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
    const isEngineRect = this instanceof HTMLElement && this.hasAttribute("data-ade-engine-rect");
    const box = isEngineRect ? ENGINE_TEST_RECT : { x: 0, y: 0, width: 0, height: 0 };
    return {
      ...box,
      top: box.y,
      left: box.x,
      right: box.x + box.width,
      bottom: box.y + box.height,
      toJSON: () => box,
    } as DOMRect;
  };
}
