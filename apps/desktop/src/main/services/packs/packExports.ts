import type {
  ConflictLineageV1,
  ContextExportLevel,
  ContextHeaderV1,
  LaneExportManifestV1,
  PackConflictStateV1,
  PackDependencyStateV1,
  PackExport,
  PackSummary,
  PackType,
  ProjectExportManifestV1,
  ProviderMode
} from "../../../shared/types";
import { CONTEXT_CONTRACT_VERSION, CONTEXT_HEADER_SCHEMA_V1 } from "../../../shared/contextContract";
import type { ExportOmissionV1, PackGraphEnvelopeV1 } from "../../../shared/contextContract";
import { stripAnsi } from "../../utils/ansiStrip";
import { extractBetweenMarkers, renderJsonSection } from "./packSections";

type Budget = { maxTokens: number };

const DEFAULT_BUDGETS: Record<PackType, Record<ContextExportLevel, Budget>> = {
  project: {
    lite: { maxTokens: 900 },
    standard: { maxTokens: 2500 },
    deep: { maxTokens: 6500 }
  },
  lane: {
    lite: { maxTokens: 800 },
    standard: { maxTokens: 2800 },
    deep: { maxTokens: 8000 }
  },
  conflict: {
    lite: { maxTokens: 1100 },
    standard: { maxTokens: 3200 },
    deep: { maxTokens: 9000 }
  },
  feature: {
    lite: { maxTokens: 1000 },
    standard: { maxTokens: 2800 },
    deep: { maxTokens: 8000 }
  },
  plan: {
    lite: { maxTokens: 1100 },
    standard: { maxTokens: 3200 },
    deep: { maxTokens: 9000 }
  },
  mission: {
    lite: { maxTokens: 1200 },
    standard: { maxTokens: 3600 },
    deep: { maxTokens: 9000 }
  }
};

function approxTokensFromText(text: string): number {
  // Lightweight heuristic: ~4 characters/token for English+code.
  return Math.max(0, Math.ceil((text ?? "").length / 4));
}

function normalizeForExport(text: string): string {
  // Keep exports stable, human-readable, and safe to send over the wire.
  return stripAnsi(String(text ?? "")).replace(/\r\n/g, "\n");
}

function renderHeaderFence(header: ContextHeaderV1, opts: { pretty?: boolean } = {}): string {
  const pretty = opts.pretty !== false;
  return ["```json", pretty ? JSON.stringify(header, null, 2) : JSON.stringify(header), "```", ""].join("\n");
}

function ensureBudgetOmission(omissions: ExportOmissionV1[], truncated: boolean): ExportOmissionV1[] {
  if (!truncated) return omissions;
  if (omissions.some((o) => o.sectionId === "export" && o.reason === "budget_clipped")) return omissions;
  return [
    ...omissions,
    {
      sectionId: "export",
      reason: "budget_clipped",
      detail: "Export clipped to fit token budget.",
      recommendedLevel: "deep"
    }
  ];
}

function takeLines(lines: string[], max: number): { lines: string[]; truncated: boolean } {
  if (lines.length <= max) return { lines, truncated: false };
  return { lines: lines.slice(0, Math.max(0, max)), truncated: true };
}

function clipBlock(text: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = normalizeForExport(text ?? "").trim();
  if (maxChars <= 0) return { text: normalized, truncated: false };
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  const clipped = `${normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n...(truncated)...\n`;
  return { text: clipped, truncated: true };
}

function extractSectionLines(args: {
  content: string;
  headingPrefix: string;
  maxLines: number;
}): { lines: string[]; truncated: boolean } {
  const raw = normalizeForExport(args.content);
  const lines = raw.split("\n");

  const startIdx = lines.findIndex((line) => line.trim() === args.headingPrefix || line.startsWith(args.headingPrefix));
  if (startIdx < 0) return { lines: [], truncated: false };

  const out: string[] = [];
  let inCodeFence = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) inCodeFence = !inCodeFence;
    if (!inCodeFence && trimmed.startsWith("## ")) break;
    if (!inCodeFence && trimmed === "---") break;
    out.push(line);
  }

  // Drop leading/trailing whitespace-only lines to keep exports tidy.
  while (out.length && !out[0]!.trim()) out.shift();
  while (out.length && !out[out.length - 1]!.trim()) out.pop();

  return takeLines(out, args.maxLines);
}

