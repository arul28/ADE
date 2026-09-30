/**
 * Minimal SQLite `CREATE TABLE` DDL reading, for the schema repair in `kvDb.ts`.
 *
 * This is not a SQL parser. It answers exactly one question — which clauses of a
 * table body are table constraints cr-sqlite cannot carry — and it exists
 * because the repair used to answer it line by line. A line filter cannot see
 * that a `foreign key(…)` clause continues onto the following `references …`
 * and `on delete …` lines: it deletes the head and leaves a bare `references`,
 * which is not valid SQLite. That invalid statement aborted the repair, and with
 * it the whole database open, on any table that wraps its foreign key.
 *
 * Everything here is dependency-free and pure, so it is testable on its own.
 */

/**
 * `text` with every comment and, optionally, every quoted region replaced by a
 * space, keeping the length.
 *
 * Every rule below runs against a masked copy and then slices the ORIGINAL text
 * with the offsets it found, so a keyword, comma or bracket that lives inside a
 * default (`default 'unique, not really'`), inside a quoted identifier, or
 * inside a comment can neither be matched nor split.
 *
 * Comments matter as much as quotes: SQLite stores the original CREATE TABLE
 * text verbatim, comments included, and an apostrophe inside a `--` comment
 * (“-- don't”) would otherwise open a string that never closes, masking the rest
 * of the statement and silently returning the DDL unstripped.
 *
 * `maskQuotes: false` leaves quoted regions readable, which is what the
 * constraint test needs: a constraint name may be quoted, and seeing spaces
 * there would hide the token that follows it. Quote and comment detection are
 * still tracked so a `--` inside a string is never read as a comment.
 *
 * SQLite has four quoting styles: `'…'`, `"…"`, `` `…` `` and `[…]`. A doubled
 * `'`, `"` or `` ` `` is an escaped terminator, not the end of the region, and
 * `[…]` does not double.
 */
function maskSqlText(text: string, options: { maskQuotes: boolean }): string {
  const chars = text.split("");
  let quoteEnd: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      else chars[index] = " ";
      continue;
    }
    if (inBlockComment) {
      chars[index] = " ";
      if (char === "*" && chars[index + 1] === "/") {
        chars[index + 1] = " ";
        index += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (quoteEnd !== null) {
      const doubled = char === quoteEnd && chars[index + 1] === quoteEnd && quoteEnd !== "]";
      if (options.maskQuotes) chars[index] = " ";
      if (char === quoteEnd) {
        if (doubled) {
          if (options.maskQuotes) chars[index + 1] = " ";
          index += 1;
        } else {
          quoteEnd = null;
        }
      }
      continue;
    }
    if (char === "-" && chars[index + 1] === "-") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      inLineComment = true;
      continue;
    }
    if (char === "/" && chars[index + 1] === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      inBlockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quoteEnd = char;
      if (options.maskQuotes) chars[index] = " ";
      continue;
    }
    if (char === "[") {
      quoteEnd = "]";
      if (options.maskQuotes) chars[index] = " ";
      continue;
    }
  }
  return chars.join("");
}

/** Comments and quoted regions both hidden. Used for scanning and slicing. */
function maskSqlQuotedText(text: string): string {
  return maskSqlText(text, { maskQuotes: true });
}

/** Only comments hidden, so a quoted constraint name stays readable. */
function stripSqlComments(text: string): string {
  return maskSqlText(text, { maskQuotes: false });
}

/** Offsets of the body between the outermost parentheses of a CREATE TABLE. */
function findCreateTableBody(sql: string): { open: number; close: number } | null {
  const masked = maskSqlQuotedText(sql);
  const open = masked.indexOf("(");
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return { open, close: index };
    }
  }
  return null;
}

/**
 * Split a CREATE TABLE body at the commas that separate its clauses.
 *
 * A comma inside a column type (`decimal(10, 2)`), inside a string default, or
 * inside a table constraint (`foreign key(a, b)`) does not end a clause, so the
 * scan tracks parenthesis depth and skips comments and quoted regions. This is
 * what keeps a clause that wraps across several lines ONE clause.
 */
function splitTopLevelSqlClauses(body: string): string[] {
  const masked = maskSqlQuotedText(body);
  const clauses: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      clauses.push(body.slice(start, index));
      start = index + 1;
    }
  }
  clauses.push(body.slice(start));
  return clauses;
}

/**
 * True when a clause is a table constraint cr-sqlite cannot carry.
 *
 * `crsql_as_crr` refuses a table with a checked foreign key or a UNIQUE
 * constraint, so the repair drops both. A column definition can never start
 * with these keywords: `unique` and `foreign` are reserved, so an unquoted
 * column cannot be named either, and a quoted name starts with its quote.
 *
 * Read the clause with its comments removed but its quotes intact — a comment
 * may sit in front of the keyword, or between `constraint` and the name.
 */
function isDroppedTableConstraint(clause: string): boolean {
  const withoutConstraintName = stripSqlComments(clause).replace(
    /^\s*constraint\s+(?:'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[\w$]+)\s*/i,
    "",
  );
  return /^(?:foreign\s+key|unique)\b/i.test(withoutConstraintName.trimStart());
}

/**
 * Drop the column-level `unique` keyword, and any `on conflict` clause after it.
 *
 * Reached only by clauses the test above kept, so the keyword here is always a
 * column constraint. Quotes and comments are hidden while matching, so a
 * default of `'unique'` keeps its text.
 */
function stripInlineUniqueKeyword(clause: string): string {
  const masked = maskSqlQuotedText(clause);
  const pattern = /\bunique\b(?:\s+on\s+conflict\s+[\w$]+)?/gi;
  let result = "";
  let cursor = 0;
  for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
    result += clause.slice(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  return cursor === 0 ? clause : result + clause.slice(cursor);
}

/**
 * Drop the table constraints cr-sqlite cannot carry from a CREATE TABLE.
 *
 * The body is split into top-level clauses instead of being filtered line by
 * line, so a wrapped foreign key goes in one piece.
 *
 * Returns `sql` unchanged when nothing was dropped, so the caller's
 * `nextSql === table.sql` short-circuit keeps working and a schema that has
 * already converged is never rebuilt a second time.
 */
export function stripCrrUnsupportedTableConstraints(sql: string): string {
  const body = findCreateTableBody(sql);
  if (!body) return sql;
  const clauses = splitTopLevelSqlClauses(sql.slice(body.open + 1, body.close));
  let changed = false;
  const kept: string[] = [];
  for (const clause of clauses) {
    if (!clause.trim()) continue;
    if (isDroppedTableConstraint(clause)) {
      changed = true;
      continue;
    }
    const withoutUnique = stripInlineUniqueKeyword(clause);
    if (withoutUnique !== clause) changed = true;
    kept.push(withoutUnique);
  }
  if (!changed) return sql;
  return `${sql.slice(0, body.open + 1)}${kept.join(",")}${sql.slice(body.close)}`;
}
