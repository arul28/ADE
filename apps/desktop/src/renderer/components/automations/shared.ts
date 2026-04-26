/** Shared utilities for the automations UI. */

import type React from "react";
import { inputCls } from "../cto/shared/designTokens";

/**
 * Legacy aliases. Existing automation call sites use these names; they now
 * resolve to the shared CTO design tokens so chrome, focus rings, and accent
 * colors match the rest of the app. Prefer `./designTokens` in new code.
 */
export const INPUT_CLS = inputCls;
export const INPUT_STYLE: React.CSSProperties = {};
export const CARD_STYLE: React.CSSProperties = {};

export const CARD_SHADOW_STYLE = CARD_STYLE;

/** Extract a human-readable error message from an unknown thrown value. */
export function extractError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function getAutomationsBridge() {
  return window.ade.automations;
}
