import React from "react";
import { Box, Text } from "ink";

import { Chip, Pill, Rail, Rule, StatusDot } from "./designKit";
import type { PluginPaneRow } from "../pluginPane";
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
      const meta = row.meta ? ` · ${row.meta}` : "";
      return (
        <Box flexDirection="column">
          <Text
            color={selected ? theme.color.violet : TONE_COLOR[row.tone]}
            bold={selected}
            wrap="truncate-end"
          >
            {lead}
            <Rail on={selected} />
            {` ${endTruncate(`${row.title}${meta}`, Math.max(4, inner - 2))}`}
          </Text>
          {row.subtitle ? (
            <Text color={theme.color.t4} dimColor wrap="truncate-end">
              {`${lead}   ${endTruncate(row.subtitle, Math.max(4, inner - 3))}`}
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
          </Text>
        ) : null}
        <Text color={theme.color.t4} dimColor>
          {model.fallback?.deeplink ? "r refresh · ctrl+y copies a link" : "r refresh"}
        </Text>
      </Box>
    </Box>
  );
}
