import type { ComponentType } from "react";

// ── Event Categories ─────────────────────────────────────────────
export type EventCategory =
  | "git"
  | "lane"
  | "session"
  | "pack"
  | "conflict"
  | "pr"
  | "mission"
  | "automation"
  | "process"
  | "system";

// ── Node Shapes (for SVG rendering) ─────────────────────────────
export type NodeShape = "circle" | "diamond" | "square" | "triangle" | "pill" | "star" | "bookmark" | "dot";

// ── Category Metadata ────────────────────────────────────────────
export type CategoryMeta = {
  label: string;
  color: string;          // primary color
  colorMuted: string;     // at 15% opacity for backgrounds
  shape: NodeShape;       // default shape for events in this category
};

export const CATEGORY_META: Record<EventCategory, CategoryMeta> = {
  git: {
    label: "Git",
    color: "#22C55E",
    colorMuted: "rgba(34,197,94,0.15)",
    shape: "circle",
  },
  lane: {
    label: "Lanes",
    color: "#A78BFA",
    colorMuted: "rgba(167,139,250,0.15)",
    shape: "diamond",
  },
  session: {
    label: "Sessions",
    color: "#3B82F6",
    colorMuted: "rgba(59,130,246,0.15)",
    shape: "square",
  },
  pack: {
    label: "Packs",
    color: "#F59E0B",
    colorMuted: "rgba(245,158,11,0.15)",
    shape: "bookmark",
  },
  conflict: {
    label: "Conflicts",
    color: "#EF4444",
    colorMuted: "rgba(239,68,68,0.15)",
    shape: "triangle",
  },
  pr: {
    label: "Pull Requests",
    color: "#06B6D4",
    colorMuted: "rgba(6,182,212,0.15)",
    shape: "pill",
  },
  mission: {
    label: "Missions",
    color: "#8B5CF6",
    colorMuted: "rgba(139,92,246,0.15)",
    shape: "star",
  },
  automation: {
    label: "Automations",
    color: "#14B8A6",
    colorMuted: "rgba(20,184,166,0.15)",
    shape: "diamond",
  },
  process: {
    label: "Processes",
    color: "#6366F1",
    colorMuted: "rgba(99,102,241,0.15)",
    shape: "square",
  },
  system: {
    label: "System",
    color: "#8B8B9A",
    colorMuted: "rgba(139,139,154,0.15)",
    shape: "dot",
  },
};

// ── Event Kind Metadata ──────────────────────────────────────────
export type EventKindMeta = {
  label: string;           // Human-readable label
  category: EventCategory;
  iconName: string;        // Phosphor icon name (for dynamic lookup)
  description: string;     // Tooltip description
};

