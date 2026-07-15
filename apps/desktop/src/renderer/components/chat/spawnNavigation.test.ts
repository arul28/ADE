/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { navigateToSpawnedChat } from "./spawnNavigation";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("navigateToSpawnedChat", () => {
  it("dispatches ade:work:select-session with the session id and lane id", () => {
    const spy = vi.spyOn(window, "dispatchEvent");
    navigateToSpawnedChat("child-1", "lane-9");

    const evt = spy.mock.calls
      .map(([e]) => e)
      .find((e): e is CustomEvent => e instanceof CustomEvent && e.type === "ade:work:select-session");
    expect(evt).toBeTruthy();
    expect(evt!.detail).toEqual({ sessionId: "child-1", laneId: "lane-9" });
  });

  it("defaults laneId to null when omitted", () => {
    const spy = vi.spyOn(window, "dispatchEvent");
    navigateToSpawnedChat("child-2");

    const evt = spy.mock.calls
      .map(([e]) => e)
      .find((e): e is CustomEvent => e instanceof CustomEvent && e.type === "ade:work:select-session");
    expect(evt!.detail).toEqual({ sessionId: "child-2", laneId: null });
  });

  it("is a no-op when the session id is falsy", () => {
    const spy = vi.spyOn(window, "dispatchEvent");
    navigateToSpawnedChat(null);
    navigateToSpawnedChat(undefined, "lane-1");
    navigateToSpawnedChat("");

    const nav = spy.mock.calls
      .map(([e]) => e)
      .find((e): e is CustomEvent => e instanceof CustomEvent && e.type === "ade:work:select-session");
    expect(nav).toBeUndefined();
  });
});
