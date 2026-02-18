import { stripAnsi } from "../../utils/ansiStrip";
import { CONTEXT_CONTRACT_VERSION, CONTEXT_HEADER_SCHEMA_V1 } from "../../../shared/contextContract";
import type { PackConflictStateV1, PackDependencyStateV1 } from "../../../shared/types";
import type { PackGraphEnvelopeV1 } from "../../../shared/contextContract";

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
  projectId: string | null;
  laneId: string;
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
  graph?: PackGraphEnvelopeV1 | null;
  dependencyState?: PackDependencyStateV1 | null;
  conflictState?: PackConflictStateV1 | null;
  whatChangedLines: string[];
  inferredWhyLines: string[];
  userIntentMarkers: { start: string; end: string };
  userIntent: string;
  taskSpecMarkers: { start: string; end: string };
  taskSpec: string;
  validationLines: string[];
  keyFiles: Array<{ file: string; insertions: number | null; deletions: number | null }>;
  errors: string[];
  sessionsRows: Array<{ when: string; tool: string; goal: string; result: string; delta: string }>;
  sessionHighlights?: Array<{
    when: string;
    tool: string;
    summary: string;
    summarySource?: string;
    summaryConfidence?: string;
    summaryOmissionTags?: string[];
  }>;
  sessionsTotal: number;
  sessionsRunning: number;
  nextSteps: string[];
  userTodosMarkers: { start: string; end: string };
  userTodos: string;
  narrativeMarkers: { start: string; end: string };
  narrative: string;
}): string {
  const shortSha = args.headSha ? args.headSha.slice(0, 8) : "unknown";
  const cleanliness = args.dirty ? "dirty" : "clean";

  const lines: string[] = [];
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        schema: CONTEXT_HEADER_SCHEMA_V1,
        contractVersion: CONTEXT_CONTRACT_VERSION,
        projectId: args.projectId,
        packKey: args.packKey,
        packType: "lane",
        laneId: args.laneId,
        peerKey: null,
        baseRef: args.baseRef,
        headSha: args.headSha,
        deterministicUpdatedAt: args.deterministicUpdatedAt,
        narrativeUpdatedAt: null,
        versionId: null,
        versionNumber: null,
        contentHash: null,
        providerMode: args.providerMode,
        graph: args.graph ?? null,
        dependencyState: args.dependencyState ?? null,
        conflictState: args.conflictState ?? null
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");
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

  lines.push("## Task Spec");
  lines.push(args.taskSpecMarkers.start);
  lines.push(stripAnsi(args.taskSpec).trim().length ? stripAnsi(args.taskSpec).trim() : "- (add task spec here)");
  lines.push(args.taskSpecMarkers.end);
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
  const highlights = Array.isArray(args.sessionHighlights) ? args.sessionHighlights : [];
  if (highlights.length) {
    lines.push("");
    lines.push("Recent summaries:");
    for (const h of highlights.slice(0, 3)) {
      const when = stripAnsi(h.when).trim();
      const tool = stripAnsi(h.tool).trim();
      const summary = stripAnsi(h.summary).trim();
      if (!summary) continue;
      const clipped = summary.length > 240 ? `${summary.slice(0, 239)}…` : summary;
      const source = stripAnsi(h.summarySource ?? "").trim();
      const confidence = stripAnsi(h.summaryConfidence ?? "").trim();
      const omissions = Array.isArray(h.summaryOmissionTags)
        ? h.summaryOmissionTags.map((entry) => stripAnsi(String(entry)).trim()).filter(Boolean)
        : [];
      const tags: string[] = [];
      if (source) tags.push(`source=${source}`);
      if (confidence) tags.push(`confidence=${confidence}`);
      if (omissions.length) tags.push(`omissions=${omissions.join(",")}`);
      const prefix = tags.length ? ` [${tags.join(" ")}]` : "";
      lines.push(`- ${when} ${tool}${prefix}: ${clipped}`);
    }
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
  lines.push(args.narrativeMarkers.start);
  lines.push(stripAnsi(args.narrative).trim().length ? stripAnsi(args.narrative).trim() : "AI narrative not yet generated.");
  lines.push(args.narrativeMarkers.end);
  lines.push("");

  lines.push("---");
  lines.push(
    `*Updated: ${stripAnsi(args.deterministicUpdatedAt)} | Trigger: ${stripAnsi(args.trigger)} | Provider: ${stripAnsi(args.providerMode)} | [View history →](ade://packs/versions/${stripAnsi(args.packKey)})*`
  );
  lines.push("");

  return `${lines.join("\n")}\n`;
}
