import type { AgentRole, AgentStatus, WorkerTemplate } from "../../../../shared/types";

/* ── Shared form class patterns ── */

export const inputCls =
  "h-8 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs font-mono text-fg placeholder:text-muted-fg/40 hover:border-white/[0.12] focus:border-accent/40 focus:outline-none transition-colors";

export const selectCls = `${inputCls} appearance-none`;

export const labelCls =
  "text-xs font-mono font-semibold uppercase tracking-[0.5px] text-muted-fg/70 mb-1.5";

export const textareaCls =
  "w-full rounded-lg border border-white/[0.08] bg-white/[0.03] p-3 text-xs font-mono text-fg placeholder:text-muted-fg/40 hover:border-white/[0.12] focus:border-accent/40 focus:outline-none resize-vertical transition-colors";

export const cardCls =
  "rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 backdrop-blur-xl";

export const surfaceCardCls =
  "rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 backdrop-blur-xl";

export const recessedPanelCls =
  "rounded-xl border border-white/[0.04] bg-white/[0.01] backdrop-blur-xl";

export const shellTabBarCls =
  "shrink-0 flex items-center gap-0 border-b border-white/[0.06] bg-white/[0.02] backdrop-blur-xl";

export const shellBodyCls =
  "flex h-full w-full overflow-hidden bg-bg text-fg";

/* ── Agent status colors ── */

export const agentStatusMap: Record<
  AgentStatus,
  { color: string; label: string; dotCls: string; textCls: string; bgCls: string }
> = {
  running: {
    color: "info",
    label: "Running",
    dotCls: "bg-info animate-pulse",
    textCls: "text-info",
    bgCls: "bg-info/10 border-info/20",
  },
  active: {
    color: "success",
    label: "Active",
    dotCls: "bg-success",
    textCls: "text-success",
    bgCls: "bg-success/10 border-success/20",
  },
  paused: {
    color: "warning",
    label: "Paused",
    dotCls: "bg-warning",
    textCls: "text-warning",
    bgCls: "bg-warning/10 border-warning/20",
  },
  idle: {
    color: "muted",
    label: "Idle",
    dotCls: "bg-muted-fg/40",
    textCls: "text-muted-fg",
    bgCls: "bg-muted/10 border-border/10",
  },
};

/* ── Worker templates ── */

export const WORKER_TEMPLATES: WorkerTemplate[] = [
  {
    id: "backend-engineer",
    name: "Backend Engineer",
    role: "engineer" as AgentRole,
    title: "Backend Engineer",
    capabilities: ["api", "database", "architecture", "debugging"],
    description: "Handles API design, database operations, and backend architecture.",
    adapterType: "claude-local",
    model: "claude-sonnet-4-6",
  },
  {
    id: "frontend-engineer",
    name: "Frontend Engineer",
    role: "engineer" as AgentRole,
    title: "Frontend Engineer",
    capabilities: ["react", "css", "ui", "accessibility"],
    description: "Builds UI components, handles styling, and ensures accessibility.",
    adapterType: "claude-local",
    model: "claude-sonnet-4-6",
  },
  {
    id: "qa-tester",
    name: "QA Tester",
    role: "qa" as AgentRole,
    title: "QA Engineer",
    capabilities: ["testing", "e2e", "regression", "test-planning"],
    description: "Writes and maintains tests. Catches bugs before they ship.",
    adapterType: "claude-local",
    model: "claude-sonnet-4-6",
  },
  {
    id: "devops",
    name: "DevOps Engineer",
    role: "devops" as AgentRole,
    title: "DevOps Engineer",
    capabilities: ["ci-cd", "docker", "infrastructure", "monitoring"],
    description: "Manages CI/CD, deployment, and infrastructure.",
    adapterType: "claude-local",
    model: "claude-sonnet-4-6",
  },
  {
    id: "researcher",
    name: "Researcher",
    role: "researcher" as AgentRole,
    title: "Technical Researcher",
    capabilities: ["research", "analysis", "documentation", "architecture"],
    description: "Investigates technical questions, evaluates approaches, writes docs.",
    adapterType: "claude-local",
    model: "claude-sonnet-4-6",
  },
  {
    id: "custom",
    name: "Custom Worker",
    role: "general" as AgentRole,
    title: "",
    capabilities: [],
    description: "Start from scratch with a blank configuration.",
    adapterType: "claude-local",
  },
];
