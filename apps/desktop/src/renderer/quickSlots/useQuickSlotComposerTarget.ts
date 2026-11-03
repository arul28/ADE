import { useEffect, useId, useRef } from "react";
import type {
  AgentChatClaudePermissionMode,
  AgentChatCursorConfigOption,
  AgentChatCursorModeSnapshot,
  AgentChatDroidPermissionMode,
  AgentChatInteractionMode,
  AgentChatMusePermissionMode,
  AgentChatOpenCodePermissionMode,
  AgentChatStopMode,
} from "../../shared/types";
import type { FastTier } from "../../shared/modelRegistry";
import { resolveModelDescriptorWithRuntimeCatalog } from "../components/shared/ModelPicker/modelCatalog";
import { resolveDisplayedReasoningEffort } from "../components/shared/ModelPicker/ReasoningEffortPicker";
import {
  CLAUDE_MODE_OPTIONS,
  COPILOT_PERMISSION_OPTIONS,
  DROID_PERMISSION_OPTIONS,
  MUSE_PERMISSION_OPTIONS,
  OPENCODE_PERMISSION_OPTIONS,
  type CodexPermissionPreset,
} from "../components/shared/permissionModePickerOptions";
import { registerQuickSlotComposer, unregisterQuickSlotComposer, type QuickSlotComposerSnapshot } from "./composerTarget";

type CopilotPermissionMode = "plan" | "ask" | "assisted" | "auto-edit" | "full-auto";
type CodexPreset = Exclude<CodexPermissionPreset, "custom">;

/**
 * What the composer knows right now, handed over on every render. The target
 * reads it at call time, so a slot never acts on a model from an older render.
 */
export type QuickSlotComposerState = {
  sessionId: string | null;
  laneId: string | null;
  provider: string;
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  fastModeSupported: boolean;
  turnActive: boolean;
  modelSelectionLocked: boolean;
  permissionModeLocked: boolean;
  catalogScopeKey: string;
  interactionMode: AgentChatInteractionMode | null | undefined;
  claudePermissionMode: AgentChatClaudePermissionMode | null | undefined;
  opencodePermissionMode: AgentChatOpenCodePermissionMode | null | undefined;
  droidPermissionMode: AgentChatDroidPermissionMode | null | undefined;
  copilotPermissionMode: CopilotPermissionMode | null | undefined;
  musePermissionMode: AgentChatMusePermissionMode | null | undefined;
  cursorModeSnapshot: AgentChatCursorModeSnapshot | null | undefined;
  cursorModeOption: AgentChatCursorConfigOption | null;
  codexPreset: CodexPermissionPreset;
  onModelChange: (modelId: string) => boolean | void;
  onReasoningEffortChange: (effort: string | null) => void;
  onFastModeChange?: (enabled: boolean, tier?: FastTier) => void;
  onOpenModelPickerRequest?: () => void;
  onInterrupt: (mode?: AgentChatStopMode) => void;
  onClaudeModeChange?: (mode: AgentChatClaudePermissionMode) => void;
  onOpenCodePermissionModeChange?: (mode: AgentChatOpenCodePermissionMode) => void;
  onDroidPermissionModeChange?: (mode: AgentChatDroidPermissionMode) => void;
  onCopilotPermissionModeChange?: (mode: CopilotPermissionMode) => void;
  onMusePermissionModeChange?: (mode: AgentChatMusePermissionMode, interaction: AgentChatInteractionMode) => void;
  onCursorModeChange?: (modeId: string) => void;
  applyCodexPreset: (preset: CodexPreset) => void;
};

/** The composer's editor, for the HUD's anchor and the caret checks. */
export type QuickSlotComposerDom = {
  anchorElement: () => HTMLElement | null;
  hasCaret: () => boolean;
  focus: () => void;
  insertText: (text: string) => void;
};

// The order a permission slot steps through. Each list is the picker's own,
// so a mode added to the picker joins the cycle; plan is a separate toggle
// for Claude, and Muse's plan runs on `denyUnmatched`, so neither is a rung.
const CLAUDE_CYCLE = CLAUDE_MODE_OPTIONS.map((option) => option.value).filter((value) => value !== "plan");
const OPENCODE_CYCLE = OPENCODE_PERMISSION_OPTIONS.map((option) => option.value);
const DROID_CYCLE = DROID_PERMISSION_OPTIONS.map((option) => option.value);
const COPILOT_CYCLE = COPILOT_PERMISSION_OPTIONS.map((option) => option.value);
const MUSE_CYCLE = MUSE_PERMISSION_OPTIONS.map((option) => option.value).filter((value) => value !== "denyUnmatched");
// Codex's presets come from the runtime; these are the ones a slot steps through.
const CODEX_CYCLE: readonly CodexPreset[] = ["default", "edit", "plan", "full-auto"];

/** One rung up `options` from `value`, clamped at the top; an unknown value starts at the bottom. */
function clampNext<T extends string>(options: readonly T[], value: string | null | undefined): T {
  const index = value ? options.indexOf(value as T) : -1;
  return options[Math.min(options.length - 1, index < 0 ? 0 : index + 1)] ?? options[0]!;
}

function currentPermission(state: QuickSlotComposerState): string | null {
  switch (state.provider) {
    case "claude": return state.interactionMode === "plan" ? "plan" : state.claudePermissionMode ?? "default";
    case "codex": return state.codexPreset;
    case "copilot": return state.copilotPermissionMode ?? null;
    case "droid": return state.droidPermissionMode ?? "auto-low";
    case "muse": return state.interactionMode === "plan" ? "plan" : state.musePermissionMode ?? "onRequest";
    case "cursor": return state.cursorModeSnapshot?.currentModeId ?? null;
    default: return state.opencodePermissionMode ?? "edit";
  }
}

