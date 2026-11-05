import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { HelpHint as BaseHelpHint } from "../../ui/HelpHint";

/**
 * A "?" beside a settings title, with one short sentence behind it.
 *
 * Settings pages kept explaining themselves in a paragraph under the heading.
 * Two sentences of prose at the top of a page is the first thing the eye lands
 * on and the last thing anyone reads twice — and once a page has one, every
 * page grows one. The explanation still exists; it just waits to be asked for.
 * The behavior is `ui/HelpHint`; this is its settings look.
 */
export function HelpHint({ text, label = "What is this?" }: { text: string; label?: string }) {
  return (
    <span style={{ display: "inline-flex" }}>
      <BaseHelpHint
        text={text}
        label={label}
        side="bottom"
        triggerStyle={(open) => ({
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 15,
          height: 15,
          padding: 0,
          borderRadius: "50%",
          border: `1px solid ${COLORS.outlineBorder}`,
          background: "transparent",
          color: open ? COLORS.textPrimary : COLORS.textDim,
          fontFamily: SANS_FONT,
          fontSize: 9.5,
          fontWeight: 700,
          lineHeight: 1,
          cursor: "help",
        })}
        tooltipStyle={{
          width: 248,
          padding: "7px 9px",
          borderRadius: 8,
          border: `1px solid ${COLORS.outlineBorder}`,
          background: "var(--color-surface-raised, var(--color-card))",
          boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
          fontFamily: SANS_FONT,
          fontSize: 11,
          lineHeight: 1.5,
          color: COLORS.textSecondary,
        }}
      />
    </span>
  );
}
