import { describe, expect, it } from "vitest";

import { MAC_DESKTOP_LEASE_TTL_MS } from "../../../shared/types/macDesktop";
import { createMacDesktopLeaseRegistry } from "./macDesktopLease";

function harness() {
  let clock = 1_000_000;
  const registry = createMacDesktopLeaseRegistry({ now: () => clock });
  return {
    registry,
    advance(ms: number) {
      clock += ms;
    },
    get now() {
      return clock;
    },
  };
}

describe("macDesktopLease", () => {
  it("grants a lease to an agent chat and reports it", () => {
    const { registry } = harness();
    const decision = registry.grantToAgent({ laneId: "lane-1", holder: "agent", holderId: "chat-1" });
    expect(decision.ok).toBe(true);
    const lease = registry.get("lane-1");
    expect(lease?.holder).toBe("agent");
    expect(lease?.holderId).toBe("chat-1");
  });

  it("refuses a second chat with MAC_DESKTOP_LEASE_HELD_BY_OTHER", () => {
    const { registry } = harness();
    registry.grantToAgent({ laneId: "lane-1", holder: "agent", holderId: "chat-1" });
    const second = registry.grantToAgent({ laneId: "lane-1", holder: "agent", holderId: "chat-2" });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("MAC_DESKTOP_LEASE_HELD_BY_OTHER");
  });

  it("refuses an agent while the user holds control", () => {
    const { registry } = harness();
    registry.takeControl({ laneId: "lane-1", controllerId: "window-7", controllerLabel: "You" });
    const decision = registry.grantToAgent({ laneId: "lane-1", holder: "agent", holderId: "chat-1" });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.code).toBe("MAC_DESKTOP_USER_HAS_CONTROL");
  });

  it("lets the user take over an agent lease", () => {
    const { registry } = harness();
    registry.grantToAgent({ laneId: "lane-1", holder: "agent", holderId: "chat-1" });
    const taken = registry.takeControl({ laneId: "lane-1", controllerId: "window-7" });
    expect(taken.ok).toBe(true);
    expect(registry.get("lane-1")?.holder).toBe("user");
    const refused = registry.checkRealInput({ laneId: "lane-1", holderId: "chat-1" });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.code).toBe("MAC_DESKTOP_USER_HAS_CONTROL");
  });

  it("only the holder returns control", () => {
    const { registry } = harness();
    registry.takeControl({ laneId: "lane-1", controllerId: "window-7" });
    expect(registry.returnControl({ laneId: "lane-1", controllerId: "someone-else" }).released).toBe(false);
    expect(registry.get("lane-1")?.holderId).toBe("window-7");
    expect(registry.returnControl({ laneId: "lane-1", controllerId: "window-7" }).released).toBe(true);
    expect(registry.get("lane-1")).toBeNull();
  });

  it("lapses on its own when nothing renews it", () => {
    const h = harness();
    h.registry.grantToAgent({ laneId: "lane-1", holder: "agent", holderId: "chat-1" });
    h.advance(MAC_DESKTOP_LEASE_TTL_MS - 1);
    expect(h.registry.get("lane-1")).not.toBeNull();
    h.advance(2);
    expect(h.registry.get("lane-1")).toBeNull();
  });

  it("renews only for the holder and only while alive", () => {
    const h = harness();
    h.registry.grantToAgent({ laneId: "lane-1", holder: "agent", holderId: "chat-1" });
    h.advance(MAC_DESKTOP_LEASE_TTL_MS / 2);
    expect(h.registry.renew({ laneId: "lane-1", holderId: "chat-2" })).toBeNull();
    expect(h.registry.renew({ laneId: "lane-1", holderId: "chat-1" })).not.toBeNull();
    h.advance(MAC_DESKTOP_LEASE_TTL_MS - 1);
    expect(h.registry.get("lane-1")).not.toBeNull();
    h.advance(2);
    expect(h.registry.renew({ laneId: "lane-1", holderId: "chat-1" })).toBeNull();
  });

  it("asks once per chat: approval survives the lease that lapsed", () => {
    const h = harness();
    expect(h.registry.isChatApproved("lane-1", "chat-1")).toBe(false);
    h.registry.approveChat("lane-1", "chat-1");
    h.registry.grantToAgent({ laneId: "lane-1", holder: "agent", holderId: "chat-1" });
    h.advance(MAC_DESKTOP_LEASE_TTL_MS * 2);
    expect(h.registry.get("lane-1")).toBeNull();
    expect(h.registry.isChatApproved("lane-1", "chat-1")).toBe(true);
    expect(h.registry.isChatApproved("lane-1", "chat-2")).toBe(false);
  });

  it("refuses real input with INPUT_LEASE_REQUIRED when nobody holds one", () => {
    const { registry } = harness();
    const decision = registry.checkRealInput({ laneId: "lane-1", holderId: "chat-1" });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.code).toBe("MAC_DESKTOP_INPUT_LEASE_REQUIRED");
  });

  it("drops a holder's leases and approvals when its chat ends", () => {
    const { registry } = harness();
    registry.approveChat("lane-1", "chat-1");
    registry.grantToAgent({ laneId: "lane-1", holder: "agent", holderId: "chat-1" });
    registry.grantToAgent({ laneId: "lane-2", holder: "agent", holderId: "chat-1" });
    const dropped = registry.releaseHolder("chat-1");
    expect(dropped.map((lease) => lease.laneId).sort()).toEqual(["lane-1", "lane-2"]);
    expect(registry.get("lane-1")).toBeNull();
    expect(registry.isChatApproved("lane-1", "chat-1")).toBe(false);
  });

  it("releaseAll drops every lease, as a sleeping machine must", () => {
    const { registry } = harness();
    registry.grantToAgent({ laneId: "lane-1", holder: "agent", holderId: "chat-1" });
    registry.takeControl({ laneId: "lane-2", controllerId: "window-7" });
    expect(registry.releaseAll()).toHaveLength(2);
    expect(registry.list()).toHaveLength(0);
  });
});
