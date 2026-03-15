/** Shared constants and utilities for the automations UI. */

/** Standard inline styles for text inputs, selects, and textareas. */
export const INPUT_CLS = "h-9 w-full rounded-md px-3 text-xs text-[#F5F7FA] placeholder:text-[#7E8A9A] font-mono";
export const INPUT_STYLE: React.CSSProperties = {
  background: "rgba(7, 15, 24, 0.82)",
  border: "1px solid rgba(74, 99, 122, 0.42)",
};

/** Standard elevated card style used across automation panels. */
export const CARD_STYLE: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(20, 31, 45, 0.96) 0%, rgba(10, 18, 28, 0.94) 100%)",
  border: "1px solid rgba(87, 108, 128, 0.22)",
  boxShadow: "0 18px 40px -24px rgba(0, 0, 0, 0.78), inset 0 1px 0 rgba(255,255,255,0.04)",
};

export const CARD_SHADOW_STYLE = CARD_STYLE;

/** Extract a human-readable error message from an unknown thrown value. */
export function extractError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function getAutomationsBridge() {
  return window.ade.automations;
}