// Complete mapping of every known ADE event kind
export const EVENT_KIND_META: Record<string, EventKindMeta> = {
  // ── Git Operations ──────────────────────────────────────────
  "git.commit":       { label: "Commit",        category: "git", iconName: "GitCommit",              description: "New commit created" },
  "git_commit":       { label: "Commit",        category: "git", iconName: "GitCommit",              description: "New commit created" },
  "git.merge":        { label: "Merge",         category: "git", iconName: "GitMerge",               description: "Branch merged" },
  "git.rebase":       { label: "Rebase",        category: "git", iconName: "GitBranch",              description: "Rebase operation" },
  "git.push":         { label: "Push",          category: "git", iconName: "ArrowUp",                description: "Pushed to remote" },
  "git.pull":         { label: "Pull",          category: "git", iconName: "ArrowDown",              description: "Pulled from remote" },
  "git.fetch":        { label: "Fetch",         category: "git", iconName: "CloudArrowDown",         description: "Fetched from remote" },
  "git.sync":         { label: "Sync",          category: "git", iconName: "ArrowsClockwise",        description: "Sync (pull + push)" },
  "git.checkout":     { label: "Checkout",      category: "git", iconName: "ArrowBendUpRight",       description: "Branch checkout" },
  "git.stash":        { label: "Stash",         category: "git", iconName: "Archive",                description: "Changes stashed" },
  "git.stash_pop":    { label: "Stash Pop",     category: "git", iconName: "ArchiveBox",             description: "Stash popped" },
  "git.cherry_pick":  { label: "Cherry Pick",   category: "git", iconName: "TreeStructure",          description: "Cherry-pick applied" },
  "git.revert":       { label: "Revert",        category: "git", iconName: "ArrowCounterClockwise",  description: "Commit reverted" },
  "git.amend":        { label: "Amend",         category: "git", iconName: "PencilLine",             description: "Commit amended" },
  "git.stage":        { label: "Stage",         category: "git", iconName: "Plus",                   description: "Files staged" },
  "git.unstage":      { label: "Unstage",       category: "git", iconName: "Minus",                  description: "Files unstaged" },
  "git.discard":      { label: "Discard",       category: "git", iconName: "Trash",                  description: "Changes discarded" },

  // ── Lane Lifecycle ──────────────────────────────────────────
  "lane.created":           { label: "Lane Created",      category: "lane", iconName: "PlusCircle",      description: "New lane created" },
  "lane.archived":          { label: "Lane Archived",     category: "lane", iconName: "ArchiveBox",      description: "Lane archived" },
  "lane.deleted":           { label: "Lane Deleted",      category: "lane", iconName: "MinusCircle",     description: "Lane deleted" },
  "lane.renamed":           { label: "Lane Renamed",      category: "lane", iconName: "TextAa",          description: "Lane renamed" },
  "lane.status_changed":    { label: "Status Changed",    category: "lane", iconName: "Pulse",           description: "Lane status changed" },
  "lane.rebase_suggested":  { label: "Rebase Suggested",  category: "lane", iconName: "Lightbulb",       description: "Rebase suggestion generated" },
  "lane.auto_rebased":      { label: "Auto Rebase",       category: "lane", iconName: "Robot",           description: "Auto-rebase executed" },
  "lane.env_init":          { label: "Env Init",          category: "lane", iconName: "GearSix",         description: "Environment initialized" },
  "lane.port_allocated":    { label: "Port Allocated",    category: "lane", iconName: "Plug",            description: "Port allocated" },
  "lane.proxy_started":     { label: "Proxy Started",     category: "lane", iconName: "Globe",           description: "Proxy started" },

  // ── Sessions & Terminals ────────────────────────────────────
  "session.started":         { label: "Session Started",  category: "session", iconName: "Terminal",    description: "Terminal session started" },
  "session.ended":           { label: "Session Ended",    category: "session", iconName: "SignOut",     description: "Terminal session ended" },
  "session.failed":          { label: "Session Failed",   category: "session", iconName: "Warning",     description: "Session exited with error" },
  "session.delta_computed":  { label: "Delta Computed",   category: "session", iconName: "ChartBar",    description: "Session delta stats computed" },

  // ── Pack & Checkpoint ───────────────────────────────────────
  "pack_update_lane":          { label: "Lane Pack",        category: "pack", iconName: "Package",               description: "Lane pack refreshed" },
  "pack_update_project":       { label: "Project Pack",     category: "pack", iconName: "FolderOpen",            description: "Project pack refreshed" },
  "checkpoint.created":        { label: "Checkpoint",       category: "pack", iconName: "BookmarkSimple",        description: "Checkpoint snapshot created" },
  "pack.narrative_requested":  { label: "Narrative Start",  category: "pack", iconName: "ChatText",              description: "Narrative generation started" },
  "pack.narrative_completed":  { label: "Narrative Ready",  category: "pack", iconName: "ChatCircleText",        description: "Narrative ready" },
  "pack.narrative_failed":     { label: "Narrative Failed", category: "pack", iconName: "ChatSlash",             description: "Narrative generation failed" },
  "pack.version_created":      { label: "Pack Version",     category: "pack", iconName: "ClockCounterClockwise", description: "New pack version" },

  // ── Conflict & Risk ─────────────────────────────────────────
  "conflict.prediction_started":  { label: "Scan Started",     category: "conflict", iconName: "MagnifyingGlass", description: "Conflict scan started" },
  "conflict.prediction_complete": { label: "Scan Complete",     category: "conflict", iconName: "ShieldCheck",     description: "Prediction complete" },
  "conflict.detected":            { label: "Conflict Found",    category: "conflict", iconName: "ShieldWarning",   description: "Active conflict detected" },
  "conflict.resolved":            { label: "Resolved",          category: "conflict", iconName: "CheckCircle",     description: "Conflict resolved" },
  "conflict.proposal_created":    { label: "Proposal",          category: "conflict", iconName: "FileArrowUp",     description: "Resolution proposal created" },
  "conflict.proposal_stale":      { label: "Proposal Stale",    category: "conflict", iconName: "FileX",           description: "Proposal became stale" },

  // ── PR & Integration ────────────────────────────────────────
  "pr.created":              { label: "PR Opened",          category: "pr", iconName: "GitPullRequest", description: "Pull request opened" },
  "pr.updated":              { label: "PR Updated",         category: "pr", iconName: "ArrowsClockwise", description: "Pull request updated" },
  "pr.merged":               { label: "PR Merged",          category: "pr", iconName: "GitMerge",       description: "Pull request merged" },
  "pr.closed":               { label: "PR Closed",          category: "pr", iconName: "XCircle",        description: "Pull request closed" },
  "pr.review_requested":     { label: "Review Requested",   category: "pr", iconName: "Eye",            description: "Review requested" },
  "pr.review_received":      { label: "Review Received",    category: "pr", iconName: "ChatCircle",     description: "Review received" },
  "pr.ci_run":               { label: "CI Started",         category: "pr", iconName: "Play",           description: "CI check started" },
  "pr.ci_completed":         { label: "CI Completed",       category: "pr", iconName: "CheckCircle",    description: "CI check completed" },
  "pr.queue_entered":        { label: "Merge Queue",        category: "pr", iconName: "Queue",          description: "Entered merge queue" },
  "pr.integration_started":  { label: "Integration",        category: "pr", iconName: "Rocket",         description: "Integration flow started" },

  // ── Mission & Orchestrator ──────────────────────────────────
  "mission.started":        { label: "Mission Started",     category: "mission", iconName: "Rocket",      description: "Mission launched" },
  "mission.completed":      { label: "Mission Done",        category: "mission", iconName: "Trophy",      description: "Mission completed" },
  "mission.failed":         { label: "Mission Failed",      category: "mission", iconName: "XCircle",     description: "Mission failed" },
  "mission.step_progress":  { label: "Step Progress",       category: "mission", iconName: "Spinner",     description: "Step in progress" },
  "mission.intervention":   { label: "Intervention",        category: "mission", iconName: "HandPalm",    description: "Intervention required" },
  "mission.worker_status":  { label: "Worker Update",       category: "mission", iconName: "Robot",       description: "Worker status update" },
  "mission.plan_revised":   { label: "Plan Revised",        category: "mission", iconName: "NotePencil",  description: "Execution plan revised" },

  // ── Automation ──────────────────────────────────────────────
  "automation.triggered":   { label: "Triggered",       category: "automation", iconName: "Lightning",    description: "Automation triggered" },
  "automation.completed":   { label: "Completed",       category: "automation", iconName: "CheckCircle",  description: "Automation completed" },
  "automation.failed":      { label: "Failed",          category: "automation", iconName: "XCircle",      description: "Automation failed" },
  "automation.night_shift": { label: "Night Shift",     category: "automation", iconName: "Moon",         description: "Night shift run" },
  "automation.webhook":     { label: "Webhook",         category: "automation", iconName: "Webhook",      description: "Webhook received" },

  // ── Process & Test ──────────────────────────────────────────
  "process.started":    { label: "Process Start",  category: "process", iconName: "Play",        description: "Process started" },
  "process.stopped":    { label: "Process Stop",   category: "process", iconName: "Stop",        description: "Process stopped" },
  "process.crashed":    { label: "Process Crash",  category: "process", iconName: "Bug",         description: "Process crashed" },
  "test.run_started":   { label: "Tests Started",  category: "process", iconName: "TestTube",    description: "Test run started" },
  "test.run_passed":    { label: "Tests Passed",   category: "process", iconName: "CheckCircle", description: "All tests passed" },
  "test.run_failed":    { label: "Tests Failed",   category: "process", iconName: "XCircle",     description: "Tests failed" },

  // ── System ──────────────────────────────────────────────────
  "memory.sweep":          { label: "Memory Sweep",       category: "system", iconName: "Broom",          description: "Memory sweep executed" },
  "memory.consolidation":  { label: "Memory Consolidate", category: "system", iconName: "Database",       description: "Memory consolidation" },
  "config.changed":        { label: "Config Changed",     category: "system", iconName: "Sliders",        description: "Configuration changed" },
  "budget.warning":        { label: "Budget Warning",     category: "system", iconName: "CurrencyDollar", description: "Budget threshold warning" },
  "budget.exceeded":       { label: "Budget Exceeded",    category: "system", iconName: "Warning",        description: "Budget exceeded" },
};

