import type { AgentRole, AgentStatus, WorkerTemplate } from "../../../../shared/types";

/* ── Shared form class patterns (app-aligned) ── */

export const inputCls =
  "h-8 w-full rounded-md border border-white/[0.08] bg-[rgba(12,10,22,0.6)] px-3 text-xs font-sans text-fg shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] placeholder:text-muted-fg/40 hover:border-accent/20 focus:border-accent/40 focus:shadow-[0_0_0_2px_var(--color-accent-muted)] focus:outline-none transition-all duration-150";

export const selectCls = `${inputCls} appearance-none`;

export const labelCls =
  "mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg/60";

export const textareaCls =
  "w-full rounded-md border border-white/[0.08] bg-[rgba(12,10,22,0.6)] p-3 text-xs font-sans text-fg shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] placeholder:text-muted-fg/40 hover:border-accent/20 focus:border-accent/40 focus:shadow-[0_0_0_2px_var(--color-accent-muted)] focus:outline-none resize-vertical transition-all duration-150";

/* ── Accent palette (app-aligned) ── */
export const ACCENT = {
  purple: "var(--color-accent)",
  blue: "#60A5FA",
  green: "#22C55E",
  pink: "#FB7185",
  amber: "#FBBF24",
} as const;

/* ── Card styles (app-aligned) ── */

export const cardCls =
  "rounded-xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(26,24,48,0.7),rgba(18,16,34,0.8))] p-5 shadow-card backdrop-blur-[20px] transition-all duration-200 hover:shadow-card-hover hover:border-white/[0.10]";

export const surfaceCardCls =
  "rounded-xl border border-white/[0.06] bg-[linear-gradient(180deg,rgba(22,20,40,0.6),rgba(16,14,30,0.7))] p-4 backdrop-blur-[18px]";

export const recessedPanelCls =
  "rounded-lg border border-white/[0.05] bg-[rgba(12,10,22,0.6)] shadow-inset backdrop-blur-[20px]";

export const shellTabBarCls =
  "shrink-0 flex items-center gap-1 rounded-xl border border-white/[0.06] bg-[rgba(12,10,22,0.5)] p-1.5 backdrop-blur-xl";

export const shellBodyCls =
  "flex h-full w-full overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(167,139,250,0.08),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(96,165,250,0.06),transparent_28%),linear-gradient(180deg,#0C0B10_0%,#0A0910_48%,#080810_100%)] text-fg font-sans";

/* ── Compact header for the CTO page ── */
export const compactHeaderCls =
  "flex items-center justify-between gap-4 border-b border-white/[0.06] px-5 py-2.5";

/* ── Stat chip for inline metrics ── */
export const statChipCls =
  "inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-[linear-gradient(135deg,rgba(22,20,40,0.7),rgba(16,14,30,0.8))] px-3 py-1.5 text-xs font-medium text-fg/68 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-200 hover:border-accent/20 hover:text-fg/82";

/* ── Pipeline stage card ── */
export const stageCardCls =
  "rounded-xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(26,24,48,0.65),rgba(18,16,34,0.75))] p-4 backdrop-blur-[20px] shadow-card transition-all duration-200 hover:shadow-card-hover hover:border-accent/20 hover:translate-y-[-1px]";

/* ── Pipeline canvas background ── */
export const pipelineCanvasCls =
  "rounded-xl border border-white/[0.05] bg-[radial-gradient(ellipse_at_top,rgba(167,139,250,0.04),transparent_60%),rgba(10,8,18,0.7)] shadow-inset backdrop-blur-[20px]";

/* ── Agent status colors (using app semantic colors) ── */

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
