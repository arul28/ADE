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
   * jsdom implements no `PointerEvent`.
   *
   * Testing Library builds a pointer event by name and falls back to a bare
   * `Event` when the constructor is missing — which silently drops `clientX`
   * and `clientY`, so every tap the control surface computes lands at `NaN`.
   * The pane's whole Control mode is those two numbers, so a test that could
   * not carry them would be asserting nothing. `MouseEvent` carries both and is
   * what jsdom's own mouse events already use.
   */
  if (!(window as unknown as { PointerEvent?: unknown }).PointerEvent) {
    (window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;
  }
}
