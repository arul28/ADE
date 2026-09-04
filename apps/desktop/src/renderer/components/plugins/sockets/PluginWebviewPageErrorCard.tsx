import React from "react";

import { COLORS, FONT_SIZES, SANS_FONT, SPACING, outlineButton } from "../../lanes/laneDesignTokens";

/**
 * What a plugin page draws when it throws or fails to load.
 *
 * The plugin's name is the title so a broken guest is not an anonymous ADE
 * error. Reload recreates the guest; Open logs is the plugin's own log, not
 * ADE's.
 */
export function PluginWebviewPageErrorCard({
  pluginName,
  message,
  onReload,
  onOpenLogs,
}: {
  pluginName: string;
  message: string;
  onReload: () => void;
  onOpenLogs: () => void;
}) {
  return (
    <div
      role="alert"
      data-plugin-webview-page-error
      style={{
        display: "grid",
        gap: 10,
        maxWidth: 420,
        fontFamily: SANS_FONT,
      }}
    >
      <strong style={{ fontSize: 14, color: COLORS.textPrimary, fontWeight: 600 }}>
        {pluginName}
      </strong>
      <p style={{ margin: 0, fontSize: FONT_SIZES.sm, lineHeight: 1.5, color: COLORS.textSecondary }}>
        {message}
      </p>
        <div style={{ display: "flex", gap: 8, marginTop: SPACING.sm }}>
        <button
          type="button"
          onClick={onReload}
          style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
        >
          Reload
        </button>
        <button
          type="button"
          onClick={onOpenLogs}
          style={{
            ...outlineButton({ height: 28, padding: "0 10px", fontSize: 11 }),
            background: "transparent",
            border: "1px solid transparent",
            color: COLORS.textMuted,
          }}
        >
          Open logs
        </button>
      </div>
    </div>
  );
}

export default PluginWebviewPageErrorCard;
