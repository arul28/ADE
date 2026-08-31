import React from "react";
import { Box, Text } from "ink";

import { Chip, Pill, Rail, Rule, StatusDot } from "./designKit";
import type { PluginPaneRow, VocabMarkdownSpan } from "../pluginPane";
import { pluginPaneWindow } from "../pluginPane";
import { theme } from "../theme";
import type { RightPaneContent } from "../types";

/**
 * The Ink half of the plugin panel interpreter.
 *
 * Stateless and cheap by construction: every layout decision was already made
 * in `pluginPane.ts`, so this only maps rows to designKit primitives. Selection
 * lives in app.tsx (`rightSelectionIndex`) like every other pane.
 *
 * Color discipline is the theme's, not the plugin's. A schema names a semantic
 * tone and `theme.vocabToneColor` picks the token — a plugin cannot paint the
 * terminal green, which is reserved for running and success. The drawer's
 * plugin row badges read the same table, so one tone means one color wherever a
 * plugin puts it.
 */

const TONE_COLOR = {
  neutral: theme.vocabToneColor("neutral"),
  accent: theme.vocabToneColor("accent"),
  success: theme.vocabToneColor("success"),
  warning: theme.vocabToneColor("warning"),
} as const;

/** Rows visible at once. Matches the density of the activity and details panes. */
const PLUGIN_PANE_ROW_CAPACITY = 14;

function endTruncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

/**
 * How much a wrapping row may occupy before it is cut, in lines.
 *
 * Ink wraps rather than clips, so a plugin that ships one long paragraph would
 * otherwise push every row below it — and the pane's own footer — out of the
 * window. Three lines is what the sibling panes allow.
 */
const WRAPPED_ROW_LINES = 3;

/**
 * {@link endTruncate} across a run list, cutting the run the budget lands in and
 * dropping the rest.
 *
 * A markdown row is many `Text` elements, so the row's line budget has to be
 * spent across them rather than applied to any one — truncating each run
 * separately would let a paragraph of twenty runs draw twenty times the budget.
 */
function truncateSpans(
  parts: readonly VocabMarkdownSpan[],
  max: number,
): VocabMarkdownSpan[] {
  const budget = Math.max(1, max);
  const kept: VocabMarkdownSpan[] = [];
  let used = 0;
  for (const span of parts) {
    const cost = span.text.length + (span.href !== undefined ? span.href.length + 3 : 0);
    if (used + cost <= budget) {
      kept.push(span);
      used += cost;
      continue;
    }
    const room = budget - used;
    if (room > 1) kept.push({ ...span, text: endTruncate(span.text, room) });
    break;
  }
  return kept.length > 0 ? kept : [{ text: endTruncate(parts[0]?.text ?? "", budget) }];
}

function pad(value: string, width: number, align: "left" | "right"): string {
  const clipped = endTruncate(value, width);
  return align === "right" ? clipped.padStart(width) : clipped.padEnd(width);
}

function indentPrefix(indent: number): string {
  return "  ".repeat(Math.max(0, Math.min(indent, 3)));
}