function cyclePermission(state: QuickSlotComposerState): { from: string; to: string } | null {
  switch (state.provider) {
    case "claude": {
      const from = state.interactionMode === "plan" ? "plan" : state.claudePermissionMode ?? "default";
      const to = from === "plan" ? "default" : clampNext(CLAUDE_CYCLE, from);
      if (to !== from) state.onClaudeModeChange?.(to);
      return { from, to };
    }
    case "opencode": {
      const from = state.opencodePermissionMode ?? "edit";
      const to = clampNext(OPENCODE_CYCLE, from);
      if (to !== from) state.onOpenCodePermissionModeChange?.(to);
      return { from, to };
    }
    case "droid": {
      const from = state.droidPermissionMode ?? "auto-low";
      const to = clampNext(DROID_CYCLE, from);
      if (to !== from) state.onDroidPermissionModeChange?.(to);
      return { from, to };
    }
    case "copilot": {
      const from = state.copilotPermissionMode ?? "ask";
      const to = clampNext(COPILOT_CYCLE, from);
      if (to !== from) state.onCopilotPermissionModeChange?.(to);
      return { from, to };
    }
    case "muse": {
      const from = state.interactionMode === "plan" ? "plan" : state.musePermissionMode ?? "onRequest";
      const to = from === "plan" ? "promptUnmatched" : clampNext(MUSE_CYCLE, from);
      if (to === from) return { from, to };
      if (to === "plan") state.onMusePermissionModeChange?.("denyUnmatched", "plan");
      else state.onMusePermissionModeChange?.(to as AgentChatMusePermissionMode, "default");
      return { from, to };
    }
    case "codex": {
      const from = state.codexPreset;
      const to = clampNext(CODEX_CYCLE, from);
      if (to !== from) state.applyCodexPreset(to);
      return { from, to };
    }
    case "cursor": {
      const option = state.cursorModeOption;
      const values = option?.options?.map((entry) => entry.value) ?? state.cursorModeSnapshot?.availableModeIds ?? [];
      if (!values.length) return null;
      const rawCurrent = option?.currentValue;
      const from = (typeof rawCurrent === "string" ? rawCurrent.trim() : "")
        || state.cursorModeSnapshot?.currentModeId
        || values[0]!;
      const to = clampNext(values, from);
      if (to !== from) state.onCursorModeChange?.(to);
      return { from, to };
    }
    default:
      return null;
  }
}

/**
 * Publish this composer as the one Quick slots act on, while it is the active
 * tile. The dispatcher runs from a window keydown, outside React, so it reaches
 * the composer through `composerTarget`'s registry. Registration is keyed on
 * "is this composer on screen" only; every value is read through a ref, so
 * typing never re-registers.
 */
export function useQuickSlotComposerTarget(
  active: boolean,
  state: QuickSlotComposerState,
  dom: QuickSlotComposerDom,
): void {
  const id = useId();
  const stateRef = useRef(state);
  stateRef.current = state;
  const domRef = useRef(dom);
  domRef.current = dom;

  useEffect(() => {
    if (!active) return undefined;
    registerQuickSlotComposer({
      id,
      anchorElement: () => domRef.current.anchorElement(),
      hasCaret: () => domRef.current.hasCaret(),
      focus: () => domRef.current.focus(),
      insertText: (text) => domRef.current.insertText(text),
      getSnapshot: (): QuickSlotComposerSnapshot => {
        const current = stateRef.current;
        return {
          sessionId: current.sessionId,
          laneId: current.laneId,
          provider: current.provider,
          modelId: current.modelId || null,
          reasoningEffort: current.reasoningEffort,
          permission: currentPermission(current),
          fastMode: current.fastMode,
          fastModeSupported: current.fastModeSupported,
          turnActive: current.turnActive,
          modelLocked: current.modelSelectionLocked || current.turnActive,
          permissionLocked: current.permissionModeLocked,
        };
      },
      setModel: (modelId) => {
        const current = stateRef.current;
        if (current.modelSelectionLocked || current.turnActive) return false;
        return current.onModelChange(modelId) !== false;
      },
      setReasoningEffort: (effort) => stateRef.current.onReasoningEffortChange(effort),
      cycleReasoningEffort: (direction = 1) => {
        const current = stateRef.current;
        const descriptor = resolveModelDescriptorWithRuntimeCatalog(current.modelId, current.catalogScopeKey);
        const tiers = descriptor?.reasoningTiers ?? [];
        if (!tiers.length) return null;
        const displayed = resolveDisplayedReasoningEffort({
          tiers,
          explicitEffort: current.reasoningEffort,
          rememberedForFamily: null,
          modelDefault: descriptor?.defaultReasoningEffort ?? null,
        });
        const index = displayed ? tiers.indexOf(displayed) : -1;
        // "Auto" (no level) sits before the first tier: up from it is the
        // first tier, and down from it stays at the first tier.
        const target = index < 0 ? 0 : index + direction;
        const next = tiers[Math.max(0, Math.min(tiers.length - 1, target))] ?? null;
        if (next === displayed) return { from: displayed, to: displayed };
        current.onReasoningEffortChange(next);
        return { from: displayed, to: next };
      },
      cyclePermission: () => cyclePermission(stateRef.current),
      toggleFast: () => {
        const current = stateRef.current;
        if (!current.fastModeSupported || !current.onFastModeChange || current.modelSelectionLocked) return false;
        current.onFastModeChange(!current.fastMode);
        return true;
      },
      openModelPicker: () => stateRef.current.onOpenModelPickerRequest?.(),
      stopTurn: () => stateRef.current.onInterrupt("stop_and_clear"),
    });
    return () => unregisterQuickSlotComposer(id);
  }, [active, id]);
}
