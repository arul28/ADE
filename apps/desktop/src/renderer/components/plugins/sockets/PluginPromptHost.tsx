import React from "react";

import { COLORS, FONT_SIZES, SANS_FONT, SPACING } from "../../lanes/laneDesignTokens";
import { useRootAppStore } from "../../../state/appStore";
import {
  PLUGIN_PROMPT_TEXT_MAX_BYTES,
  pluginUtf8ByteLength,
} from "../../../../shared/plugins/sdk";
import {
  closePluginPrompt,
  submitPluginPrompt,
  usePluginPrompt,
  type PluginPromptAnchor,
} from "./pluginPromptStore";

/**
 * The one question a plugin action can put on screen.
 *
 * Mounted once in `AppShell`, it draws whatever `pluginPromptStore` holds: a
 * text field, or a picker when the question carried `options`, at the control
 * that was pressed, with the plugin's own question above it. Enter submits a
 * typed answer, a list row submits its value, Escape and a click outside cancel
 * — and a cancel invokes nothing at all, which is the rule that makes the verb
 * safe to put behind any button.
 *
 * A popover rather than a modal on purpose. The whole reason the verb exists is
 * "a Log it button that saves a one-line note of what I'm doing": taking the
 * reader off what they were doing to type one line is the workaround it
 * replaces, so the answer is typed over the work, next to the button, and the
 * work stays visible behind it.
 *
 * Over the ceiling the submit is REFUSED, not truncated — the field says how
 * far over it is and the button turns off. A note cut in half and then saved is
 * worse than one the reader was asked to shorten.
 */

/** Width of the card, and the margin it keeps from every edge of the window. */
const CARD_WIDTH = 320;
const EDGE_MARGIN = 12;
/** Gap between the pressed control and the card that answers it. */
const ANCHOR_GAP = 8;

/**
 * Where the card sits, given the control it belongs to.
 *
 * Below the control when there is room, above it when there is not, and clamped
 * into the window on both axes — so a button in the last row of a list or hard
 * against the right edge still gets a card the reader can read and type into.
 * Centred when the press had no locatable control at all.
 */
function cardPosition(
  anchor: PluginPromptAnchor | null,
  viewport: { width: number; height: number },
  estimatedHeight: number,
): {
  left: number;
  top: number;
} {
  if (!anchor) {
    return {
      left: Math.max(EDGE_MARGIN, (viewport.width - CARD_WIDTH) / 2),
      top: Math.max(EDGE_MARGIN, (viewport.height - estimatedHeight) / 2),
    };
  }
  const below = anchor.y + anchor.height + ANCHOR_GAP;
  const fitsBelow = below + estimatedHeight + EDGE_MARGIN <= viewport.height;
  const top = fitsBelow ? below : Math.max(EDGE_MARGIN, anchor.y - ANCHOR_GAP - estimatedHeight);
  const preferredLeft = anchor.x + anchor.width / 2 - CARD_WIDTH / 2;
  const left = Math.min(
    Math.max(EDGE_MARGIN, preferredLeft),
    Math.max(EDGE_MARGIN, viewport.width - CARD_WIDTH - EDGE_MARGIN),
  );
  return { left, top };
}

