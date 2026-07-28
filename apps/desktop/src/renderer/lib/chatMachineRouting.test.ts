import { describe, expect, it } from "vitest";
import {
  buildLaneBindingIndex,
  createChatMachineRouter,
  isLivePinnedBinding,
  resolveChatRuntimePin,
  resolveLaneBindingKey,
} from "./chatMachineRouting";
import type { OpenProjectBinding } from "../../shared/types/core";

const machineA: OpenProjectBinding = {
  kind: "local",
  key: "local:/repo-a",
  rootPath: "/repo-a",
  displayName: "Machine A",
};

const machineB: OpenProjectBinding = {
  kind: "remote",
  key: "remote:target-b:project-b",
  targetId: "target-b",
  runtimeName: "machine-b",
  projectId: "project-b",
  rootPath: "/repo-b",
  displayName: "Machine B",
};

function state(overrides?: Partial<Parameters<typeof createChatMachineRouter>[0]>) {
  return {
    activeBinding: machineA,
    openBindings: [machineA, machineB],
    laneBindingIndex: buildLaneBindingIndex([
      { bindingKey: machineA.key, laneIds: ["lane-a1", "lane-a2"] },
      { bindingKey: machineB.key, laneIds: ["lane-b1"] },
    ]),
    ...overrides,
  };
}

describe("buildLaneBindingIndex", () => {
  it("maps lanes to their owning binding and keeps the first source on conflict", () => {
    const index = buildLaneBindingIndex([
      { bindingKey: machineA.key, laneIds: ["lane-1", " lane-2 "] },
      { bindingKey: machineB.key, laneIds: ["lane-1", "lane-3"] },
    ]);
    expect(index.get("lane-1")).toBe(machineA.key);
    expect(index.get("lane-2")).toBe(machineA.key);
    expect(index.get("lane-3")).toBe(machineB.key);
  });

  it("ignores blank binding keys and lane ids", () => {
    const index = buildLaneBindingIndex([
      { bindingKey: "  ", laneIds: ["lane-x"] },
      { bindingKey: machineA.key, laneIds: ["", "   ", "lane-y"] },
    ]);
    expect(index.has("lane-x")).toBe(false);
    expect(index.get("lane-y")).toBe(machineA.key);
    expect(index.size).toBe(1);
  });
});

describe("resolveLaneBindingKey", () => {
  it("resolves known lanes and returns null for unknown or blank ones", () => {
    const s = state();
    expect(resolveLaneBindingKey(s, "lane-b1")).toBe(machineB.key);
    expect(resolveLaneBindingKey(s, "lane-unknown")).toBeNull();
    expect(resolveLaneBindingKey(s, "")).toBeNull();
    expect(resolveLaneBindingKey(s, null)).toBeNull();
  });
});

describe("resolveChatRuntimePin", () => {
  it("pins a chat whose lane lives on another machine to that machine", () => {
    // Active binding is A; the chat's lane lives on B.
    const s = state();
    expect(resolveChatRuntimePin(s, "lane-b1")).toEqual(machineB);
    // Resolution is a pure derivation: it does not touch the active binding.
    expect(s.activeBinding).toBe(machineA);
    expect(s.openBindings).toEqual([machineA, machineB]);
  });

  it("returns null for a chat on the active binding so callers take the cheap path", () => {
    expect(resolveChatRuntimePin(state(), "lane-a1")).toBeNull();
  });

  it("returns null when the lane's owner is unknown", () => {
    expect(resolveChatRuntimePin(state(), "lane-nobody")).toBeNull();
    expect(resolveChatRuntimePin(state(), null)).toBeNull();
  });

  it("returns null when the owning binding is no longer open", () => {
    const s = state({ openBindings: [machineA] });
    expect(resolveChatRuntimePin(s, "lane-b1")).toBeNull();
  });

  it("still pins when there is no active binding at all", () => {
    const s = state({ activeBinding: null });
    expect(resolveChatRuntimePin(s, "lane-b1")).toEqual(machineB);
    expect(resolveChatRuntimePin(s, "lane-a1")).toEqual(machineA);
  });
});

describe("isLivePinnedBinding", () => {
  it("accepts an absent pin", () => {
    expect(isLivePinnedBinding(null, [machineA])).toBe(true);
    expect(isLivePinnedBinding(undefined, [])).toBe(true);
  });

  it("accepts a foreign-but-open pin — the normal state under per-chat routing", () => {
    // The old `pin.key === activeBinding.key` guard would have dropped this.
    expect(isLivePinnedBinding(machineB, [machineA, machineB])).toBe(true);
  });

  it("rejects a pin whose binding is no longer open", () => {
    expect(isLivePinnedBinding(machineB, [machineA])).toBe(false);
  });
});

describe("createChatMachineRouter", () => {
  it("memoizes per-lane resolution and returns a stable pin instance", () => {
    const router = createChatMachineRouter(state());
    const first = router.pinForLane("lane-b1");
    const second = router.pinForLane("lane-b1");
    expect(first).toBe(machineB);
    expect(second).toBe(first);
    expect(router.pinForLane("lane-a1")).toBeNull();
    expect(router.pinForLane(null)).toBeNull();
  });

  it("exposes the corrected live-pin predicate over its own open bindings", () => {
    const router = createChatMachineRouter(state({ openBindings: [machineA] }));
    expect(router.isLivePin(machineA)).toBe(true);
    expect(router.isLivePin(machineB)).toBe(false);
  });
});
