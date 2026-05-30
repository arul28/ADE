import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";

/**
 * designKit — the shared visual vocabulary for the ADE TUI.
 *
 * Every pane composes these primitives so the whole client reads as one
 * designed product: the same titled-card section headers, the same status
 * glyphs/colors, the same labeled chips, the same hairline rules and key-hint
 * footers. Colors come exclusively from theme.ts tokens.
 *
 * Color discipline (the user is firm): violet (#A78BFA) is the brand accent and
 * selection color; neutral tokens for borders/secondary text; amber for
 * attention/awaiting. GREEN is reserved for two semantic signals only — a
 * running spinner, and a success ✓/● glyph (matching Claude Code) — NEVER for
 * borders, bars, fills, or idle chrome, where it reads as a glitch.
 *
 * All primitives are pure/cheap (no state, no effects) so they never add idle
 * re-renders.
 */

// ── Rules & dividers ───────────────────────────────────────────────────────

/** A hairline rule that fills `width` columns. */
export function Rule({ width, color = theme.color.borderSoft }: { width: number; color?: string }) {
  return <Text color={color}>{"─".repeat(Math.max(0, Math.floor(width)))}</Text>;
}

// ── Section headers ──────────────────────────────────────────────────────────

/**
 * Titled-card section header: optional glyph + bold title, a hairline rule that
 * fills the gap, and a right-aligned dim hint. The signature look that ties the
 * panes together.
 */
export function SectionHeader({
  title,
  hint,
  color = theme.color.violet,
  glyph,
  width,
  marginTop = 1,
}: {
  title: string;
  hint?: string;
  color?: string;
  glyph?: string;
  width: number;
  marginTop?: number;
}) {
  const inner = Math.max(8, Math.floor(width));
  const used = (glyph ? glyph.length + 1 : 0) + title.length + 2 + (hint ? hint.length + 1 : 0);
  const ruleLen = Math.max(1, inner - used);
  return (
    <Box flexDirection="row" marginTop={marginTop}>
      {glyph ? <Text color={color}>{`${glyph} `}</Text> : null}
      <Text bold color={color}>{title}</Text>
      <Text color={theme.color.borderSoft}>{` ${"─".repeat(ruleLen)}${hint ? " " : ""}`}</Text>
      {hint ? <Text color={theme.color.t4} dimColor>{hint}</Text> : null}
    </Box>
  );
}

// ── Status glyphs ────────────────────────────────────────────────────────────

export type StatusKind = "live" | "idle" | "done" | "failed" | "pending" | "info" | "warn";

const STATUS_GLYPH: Record<StatusKind, { glyph: string; color: string }> = {
  // Green only here for the two allowed semantic signals (live + done).
  live: { glyph: "●", color: theme.color.running },
  done: { glyph: "✓", color: theme.color.done },
  failed: { glyph: "✗", color: theme.color.error },
  pending: { glyph: "◔", color: theme.color.attention },
  warn: { glyph: "▲", color: theme.color.warning },
  info: { glyph: "●", color: theme.color.info },
  idle: { glyph: "○", color: theme.color.t4 },
};

export function statusGlyph(kind: StatusKind): { glyph: string; color: string } {
  return STATUS_GLYPH[kind];
}

/** A colored status dot + optional label, e.g. `● live`, `✓ passing`. */
export function StatusDot({ kind, label, bold }: { kind: StatusKind; label?: string; bold?: boolean }) {
  const s = STATUS_GLYPH[kind];
  return (
    <Text color={s.color} bold={bold}>
      {s.glyph}
      {label ? ` ${label}` : ""}
    </Text>
  );
}

// ── Chips ────────────────────────────────────────────────────────────────────

/** A labeled value chip: dim label + colored value. `label value`. */
export function Chip({
  label,
  value,
  valueColor = theme.color.t2,
  active,
}: {
  label?: string;
  value: string;
  valueColor?: string;
  active?: boolean;
}) {
  return (
    <Text>
      {label ? <Text color={theme.color.t4} dimColor>{`${label} `}</Text> : null}
      <Text color={active ? theme.color.violet : valueColor} bold={active}>{value}</Text>
    </Text>
  );
}

/** A bracketed pill — used for primary actions/buttons. */
export function Pill({ label, active, disabled }: { label: string; active?: boolean; disabled?: boolean }) {
  const color = disabled ? theme.color.t5 : active ? theme.color.violet : theme.color.violetDeep;
  return <Text color={color} bold={active}>{`[ ${label} ]`}</Text>;
}

// ── Selection rail ───────────────────────────────────────────────────────────

/** The leading violet rail glyph shown on a selected/focused row (else a space). */
export function Rail({ on }: { on: boolean }) {
  return <Text color={on ? theme.color.violet : theme.color.t5}>{on ? theme.rail : " "}</Text>;
}

// ── Key-hints footer ─────────────────────────────────────────────────────────

/** Dim key-hint footer: `key action · key action · …` with keys in accent. */
export function KeyHints({ items, marginTop = 1 }: { items: Array<[string, string]>; marginTop?: number }) {
  return (
    <Box marginTop={marginTop}>
      <Text wrap="truncate-end">
        {items.map(([key, action], index) => (
          <Text key={`${key}:${action}`}>
            {index > 0 ? <Text color={theme.color.t5} dimColor>{"  ·  "}</Text> : null}
            <Text color={theme.color.accent}>{key}</Text>
            <Text color={theme.color.t4} dimColor>{` ${action}`}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}