function PluginRow({
  row,
  selectionIndex,
  width,
  editingValue,
}: {
  row: PluginPaneRow;
  selectionIndex: number;
  width: number;
  editingValue: string | null;
}) {
  const lead = indentPrefix(row.indent);
  const inner = Math.max(8, width - 4 - lead.length);

  switch (row.kind) {
    case "text": {
      const bold = row.variant === "title" || row.variant === "subtitle";
      const color = row.variant === "caption"
        ? theme.color.t4
        : row.variant === "code"
          ? theme.color.t1
          : TONE_COLOR[row.tone];
      return (
        <Text color={color} bold={bold} dimColor={row.variant === "caption"} wrap="wrap">
          {`${lead}${endTruncate(row.text, inner * WRAPPED_ROW_LINES)}`}
        </Text>
      );
    }
    case "inline": {
      return (
        <Text wrap="truncate-end">
          {lead}
          {row.parts.map((part, index) => (
            <Text key={`${part.text}:${index}`}>
              {index > 0 ? <Text color={theme.color.t5}>{" "}</Text> : null}
              {part.badge
                ? <Chip value={`[${part.text}]`} valueColor={TONE_COLOR[part.tone]} />
                : <Text color={TONE_COLOR[part.tone]}>{part.text}</Text>}
            </Text>
          ))}
        </Text>
      );
    }
    case "divider": {
      return row.label
        ? (
          <Box flexDirection="row">
            <Text color={theme.color.t4} dimColor>{`${lead}${row.label} `}</Text>
            <Rule width={Math.max(1, inner - row.label.length - 1)} />
          </Box>
        )
        : <Box><Text>{lead}</Text><Rule width={inner} /></Box>;
    }
    case "keyValue": {
      const labelWidth = Math.min(18, Math.max(6, Math.floor(inner * 0.4)));
      return (
        <Text wrap="truncate-end">
          {lead}
          <Text color={theme.color.t4}>{pad(row.label, labelWidth, "left")}</Text>
          <Text color={TONE_COLOR[row.tone]}>{` ${endTruncate(row.value, Math.max(4, inner - labelWidth - 1))}`}</Text>
        </Text>
      );
    }
    case "listItem": {
      const selected = row.selection !== null && row.selection === selectionIndex;
      // The tick box is its own cursor stop, so a reader can stand on the box
      // without standing on the row's press. Only the box lights up then — the
      // title stays in its own tone, because the thing under the cursor is the
      // batch, not the row.
      const ticking = row.tick !== null && row.tick.selection === selectionIndex;
      const meta = row.meta ? ` · ${row.meta}` : "";
      // The badge is bracketed rather than coloured on its own, because the
      // title line is already one `Text` and splitting it would cost the
      // truncation that keeps a long title from wrapping the pane.
      const badge = row.badge ? ` [${row.badge.text}]` : "";
      // ASCII, deliberately: `☑` is a double-width glyph in some terminals and
      // a missing one in others, and a checkbox that shifts the whole line by a
      // column as it is ticked is worse than one that never moves.
      const box = row.tick ? `${row.tick.checked ? "[x]" : "[ ]"} ` : "";
      return (
        <Box flexDirection="column">
          <Text
            color={selected ? theme.color.violet : TONE_COLOR[row.tone]}
            bold={selected}
            wrap="truncate-end"
          >
            {lead}
            <Rail on={selected || ticking} />
            {box ? (
              <Text color={ticking ? theme.color.violet : row.tick?.checked ? theme.color.t1 : theme.color.t4} bold={ticking || row.tick?.checked}>
                {` ${box}`}
              </Text>
            ) : null}
            {`${box ? "" : " "}${endTruncate(`${row.title}${badge}${meta}`, Math.max(4, inner - 2 - box.length))}`}
          </Text>
          {row.subtitle ? (
            <Text color={theme.color.t4} dimColor wrap="truncate-end">
              {`${lead}   ${endTruncate(row.subtitle, Math.max(4, inner - 3))}`}
            </Text>
          ) : null}
          {row.mono ? (
            <Text color={theme.color.t4} dimColor wrap="truncate-end">
              {`${lead}   ${endTruncate(row.mono, Math.max(4, inner - 3))}`}
            </Text>
          ) : null}
        </Box>
      );
    }
    case "tableHead": {
      return (
        <Text color={theme.color.t4} bold wrap="truncate-end">
          {lead}
          {row.cells.map((cell, index) => pad(cell, row.widths[index] ?? 3, row.aligns[index] ?? "left")).join(" ")}
        </Text>
      );
    }
    case "tableRow": {
      return (
        <Text color={theme.color.t2} wrap="truncate-end">
          {lead}
          {row.cells.map((cell, index) => pad(cell, row.widths[index] ?? 3, row.aligns[index] ?? "left")).join(" ")}
        </Text>
      );
    }
    case "group": {
      // The house disclosure glyph, the same one the chats and activity panes
      // fold their sections with, so one triangle means one thing everywhere in
      // this client.
      const focused = row.selection === selectionIndex;
      return (
        <Text
          color={focused ? theme.color.violet : theme.color.t1}
          bold
          wrap="truncate-end"
        >
          {lead}
          <Rail on={focused} />
          {` ${row.open ? "▾" : "▸"} ${endTruncate(row.title, Math.max(4, inner - 4))}`}
          {row.badge ? <Text color={theme.color.t4} dimColor>{`  ${row.badge}`}</Text> : null}
        </Text>
      );
    }
    case "bulkBar": {
      // The count leads, because it is the half of this bar that is not a
      // button: it names the batch the verbs beside it would spend.
      return (
        <Text wrap="truncate-end">
          {lead}
          <Text color={theme.color.violet} bold>{`${row.count} selected  `}</Text>
          {row.buttons.map((button, index) => (
            <Text key={`${button.label}:${index}`}>
              {index > 0 ? <Text>{" "}</Text> : null}
              <Pill
                label={button.label}
                active={button.selection !== null && button.selection === selectionIndex}
                disabled={button.disabled}
              />
            </Text>
          ))}
        </Text>
      );
    }
    case "buttons": {
      return (
        <Text wrap="truncate-end">
          {lead}
          {row.buttons.map((button, index) => (
            <Text key={`${button.label}:${index}`}>
              {index > 0 ? <Text>{" "}</Text> : null}
              <Pill
                label={button.label}
                active={button.selection !== null && button.selection === selectionIndex}
                disabled={button.disabled}
              />
            </Text>
          ))}
        </Text>
      );
    }
    case "field": {
      const selected = row.selection === selectionIndex;
      // While typing, the row echoes the composer — except for a secret, which
      // stays masked here even though the composer itself cannot mask it.
      const display = row.editing && editingValue !== null && row.fieldKind !== "secret"
        ? (editingValue || "…")
        : row.display;
      const hint = row.editing
        ? " ← typing below"
        : selected && (row.fieldKind === "select" || row.fieldKind === "toggle")
          ? " ←→ change"
          : "";
      return (
        <Text color={selected ? theme.color.violet : undefined} bold={row.editing} wrap="truncate-end">
          {lead}
          <Rail on={selected} />
          {` ${row.label}: `}
          <Text color={row.editing ? theme.color.violet : theme.color.t2}>
            {endTruncate(display, Math.max(6, inner - row.label.length - 4))}
          </Text>
          {hint ? <Text color={theme.color.t4} dimColor>{hint}</Text> : null}
        </Text>
      );
    }
    case "segmented": {
      // Two signals, deliberately separate: the CURSOR is where the arrow keys
      // are (violet, like every other selected row in this client), and the DOT
      // is which option is in force. A reader moving through the options must
      // still be able to see the one that is filtering the list.
      return (
        <Text wrap="truncate-end">
          {lead}
          {row.label ? <Text color={theme.color.t4} dimColor>{`${row.label}  `}</Text> : null}
          {row.options.map((option, index) => {
            const cursor = option.selection === selectionIndex;
            const text = `${option.selected ? "● " : ""}${option.label}${option.badge ? ` ${option.badge}` : ""}`;
            return (
              <Text key={`${option.label}:${index}`}>
                {index > 0 ? <Text>{" "}</Text> : null}
                <Text
                  color={cursor ? theme.color.violet : option.selected ? theme.color.t1 : theme.color.t4}
                  bold={cursor || option.selected}
                  dimColor={!cursor && !option.selected}
                >
                  {`[ ${text} ]`}
                </Text>
              </Text>
            );
          })}
        </Text>
      );
    }
    case "menu": {
      // A collection-bound control with thirty options. One line, not thirty
      // pills: the option in force, its place in the list so the reader knows
      // there are others, and the ←/→ gesture that reaches them.
      const focused = row.selection === selectionIndex;
      const place = row.count > 0 ? `${row.position}/${row.count}` : "";
      return (
        <Text wrap="truncate-end">
          {lead}
          <Rail on={focused} />
          {row.label ? <Text color={theme.color.t4} dimColor>{` ${row.label}  `}</Text> : " "}
          <Text color={focused ? theme.color.violet : theme.color.t1} bold>
            {endTruncate(row.value, Math.max(6, inner - 14))}
          </Text>
          {row.badge ? <Text color={theme.color.t4} dimColor>{` ${row.badge}`}</Text> : null}
          <Text color={theme.color.t4} dimColor>
            {`  ${place}${focused ? " ←→" : ""}`}
          </Text>
        </Text>
      );
    }
    case "submit": {
      return (
        <Box marginTop={1}>
          <Text>
            {lead}
            <Pill label={row.label} active={row.selection === selectionIndex} />
          </Text>
        </Box>
      );
    }
    case "markdown": {
      const bold = row.variant === "title" || row.variant === "subtitle";
      const base = row.variant === "code" ? theme.color.t1 : theme.color.t2;
      // Same budget as a `text` row, applied across the runs rather than to one
      // string: a paragraph may wrap to three lines and no further, or a long
      // issue body would push the pane's own footer off the window.
      const parts = truncateSpans(row.parts, inner * WRAPPED_ROW_LINES - row.prefix.length);
      return (
        <Text color={base} bold={bold} wrap="wrap">
          {lead}
          {row.prefix ? <Text color={theme.color.t4} dimColor>{row.prefix}</Text> : null}
          {parts.map((span, index) => (
            <Text key={`${index}:${span.text.length}`}>
              <Text
                bold={bold || span.bold === true}
                italic={span.italic === true}
                strikethrough={span.strike === true}
                underline={span.href !== undefined}
                color={span.href !== undefined
                  ? theme.color.violet
                  : span.code === true
                    ? theme.color.t1
                    : base}
              >
                {span.text}
              </Text>
              {/* A terminal cannot hide a destination behind a word, and should
                  not try: the URL is printed beside the words it belongs to, so
                  the reader can see and copy where a link goes. */}
              {span.href !== undefined ? (
                <Text color={theme.color.t4} dimColor>{` (${span.href})`}</Text>
              ) : null}
            </Text>
          ))}
        </Text>
      );
    }
    // What the list is drawing, and the way to ask for more of it. A pill when
    // there is more to draw, a dim line when the list has hit the vocabulary's
    // ceiling — because a list that stopped and said nothing is what made a
    // truncated list read as a complete one.
    case "listPage": {
      if (row.selection === null) {
        return (
          <Text color={theme.color.t4} dimColor wrap="truncate-end">
            {`${lead}${endTruncate(row.label, Math.max(4, inner))}`}
          </Text>
        );
      }
      return (
        <Text wrap="truncate-end">
          {lead}
          <Pill
            label={endTruncate(row.label, Math.max(4, inner - 2))}
            active={row.selection === selectionIndex}
            disabled={false}
          />
        </Text>
      );
    }
    case "note": {
      return (
        <Text color={theme.color.t4} dimColor wrap="wrap">
          {`${lead}${endTruncate(row.text, inner * WRAPPED_ROW_LINES)}`}
        </Text>
      );
    }
    case "placeholder": {
      // Named, never blank: the user should know something is there and how to
      // reach it, rather than reading a gap as a broken plugin.
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            {lead}
            <StatusDot kind="info" />
            <Text color={theme.color.t2}>{` ${endTruncate(row.label, Math.max(4, inner - 2))}`}</Text>
          </Text>
          <Text color={theme.color.t4} dimColor wrap="truncate-end">
            {`${lead}   ${endTruncate(row.hint, Math.max(4, inner - 3))}`}
          </Text>
        </Box>
      );
    }
    default:
      return null;
  }
}

