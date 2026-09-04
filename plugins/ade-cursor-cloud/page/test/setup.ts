/**
 * jsdom gaps the ported components rely on.
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
  // jsdom's observer never fires and its rects are 0×0, so a composer picker
  // that reports height via ResizeObserver would never call `ui.resize` in
  // this environment. The stub measures a real box and delivers one frame on
  // observe — enough for the seam, not a layout engine.
  window.ResizeObserver = class {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element): void {
      this.callback(
        [{ target } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 480,
      right: 560,
      width: 560,
      height: 480,
      toJSON() {
        return this;
      },
    };
  };
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}
