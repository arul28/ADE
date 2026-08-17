import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { describe, expect, it } from "vitest";
import {
  PROMPT_ROW_CHROME_CELLS,
  promptDisplayRows,
  promptDisplayRowsWithCursor,
  promptRowHintFits,
  promptWrapWidth,
} from "../app";
import { terminalDisplayWidth } from "../displayWidth";

/**
 * Regression coverage for the composer newline/word-split bug.
 *
 * Root cause: the wrap budget was `promptPaneWidth - 5`, but a prompt row
 * costs `promptPaneWidth - 4` (border + padding) minus a 2-cell gutter minus
 * up to 1 cell for the inverse cursor block. A row that filled the old budget
 * overran the box by 1-2 cells, so Ink re-wrapped it with `hard: true` — one
 * logical row became two terminal lines split through the middle of a word.
 * Pressing Enter is what parks the caret at the end of a full row (a wrap
 * point moves the caret to the next row instead), which is why the report
 * described it as "one newline looks like two".
 */

/** Mirrors the prompt row markup in app.tsx closely enough to catch overflow. */
function PromptRows({
  columns,
  rows,
}: {
  columns: number;
  rows: Array<{ text: string; cursorColumn: number | null }>;
}) {
  return (
    <Box borderStyle="round" paddingX={1} flexShrink={0} flexDirection="column" width={columns}>
      {rows.map((line, index) => {
        const cursor = line.cursorColumn;
        const before = cursor == null ? line.text : line.text.slice(0, cursor);
        const at = cursor == null ? "" : line.text.slice(cursor, cursor + 1) || " ";
        const after = cursor == null ? "" : line.text.slice(cursor + 1);
        return (
          <Box key={index} flexDirection="row">
            <Text>{index === 0 ? "› " : "  "}</Text>
            {cursor == null ? <Text>{line.text}</Text> : (
              <>
                <Text>{before}</Text>
                <Text inverse>{at}</Text>
                <Text>{after}</Text>
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** Strips SGR escapes (e.g. the inverse-video caret cell) for text compares. */
function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

/** Body lines of the rendered box, with the border/padding stripped. */
function boxBodyLines(frame: string): string[] {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("│"))
    .map((line) => line.slice(1, -1));
}

describe("prompt wrap budget", () => {
  it("leaves room for the border, padding, gutter and cursor cell", () => {
    expect(promptWrapWidth(80)).toBe(80 - PROMPT_ROW_CHROME_CELLS);
    expect(promptWrapWidth(3)).toBe(1);
    expect(promptWrapWidth(-10)).toBe(1);
  });

  it("renders a full-width row on ONE terminal line with the gutter intact", () => {
    const columns = 40;
    const text = "abcdefghij".repeat(6).slice(0, promptWrapWidth(columns));
    const { lastFrame } = render(
      <PromptRows columns={columns} rows={[{ text, cursorColumn: null }]} />,
    );
    const body = boxBodyLines(lastFrame() ?? "");
    expect(body).toHaveLength(1);
    // The old budget ate the gutter space, rendering "›abcdef…".
    expect(body[0]).toContain("› abcdefghij");
  });

  it("keeps the caret at the end of a full row on ONE terminal line", () => {
    // This is the exact newline case: "\n" lets the caret sit at the end of a
    // row that is already as wide as the wrap budget allows.
    const columns = 40;
    const text = "abcdefghij".repeat(6).slice(0, promptWrapWidth(columns));
    const { lastFrame } = render(
      <PromptRows columns={columns} rows={[{ text, cursorColumn: text.length }]} />,
    );
    const body = boxBodyLines(lastFrame() ?? "");
    expect(body).toHaveLength(1);
    // The caret is an inverse-video cell rendered *after* the last character;
    // PROMPT_ROW_CHROME_CELLS reserves a column for it, so the row still fits
    // ONE terminal line. The old assertion used `.trim()`, which cannot strip a
    // space wrapped in SGR escapes, so it never matched — strip the escapes.
    expect(stripAnsi(body[0]!).trim()).toBe(`› ${text}`);
    expect(body[0]).toContain("\u001B[7m \u001B[27m");
  });

  it("reports when a trailing hint still fits beside a short row", () => {
    expect(promptRowHintFits("hi", 40)).toBe(true);
    const full = "abcdefghij".repeat(6).slice(0, promptWrapWidth(40));
    expect(promptRowHintFits(full, 40)).toBe(false);
  });
});

describe("prompt newline rows", () => {
  it("turns one newline into exactly one extra row", () => {
    expect(promptDisplayRows("ab\ncd", 20)).toEqual(["ab", "cd"]);
    expect(promptDisplayRows("ab\n", 20)).toEqual(["ab", ""]);
    expect(promptDisplayRows("ab\n\ncd", 20)).toEqual(["ab", "", "cd"]);
  });

  it("puts the caret on the row the newline opened, not two rows down", () => {
    const value = "ab\n";
    const display = promptDisplayRowsWithCursor(value, 20, value.length);
    expect(display.rows).toHaveLength(2);
    expect(display.cursorRow).toBe(1);
    expect(display.cursorColumn).toBe(0);
  });

  it("keeps the caret at the end of the line a newline terminated", () => {
    const value = "hello\nworld";
    const display = promptDisplayRowsWithCursor(value, 20, 5);
    expect(display.cursorRow).toBe(0);
    expect(display.cursorColumn).toBe(5);
  });
});

describe("prompt wrapping", () => {
  it("breaks between words instead of through them", () => {
    // "alpha beta gamma" at width 12 must not emit "alpha beta g" / "amma".
    const rows = promptDisplayRows("alpha beta gamma", 12);
    expect(rows).toEqual(["alpha beta ", "gamma"]);
  });

  it("hard-breaks a single word that is wider than the row", () => {
    const rows = promptDisplayRows("abcdefghijklmnop", 6);
    expect(rows).toEqual(["abcdef", "ghijkl", "mnop"]);
  });

  it("never emits a row wider than the budget", () => {
    const value = "the quick brown fox jumps over the lazy dog and keeps running onwards";
    for (const width of [5, 8, 13, 21, 34]) {
      for (const row of promptDisplayRows(value, width, 99)) {
        expect(terminalDisplayWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("preserves every character across the wrapped rows", () => {
    const value = "alpha beta gamma delta epsilon zeta eta theta";
    for (const width of [7, 11, 16, 29]) {
      const display = promptDisplayRowsWithCursor(value, width, 0, 99);
      const joined = display.rows.map((row) => value.slice(row.start, row.end)).join("");
      expect(joined).toBe(value);
    }
  });

  it("keeps rows contiguous so cursor mapping stays exact", () => {
    const value = "alpha beta gamma\nsecond line here";
    const display = promptDisplayRowsWithCursor(value, 10, 0, 99);
    for (const row of display.rows) {
      expect(value.slice(row.start, row.end)).toBe(row.text);
    }
  });

  it("wraps grapheme clusters whole", () => {
    // Family emoji + skin-tone modifiers must never be split mid-sequence.
    const value = "👩‍👩‍👧‍👦 👨🏽‍🚀 hello";
    for (const row of promptDisplayRows(value, 9, 99)) {
      expect(row.includes("‍") ? row.startsWith("‍") : false).toBe(false);
    }
    expect(promptDisplayRows(value, 9, 99).join("")).toBe(value);
  });
});
