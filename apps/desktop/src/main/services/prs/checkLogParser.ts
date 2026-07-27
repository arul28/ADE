// ---------------------------------------------------------------------------
// GitHub Actions job-log parsing.
//
// `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` 302s to a plain-text
// blob. Every line is prefixed with an ISO-8601 timestamp, and steps are framed
// with `##[group]` / `##[endgroup]` workflow-command markers. This module is
// pure so it can be tested against a fixture without touching the network;
// `prService.getCheckLog` owns the streaming download.
// ---------------------------------------------------------------------------

/** `2026-07-27T10:00:00.1234567Z ` — leading per-line timestamp. */
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;
/** `##[group]`, `##[error]`, `##[command]`, … — Actions workflow commands. */
const WORKFLOW_COMMAND = /^##\[(\w+)\](.*)$/;

export type LogStepSection = {
  /** The `##[group]` header text, e.g. `Run npm test`. */
  title: string;
  /** Section body with timestamps and markers already stripped. */
  lines: string[];
  /** True when the section contains an `##[error]` line. */
  hasError: boolean;
};

/** Strip the ISO timestamp GitHub prefixes onto every log line. */
export function stripTimestamp(line: string): string {
  return line.replace(/\r$/, "").replace(TIMESTAMP_PREFIX, "");
}

/**
 * Split a raw job log into step sections.
 *
 * A top-level `##[group]` opens a section that runs until the next top-level
 * `##[group]`; nested groups stay inside their parent. Anything before the first
 * group becomes an untitled leading section so no output is lost.
 */
export function splitLogIntoSections(rawLog: string): LogStepSection[] {
  const sections: LogStepSection[] = [];
  let current: LogStepSection = { title: "", lines: [], hasError: false };
  let depth = 0;

  for (const rawLine of rawLog.split("\n")) {
    const line = stripTimestamp(rawLine);
    const command = WORKFLOW_COMMAND.exec(line);
    if (command) {
      const kind = command[1]!.toLowerCase();
      const rest = command[2] ?? "";
      if (kind === "group") {
        if (depth === 0) {
          if (current.title || current.lines.length) sections.push(current);
          current = { title: rest.trim(), lines: [], hasError: false };
        } else {
          current.lines.push(rest);
        }
        depth += 1;
        continue;
      }
      if (kind === "endgroup") {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (kind === "error" || kind === "warning" || kind === "notice") {
        if (kind === "error") current.hasError = true;
        // `##[error]file=…,line=…::message` — keep the message, drop the props.
        const separator = rest.indexOf("::");
        current.lines.push(separator >= 0 ? rest.slice(separator + 2) : rest);
        continue;
      }
      // `##[command]`, `##[debug]`, `##[section]`, … — keep the text only.
      current.lines.push(rest);
      continue;
    }
    current.lines.push(line);
  }
  if (current.title || current.lines.length) sections.push(current);
  return sections;
}

/**
 * Find the section belonging to a step.
 *
 * GitHub titles the group either with the step's `name:` or with the synthesized
 * `Run <command>`, so we accept an exact match, a `Run <name>` match, and a
 * containment match in that order — never a fuzzy substring in the other
 * direction, which would happily match the wrong step.
 */
export function findStepSection(
  sections: readonly LogStepSection[],
  stepName: string | null,
): LogStepSection | null {
  if (sections.length === 0) return null;
  const wanted = (stepName ?? "").trim().toLowerCase();
  if (wanted) {
    const exact = sections.find((section) => section.title.trim().toLowerCase() === wanted);
    if (exact) return exact;
    const run = sections.find((section) => section.title.trim().toLowerCase() === `run ${wanted}`);
    if (run) return run;
    const contains = sections.find((section) => section.title.trim().toLowerCase().includes(wanted));
    if (contains) return contains;
  }
  // No name match: the last section that actually errored is the best guess.
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (sections[i]!.hasError) return sections[i]!;
  }
  return sections[sections.length - 1] ?? null;
}

/**
 * Lift the test framework's own summary line, when we recognize one.
 *
 * Deliberately conservative: an unrecognized format returns `null` rather than
 * a guessed line, and nothing here can throw.
 */
export function extractHeadline(lines: readonly string[]): string | null {
  const patterns: RegExp[] = [
    // vitest: `Tests  3 failed | 42 passed (45)`
    // jest:   `Tests:       3 failed, 42 passed, 45 total`
    /^\s*Tests:?\s+.*\b\d+\s+failed\b/i,
    // pytest: `=========== 3 failed, 10 passed in 1.23s ===========`
    /^=+.*\b\d+\s+failed\b.*=+\s*$/i,
    // go test: `--- FAIL: TestThing (0.00s)`
    /^\s*---\s+FAIL:\s+\S+/,
  ];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line || line.length > 400) continue;
    for (const pattern of patterns) {
      if (pattern.test(line)) return line.trim();
    }
  }
  return null;
}

export type ParsedCheckLog = {
  lines: string[];
  headline: string | null;
  /** The section title we actually used, for diagnostics. */
  sectionTitle: string | null;
};

/**
 * Full parse: raw log text → the tail of the failing step, plus a headline.
 */
export function parseCheckLog(args: {
  rawLog: string;
  failingStepName: string | null;
  maxLines: number;
}): ParsedCheckLog {
  const sections = splitLogIntoSections(args.rawLog);
  const section = findStepSection(sections, args.failingStepName);
  const body = section ? section.lines : args.rawLog.split("\n").map(stripTimestamp);

  // Trim trailing blank lines so the drawer does not open on empty space.
  let end = body.length;
  while (end > 0 && body[end - 1]!.trim().length === 0) end -= 1;
  const trimmed = body.slice(0, end);

  const limit = Math.max(1, Math.floor(args.maxLines));
  return {
    lines: trimmed.slice(Math.max(0, trimmed.length - limit)),
    headline: extractHeadline(trimmed),
    sectionTitle: section?.title ?? null,
  };
}
