/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { WorkToolShowRequest } from "../../shared/types/workToolShow";
import {
  answerWorkToolShowRequest,
  registerWorkToolShowHandler,
  resetWorkToolShowRequestsForTests,
  setWorkToolShowClockForTests,
  useWorkToolShowRequestListener,
  WORK_TOOL_SHOW_HOLD_TTL_MS,
} from "./workToolShowRequests";
import {
  isWorkSurfaceOnScreen,
  noteWorkSurfaceMounted,
  resetWorkToolOnScreenForTests,
  setDocumentVisibleForTests,
  workSurfaceKey,
} from "./workToolOnScreen";

let nextId = 1;
function request(overrides: Partial<WorkToolShowRequest> = {}): WorkToolShowRequest {
  return {
    requestId: `wts-${nextId++}`,
    surface: "apple",
    chatSessionId: "chat-1",
    laneId: "lane-1",
    auto: false,
    requestedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  resetWorkToolShowRequestsForTests();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("work tool show requests", () => {
  it("shows at once when the chat's surface is registered", async () => {
    const show = vi.fn(() => "shown" as const);
    registerWorkToolShowHandler({ chatSessionId: "chat-1", surfaces: ["apple"], show });
    await expect(answerWorkToolShowRequest(request())).resolves.toEqual({ status: "shown" });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("holds a request for a chat that is not in front and delivers it when that chat mounts", async () => {
    const onOtherChat = vi.fn(() => "shown" as const);
    registerWorkToolShowHandler({ chatSessionId: "chat-2", surfaces: ["apple", "proof"], show: onOtherChat });
    const asked = request({ surface: "proof" });
    await expect(answerWorkToolShowRequest(asked)).resolves.toMatchObject({ status: "held" });
    expect(onOtherChat).not.toHaveBeenCalled();

    const show = vi.fn(() => "shown" as const);
    registerWorkToolShowHandler({ chatSessionId: "chat-1", surfaces: ["proof"], show });
    await waitFor(() => expect(show).toHaveBeenCalledWith(asked));
    // Delivered once: a second mount does not replay it.
    const again = vi.fn(() => "shown" as const);
    registerWorkToolShowHandler({ chatSessionId: "chat-1", surfaces: ["proof"], show: again });
    await Promise.resolve();
    expect(again).not.toHaveBeenCalled();
  });

  it("keeps a hold only for a while", async () => {
    setWorkToolShowClockForTests(1_000);
    await answerWorkToolShowRequest(request());
    setWorkToolShowClockForTests(1_000 + WORK_TOOL_SHOW_HOLD_TTL_MS + 1);
    const show = vi.fn(() => "shown" as const);
    registerWorkToolShowHandler({ chatSessionId: "chat-1", surfaces: ["apple"], show });
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
  });

  it("never holds an automatic float offer, and answers nothing for it", async () => {
    await expect(answerWorkToolShowRequest(request({ surface: "floating-apple", auto: true }))).resolves.toBeNull();
    const show = vi.fn(() => "shown" as const);
    registerWorkToolShowHandler({ chatSessionId: "chat-1", surfaces: ["floating-apple"], show });
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
  });

  it("answers a request heard twice only once", async () => {
    const show = vi.fn(() => "shown" as const);
    registerWorkToolShowHandler({ chatSessionId: "chat-1", surfaces: ["apple"], show });
    const asked = request();
    await expect(answerWorkToolShowRequest(asked)).resolves.toEqual({ status: "shown" });
    await expect(answerWorkToolShowRequest(asked)).resolves.toBeNull();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("holds when the handler could not show it, and when it throws", async () => {
    registerWorkToolShowHandler({ chatSessionId: "chat-1", surfaces: ["apple"], show: () => "declined" as const });
    await expect(answerWorkToolShowRequest(request())).resolves.toMatchObject({ status: "held" });
    resetWorkToolShowRequestsForTests();
    registerWorkToolShowHandler({
      chatSessionId: "chat-1",
      surfaces: ["floating-apple"],
      show: async () => { throw new Error("no device"); },
    });
    await expect(answerWorkToolShowRequest(request({ surface: "floating-apple" }))).resolves.toMatchObject({ status: "held" });
  });

  /* Regression (A2-3 / D3): a surface the handler already opened is never
   * replayed, so a tool the user closed does not come back on a re-register. */
  it("answers held but never replays a request the handler already opened", async () => {
    const show = vi.fn(() => "opened" as const);
    registerWorkToolShowHandler({ chatSessionId: "chat-1", surfaces: ["apple"], show });
    await expect(answerWorkToolShowRequest(request())).resolves.toMatchObject({ status: "held" });
    const again = vi.fn(() => "shown" as const);
    registerWorkToolShowHandler({ chatSessionId: "chat-1", surfaces: ["apple"], show: again });
    await Promise.resolve();
    expect(again).not.toHaveBeenCalled();
  });

  it("acks shown or held on the runtime it heard the request on, and never an auto offer", async () => {
    let listener: ((request: WorkToolShowRequest) => void) | null = null;
    const onShowRequest = vi.fn((cb: (request: WorkToolShowRequest) => void) => {
      listener = cb;
      return () => { listener = null; };
    });
    const acknowledgeShow = vi.fn(async () => ({ ok: true }));
    (window as unknown as { ade: unknown }).ade = { workTools: { onShowRequest, acknowledgeShow } };
    const pin = { kind: "remote", key: "remote:studio" } as never;
    function Listener() {
      useWorkToolShowRequestListener(true, pin);
      return null;
    }
    const view = render(createElement(Listener));
    expect(onShowRequest).toHaveBeenCalledWith(expect.any(Function), pin);

    registerWorkToolShowHandler({ chatSessionId: "chat-1", surfaces: ["apple", "floating-apple"], show: () => "shown" as const });
    const shown = request();
    listener!(shown);
    await waitFor(() => expect(acknowledgeShow).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: shown.requestId, status: "shown" }),
      pin,
    ));
    // Opened but not confirmed on screen: the brain is told so.
    registerWorkToolShowHandler({ chatSessionId: "chat-2", surfaces: ["proof"], show: () => "opened" as const });
    const opened = request({ chatSessionId: "chat-2", surface: "proof" });
    listener!(opened);
    await waitFor(() => expect(acknowledgeShow).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: opened.requestId, status: "held", opened: true }),
      pin,
    ));
    const held = request({ chatSessionId: "chat-9" });
    listener!(held);
    await waitFor(() => expect(acknowledgeShow).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: held.requestId, status: "held" }),
      pin,
    ));
    acknowledgeShow.mockClear();
    listener!(request({ surface: "floating-apple", auto: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(acknowledgeShow).not.toHaveBeenCalled();

    view.unmount();
    expect(listener).toBeNull();
  });
});

