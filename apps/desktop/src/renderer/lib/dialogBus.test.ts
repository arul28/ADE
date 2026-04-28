import { describe, expect, it, vi } from "vitest";
import { createDialogBus, type DialogBusEvent } from "./dialogBus";

describe("dialogBus", () => {
  it("broadcasts open events to subscribers listening for the matching id", () => {
    const bus = createDialogBus();
    const cb = vi.fn();
    bus.subscribe("lanes.create", cb);
    bus.open("lanes.create");
    expect(cb).toHaveBeenCalledTimes(1);
    const event = cb.mock.calls[0][0] as DialogBusEvent;
    expect(event.type).toBe("open");
    expect(event.id).toBe("lanes.create");
  });

  it("also broadcasts events to subscribeAll listeners", () => {
    const bus = createDialogBus();
    const allCb = vi.fn();
    bus.subscribeAll(allCb);
    bus.open("lanes.create");
    bus.close("lanes.create");
    expect(allCb).toHaveBeenCalledTimes(2);
    const events = allCb.mock.calls.map((c) => c[0] as DialogBusEvent);
    expect(events[0]).toMatchObject({ type: "open", id: "lanes.create" });
    expect(events[1]).toMatchObject({ type: "close", id: "lanes.create" });
  });

  it("does not call id-subscribers for a different id", () => {
    const bus = createDialogBus();
    const lanesCb = vi.fn();
    const prsCb = vi.fn();
    bus.subscribe("lanes.create", lanesCb);
    bus.subscribe("prs.create", prsCb);
    bus.open("lanes.create");
    expect(lanesCb).toHaveBeenCalledTimes(1);
    expect(prsCb).not.toHaveBeenCalled();
  });

  it("stops delivering events after unsubscribe()", () => {
    const bus = createDialogBus();
    const cb = vi.fn();
    const unsubscribe = bus.subscribe("lanes.create", cb);
    bus.open("lanes.create");
    unsubscribe();
    bus.open("lanes.create");
    expect(cb).toHaveBeenCalledTimes(1);

    const allCb = vi.fn();
    const unsubscribeAll = bus.subscribeAll(allCb);
    bus.close("lanes.create");
    unsubscribeAll();
    bus.close("lanes.create");
    expect(allCb).toHaveBeenCalledTimes(1);
  });

  it("passes props through on open events", () => {
    const bus = createDialogBus();
    const cb = vi.fn();
    bus.subscribe("prs.create", cb);
    bus.open("prs.create", { title: "Fix bug", draft: true });
    const event = cb.mock.calls[0][0] as DialogBusEvent;
    expect(event).toMatchObject({
      type: "open",
      id: "prs.create",
      props: { title: "Fix bug", draft: true },
    });
  });

  it("fires close events with the close type", () => {
    const bus = createDialogBus();
    const cb = vi.fn();
    bus.subscribe("lanes.manage", cb);
    bus.close("lanes.manage");
    const event = cb.mock.calls[0][0] as DialogBusEvent;
    expect(event).toEqual({ type: "close", id: "lanes.manage" });
  });
});
