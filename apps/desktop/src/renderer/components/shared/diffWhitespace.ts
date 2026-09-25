/**
 * Ignore-whitespace helpers for the diff viewer.
 *
 * `@pierre/diffs` forwards `parseDiffOptions` to the underlying `diff` library
 * when it computes a diff from full file contents, so the old/new-contents path
 * can pass `{ ignoreWhitespace: true }`. A pre-parsed patch has no such hook, so
 * the unified-diff text is filtered here by dropping `-`/`+` pairs whose content
 * is equal after per-line `trim()` (the same "ignore leading/trailing
 * whitespace" rule `diff` uses). A trimmed line also drops a trailing `\r`, so
 * CRLF and LF compare equal, and a tab-vs-spaces reindent is a no-op.
 *
 * Pure and dependency-free so both the PR code tab (patch) and the chat turn
 * diff panel (file contents) share one rule and one test surface.
 */

/** Per-line normalization used for whitespace-only comparison. */
function normalizeLineForWhitespaceCompare(line: string): string {
  return line.trim();
}

/**
 * True when two full texts differ only by leading/trailing whitespace on their
 * lines (including tabs-vs-spaces, CRLF-vs-LF, and a trailing newline).
 */
export function isWhitespaceOnlyTextDiff(oldText: string, newText: string): boolean {
  const toLines = (text: string): string[] => {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines.map(normalizeLineForWhitespaceCompare);
  };
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);
  if (oldLines.length !== newLines.length) return false;
  for (let index = 0; index < oldLines.length; index += 1) {
    if (oldLines[index] !== newLines[index]) return false;
  }
  return true;
}

function isChangeLine(line: string): boolean {
  if (line.startsWith("-") || line.startsWith("+")) return true;
  return false;
}

type FilteredHunk = {
  lines: string[];
  /** Number of addition/deletion lines kept; 0 means the hunk was whitespace-only. */
  changes: number;
};

/**
 * Drop whitespace-only `-`/`+` pairs from one hunk body.
 *
 * A change block in unified diff output is a run of `-` lines followed by `+`
 * lines, so deletion[k] pairs with addition[k]. A pair whose content is equal
 * after `trim()` is removed; anything unpaired is kept. `\ No newline at end of
 * file` markers follow the line they annotate and are dropped or kept with it.
 */
function filterHunkBody(body: string[]): FilteredHunk {
  const out: string[] = [];
  let changes = 0;
  let index = 0;
  while (index < body.length) {
    const line = body[index]!;
    if (!isChangeLine(line)) {
      out.push(line);
      index += 1;
      continue;
    }
    const deletions: string[] = [];
    const additions: string[] = [];
    const deletionMarkers: Array<string | null> = [];
    const additionMarkers: Array<string | null> = [];
    while (index < body.length) {
      const current = body[index]!;
      if (current.startsWith("-")) {
        deletions.push(current);
        deletionMarkers.push(null);
      } else if (current.startsWith("+")) {
        additions.push(current);
        additionMarkers.push(null);
      } else if (current.startsWith("\\") && (additions.length > 0 || deletions.length > 0)) {
        if (additions.length > 0) additionMarkers[additions.length - 1] = current;
        else deletionMarkers[deletions.length - 1] = current;
      } else {
        break;
      }
      index += 1;
    }

    const paired = Math.min(deletions.length, additions.length);
    for (let pair = 0; pair < paired; pair += 1) {
      const deletionText = deletions[pair]!.slice(1);
      const additionText = additions[pair]!.slice(1);
      if (normalizeLineForWhitespaceCompare(deletionText) === normalizeLineForWhitespaceCompare(additionText)) {
        continue;
      }
      out.push(deletions[pair]!);
      if (deletionMarkers[pair]) out.push(deletionMarkers[pair]!);
      out.push(additions[pair]!);
      if (additionMarkers[pair]) out.push(additionMarkers[pair]!);
      changes += 1;
    }
    for (let leftover = paired; leftover < deletions.length; leftover += 1) {
      out.push(deletions[leftover]!);
      if (deletionMarkers[leftover]) out.push(deletionMarkers[leftover]!);
      changes += 1;
    }
    for (let leftover = paired; leftover < additions.length; leftover += 1) {
      out.push(additions[leftover]!);
      if (additionMarkers[leftover]) out.push(additionMarkers[leftover]!);
      changes += 1;
    }
  }
  return { lines: out, changes };
}

function rebuildHunkHeader(original: string, lines: string[]): string {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(original);
  if (!match) return original;
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) newCount += 1;
    else if (line.startsWith("-")) oldCount += 1;
    else {
      oldCount += 1;
      newCount += 1;
    }
  }
  return `@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3] ?? ""}`;
}

export type WhitespaceFilteredPatch = {
  /** The patch with whitespace-only change pairs removed. */
  patch: string;
  /**
   * True when the patch had hunks and every one was whitespace-only, so
   * `patch` carries no hunks and the viewer should say so instead of drawing an
   * empty diff.
   */
  whitespaceOnly: boolean;
};

function startsFileHeader(line: string): boolean {
  return line.startsWith("diff --git ") || line.startsWith("diff --cc ");
}

/**
 * Remove whitespace-only changes from a unified diff. File headers are kept;
 * hunks whose changes are all whitespace-only are dropped; kept hunks get their
 * `@@` counts recomputed.
 */
export function stripWhitespaceOnlyPatchChanges(patchText: string): WhitespaceFilteredPatch {
  const lines = patchText.split("\n");
  const out: string[] = [];
  let sawHunk = false;
  let sawKeptHunk = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.startsWith("@@")) {
      out.push(line);
      index += 1;
      continue;
    }
    sawHunk = true;
    let end = index + 1;
    while (end < lines.length && !lines[end]!.startsWith("@@") && !startsFileHeader(lines[end]!)) {
      end += 1;
    }
    const filtered = filterHunkBody(lines.slice(index + 1, end));
    if (filtered.changes > 0) {
      out.push(rebuildHunkHeader(line, filtered.lines));
      out.push(...filtered.lines);
      sawKeptHunk = true;
    }
    index = end;
  }
  if (!sawHunk || sawKeptHunk) {
    return { patch: out.join("\n"), whitespaceOnly: false };
  }
  return { patch: "", whitespaceOnly: true };
}

export const _testing = { filterHunkBody, rebuildHunkHeader };