describe("work surface on screen", () => {
  afterEach(() => {
    resetWorkToolOnScreenForTests();
    document.body.innerHTML = "";
  });

  function pane(width: number): HTMLElement {
    const element = document.createElement("div");
    element.setAttribute("data-work-sidebar-pane", "");
    element.getBoundingClientRect = () => ({ width } as DOMRect);
    document.body.appendChild(element);
    return element;
  }

  it("regression: a tool is on screen only when its own pane is laid out, on its own machine", () => {
    // Another tools pane is wide open; the Apple tool's own pane is a 19px sliver.
    pane(400);
    const own = pane(19);
    const tool = document.createElement("div");
    tool.getBoundingClientRect = () => ({ width: 400 } as DOMRect);
    own.appendChild(tool);
    const key = workSurfaceKey("apple", "bound", "lane-1");
    noteWorkSurfaceMounted(key, tool);
    setDocumentVisibleForTests(true);

    expect(isWorkSurfaceOnScreen(key)).toBe(false);

    own.getBoundingClientRect = () => ({ width: 400 } as DOMRect);
    expect(isWorkSurfaceOnScreen(key)).toBe(true);
    // The same lane id on another machine is another surface.
    expect(isWorkSurfaceOnScreen(workSurfaceKey("apple", "remote:studio", "lane-1"))).toBe(false);

    setDocumentVisibleForTests(false);
    expect(isWorkSurfaceOnScreen(key)).toBe(false);
  });
});
