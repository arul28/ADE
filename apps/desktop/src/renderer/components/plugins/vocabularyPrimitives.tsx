import { WarningCircle } from "@phosphor-icons/react";

import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import type { PluginCollectionRow } from "../../lib/pluginRuntimeBridge";
import type { VocabAction, VocabTone } from "../../../shared/plugins/vocabulary";

/**
 * What every vocabulary leaf renderer shares: the render context it is handed,
 * and the three small pieces more than one of them draws.
 *
 * A leaf module rather than part of `vocabularyComponents`: the chart and the
 * form live in their own files and both need these, and importing them back out
 * of the module that re-exports those components would be an import cycle.
 */

/** Merged into an action's own args when a form submits. */
export type VocabActionArgs = Record<string, string | number | boolean>;

export type VocabDispatch = (action: VocabAction, extraArgs?: VocabActionArgs) => Promise<void>;

export type VocabRenderContext = {
  pluginId: string;
  /** Rows already fetched for every binding in the panel, keyed by `bindingKey`. */
  rowsByBinding: ReadonlyMap<string, PluginCollectionRow[]>;
  dispatch: VocabDispatch;
  /**
   * False while the hosting surface is mounted but not visible. Media does not
   * load and animation does not run when false — the hidden-but-mounted perf law.
   */
  active: boolean;
};

export const TONE_COLOR: Record<VocabTone, string> = {
  neutral: COLORS.textMuted,
  accent: COLORS.accent,
  success: COLORS.success,
  warning: COLORS.warning,
};

/** "Nothing here yet" at the size of the component it replaces. */
export function EmptyLine({ text }: { text: string }) {
  return (
    <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>{text}</p>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: SANS_FONT,
        fontSize: 11,
        color: COLORS.warning,
      }}
    >
      <WarningCircle size={12} weight="regular" aria-hidden />
      {message}
    </span>
  );
}
