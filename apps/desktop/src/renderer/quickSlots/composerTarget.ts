import { isInParkedSurface } from "../lib/parkedSurface";

/**
 * The composer a quick slot acts on.
 *
 * One registry, module-level by design (the same pattern the handoff intents
 * use): the dispatcher runs from a window keydown, outside React, and only the
 * composer that is actually on screen should answer. `AgentChatComposer`
 * registers while its pane is the active tile; every function reads the props
 * at call time, so the target never holds a stale model or draft.
 */
export type QuickSlotComposerSnapshot = {
  sessionId: string | null;
  /** The chat's lane, so lane slots can follow the chat rather than the sidebar. */
  laneId: string | null;
  provider: string | null;
  modelId: string | null;
  reasoningEffort: string | null;
  /** The provider's own permission word, when the composer has one. */
  permission: string | null;
  fastMode: boolean;
  fastModeSupported: boolean;
  /** A turn is running in this chat. */
  turnActive: boolean;
  /** Model controls are locked (a turn is running, the route is persistent, …). */
  modelLocked: boolean;
  /** Permission controls are locked (identity session, project transition, …). */
  permissionLocked: boolean;
};

export type QuickSlotComposerTarget = {
  /** Stable id for safe deregistration when a newer composer takes over. */
  id: string;
  /** The composer's dock element, so the HUD anchors over the active tile. */
  anchorElement: () => HTMLElement | null;
  /** True when the caret is inside this composer's editor right now. */
  hasCaret: () => boolean;
  focus: () => void;
  insertText: (text: string) => void;
  getSnapshot: () => QuickSlotComposerSnapshot;
  /** Apply a model id; returns false when the picker would refuse it. */
  setModel: (modelId: string) => boolean;
  setReasoningEffort: (effort: string | null) => void;
  /** One notch along the model's own tier list, clamped at either end. */
  cycleReasoningEffort: (direction?: 1 | -1) => { from: string | null; to: string | null } | null;
  /** One rung up the provider's permission list. Null when the harness has none. */
  cyclePermission: () => { from: string; to: string } | null;
  /** False when the model does not offer a fast tier. */
  toggleFast: () => boolean;
  openModelPicker: () => void;
  /** Stop the running turn (the composer's own Stop action). */
  stopTurn: () => void;
};

/**
 * Every composer that says it is its tile's active one, newest last. A Work
 * page can stay mounted while another page or project tab shows, so several
 * can be registered at once; only one the user can see may answer.
 */
const targets: QuickSlotComposerTarget[] = [];

export function registerQuickSlotComposer(target: QuickSlotComposerTarget): void {
  unregisterQuickSlotComposer(target.id);
  targets.push(target);
}

export function unregisterQuickSlotComposer(id: string): void {
  const index = targets.findIndex((target) => target.id === id);
  if (index >= 0) targets.splice(index, 1);
}

/** The newest registered composer that is on screen, or null when none is. */
export function getQuickSlotComposer(): QuickSlotComposerTarget | null {
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const target = targets[index]!;
    const anchor = target.anchorElement();
    // A parked surface (another page or project tab is showing) keeps its
    // layout, so only its parked marker says the user cannot see it.
    if (anchor && anchor.getClientRects().length > 0 && !isInParkedSurface(anchor)) return target;
  }
  return null;
}
