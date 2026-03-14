import type { AgentRole, AgentStatus, WorkerTemplate } from "../../../../shared/types";

/* ── Shared form class patterns ── */

export const inputCls =
  "h-9 w-full rounded-lg border border-white/[0.07] bg-[rgba(24,20,35,0.5)] px-3 text-sm font-sans text-fg placeholder:text-muted-fg/40 hover:border-[rgba(167,139,250,0.18)] focus:border-[rgba(167,139,250,0.35)] focus:outline-none transition-colors backdrop-blur-sm";

export const selectCls = `${inputCls} appearance-none`;

export const labelCls =
  "mb-1.5 text-xs font-medium text-muted-fg/55";

/* ── Accent palette (matches Preview tab) ── */
export const ACCENT = {
  purple: "#A78BFA",
  blue: "#60A5FA",
  green: "#34D399",
  pink: "#F472B6",
  amber: "#FBBF24",
} as const;

export const textareaCls =
  "w-full rounded-lg border border-white/[0.07] bg-[rgba(24,20,35,0.5)] p-3 text-sm font-sans text-fg placeholder:text-muted-fg/40 hover:border-[rgba(167,139,250,0.18)] focus:border-[rgba(167,139,250,0.35)] focus:outline-none resize-vertical transition-colors backdrop-blur-sm";

export const cardCls =
  "rounded-xl border border-[rgba(167,139,250,0.1)] bg-[rgba(24,20,35,0.55)] p-4 backdrop-blur-[20px] transition-all duration-200 hover:border-[rgba(167,139,250,0.22)] hover:bg-[rgba(24,20,35,0.7)]";

export const surfaceCardCls =
  "rounded-xl border border-[rgba(167,139,250,0.08)] bg-[rgba(24,20,35,0.4)] p-4 backdrop-blur-[20px]";

export const recessedPanelCls =
  "rounded-xl border border-white/[0.05] bg-[rgba(15,12,24,0.6)] backdrop-blur-[20px]";

export const shellTabBarCls =
  "shrink-0 flex items-center gap-0 border-b border-white/[0.05] bg-transparent backdrop-blur-sm";

export const shellBodyCls =
  "flex h-full w-full overflow-hidden bg-bg text-fg font-sans";

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
