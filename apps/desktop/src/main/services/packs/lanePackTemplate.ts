import { stripAnsi } from "../../utils/ansiStrip";

function fmtChange(insertions: number | null, deletions: number | null): string {
  if (insertions == null || deletions == null) return "binary";
  return `+${insertions}/-${deletions}`;
}

function mdCode(value: string): string {
  // Inline code cannot contain backticks without escaping; keep it simple.
  const clean = value.replace(/`/g, "'");
  return `\`${clean}\``;
}

export function renderLanePackMarkdown(args: {
  packKey: string;
  laneName: string;
  branchRef: string;
  baseRef: string;
  headSha: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  parentName: string | null;
  deterministicUpdatedAt: string;
  trigger: string;
  providerMode: string;
  whatChangedLines: string[];
  inferredWhyLines: string[];
  userIntentMarkers: { start: string; end: string };
  userIntent: string;
  validationLines: string[];
  keyFiles: Array<{ file: string; insertions: number | null; deletions: number | null }>;
  errors: string[];
  sessionsRows: Array<{ when: string; tool: string; goal: string; result: string; delta: string }>;
  sessionsTotal: number;
  sessionsRunning: number;
  nextSteps: string[];
  userTodosMarkers: { start: string; end: string };
  userTodos: string;
  narrativePlaceholder: string;
}): string {
  const shortSha = args.headSha ? args.headSha.slice(0, 8) : "unknown";
  const cleanliness = args.dirty ? "dirty" : "clean";

  const lines: string[] = [];
  lines.push(`# Lane: ${stripAnsi(args.laneName)}`);
  lines.push(`> Branch: ${mdCode(stripAnsi(args.branchRef))} | Base: ${mdCode(stripAnsi(args.baseRef))} | HEAD: ${mdCode(shortSha)} | ${cleanliness} · ahead ${args.ahead} · behind ${args.behind}`);
  if (args.parentName) lines.push(`> Parent: ${stripAnsi(args.parentName)}`);
  lines.push("");

  lines.push("## What Changed");
  if (args.whatChangedLines.length) {
    for (const entry of args.whatChangedLines) lines.push(`- ${stripAnsi(entry)}`);
  } else {
    lines.push("- No changes detected yet.");
  }
  lines.push("");

  lines.push("## Why");
  lines.push(args.userIntentMarkers.start);
  lines.push(stripAnsi(args.userIntent).trim().length ? stripAnsi(args.userIntent).trim() : "Intent not set — click to add.");
  lines.push(args.userIntentMarkers.end);
  if (args.inferredWhyLines.length) {
    lines.push("");
    lines.push("Inferred from commits:");
    for (const entry of args.inferredWhyLines) lines.push(`- ${stripAnsi(entry)}`);
  }
  lines.push("");

  lines.push("## Validation");
  if (args.validationLines.length) {
    for (const entry of args.validationLines) lines.push(`- ${stripAnsi(entry)}`);
  } else {
    lines.push("- Tests: NOT RUN");
    lines.push("- Lint: NOT RUN");
  }
  lines.push("");

  lines.push(`## Key Files (${args.keyFiles.length} files touched)`);
  if (!args.keyFiles.length) {
    lines.push("No files touched.");
    lines.push("");
  } else {
    lines.push("| File | Change |");
    lines.push("|------|--------|");
    for (const row of args.keyFiles.slice(0, 10)) {
      lines.push(`| ${mdCode(stripAnsi(row.file))} | ${fmtChange(row.insertions, row.deletions)} |`);
    }
    lines.push("");
  }

  lines.push("## Errors & Issues");
  if (!args.errors.length) {
    lines.push("No errors detected.");
  } else {
    for (const entry of args.errors.slice(0, 12)) lines.push(`- ${stripAnsi(entry)}`);
  }
  lines.push("");

  lines.push(`## Sessions (${args.sessionsTotal} total, ${args.sessionsRunning} running)`);
  lines.push("| When | Tool | Goal | Result | Delta |");
  lines.push("|------|------|------|--------|-------|");
  if (args.sessionsRows.length) {
    for (const row of args.sessionsRows.slice(0, 5)) {
      lines.push(
        `| ${stripAnsi(row.when)} | ${stripAnsi(row.tool)} | ${stripAnsi(row.goal)} | ${stripAnsi(row.result)} | ${stripAnsi(row.delta)} |`
      );
    }
  } else {
    lines.push("| - | - | - | - | - |");
  }
  lines.push("");

  lines.push("## Open Questions / Next Steps");
  if (args.nextSteps.length) {
    for (const entry of args.nextSteps) lines.push(`- ${stripAnsi(entry)}`);
  } else {
    lines.push("- (none detected)");
  }
  lines.push("");
  lines.push(args.userTodosMarkers.start);
  lines.push(stripAnsi(args.userTodos).trim().length ? stripAnsi(args.userTodos).trim() : "- (add notes/todos here)");
  lines.push(args.userTodosMarkers.end);
  lines.push("");

  lines.push("## Narrative");
  lines.push(stripAnsi(args.narrativePlaceholder).trim().length ? stripAnsi(args.narrativePlaceholder).trim() : "AI narrative not yet generated.");
  lines.push("");

  lines.push("---");
  lines.push(
    `*Updated: ${stripAnsi(args.deterministicUpdatedAt)} | Trigger: ${stripAnsi(args.trigger)} | Provider: ${stripAnsi(args.providerMode)} | [View history →](ade://packs/versions/${stripAnsi(args.packKey)})*`
  );
  lines.push("");

  return `${lines.join("\n")}\n`;
}
