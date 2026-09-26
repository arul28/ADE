/**
 * Ignore-whitespace helpers for the diff viewer.
 *
 * `@pierre/diffs` forwards `parseDiffOptions` to the underlying `diff` library
 * when it computes a diff from full file contents, so the old/new-contents path
 * can pass `{ ignoreWhitespace: true }`. A pre-parsed patch has no such hook, so
 * the unified-diff text is filtered here by turning a `-`/`+` pair whose content
 * is equal after per-line `trim()` back into a context line (the new-side text,
 * as `git diff -w` prints it), which is the same "ignore leading/trailing
 * whitespace" rule `diff` uses. A trimmed line also drops a trailing `\r`, so
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
 * Remove whitespace-only changes from one hunk body.
 *
 * A change block in unified diff output is a run of `-` lines followed by `+`
 * lines, so deletion[k] pairs with addition[k] — the same pairing a side-by-side
 * view draws. A pair whose content is equal after `trim()` did not really change,
 * so it becomes a **context line** (keeping the new-side text, exactly what
 * `git diff -w` prints) rather than being deleted. Keeping it in place is what
 * preserves the order of the changes around it; removing the line instead would
 * let an unpaired addition slip ahead of a line that follows it. Because a
 * dropped pair was one old line plus one new line and a context line is also one
 * of each, the hunk's `@@` start and counts stay correct with no rewrite.
 *
 * Anything unpaired is a real change and is kept. `\ No newline at end of file`
 * markers follow the line they annotate and are dropped or kept with it.
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
      const deletionMarker = deletionMarkers[pair];
      const additionMarker = additionMarkers[pair];
      // A pair whose newline-at-EOF state differs is not whitespace-only: one
      // context line cannot carry both states, so it stays a real change.
      if (
        normalizeLineForWhitespaceCompare(deletionText) === normalizeLineForWhitespaceCompare(additionText)
        && Boolean(deletionMarker) === Boolean(additionMarker)
      ) {
        // Whitespace-only: the line is unchanged, so show it as context in
        // place. The new-side text is what `git diff -w` prints; a shared
        // no-newline marker follows it so the hunk keeps its real EOF state.
        out.push(` ${additionText}`);
        if (additionMarker) out.push(additionMarker);
        continue;
      }
      out.push(deletions[pair]!);
      if (deletionMarker) out.push(deletionMarker);
      out.push(additions[pair]!);
      if (additionMarker) out.push(additionMarker);
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
      // A dropped pair became a context line, so the hunk's own `@@` start and
      // counts are still exact — the header is reused untouched.
      out.push(line);
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
