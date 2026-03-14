import type {
  AutomationIngressStatus,
  NightShiftQueueMutationRequest,
  NightShiftState,
} from "../../../shared/types";

/** Shared constants and utilities for the automations UI. */

/** Standard inline styles for text inputs, selects, and textareas. */
export const INPUT_CLS = "h-8 w-full px-3 text-xs text-[#FAFAFA] placeholder:text-[#71717A50] font-mono";
export const INPUT_STYLE: React.CSSProperties = { background: "#0B0A0F", border: "1px solid #2D284080" };

/** Standard elevated card shadow used across automation panels. */
export const CARD_SHADOW_STYLE: React.CSSProperties = {
  background: "#181423",
  border: "1px solid #2D2840",
  boxShadow: "0 1px 6px -1px rgba(0,0,0,0.6), 0 0 0 1px rgba(45,40,64,0.3)",
};

/** Extract a human-readable error message from an unknown thrown value. */
export function extractError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type AutomationsRendererBridge = Omit<typeof window.ade.automations, "getIngressStatus" | "mutateNightShiftQueue"> & {
  getIngressStatus?: () => Promise<AutomationIngressStatus>;
  mutateNightShiftQueue?: (args: NightShiftQueueMutationRequest) => Promise<NightShiftState>;
};

export function getAutomationsBridge(): AutomationsRendererBridge {
  return window.ade.automations as AutomationsRendererBridge;
}
