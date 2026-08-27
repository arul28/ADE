import { CheckCircle, WarningCircle } from "@phosphor-icons/react";

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

/**
 * What an action said about how it went, under the panel it was pressed in.
 *
 * iOS and the TUI have shown this since the verb existed — the phone as a
 * coloured banner, the TUI as a notice — while desktop and the web threw the
 * sentence away, so a plugin wrote one line of copy and two of its four clients
 * showed nothing. This is the same banner, with the same tones.
 *
 * `role="status"` rather than `alert`: it reports an outcome the reader asked
 * for by pressing something, so it belongs in the polite queue.
 */
export function PluginActionBanner({ text, ok }: { text: string; ok: boolean }) {
  const color = ok ? COLORS.success : COLORS.warning;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "9px 11px",
        borderRadius: 10,
        // The tone at a tenth, matching `PluginActionMessageView` on iOS.
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        fontFamily: SANS_FONT,
        fontSize: 11,
        color,
      }}
    >
      {ok
        ? <CheckCircle size={13} weight="regular" aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
        : <WarningCircle size={13} weight="regular" aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />}
      <span style={{ minWidth: 0 }}>{text}</span>
    </div>
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
