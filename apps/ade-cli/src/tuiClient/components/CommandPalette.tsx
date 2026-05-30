import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";
import type { AdeCodeProvider } from "../types";

export type CommandPaletteItem = {
  key: string;
  kind: "command" | "lane" | "chat";
  label: string;
  detail: string;
};

// Header + VISIBLE_ROWS body rows + detail line + footer = the reserved height.
// app.tsx windows the list with `COMMAND_PALETTE_ROWS - 3`, so VISIBLE_ROWS must
// stay in lockstep with that subtraction (header + detail + footer = 3 extras).
const VISIBLE_ROWS = 7;
export const COMMAND_PALETTE_ROWS = VISIBLE_ROWS + 3;
const DEFAULT_PALETTE_WIDTH = 92;
const MAX_PALETTE_WIDTH = 112;

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<AdeCodeProvider>([
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
  "ollama",
  "lmstudio",
]);

const KIND_TAG: Record<CommandPaletteItem["kind"], string> = {
  command: "cmd",
  lane: "lane",
  chat: "chat",
};

const TAG_WIDTH = 4;
// Every glyph this palette draws (◇ ◉ / ▎ · ↑ ↓ ↵ …) is a single terminal cell
// per `string-width`, so a code-point count is an accurate column measure.
const GLYPH_WIDTH = 1;

function cellWidth(value: string): number {
  return [...value].length;
}

function endTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (cellWidth(value) <= max) return value;
  return `${[...value].slice(0, Math.max(0, max - 1)).join("")}…`;
}

