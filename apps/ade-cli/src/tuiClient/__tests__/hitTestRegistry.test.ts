import { describe, expect, it, vi } from "vitest";
import { createHitTestRegistry } from "../hitTestRegistry";

describe("hit test registry", () => {
  it("finds registered targets and unregisters by id", () => {
    const registry = createHitTestRegistry();
    registry.register({ id: "one", rect: { x: 2, y: 3, w: 4, h: 2 } });

    expect(registry.hitTest(2, 3)?.id).toBe("one");
    expect(registry.hitTest(5, 4)?.id).toBe("one");
    expect(registry.hitTest(6, 4)).toBeNull();

    registry.unregister("one");
    expect(registry.hitTest(2, 3)).toBeNull();
  });

  it("lets higher z-index targets win overlapping cells", () => {
    const registry = createHitTestRegistry();
    registry.register({ id: "base", rect: { x: 1, y: 1, w: 10, h: 5 }, zIndex: 1 });
    registry.register({ id: "top", rect: { x: 3, y: 2, w: 4, h: 2 }, zIndex: 10 });

    expect(registry.hitTest(4, 3)?.id).toBe("top");
    expect(registry.hitTest(9, 3)?.id).toBe("base");
  });

  it("replaces duplicate ids instead of accumulating stale targets", () => {
    const registry = createHitTestRegistry();
    const onClick = vi.fn();
    registry.register({ id: "same", rect: { x: 1, y: 1, w: 2, h: 2 } });
    registry.register({ id: "same", rect: { x: 5, y: 5, w: 2, h: 2 }, onClick });

    expect(registry.hitTest(1, 1)).toBeNull();
    expect(registry.hitTest(5, 5)?.onClick).toBe(onClick);
  });
});
