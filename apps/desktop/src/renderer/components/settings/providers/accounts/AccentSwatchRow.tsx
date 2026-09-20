/**
 * Pick the colour that tells two accounts apart.
 *
 * Eight fixed swatches plus a hex field, shared by the add-account sheet and
 * the row menu's "Change accent" so the two can never offer different palettes.
 * The hex field commits only on a valid `#rrggbb` — the store rejects anything
 * else, and a control that silently discards what you typed is worse than one
 * that visibly waits for the sixth character.
 */
import React, { useEffect, useState } from "react";
import { Check } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT } from "../../../lanes/laneDesignTokens";
import { PROVIDER_INSTANCE_ACCENT_PATTERN } from "../../../../../shared/types/providerInstances";
import { ACCOUNT_ACCENT_SWATCHES, accentTint } from "./accountPresentation";

export function AccentSwatchRow({
  value,
  onChange,
  label = "Accent",
}: {
  value: string | null;
  onChange: (accent: string | null) => void;
  label?: string;
}) {
  const [hex, setHex] = useState(value ?? "");

  useEffect(() => {
    setHex(value ?? "");
  }, [value]);

  const commitHex = (next: string) => {
    setHex(next);
    const trimmed = next.trim();
    if (!trimmed) {
      onChange(null);
      return;
    }
    if (PROVIDER_INSTANCE_ACCENT_PATTERN.test(trimmed)) onChange(trimmed.toLowerCase());
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>{label}</div>
      <div role="group" aria-label={label} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {ACCOUNT_ACCENT_SWATCHES.map((swatch) => {
          const selected = value?.toLowerCase() === swatch;
          return (
            <button
              key={swatch}
              type="button"
              aria-label={`Accent ${swatch}`}
              aria-pressed={selected}
              onClick={() => onChange(swatch)}
              style={{
                width: 20,
                height: 20,
                padding: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                background: accentTint(swatch, 78),
                border: `1px solid ${selected ? swatch : accentTint(swatch, 40)}`,
                borderRadius: 6,
                color: COLORS.pageBg,
              }}
            >
              {selected ? <Check size={11} weight="bold" /> : null}
            </button>
          );
        })}
        <input
          aria-label={`${label} hex`}
          value={hex}
          placeholder="#rrggbb"
          onChange={(event) => commitHex(event.target.value)}
          style={{
            width: 88,
            height: 22,
            padding: "0 6px",
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: COLORS.textPrimary,
            background: COLORS.cardBg,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            outline: "none",
          }}
        />
      </div>
    </div>
  );
}