function fillEnd(value: string, width: number): string {
  const clipped = endTruncate(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - cellWidth(clipped)))}`;
}

function glyph(kind: CommandPaletteItem["kind"]): string {
  if (kind === "lane") return "◇";
  if (kind === "chat") return "◉";
  return "/";
}

// Per-kind accent for the leading glyph (and the kind tag). Commands are the
// brand/accent action so they wear violet; lanes are neutral chrome (they carry
// no color of their own at this layer); chats borrow their provider brand color
// when the trailing detail segment names a known provider, else a calm blue
// "thread" tone. Never green here — that stays reserved for running/success.
function kindColor(item: CommandPaletteItem): string {
  if (item.kind === "command") return theme.color.violet;
  if (item.kind === "lane") return theme.color.t3;
  const provider = item.detail.split("·").pop()?.trim().toLowerCase() ?? "";
  if (KNOWN_PROVIDERS.has(provider)) return theme.provider(provider as AdeCodeProvider).color;
  return theme.color.info;
}

// One full-width body row painted on the palette surface. The row is composed of
// colored segments — a selection rail, a per-kind glyph, a dim kind tag, the
// label, and a dim right-side detail — then padded out to the inner width so the
// right border lands flush. The selected row swaps its leading space for a
// violet rail and brightens + bolds.
function PaletteRow({
  item,
  selected,
  labelWidth,
  detailWidth,
  innerWidth,
}: {
  item: CommandPaletteItem | null;
  selected: boolean;
  labelWidth: number;
  detailWidth: number;
  innerWidth: number;
}) {
  if (!item) {
    return (
      <Text backgroundColor={theme.color.surface1} color={theme.color.t5}>
        {`│${" ".repeat(innerWidth)}│`}
      </Text>
    );
  }
  const accent = kindColor(item);
  const tag = KIND_TAG[item.kind];
  const label = fillEnd(item.label, labelWidth);
  const detail = endTruncate(item.detail, detailWidth);
  // Visible columns consumed by the content between the framing pipes:
  //   "│ " rail " glyph " tag(padded) " " label " " detail
  // The leading "│ " (2) belongs to the framing segment; the rest is summed here.
  const content =
    1 /*rail*/ +
    1 /*space*/ +
    GLYPH_WIDTH +
    1 /*space*/ +
    TAG_WIDTH +
    1 /*space*/ +
    labelWidth +
    1 /*space*/ +
    cellWidth(detail);
  // innerWidth includes the lead space after "│"; subtract it (1) plus content.
  const pad = " ".repeat(Math.max(0, innerWidth - 1 - content));
  return (
    <Text backgroundColor={theme.color.surface1}>
      <Text color={theme.color.t5}>│ </Text>
      <Text color={selected ? theme.color.violet : theme.color.t5} bold={selected}>
        {selected ? theme.rail : " "}
      </Text>
      <Text color={accent} bold={selected}>{` ${glyph(item.kind)} `}</Text>
      <Text color={selected ? accent : theme.color.t5} dimColor={!selected}>
        {`${fillEnd(tag, TAG_WIDTH)} `}
      </Text>
      <Text color={selected ? theme.color.t1 : theme.color.t2} bold={selected}>{label}</Text>
      <Text color={selected ? theme.color.t3 : theme.color.t4} dimColor={!selected}>{` ${detail}`}</Text>
      <Text color={theme.color.t5}>{`${pad}│`}</Text>
    </Text>
  );
}

export function CommandPalette({
  query,
  items,
  selectedIndex,
  width,
}: {
  query: string;
  items: CommandPaletteItem[];
  selectedIndex: number;
  width?: number;
}) {
  const paletteWidth = Math.min(MAX_PALETTE_WIDTH, Math.max(56, Math.floor(width ?? DEFAULT_PALETTE_WIDTH) - 2));
  const innerWidth = Math.max(1, paletteWidth - 2);
  const total = items.length;
  const safeIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, total - 1)));
  const half = Math.floor(VISIBLE_ROWS / 2);
  let start = Math.max(0, safeIndex - half);
  const end = Math.min(total, start + VISIBLE_ROWS);
  start = Math.max(0, end - VISIBLE_ROWS);
  const window = items.slice(start, end);
  const selected = items[safeIndex] ?? null;
  const aboveCount = start;
  const belowCount = total - end;

  const labelWidth = Math.max(18, Math.floor(paletteWidth * 0.38));
  // Reserve the fixed left gutter — lead 1 + rail 1 + sp 1 + glyph + sp 1 +
  // tag + sp 1 + label + sp 1 — so the detail column aligns under the header on
  // every row. Mirrors PaletteRow's content sum exactly.
  const gutter = 1 + 1 + 1 + GLYPH_WIDTH + 1 + TAG_WIDTH + 1 + labelWidth + 1;
  const detailWidth = Math.max(10, innerWidth - gutter);

  // Header — a SectionHeader-style hairline: bold violet title, a borderSoft
  // rule that fills the gap, and a dim right-aligned result count.
  const title = `Command palette · ${query.trim() || "all"}`;
  const countHint = `${total} match${total === 1 ? "" : "es"}`;
  const headerTitle = endTruncate(title, Math.max(8, innerWidth - cellWidth(countHint) - 4));
  // "┌ " (2) + title + " " (1) + rule + " " (1) + count + " ┐" (2) === paletteWidth
  const headerRuleLen = Math.max(1, paletteWidth - 6 - cellWidth(headerTitle) - cellWidth(countHint));

  // Footer — the key hints sit on the bottom rule, with an above/below scroll
  // affordance ahead of them when the list overflows the window.
  const moreSummary = [
    aboveCount ? `↑ ${aboveCount} above` : null,
    belowCount ? `↓ ${belowCount} below` : null,
  ].filter(Boolean).join(" · ");
  const morePrefix = moreSummary ? `${moreSummary} · ` : "";
  // Rendered cell-width of the hint cluster "↑↓ move · ↵ run · esc close".
  const hintWidth = cellWidth("↑↓ move · ↵ run · esc close");
  // "└ " (2) + morePrefix + hints + " " (1) + rule + "┘" (1) === paletteWidth
  const footerRuleLen = Math.max(1, paletteWidth - 4 - cellWidth(morePrefix) - hintWidth);

  return (
    <Box width={paletteWidth} flexDirection="column">
      {/* Header rule */}
      <Text backgroundColor={theme.color.surface1}>
        <Text color={theme.color.t5}>{"┌ "}</Text>
        <Text color={theme.color.violet} bold>{headerTitle}</Text>
        <Text color={theme.color.borderSoft}>{` ${"─".repeat(headerRuleLen)} `}</Text>
        <Text color={theme.color.t4} dimColor>{countHint}</Text>
        <Text color={theme.color.t5}>{" ┐"}</Text>
      </Text>

      {/* Rows */}
      {Array.from({ length: VISIBLE_ROWS }).map((_, index) => {
        const item = window[index] ?? null;
        const absoluteIndex = start + index;
        return (
          <PaletteRow
            key={`row:${index}`}
            item={item}
            selected={item != null && absoluteIndex === safeIndex}
            labelWidth={labelWidth}
            detailWidth={detailWidth}
            innerWidth={innerWidth}
          />
        );
      })}

      {/* Selected-item detail line */}
      <DetailLine item={selected} innerWidth={innerWidth} />

      {/* Footer rule + key hints */}
      <Text backgroundColor={theme.color.surface1}>
        <Text color={theme.color.t5}>{"└ "}</Text>
        {morePrefix ? <Text color={theme.color.t4} dimColor>{morePrefix}</Text> : null}
        <Text color={theme.color.accent}>{"↑↓"}</Text>
        <Text color={theme.color.t4} dimColor>{" move "}</Text>
        <Text color={theme.color.t5} dimColor>{"· "}</Text>
        <Text color={theme.color.accent}>{"↵"}</Text>
        <Text color={theme.color.t4} dimColor>{" run "}</Text>
        <Text color={theme.color.t5} dimColor>{"· "}</Text>
        <Text color={theme.color.accent}>{"esc"}</Text>
        <Text color={theme.color.t4} dimColor>{" close"}</Text>
        <Text color={theme.color.borderSoft}>{` ${"─".repeat(footerRuleLen)}`}</Text>
        <Text color={theme.color.t5}>{"┘"}</Text>
      </Text>
    </Box>
  );
}

// The detail line echoes the selected row's glyph, label, and full detail, then
// pads out to the inner width so the right border stays flush.
function DetailLine({ item, innerWidth }: { item: CommandPaletteItem | null; innerWidth: number }) {
  if (!item) {
    const empty = "No matches";
    const pad = " ".repeat(Math.max(0, innerWidth - 1 - empty.length));
    return (
      <Text backgroundColor={theme.color.surface1}>
        <Text color={theme.color.t5}>{"│ "}</Text>
        <Text color={theme.color.t4} dimColor>{empty}</Text>
        <Text color={theme.color.t5}>{`${pad}│`}</Text>
      </Text>
    );
  }
  const labelCap = Math.max(8, Math.floor(innerWidth * 0.4));
  const label = endTruncate(item.label, labelCap);
  // Within innerWidth (the columns after "│"):
  //   lead space (1) + glyph (2) + " " (1) + label + " · " (3) + detail
  const sep = " · ";
  const fixed = 1 + GLYPH_WIDTH + 1 + cellWidth(label) + cellWidth(sep);
  const detailCap = Math.max(4, innerWidth - fixed);
  const detail = endTruncate(item.detail, detailCap);
  const content = fixed + cellWidth(detail);
  const pad = " ".repeat(Math.max(0, innerWidth - content));
  return (
    <Text backgroundColor={theme.color.surface1}>
      <Text color={theme.color.t5}>{"│ "}</Text>
      <Text color={kindColor(item)} bold>{glyph(item.kind)}</Text>
      <Text color={theme.color.t2}>{` ${label}`}</Text>
      <Text color={theme.color.t5} dimColor>{sep}</Text>
      <Text color={theme.color.t4} dimColor>{detail}</Text>
      <Text color={theme.color.t5}>{`${pad}│`}</Text>
    </Text>
  );
}
