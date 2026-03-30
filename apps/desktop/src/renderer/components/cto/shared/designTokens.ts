import type { AgentRole, AgentStatus, WorkerTemplate } from "../../../../shared/types";

/* ── Shared form class patterns ── */

export const inputCls =
  "h-10 w-full rounded-xl border border-white/[0.08] bg-[linear-gradient(180deg,rgba(21,26,35,0.92),rgba(14,18,26,0.94))] px-3.5 text-sm font-sans text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] placeholder:text-muted-fg/36 hover:border-[rgba(56,189,248,0.28)] focus:border-[rgba(56,189,248,0.45)] focus:outline-none transition-all duration-200";

export const selectCls = `${inputCls} appearance-none`;

export const labelCls =
  "mb-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-fg/46";

/* ── Accent palette ── */
export const ACCENT = {
  sky: "#38BDF8",
  blue: "#60A5FA",
  green: "#34D399",
  pink: "#FB7185",
  amber: "#FBBF24",
} as const;

export const textareaCls =
  "w-full rounded-xl border border-white/[0.08] bg-[linear-gradient(180deg,rgba(21,26,35,0.92),rgba(14,18,26,0.94))] p-3.5 text-sm font-sans text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] placeholder:text-muted-fg/36 hover:border-[rgba(56,189,248,0.28)] focus:border-[rgba(56,189,248,0.45)] focus:outline-none resize-vertical transition-all duration-200";

export const cardCls =
  "rounded-2xl border border-white/[0.08] bg-[linear-gradient(180deg,rgba(19,24,34,0.92),rgba(12,15,23,0.95))] p-5 shadow-[0_24px_60px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-[22px] transition-all duration-200 hover:border-[rgba(56,189,248,0.18)] hover:shadow-[0_28px_72px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.05)]";

export const surfaceCardCls =
  "rounded-2xl border border-white/[0.06] bg-[linear-gradient(180deg,rgba(15,20,28,0.82),rgba(11,14,22,0.88))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-[18px]";

export const recessedPanelCls =
  "rounded-2xl border border-white/[0.06] bg-[linear-gradient(180deg,rgba(10,14,21,0.96),rgba(7,10,16,0.96))] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-[20px]";

export const shellTabBarCls =
  "shrink-0 flex items-center gap-1 rounded-2xl border border-white/[0.06] bg-[rgba(8,11,18,0.72)] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-xl";

export const shellBodyCls =
  "flex h-full w-full overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_32%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.1),transparent_26%),linear-gradient(180deg,#0B1017_0%,#090D13_48%,#070A10_100%)] text-fg font-sans";

/* ── Compact header for the CTO page ── */
export const compactHeaderCls =
  "flex items-center justify-between gap-4 border-b border-white/[0.06] px-5 py-2.5";

/* ── Stat chip for inline metrics ── */
export const statChipCls =
  "inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-[linear-gradient(135deg,rgba(21,28,40,0.72),rgba(14,18,28,0.82))] px-2.5 py-1 text-[11px] font-medium text-fg/68 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-200 hover:border-[rgba(56,189,248,0.22)] hover:text-fg/82 hover:shadow-[0_0_12px_rgba(56,189,248,0.06)]";

/* ── Pipeline stage card with glow effect ── */
export const stageCardCls =
  "rounded-2xl border border-white/[0.08] bg-[linear-gradient(180deg,rgba(19,24,38,0.88),rgba(12,16,26,0.92))] p-4 backdrop-blur-[22px] shadow-[0_16px_48px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-300 hover:border-[rgba(56,189,248,0.24)] hover:shadow-[0_20px_56px_rgba(0,0,0,0.28),0_0_24px_rgba(56,189,248,0.06),inset_0_1px_0_rgba(255,255,255,0.05)] hover:translate-y-[-1px]";

/* ── Pipeline canvas background ── */
export const pipelineCanvasCls =
  "rounded-2xl border border-white/[0.05] bg-[radial-gradient(ellipse_at_top,rgba(56,189,248,0.05),transparent_60%),radial-gradient(ellipse_at_bottom_right,rgba(167,139,250,0.04),transparent_50%),linear-gradient(180deg,rgba(8,11,18,0.96),rgba(6,8,14,0.98))] shadow-[inset_0_2px_4px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.02)] backdrop-blur-[24px]";

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