function clipToBudget(args: { content: string; maxTokens: number }): { content: string; truncated: boolean } {
  const normalized = normalizeForExport(args.content);
  const approx = approxTokensFromText(normalized);
  if (approx <= args.maxTokens) return { content: normalized, truncated: false };

  const maxChars = Math.max(0, args.maxTokens * 4);
  if (normalized.length <= maxChars) return { content: normalized, truncated: false };
  const clipped = `${normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n\n...(truncated)...\n`;
  return { content: clipped, truncated: true };
}

export function buildLaneExport(args: {
  level: ContextExportLevel;
  projectId: string | null;
  laneId: string;
  laneName: string;
  branchRef: string;
  baseRef: string;
  headSha: string | null;
  pack: PackSummary;
  providerMode: ProviderMode;
  apiBaseUrl: string | null;
  remoteProjectId: string | null;
  graph?: PackGraphEnvelopeV1 | null;
  manifest?: LaneExportManifestV1 | null;
  dependencyState?: PackDependencyStateV1 | null;
  conflictState?: PackConflictStateV1 | null;
  markers: {
    taskSpecStart: string;
    taskSpecEnd: string;
    intentStart: string;
    intentEnd: string;
    todosStart: string;
    todosEnd: string;
    narrativeStart: string;
    narrativeEnd: string;
  };
  conflictRiskSummaryLines: string[];
}): PackExport {
  const level = args.level;
  const budget = DEFAULT_BUDGETS.lane[level];

  const body = normalizeForExport(args.pack.body ?? "");

  const taskSpecRaw =
    extractBetweenMarkers(body, args.markers.taskSpecStart, args.markers.taskSpecEnd) ??
    "(task spec missing; lane context markers unavailable)";
  const intentRaw =
    extractBetweenMarkers(body, args.markers.intentStart, args.markers.intentEnd) ??
    "(intent missing; lane context markers unavailable)";
  const todosRaw = extractBetweenMarkers(body, args.markers.todosStart, args.markers.todosEnd) ?? "";
  const narrativeRaw = extractBetweenMarkers(body, args.markers.narrativeStart, args.markers.narrativeEnd) ?? "";

  const whatChanged = extractSectionLines({
    content: body,
    headingPrefix: "## What Changed",
    maxLines: level === "lite" ? 10 : level === "standard" ? 24 : 80
  });
  const validation = extractSectionLines({
    content: body,
    headingPrefix: "## Validation",
    maxLines: level === "lite" ? 8 : level === "standard" ? 16 : 40
  });
  const keyFiles = extractSectionLines({
    content: body,
    headingPrefix: "## Key Files",
    maxLines: level === "lite" ? 10 : level === "standard" ? 20 : 60
  });
  const errors = extractSectionLines({
    content: body,
    headingPrefix: "## Errors & Issues",
    maxLines: level === "lite" ? 12 : level === "standard" ? 30 : 120
  });
  const sessions = extractSectionLines({
    content: body,
    headingPrefix: "## Sessions",
    maxLines: level === "lite" ? 12 : level === "standard" ? 24 : 80
  });
  const nextSteps = extractSectionLines({
    content: body,
    headingPrefix: "## Open Questions / Next Steps",
    maxLines: level === "lite" ? 16 : level === "standard" ? 40 : 120
  });

  const warnings: string[] = [];
  const omissionsBase: ExportOmissionV1[] = [];
  const userBlockLimits =
    level === "lite"
      ? { taskSpecChars: 650, intentChars: 360, todosChars: 450, narrativeChars: 0 }
      : level === "standard"
        ? { taskSpecChars: 2200, intentChars: 1400, todosChars: 1200, narrativeChars: 0 }
        : { taskSpecChars: 4000, intentChars: 2200, todosChars: 2000, narrativeChars: 5000 };

  const taskSpec = clipBlock(taskSpecRaw, userBlockLimits.taskSpecChars);
  const intent = clipBlock(intentRaw, userBlockLimits.intentChars);
  const todos = clipBlock(todosRaw, userBlockLimits.todosChars);
  const narrative = clipBlock(narrativeRaw, userBlockLimits.narrativeChars);

  if (taskSpec.truncated) {
    warnings.push("Task Spec section truncated for export budget.");
    omissionsBase.push({ sectionId: "task_spec", reason: "truncated_section", detail: "Task Spec truncated." });
  }
  if (intent.truncated) {
    warnings.push("Intent section truncated for export budget.");
    omissionsBase.push({ sectionId: "intent", reason: "truncated_section", detail: "Intent truncated." });
  }
  if (todos.truncated) {
    warnings.push("Todos section truncated for export budget.");
    omissionsBase.push({ sectionId: "todos", reason: "truncated_section", detail: "Todos truncated." });
  }
  if (narrative.truncated) {
    warnings.push("Narrative section truncated for export budget.");
    omissionsBase.push({ sectionId: "narrative", reason: "truncated_section", detail: "Narrative truncated." });
  }
  if (whatChanged.truncated) {
    warnings.push("What Changed section truncated for export budget.");
    omissionsBase.push({ sectionId: "what_changed", reason: "truncated_section", detail: "What Changed truncated." });
  }
  if (validation.truncated) {
    warnings.push("Validation section truncated for export budget.");
    omissionsBase.push({ sectionId: "validation", reason: "truncated_section", detail: "Validation truncated." });
  }
  if (keyFiles.truncated) {
    warnings.push("Key Files section truncated for export budget.");
    omissionsBase.push({ sectionId: "key_files", reason: "truncated_section", detail: "Key Files truncated." });
  }
  if (errors.truncated) {
    warnings.push("Errors section truncated for export budget.");
    omissionsBase.push({ sectionId: "errors", reason: "truncated_section", detail: "Errors truncated." });
  }
  if (sessions.truncated) {
    warnings.push("Sessions section truncated for export budget.");
    omissionsBase.push({ sectionId: "sessions", reason: "truncated_section", detail: "Sessions truncated." });
  }
  if (nextSteps.truncated) {
    warnings.push("Next Steps section truncated for export budget.");
    omissionsBase.push({ sectionId: "next_steps", reason: "truncated_section", detail: "Next Steps truncated." });
  }

  const exportedAt = new Date().toISOString();
  const header: ContextHeaderV1 = {
    schema: CONTEXT_HEADER_SCHEMA_V1,
    contractVersion: CONTEXT_CONTRACT_VERSION,
    projectId: args.projectId,
    packKey: args.pack.packKey,
    packType: "lane",
    exportLevel: level,
    laneId: args.laneId,
    peerKey: null,
    baseRef: args.baseRef,
    headSha: args.headSha,
    deterministicUpdatedAt: args.pack.deterministicUpdatedAt,
    narrativeUpdatedAt: args.pack.narrativeUpdatedAt,
    versionId: args.pack.versionId ?? null,
    versionNumber: args.pack.versionNumber ?? null,
    contentHash: args.pack.contentHash ?? null,
    providerMode: args.providerMode,
    exportedAt,
    apiBaseUrl: args.apiBaseUrl,
    remoteProjectId: args.remoteProjectId,
    graph: args.graph ?? null,
    dependencyState: args.dependencyState ?? null,
    conflictState: args.conflictState ?? null,
    omissions: null
  };

  const lines: string[] = [];
  lines.push(`# Lane Export (${level.toUpperCase()})`);
  lines.push(
    `> Lane: ${normalizeForExport(args.laneName)} | Branch: \`${normalizeForExport(args.branchRef)}\` | Base: \`${normalizeForExport(args.baseRef)}\``
  );
  lines.push("");

  if (args.manifest) {
    const liteManifest =
      level === "lite"
        ? {
            schema: args.manifest.schema,
            projectId: args.manifest.projectId,
            laneId: args.manifest.laneId,
            laneName: args.manifest.laneName,
            laneType: args.manifest.laneType,
            branchRef: args.manifest.branchRef,
            baseRef: args.manifest.baseRef,
            lineage: args.manifest.lineage,
            mergeConstraints: args.manifest.mergeConstraints,
            branchState: {
              baseRef: args.manifest.branchState?.baseRef ?? null,
              headRef: args.manifest.branchState?.headRef ?? null,
              headSha: args.manifest.branchState?.headSha ?? null,
              lastPackRefreshAt: args.manifest.branchState?.lastPackRefreshAt ?? null,
              isEditProtected: args.manifest.branchState?.isEditProtected ?? null,
              packStale: args.manifest.branchState?.packStale ?? null,
              ...(args.manifest.branchState?.packStaleReason ? { packStaleReason: args.manifest.branchState.packStaleReason } : {})
            },
            conflicts: {
              activeConflictPackKeys: args.manifest.conflicts?.activeConflictPackKeys ?? [],
              unresolvedPairCount: args.manifest.conflicts?.unresolvedPairCount ?? 0,
              lastConflictRefreshAt: args.manifest.conflicts?.lastConflictRefreshAt ?? null,
              lastConflictRefreshAgeMs: args.manifest.conflicts?.lastConflictRefreshAgeMs ?? null,
              ...(args.manifest.conflicts?.predictionStale != null ? { predictionStale: args.manifest.conflicts.predictionStale } : {}),
              ...(args.manifest.conflicts?.stalePolicy ? { stalePolicy: args.manifest.conflicts.stalePolicy } : {}),
              ...(args.manifest.conflicts?.staleReason ? { staleReason: args.manifest.conflicts.staleReason } : {})
            }
          }
        : args.manifest;

    lines.push(...renderJsonSection("## Manifest", liteManifest, { pretty: level !== "lite" }));
  } else {
    lines.push(...renderJsonSection("## Manifest", { schema: "ade.manifest.lane.v1", unavailable: true }, { pretty: level !== "lite" }));
    omissionsBase.push({ sectionId: "manifest", reason: "data_unavailable", detail: "Manifest unavailable." });
  }

  lines.push("## Task Spec");
  lines.push(args.markers.taskSpecStart);
  lines.push(taskSpec.text);
  lines.push(args.markers.taskSpecEnd);
  lines.push("");

  lines.push("## Intent");
  lines.push(args.markers.intentStart);
  lines.push(intent.text);
  lines.push(args.markers.intentEnd);
  lines.push("");

  lines.push("## Conflict Risk Summary");
  if (args.conflictRiskSummaryLines.length) {
    const max = level === "lite" ? 8 : args.conflictRiskSummaryLines.length;
    for (const line of args.conflictRiskSummaryLines.slice(0, max)) lines.push(line);
  } else {
    lines.push("- Conflict status: unknown (prediction not available yet)");
  }
  lines.push("");

  if (whatChanged.lines.length) {
    lines.push("## What Changed");
    lines.push(...whatChanged.lines);
    lines.push("");
  }

  if (validation.lines.length) {
    lines.push("## Validation");
    lines.push(...validation.lines);
    lines.push("");
  }

  if (keyFiles.lines.length) {
    lines.push("## Key Files");
    lines.push(...keyFiles.lines);
    lines.push("");
  }

  if (errors.lines.length) {
    lines.push("## Errors & Issues");
    lines.push(...errors.lines);
    lines.push("");
  }

  if (sessions.lines.length) {
    lines.push("## Sessions");
    lines.push(...sessions.lines);
    lines.push("");
  }

  if (nextSteps.lines.length) {
    lines.push("## Next Steps");
    lines.push(...nextSteps.lines);
    lines.push("");
  }

  if (todos.text.trim().length) {
    lines.push("## Notes / Todos");
    lines.push(args.markers.todosStart);
    lines.push(todos.text);
    lines.push(args.markers.todosEnd);
    lines.push("");
  }

  if (level === "deep" && narrative.text.trim().length) {
    lines.push("## Narrative (Deep)");
    lines.push(args.markers.narrativeStart);
    lines.push(narrative.text);
    lines.push(args.markers.narrativeEnd);
    lines.push("");
  } else if (level !== "deep") {
    omissionsBase.push({
      sectionId: "narrative",
      reason: "omitted_by_level",
      detail: "Narrative is only included at deep export level.",
      recommendedLevel: "deep"
    });
  }

  const buildContent = (omissions: ExportOmissionV1[]) => {
    header.omissions = omissions.length ? omissions : null;
    header.maxTokens = budget.maxTokens;
    const draft = `${renderHeaderFence(header, { pretty: level !== "lite" })}${lines.join("\n")}\n`;
    return clipToBudget({ content: draft, maxTokens: budget.maxTokens });
  };

  let clipped = buildContent(omissionsBase);
  const omissionsFinal = ensureBudgetOmission(omissionsBase, clipped.truncated);
  if (omissionsFinal !== omissionsBase) {
    clipped = buildContent(omissionsFinal);
  }

  const approxTokens = approxTokensFromText(clipped.content);
  header.approxTokens = approxTokens;

  return {
    packKey: args.pack.packKey,
    packType: "lane",
    level,
    header,
    content: clipped.content,
    approxTokens,
    maxTokens: budget.maxTokens,
    truncated: clipped.truncated,
    warnings: clipped.truncated ? [...warnings, "Export clipped to fit token budget."] : warnings,
    clipReason: clipped.truncated ? "budget_clipped" : null,
    omittedSections: (header.omissions ?? []).map((entry) => entry.sectionId)
  };
}

