import React from "react";

import {
  COLORS,
  FONT_SIZES,
  SANS_FONT,
  SPACING,
  dangerButton,
  outlineButton,
  primaryButton,
} from "../../lanes/laneDesignTokens";
import {
  PLUGIN_WEBVIEW_CONFIRM_BODY_MAX_CHARS,
  PLUGIN_WEBVIEW_CONFIRM_TITLE_MAX_CHARS,
} from "../../../../shared/plugins/webviewBridge";
import {
  settlePluginWebviewConfirm,
  usePluginWebviewConfirm,
} from "./pluginWebviewConfirmStore";

/**
 * The yes/no a plugin page asks through `ui.confirm`.
 *
 * Mounted once in `AppShell`. It has to sit above the guest rather than inside
 * it, which is the whole reason the verb exists: a page CAN draw its own dialog,
 * but a page's dialog is drawn inside the page's own box, so a confirm in a
 * 520-pixel popover would be a modal the reader can scroll away from. This one
 * covers the window the way ADE's own do.
 *
 * ## Every path settles
 *
 * Confirm, cancel, Escape and a click outside all call
 * {@link settlePluginWebviewConfirm}, which answers the page exactly once. A
 * dismissal is `false` — the reader did not say yes — and never "no answer",
 * because on the other end is a promise main will hold for ten minutes.
 *
 * ## The plugin's name is on it
 *
 * A page's question drawn in ADE's own chrome, with no attribution, is a
 * question the reader would reasonably read as ADE's. The plugin's name above
 * the title is what keeps a plugin from borrowing the product's voice for a
 * decision it wants made.
 */
export function PluginWebviewConfirmHost() {
  const request = usePluginWebviewConfirm();
  const token = request?.token ?? null;

  React.useEffect(() => {
    if (token === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      settlePluginWebviewConfirm(false, token);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [token]);

  if (!request) return null;

  const { confirm } = request;
  // Re-clipped here as well as in main. The ceilings are the page's contract and
  // main enforces them, but this component is what the reader actually sees, and
  // a card that can be stretched off screen by a long line is worth one slice.
  const title = String(confirm.title ?? "").slice(0, PLUGIN_WEBVIEW_CONFIRM_TITLE_MAX_CHARS);
  const body = confirm.body
    ? String(confirm.body).slice(0, PLUGIN_WEBVIEW_CONFIRM_BODY_MAX_CHARS)
    : null;
  const confirmLabel = confirm.confirmLabel?.slice(0, 32) || "Confirm";
  const cancelLabel = confirm.cancelLabel?.slice(0, 32) || "Cancel";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1400,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
      }}
      onMouseDown={() => settlePluginWebviewConfirm(false, request.token)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-plugin-webview-confirm={request.pluginId}
        style={{
          width: "min(420px, 88vw)",
          borderRadius: 10,
          border: `1px solid ${COLORS.outlineBorder}`,
          background: COLORS.cardBgSolid,
          boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
          fontFamily: SANS_FONT,
          padding: SPACING.lg,
          display: "flex",
          flexDirection: "column",
          gap: SPACING.sm,
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span style={{ fontSize: FONT_SIZES.sm, color: COLORS.textDim }}>
          {request.displayName}
        </span>
        <strong style={{ fontSize: 14, color: COLORS.textPrimary, fontWeight: 600 }}>
          {title}
        </strong>
        {body ? (
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: COLORS.textSecondary }}>
            {body}
          </p>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: SPACING.sm }}>
          <button
            type="button"
            onClick={() => settlePluginWebviewConfirm(false, request.token)}
            style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => settlePluginWebviewConfirm(true, request.token)}
            // The destructive tint is the plugin's own word about the action
            // and costs the host nothing to honour: the reader is about to
            // approve something, and "delete" should not look like "save".
            style={(confirm.destructive ? dangerButton : primaryButton)({
              height: 28,
              padding: "0 12px",
              fontSize: 12,
            })}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PluginWebviewConfirmHost;