export function PluginPromptHost() {
  const request = usePluginPrompt();
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);
  const [text, setText] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const token = request?.token ?? null;

  // Cleared per question, keyed on the token: a second prompt from the same
  // button must start empty rather than showing the last answer.
  React.useEffect(() => {
    setText("");
  }, [token]);

  React.useEffect(() => {
    if (token === null) return;
    // A frame later, so the field exists and the click that opened it has
    // finished moving focus around.
    const handle = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(handle);
  }, [token]);

  React.useEffect(() => {
    if (token === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePluginPrompt(token);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [token]);

  const overBudget = pluginUtf8ByteLength(text) > PLUGIN_PROMPT_TEXT_MAX_BYTES;

  if (!request) return null;

  const plugin = installedPlugins.find((entry) => entry.pluginId === request.pluginId) ?? null;
  const title = request.prompt.title
    ?? request.fallbackTitle
    ?? plugin?.displayName
    ?? request.pluginId;
  const submitLabel = request.prompt.submitLabel ?? "Save";
  const options = request.prompt.options ?? [];
  // Tall enough for the question plus either a field or a capped list. An
  // estimate rather than a measurement, because the flip decision has to be
  // made before the card has been laid out, and being a few pixels out only
  // shifts a clamp.
  const estimatedHeight = options.length > 0
    ? 96 + Math.min(options.length * 36, 240)
    : 148;
  const position = cardPosition(request.anchor, {
    width: window.innerWidth,
    height: window.innerHeight,
  }, estimatedHeight);

  const cancel = () => closePluginPrompt(request.token);
  const submit = (value = text) => {
    if (pluginUtf8ByteLength(value) > PLUGIN_PROMPT_TEXT_MAX_BYTES) return;
    submitPluginPrompt(value);
  };

  return (
    <div
      // A full-window catcher rather than a modal backdrop: it dims nothing, so
      // the work the reader is describing stays exactly as visible as it was.
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "transparent",
      }}
      onMouseDown={cancel}
    >
      <div
        role="dialog"
        aria-label={title}
        style={{
          position: "absolute",
          left: position.left,
          top: position.top,
          width: CARD_WIDTH,
          padding: SPACING.md,
          borderRadius: 8,
          border: `1px solid ${COLORS.outlineBorder}`,
          background: COLORS.cardBgSolid,
          boxShadow: "0 12px 32px rgba(0,0,0,0.32)",
          fontFamily: SANS_FONT,
          display: "flex",
          flexDirection: "column",
          gap: SPACING.sm,
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div style={{ fontSize: FONT_SIZES.lg, color: COLORS.textPrimary, fontWeight: 500 }}>
          {title}
        </div>
        {plugin ? (
          <div style={{ fontSize: FONT_SIZES.sm, color: COLORS.textMuted }}>
            {`${plugin.displayName} plugin`}
          </div>
        ) : null}
        {options.length > 0 ? (
          <div
            role="listbox"
            aria-label={title}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              maxHeight: 240,
              overflowY: "auto",
            }}
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                onClick={() => submit(option.value)}
                style={{
                  textAlign: "left",
                  padding: `${SPACING.xs}px ${SPACING.sm}px`,
                  borderRadius: 6,
                  border: `1px solid ${COLORS.border}`,
                  background: COLORS.recessedBg,
                  color: COLORS.textPrimary,
                  fontFamily: SANS_FONT,
                  fontSize: FONT_SIZES.base,
                  cursor: "pointer",
                }}
              >
                {option.label ?? option.value}
              </button>
            ))}
          </div>
        ) : (
          <input
            ref={inputRef}
            value={text}
            placeholder={request.prompt.placeholder ?? ""}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
            style={{
              width: "100%",
              padding: `${SPACING.xs}px ${SPACING.sm}px`,
              borderRadius: 6,
              border: `1px solid ${overBudget ? COLORS.danger : COLORS.border}`,
              background: COLORS.recessedBg,
              color: COLORS.textPrimary,
              fontFamily: SANS_FONT,
              fontSize: FONT_SIZES.base,
              outline: "none",
            }}
          />
        )}
        {options.length === 0 && overBudget ? (
          <div style={{ fontSize: FONT_SIZES.sm, color: COLORS.danger }}>
            That is too long to save. Shorten it and try again.
          </div>
        ) : null}
        {options.length === 0 ? (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: SPACING.sm }}>
          <button
            type="button"
            onClick={cancel}
            style={{
              padding: `${SPACING.xs}px ${SPACING.md}px`,
              borderRadius: 6,
              border: `1px solid ${COLORS.border}`,
              background: "transparent",
              color: COLORS.textSecondary,
              fontFamily: SANS_FONT,
              fontSize: FONT_SIZES.base,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submit()}
            disabled={overBudget}
            style={{
              padding: `${SPACING.xs}px ${SPACING.md}px`,
              borderRadius: 6,
              border: `1px solid ${COLORS.accentBorder}`,
              background: overBudget ? COLORS.recessedBg : COLORS.accentSubtle,
              color: overBudget ? COLORS.textMuted : COLORS.textPrimary,
              fontFamily: SANS_FONT,
              fontSize: FONT_SIZES.base,
              cursor: overBudget ? "not-allowed" : "pointer",
            }}
          >
            {submitLabel}
          </button>
        </div>
        ) : (
          <button
            type="button"
            onClick={cancel}
            style={{
              alignSelf: "flex-end",
              padding: `${SPACING.xs}px ${SPACING.md}px`,
              borderRadius: 6,
              border: `1px solid ${COLORS.border}`,
              background: "transparent",
              color: COLORS.textSecondary,
              fontFamily: SANS_FONT,
              fontSize: FONT_SIZES.base,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
