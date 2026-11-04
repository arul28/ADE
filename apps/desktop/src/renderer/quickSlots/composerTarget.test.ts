import { describe, expect, it } from "vitest";
import {
  getQuickSlotComposer,
  registerQuickSlotComposer,
  unregisterQuickSlotComposer,
  type QuickSlotComposerTarget,
} from "./composerTarget";

/** A composer dock as the registry sees it: on screen or not, parked or not. */
function dock(state: { onScreen: boolean; parked?: boolean }): HTMLElement {
  return {
    getClientRects: () => ({ length: state.onScreen ? 1 : 0 }),
    closest: (selector: string) => (state.parked && selector.includes("data-ade-surface-hidden") ? {} : null),
  } as unknown as HTMLElement;
}

function composer(id: string, anchor: HTMLElement): QuickSlotComposerTarget {
  return { id, anchorElement: () => anchor } as unknown as QuickSlotComposerTarget;
}

describe("Quick slots composer registry", () => {
  // A Quick slot can change a chat's model, stop its turn or push its lane, so
  // it must only ever reach a composer the user can see. Work pages and other
  // project tabs stay mounted (parked) while another page shows.
  it("answers with the newest composer on screen, never a hidden or parked one", () => {
    const visible = composer("visible", dock({ onScreen: true }));
    const parked = composer("parked", dock({ onScreen: true, parked: true }));
    const offscreen = composer("offscreen", dock({ onScreen: false }));

    registerQuickSlotComposer(visible);
    registerQuickSlotComposer(parked);
    registerQuickSlotComposer(offscreen);
    expect(getQuickSlotComposer()?.id).toBe("visible");

    const newer = composer("newer", dock({ onScreen: true }));
    registerQuickSlotComposer(newer);
    expect(getQuickSlotComposer()?.id).toBe("newer");

    unregisterQuickSlotComposer("newer");
    expect(getQuickSlotComposer()?.id).toBe("visible");

    unregisterQuickSlotComposer("visible");
    expect(getQuickSlotComposer()).toBeNull();

    unregisterQuickSlotComposer("parked");
    unregisterQuickSlotComposer("offscreen");
  });
});