// ── Lookup helpers ───────────────────────────────────────────────

/** Get metadata for an event kind, with sensible fallback for unknown kinds. */
export function getEventMeta(kind: string): EventKindMeta & { categoryMeta: CategoryMeta } {
  const meta = EVENT_KIND_META[kind];
  if (meta) {
    return { ...meta, categoryMeta: CATEGORY_META[meta.category] };
  }

  // Infer category from kind prefix
  const prefix = kind.split(".")[0];
  const inferredCategory = (
    prefix in CATEGORY_META ? prefix : "system"
  ) as EventCategory;

  return {
    label: kind.split(".").pop()?.replace(/_/g, " ") ?? kind,
    category: inferredCategory,
    iconName: "CircleDashed",
    description: kind,
    categoryMeta: CATEGORY_META[inferredCategory],
  };
}

/** Get all unique categories present in a list of event kinds. */
export function getActiveCategories(kinds: string[]): EventCategory[] {
  const cats = new Set<EventCategory>();
  for (const kind of kinds) {
    cats.add(getEventMeta(kind).category);
  }
  return Array.from(cats);
}

/** Get the display color for an operation status. */
export function getStatusColor(status: string): string {
  switch (status) {
    case "running":   return "#F59E0B"; // amber
    case "succeeded": return "#22C55E"; // emerald
    case "failed":    return "#EF4444"; // red
    case "canceled":  return "#8B8B9A"; // gray
    default:          return "#8B8B9A";
  }
}

