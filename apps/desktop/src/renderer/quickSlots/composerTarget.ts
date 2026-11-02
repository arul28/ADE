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
  /** One notch up the model's own tier list, clamped at the top. */
  cycleReasoningEffort: () => { from: string | null; to: string | null } | null;
  /** One rung up the provider's permission list. Null when the harness has none. */
  cyclePermission: () => { from: string; to: string } | null;
  /** False when the model does not offer a fast tier. */
  toggleFast: () => boolean;
  openModelPicker: () => void;
  /** Stop the running turn (the composer's own Stop action). */
  stopTurn: () => void;
};

let current: QuickSlotComposerTarget | null = null;

export function registerQuickSlotComposer(target: QuickSlotComposerTarget): void {
  current = target;
}

export function unregisterQuickSlotComposer(id: string): void {
  if (current?.id === id) current = null;
}

export function getQuickSlotComposer(): QuickSlotComposerTarget | null {
  return current;
}