export function buildProjectExport(args: {
  level: ContextExportLevel;
  projectId: string | null;
  pack: PackSummary;
  providerMode: ProviderMode;
  apiBaseUrl: string | null;
  remoteProjectId: string | null;
  graph?: PackGraphEnvelopeV1 | null;
  manifest?: ProjectExportManifestV1 | null;
}): PackExport {
  const level = args.level;
  const budget = DEFAULT_BUDGETS.project[level];
  const body = normalizeForExport(args.pack.body ?? "");

  const overview = extractSectionLines({
    content: body,
    headingPrefix: "# Project Pack",
    maxLines: level === "lite" ? 60 : level === "standard" ? 140 : 400
  });

  const warnings: string[] = [];
  const omissionsBase: ExportOmissionV1[] = [];

  const exportedAt = new Date().toISOString();
  const header: ContextHeaderV1 = {
    schema: CONTEXT_HEADER_SCHEMA_V1,
    contractVersion: CONTEXT_CONTRACT_VERSION,
    projectId: args.projectId,
    packKey: args.pack.packKey,
    packType: "project",
    exportLevel: level,
    laneId: null,
    peerKey: null,
    baseRef: null,
    headSha: null,
    deterministicUpdatedAt: args.pack.deterministicUpdatedAt,
    narrativeUpdatedAt: args.pack.narrativeUpdatedAt,
    versionId: args.pack.versionId ?? null,
    versionNumber: args.pack.versionNumber ?? null,
    contentHash: args.pack.contentHash ?? null,
    providerMode: args.providerMode,
    exportedAt,
    apiBaseUrl: args.apiBaseUrl,
    remoteProjectId: args.remoteProjectId,
    graph: args.graph ?? null,
    omissions: null
  };

  const lines: string[] = [];
  lines.push(`# Project Export (${level.toUpperCase()})`);
  lines.push("");

  if (args.manifest) {
    lines.push(...renderJsonSection("## Manifest", args.manifest, { pretty: level !== "lite" }));
  } else {
    lines.push(...renderJsonSection("## Manifest", { schema: "ade.manifest.project.v1", unavailable: true }, { pretty: level !== "lite" }));
    omissionsBase.push({ sectionId: "manifest", reason: "data_unavailable", detail: "Manifest unavailable." });
  }

  if (overview.lines.length) {
    lines.push("## Snapshot");
    lines.push(...overview.lines);
    lines.push("");
  } else {
    lines.push("## Snapshot");
    lines.push("- Project context is currently unavailable.");
    lines.push("");
    omissionsBase.push({ sectionId: "snapshot", reason: "data_unavailable", detail: "Snapshot unavailable." });
  }

  if (overview.truncated) {
    warnings.push("Project snapshot truncated for export budget.");
    omissionsBase.push({ sectionId: "snapshot", reason: "truncated_section", detail: "Snapshot truncated." });
  }

  const buildContent = (omissions: ExportOmissionV1[]) => {
    header.omissions = omissions.length ? omissions : null;
    header.maxTokens = budget.maxTokens;
    const draft = `${renderHeaderFence(header, { pretty: level !== "lite" })}${lines.join("\n")}\n`;
    return clipToBudget({ content: draft, maxTokens: budget.maxTokens });
  };

  let clipped = buildContent(omissionsBase);
  const omissionsFinal = ensureBudgetOmission(omissionsBase, clipped.truncated);
  if (omissionsFinal !== omissionsBase) {
    clipped = buildContent(omissionsFinal);
  }

  const approxTokens = approxTokensFromText(clipped.content);
  header.approxTokens = approxTokens;

  return {
    packKey: args.pack.packKey,
    packType: "project",
    level,
    header,
    content: clipped.content,
    approxTokens,
    maxTokens: budget.maxTokens,
    truncated: clipped.truncated,
    warnings: clipped.truncated ? [...warnings, "Export clipped to fit token budget."] : warnings,
    clipReason: clipped.truncated ? "budget_clipped" : null,
    omittedSections: (header.omissions ?? []).map((entry) => entry.sectionId)
  };
}