/** Get Tailwind classes for an operation status badge. */
export function getStatusClasses(status: string): string {
  switch (status) {
    case "running":   return "bg-amber-500/15 text-amber-400 border-amber-500/15";
    case "succeeded": return "bg-emerald-500/15 text-emerald-400 border-emerald-500/15";
    case "failed":    return "bg-red-500/15 text-red-400 border-red-500/15";
    case "canceled":  return "bg-muted-fg/15 text-muted-fg border-muted-fg/15";
    default:          return "bg-muted-fg/15 text-muted-fg border-muted-fg/15";
  }
}

// ── Lane Track Colors (rotating palette) ─────────────────────────
export const LANE_TRACK_COLORS = [
  "#A78BFA", // purple (accent)
  "#22C55E", // emerald
  "#3B82F6", // blue
  "#F59E0B", // amber
  "#EF4444", // red
  "#06B6D4", // cyan
  "#EC4899", // pink
  "#8B5CF6", // violet
  "#14B8A6", // teal
  "#F97316", // orange
] as const;

/** Get a track color for a lane, using its own color or rotating palette. */
export function getLaneTrackColor(laneColor: string | null, index: number): string {
  if (laneColor) return laneColor;
  return LANE_TRACK_COLORS[index % LANE_TRACK_COLORS.length];
}
