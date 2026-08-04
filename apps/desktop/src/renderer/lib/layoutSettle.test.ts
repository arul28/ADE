// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLayoutSettleForTests,
  holdLayoutSettle,
  installLayoutSettleResizeObserver,
} from "./layoutSettle";

/**
 * jsdom has no ResizeObserver, and we need to drive delivery by hand anyway, so
 * stand in a fake whose `emit` plays the role of the browser's delivery step.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  readonly observeCalls: Element[] = [];
  constructor(readonly callback: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.observeCalls.push(target);
    if (!this.observed.includes(target)) this.observed.push(target);
  }
  unobserve(target: Element): void {
    const idx = this.observed.indexOf(target);
    if (idx >= 0) this.observed.splice(idx, 1);
  }
  disconnect(): void {
    this.observed.length = 0;
  }
  emit(...targets: Element[]): void {
    this.callback(
      targets.map((target) => ({ target }) as unknown as ResizeObserverEntry),
      this as unknown as ResizeObserver,
    );
  }
}

const nativeDescriptor = Object.getOwnPropertyDescriptor(window, "ResizeObserver");

function makeScope() {
  const scope = document.createElement("main");
  const inner = document.createElement("div");
  scope.appendChild(inner);
  document.body.appendChild(scope);
  const outside = document.createElement("div");
  document.body.appendChild(outside);
  return { scope, inner, outside };
}

describe("layoutSettle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeResizeObserver.instances = [];
    Object.defineProperty(window, "ResizeObserver", {
      value: FakeResizeObserver,
      configurable: true,
      writable: true,
    });
    __resetLayoutSettleForTests();
    installLayoutSettleResizeObserver();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    __resetLayoutSettleForTests();
    if (nativeDescriptor) Object.defineProperty(window, "ResizeObserver", nativeDescriptor);
  });

  it("delivers normally when nothing is holding", () => {
    const { inner } = makeScope();
    const callback = vi.fn();
    const observer = new window.ResizeObserver(callback);
    observer.observe(inner);
    FakeResizeObserver.instances[0].emit(inner);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("swallows deliveries inside the held scope and re-observes on release", () => {
    const { scope, inner } = makeScope();
    const callback = vi.fn();
    const observer = new window.ResizeObserver(callback);
    observer.observe(inner);
    const inner1 = FakeResizeObserver.instances[0];
    expect(inner1.observeCalls).toHaveLength(1);

    const release = holdLayoutSettle(scope);
    inner1.emit(inner);
    inner1.emit(inner);
    inner1.emit(inner);
    expect(callback).not.toHaveBeenCalled();

    release();
    // Released by re-observing, so the consumer is handed the element's real
    // settled geometry rather than a size it had mid-animation.
    expect(inner1.observeCalls).toEqual([inner, inner]);
    expect(inner1.observed).toContain(inner);
  });

  it("keeps delivering for targets outside the held scope", () => {
    const { scope, inner, outside } = makeScope();
    const callback = vi.fn();
    const observer = new window.ResizeObserver(callback);
    observer.observe(inner);
    observer.observe(outside);

    holdLayoutSettle(scope);
    FakeResizeObserver.instances[0].emit(inner, outside);

    expect(callback).toHaveBeenCalledTimes(1);
    const entries = callback.mock.calls[0][0] as ResizeObserverEntry[];
    expect(entries.map((entry) => entry.target)).toEqual([outside]);
  });

  it("releases on the backstop timer when the caller never does", () => {
    const { scope, inner } = makeScope();
    const callback = vi.fn();
    const observer = new window.ResizeObserver(callback);
    observer.observe(inner);
    const fake = FakeResizeObserver.instances[0];

    holdLayoutSettle(scope, 400);
    fake.emit(inner);
    expect(fake.observeCalls).toHaveLength(1);

    vi.advanceTimersByTime(400);
    expect(fake.observeCalls).toHaveLength(2);

    fake.emit(inner);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("is reference counted, so overlapping holds do not release early", () => {
    const { scope, inner } = makeScope();
    const callback = vi.fn();
    const observer = new window.ResizeObserver(callback);
    observer.observe(inner);
    const fake = FakeResizeObserver.instances[0];

    const releaseA = holdLayoutSettle(scope);
    const releaseB = holdLayoutSettle(scope);
    releaseA();
    fake.emit(inner);
    expect(callback).not.toHaveBeenCalled();

    releaseB();
    fake.emit(inner);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect targets that were unobserved while held", () => {
    const { scope, inner } = makeScope();
    const observer = new window.ResizeObserver(vi.fn());
    observer.observe(inner);
    const fake = FakeResizeObserver.instances[0];

    const release = holdLayoutSettle(scope);
    fake.emit(inner);
    observer.unobserve(inner);
    release();

    expect(fake.observed).toHaveLength(0);
    expect(fake.observeCalls).toEqual([inner]);
  });
});
