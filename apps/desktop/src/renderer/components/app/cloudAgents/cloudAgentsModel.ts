import type { CloudAgent, CloudAgentProvider, CloudAgentStatus } from "../../../../shared/types";

/**
 * What the cloud-agents panel shows, decided in one place: filters, sections,
 * the per-provider brand. Pure, so the panel is layout only.
 */

export type CloudAgentFilter = "all" | "active" | "needs_you" | "done";
export type CloudAgentScope = "project" | "everywhere";

export type CloudProviderBrand = {
  provider: CloudAgentProvider;
  name: string;
  /** Short noun for one agent: "session" on Devin, "agent" on Cursor. */
  noun: string;
  /** Brand accent, used sparingly: the header tile and the launch button. */
  accent: string;
  webHome: string;
  webHomeLabel: string;
};

export const CLOUD_PROVIDER_BRANDS: Record<CloudAgentProvider, CloudProviderBrand> = {
  devin: {
    provider: "devin",
    name: "Devin Cloud",
    noun: "session",
    accent: "#3B82F6",
    webHome: "https://app.devin.ai",
    webHomeLabel: "app.devin.ai",
  },
  cursor: {
    provider: "cursor",
    name: "Cursor Cloud",
    noun: "agent",
    accent: "#A78BFA",
    webHome: "https://cursor.com/agents",
    webHomeLabel: "cursor.com/agents",
  },
};

export function isActiveStatus(status: CloudAgentStatus): boolean {
  return status === "starting" || status === "working" || status === "needs_you";
}

export function isDoneStatus(status: CloudAgentStatus): boolean {
  return status === "finished" || status === "failed" || status === "idle";
}

export function matchesFilter(agent: CloudAgent, filter: CloudAgentFilter): boolean {
  if (agent.status === "archived") return false;
  switch (filter) {
    case "all":
      return true;
    case "active":
      return agent.status === "starting" || agent.status === "working";
    case "needs_you":
      return agent.status === "needs_you";
    case "done":
      return isDoneStatus(agent.status);
  }
}

export function matchesSearch(agent: CloudAgent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [agent.title, agent.excerpt, agent.branch, agent.link?.laneName, agent.pullRequest?.title, ...agent.repos]
    .some((value) => typeof value === "string" && value.toLowerCase().includes(q));
}

export type CloudAgentSection = {
  id: "needs_you" | "working" | "in_ade" | "recent";
  label: string;
  agents: CloudAgent[];
};

function updatedMs(agent: CloudAgent): number {
  const ms = Date.parse(agent.updatedAt ?? agent.createdAt ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Sections, loudest first: what needs the human, what is running, what already
 * lives in ADE, everything else. Newest first inside each.
 */
export function sectionAgents(agents: CloudAgent[]): CloudAgentSection[] {
  const sorted = [...agents].sort((a, b) => updatedMs(b) - updatedMs(a));
  const needs = sorted.filter((agent) => agent.status === "needs_you");
  const working = sorted.filter((agent) => agent.status === "working" || agent.status === "starting");
  const rest = sorted.filter((agent) => !isActiveStatus(agent.status));
  const inAde = rest.filter((agent) => agent.link !== null);
  const recent = rest.filter((agent) => agent.link === null);
  return ([
    { id: "needs_you", label: "Needs you", agents: needs },
    { id: "working", label: "Working", agents: working },
    { id: "in_ade", label: "In ADE", agents: inAde },
    { id: "recent", label: "Recent", agents: recent },
  ] as CloudAgentSection[]).filter((section) => section.agents.length > 0);
}

export function filterCounts(agents: CloudAgent[]): Record<CloudAgentFilter, number> {
  return {
    all: agents.filter((agent) => agent.status !== "archived").length,
    active: agents.filter((agent) => matchesFilter(agent, "active")).length,
    needs_you: agents.filter((agent) => matchesFilter(agent, "needs_you")).length,
    done: agents.filter((agent) => matchesFilter(agent, "done")).length,
  };
}

/** "3 working · 1 needs you" — the header's one-line state of the fleet. */
export function fleetSummary(agents: CloudAgent[], noun: string): string {
  const counts = filterCounts(agents);
  const parts: string[] = [];
  if (counts.active) parts.push(`${counts.active} working`);
  if (counts.needs_you) parts.push(`${counts.needs_you} need${counts.needs_you === 1 ? "s" : ""} you`);
  parts.push(`${counts.all} ${noun}${counts.all === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function relativeAge(iso: string | null | undefined, now = Date.now()): string | null {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return null;
  const delta = Math.max(0, now - ms);
  if (delta < 45_000) return "now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

export const STATUS_TONE: Record<CloudAgentStatus, { dot: string; text: string; label: string }> = {
  starting: { dot: "bg-sky-300", text: "text-sky-200/85", label: "Starting" },
  working: { dot: "bg-sky-400", text: "text-sky-200", label: "Working" },
  needs_you: { dot: "bg-amber-400", text: "text-amber-200", label: "Needs you" },
  idle: { dot: "bg-violet-300/80", text: "text-violet-200/80", label: "Your turn" },
  finished: { dot: "bg-emerald-400/80", text: "text-emerald-200/75", label: "Done" },
  failed: { dot: "bg-red-400", text: "text-red-300", label: "Failed" },
  archived: { dot: "bg-white/25", text: "text-muted-fg/55", label: "Archived" },
};

/**
 * A model as a short label. With a known list (Devin's versions) an unknown id
 * is an internal codename and shows nothing; without one (Cursor) the id is
 * already readable.
 */
export function modelLabel(model: string | null | undefined, options: Array<{ value: string; label: string }>): string | null {
  if (!model) return null;
  if (!options.length) return model;
  return options.find((option) => option.value === model)?.label ?? null;
}