export function buildConflictExport(args: {
  level: ContextExportLevel;
  projectId: string | null;
  packKey: string;
  laneId: string;
  peerLabel: string;
  pack: PackSummary;
  providerMode: ProviderMode;
  apiBaseUrl: string | null;
  remoteProjectId: string | null;
  graph?: PackGraphEnvelopeV1 | null;
  lineage?: ConflictLineageV1 | null;
}): PackExport {
  const level = args.level;
  const budget = DEFAULT_BUDGETS.conflict[level];
  const body = normalizeForExport(args.pack.body ?? "");

  const overlapLines = extractSectionLines({
    content: body,
    headingPrefix: "## Overlapping Files",
    maxLines: level === "lite" ? 24 : level === "standard" ? 60 : 220
  });
  const conflictsLines = extractSectionLines({
    content: body,
    headingPrefix: "## Conflicts (merge-tree)",
    maxLines: level === "lite" ? 60 : level === "standard" ? 140 : 400
  });

  const warnings: string[] = [];
  const omissionsBase: ExportOmissionV1[] = [];
  if (overlapLines.truncated) warnings.push("Overlap list truncated for export budget.");
  if (conflictsLines.truncated) warnings.push("Conflicts section truncated for export budget.");
  if (overlapLines.truncated) omissionsBase.push({ sectionId: "overlap_files", reason: "truncated_section", detail: "Overlap list truncated." });
  if (conflictsLines.truncated) omissionsBase.push({ sectionId: "merge_tree", reason: "truncated_section", detail: "Merge-tree conflicts truncated." });

  const exportedAt = new Date().toISOString();
  const header: ContextHeaderV1 = {
    schema: CONTEXT_HEADER_SCHEMA_V1,
    contractVersion: CONTEXT_CONTRACT_VERSION,
    projectId: args.projectId,
    packKey: args.packKey,
    packType: "conflict",
    exportLevel: level,
    laneId: args.laneId,
    peerKey: args.peerLabel,
    baseRef: null,
    headSha: args.pack.lastHeadSha ?? null,
    deterministicUpdatedAt: args.pack.deterministicUpdatedAt,
    narrativeUpdatedAt: args.pack.narrativeUpdatedAt,
    versionId: args.pack.versionId ?? null,
    versionNumber: args.pack.versionNumber ?? null,
    contentHash: args.pack.contentHash ?? null,
    providerMode: args.providerMode,
    exportedAt,
    apiBaseUrl: args.apiBaseUrl,
    remoteProjectId: args.remoteProjectId,
    graph: args.graph ?? null,
    omissions: null
  };

  const lines: string[] = [];
  lines.push(`# Conflict Export (${level.toUpperCase()})`);
  lines.push(`> Lane: ${args.laneId} | Peer: ${normalizeForExport(args.peerLabel)}`);
  lines.push("");

  if (args.lineage) {
    lines.push(...renderJsonSection("## Conflict Lineage", args.lineage, { pretty: level !== "lite" }));
  } else {
    omissionsBase.push({ sectionId: "conflict_lineage", reason: "data_unavailable", detail: "Conflict lineage unavailable." });
  }

  lines.push("## Overlapping Files");
  if (overlapLines.lines.length) lines.push(...overlapLines.lines);
  else lines.push("- (none listed; live conflict context is unavailable)");
  lines.push("");

  lines.push("## Conflicts (merge-tree)");
  if (conflictsLines.lines.length) lines.push(...conflictsLines.lines);
  else lines.push("- (none listed; live conflict context is unavailable)");
  lines.push("");

  const buildContent = (omissions: ExportOmissionV1[]) => {
    header.omissions = omissions.length ? omissions : null;
    header.maxTokens = budget.maxTokens;
    const draft = `${renderHeaderFence(header, { pretty: level !== "lite" })}${lines.join("\n")}\n`;
    return clipToBudget({ content: draft, maxTokens: budget.maxTokens });
  };

  let clipped = buildContent(omissionsBase);
  const omissionsFinal = ensureBudgetOmission(omissionsBase, clipped.truncated);
  if (omissionsFinal !== omissionsBase) {
    clipped = buildContent(omissionsFinal);
  }

  const approxTokens = approxTokensFromText(clipped.content);
  header.approxTokens = approxTokens;

  return {
    packKey: args.packKey,
    packType: "conflict",
    level,
    header,
    content: clipped.content,
    approxTokens,
    maxTokens: budget.maxTokens,
    truncated: clipped.truncated,
    warnings: clipped.truncated ? [...warnings, "Export clipped to fit token budget."] : warnings,
    clipReason: clipped.truncated ? "budget_clipped" : null,
    omittedSections: (header.omissions ?? []).map((entry) => entry.sectionId)
  };
}