export function PluginPanelPane({
  content,
  selectedIndex,
  width,
  editingValue = null,
}: {
  content: Extract<RightPaneContent, { kind: "plugin-panel" }>;
  selectedIndex: number;
  width: number;
  /** Live composer text for the field being typed, if any. */
  editingValue?: string | null;
}) {
  const { model } = content;
  const inner = Math.max(8, width - 4);
  const window = pluginPaneWindow(model, selectedIndex, PLUGIN_PANE_ROW_CAPACITY);
  const hasFields = model.interactives.some((entry) => entry.kind === "field");
  const hasControls = model.interactives.some((entry) => entry.kind === "state");

  return (
    <Box flexDirection="column">
      <Text color={theme.color.t4} dimColor wrap="truncate-end">{model.pluginId}</Text>

      {window.hiddenBefore > 0 ? (
        <Text color={theme.color.t4} dimColor>{`↑ ${window.hiddenBefore} earlier`}</Text>
      ) : null}

      {window.rows.map((row) => (
        <PluginRow
          key={row.key}
          row={row}
          selectionIndex={selectedIndex}
          width={width}
          editingValue={editingValue}
        />
      ))}

      {window.hiddenAfter > 0 ? (
        <Text color={theme.color.t4} dimColor>{`↓ ${window.hiddenAfter} more`}</Text>
      ) : null}

      {model.warnings.length > 0 ? (
        <Box marginTop={1}>
          <Text color={theme.color.attention} dimColor wrap="truncate-end">
            {endTruncate(
              model.warnings.length === 1
                ? model.warnings[0] ?? ""
                : `${model.warnings.length} parts of this panel could not be drawn`,
              inner,
            )}
          </Text>
        </Box>
      ) : null}

      {content.error ? (
        <Box marginTop={1}>
          <Text color={theme.color.error} wrap="wrap">
            {endTruncate(content.error, inner * WRAPPED_ROW_LINES)}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {model.interactives.length > 0 ? (
          <Text color={theme.color.t4} dimColor>
            {hasFields ? "↑↓ move · enter edits or runs" : "↑↓ move · enter runs"}
            {hasControls || hasFields ? " · ←→ change" : ""}
          </Text>
        ) : null}
        <Text color={theme.color.t4} dimColor>
          {model.fallback?.deeplink ? "r refresh · ctrl+y copies a link" : "r refresh"}
        </Text>
      </Box>
    </Box>
  );
}
