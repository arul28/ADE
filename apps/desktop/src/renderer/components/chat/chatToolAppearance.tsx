import {
  ArrowSquareOut,
  Brain,
  ChatCircle,
  CheckCircle,
  Checks,
  Circle,
  ClipboardText,
  Cpu,
  FileCode,
  FolderOpen,
  Globe,
  ListBullets,
  ListChecks,
  MagnifyingGlass,
  Note,
  Notepad,
  PencilSimpleLine,
  Robot,
  Scissors,
  StopCircle,
  Terminal,
  User,
  Warning,
  Wrench,
  XCircle,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { ChatSurfaceChipTone } from "../../../shared/types";
import { describeToolIdentifier } from "./toolPresentation";

export type ToolMeta = {
  label: string;
  icon: Icon;
  badgeCls: string;
  category: "read" | "write" | "exec" | "web" | "plan" | "meta" | "codex";
  sourceTone?: ChatSurfaceChipTone;
  getTarget?: (args: Record<string, unknown>) => string | null;
};

const TOOL_META: Record<string, ToolMeta> = {
  Read: { label: "Read", icon: FileCode, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "read", sourceTone: "info", getTarget: a => String(a.file_path ?? a.path ?? "") || null },
  Grep: { label: "Search", icon: MagnifyingGlass, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "read", sourceTone: "info", getTarget: a => String(a.pattern ?? a.path ?? "") || null },
  Glob: { label: "Find Files", icon: FolderOpen, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "read", sourceTone: "info", getTarget: a => String(a.pattern ?? "") || null },
  LS: { label: "List Files", icon: ListBullets, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "read", sourceTone: "info", getTarget: a => String(a.path ?? "") || null },
  Write: { label: "Write", icon: Note, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "write", sourceTone: "success", getTarget: a => String(a.file_path ?? "") || null },
  Edit: { label: "Edit", icon: PencilSimpleLine, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "write", sourceTone: "success", getTarget: a => String(a.file_path ?? "") || null },
  MultiEdit: { label: "Multi Edit", icon: Notepad, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "write", sourceTone: "success", getTarget: a => String(a.file_path ?? "") || null },
  NotebookEdit: { label: "Notebook", icon: Notepad, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "write", sourceTone: "success", getTarget: a => String(a.notebook_path ?? "") || null },
  Bash: { label: "Shell", icon: Terminal, badgeCls: "border-amber-400/25 bg-amber-400/12 text-amber-200", category: "exec", sourceTone: "warning", getTarget: a => String(a.command ?? "") || null },
  BashOutput: { label: "Output", icon: Terminal, badgeCls: "border-amber-400/25 bg-amber-400/12 text-amber-200", category: "exec", sourceTone: "warning" },
  KillBash: { label: "Kill", icon: StopCircle, badgeCls: "border-red-400/25 bg-red-500/12 text-red-200", category: "exec", sourceTone: "warning" },
  WebSearch: { label: "Search", icon: MagnifyingGlass, badgeCls: "border-indigo-400/25 bg-indigo-400/12 text-indigo-200", category: "web", sourceTone: "accent", getTarget: a => String(a.query ?? "") || null },
  WebFetch: { label: "Fetch", icon: Globe, badgeCls: "border-indigo-400/25 bg-indigo-400/12 text-indigo-200", category: "web", sourceTone: "accent", getTarget: a => String(a.url ?? "") || null },
  TodoWrite: { label: "Plan", icon: ClipboardText, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "plan", sourceTone: "accent" },
  TodoRead: { label: "Plan", icon: ClipboardText, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "plan", sourceTone: "accent" },
  Task: { label: "Task", icon: Cpu, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "meta", sourceTone: "accent" },
  ExitPlanMode: { label: "Plan Approval", icon: ListChecks, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "plan", sourceTone: "accent" },
  exitPlanMode: { label: "Plan Approval", icon: ListChecks, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "plan", sourceTone: "accent" },
  exec_command: { label: "Shell", icon: Terminal, badgeCls: "border-amber-400/25 bg-amber-400/12 text-amber-200", category: "codex", sourceTone: "warning", getTarget: a => String(a.command ?? a.cmd ?? "") || null },
  apply_patch: { label: "Patch", icon: Scissors, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "codex", sourceTone: "success" },
  update_plan: { label: "Plan", icon: ListChecks, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "codex", sourceTone: "accent" },
  readFile: { label: "Read", icon: FileCode, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "read", sourceTone: "info", getTarget: a => String(a.path ?? a.file_path ?? "") || null },
  grep: { label: "Search", icon: MagnifyingGlass, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "read", sourceTone: "info", getTarget: a => String(a.pattern ?? "") || null },
  glob: { label: "Find Files", icon: FolderOpen, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "read", sourceTone: "info", getTarget: a => String(a.pattern ?? "") || null },
  listDir: { label: "List", icon: FolderOpen, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "read", sourceTone: "info", getTarget: a => String(a.path ?? "") || null },
  gitStatus: { label: "Git Status", icon: ClipboardText, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "read", sourceTone: "info" },
  gitDiff: { label: "Git Diff", icon: Scissors, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "read", sourceTone: "info", getTarget: a => String(a.path ?? a.ref ?? "") || null },
  gitLog: { label: "Git Log", icon: ClipboardText, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "read", sourceTone: "info", getTarget: a => String(a.ref ?? "") || null },
  editFile: { label: "Edit", icon: PencilSimpleLine, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "write", sourceTone: "success", getTarget: a => String(a.file_path ?? a.path ?? "") || null },
  writeFile: { label: "Write", icon: Note, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "write", sourceTone: "success", getTarget: a => String(a.file_path ?? a.path ?? "") || null },
  bash: { label: "Shell", icon: Terminal, badgeCls: "border-amber-400/25 bg-amber-400/12 text-amber-200", category: "exec", sourceTone: "warning", getTarget: a => String(a.command ?? "") || null },
  askUser: { label: "Ask User", icon: ChatCircle, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "meta", sourceTone: "accent", getTarget: a => String(a.question ?? "") || null },
  memorySearch: { label: "Memory", icon: Brain, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "meta", sourceTone: "accent", getTarget: a => String(a.query ?? "") || null },
  memoryAdd: { label: "Memory Add", icon: Brain, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "meta", sourceTone: "accent" },
  memoryPin: { label: "Memory Pin", icon: Brain, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "meta", sourceTone: "accent" },
  memoryUpdateCore: { label: "Core Memory", icon: Brain, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "meta", sourceTone: "accent" },
  spawn_worker: { label: "Spawn", icon: Robot, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "meta", sourceTone: "info", getTarget: a => String(a.name ?? a.workerId ?? "") || null },
  request_specialist: { label: "Specialist", icon: User, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "meta", sourceTone: "info", getTarget: a => String(a.role ?? a.name ?? "") || null },
  delegate_to_subagent: { label: "Delegate", icon: User, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "meta", sourceTone: "info", getTarget: a => String(a.name ?? a.parentWorkerId ?? "") || null },
  delegate_parallel: { label: "Delegate Batch", icon: User, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "meta", sourceTone: "info", getTarget: a => `${Array.isArray(a.tasks) ? a.tasks.length : 0} task(s)` },
  read_mission_status: { label: "Mission Status", icon: MagnifyingGlass, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "plan", sourceTone: "accent" },
  get_worker_output: { label: "Worker Output", icon: FileCode, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "plan", sourceTone: "accent", getTarget: a => String(a.workerId ?? "") || null },
  revise_plan: { label: "Revise Plan", icon: ListChecks, badgeCls: "border-violet-400/25 bg-violet-400/12 text-violet-200", category: "plan", sourceTone: "accent" },
  retry_step: { label: "Retry", icon: ArrowSquareOut, badgeCls: "border-amber-400/25 bg-amber-400/12 text-amber-200", category: "meta", sourceTone: "warning", getTarget: a => String(a.workerId ?? "") || null },
  skip_step: { label: "Skip", icon: StopCircle, badgeCls: "border-red-400/25 bg-red-500/12 text-red-200", category: "meta", sourceTone: "warning", getTarget: a => String(a.workerId ?? "") || null },
  mark_step_complete: { label: "Mark Complete", icon: CheckCircle, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "meta", sourceTone: "success", getTarget: a => String(a.workerId ?? "") || null },
  mark_step_failed: { label: "Mark Failed", icon: XCircle, badgeCls: "border-red-400/25 bg-red-500/12 text-red-200", category: "meta", sourceTone: "danger", getTarget: a => String(a.workerId ?? "") || null },
  message_worker: { label: "Message", icon: Note, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "meta", sourceTone: "success", getTarget: a => String(a.workerId ?? a.to ?? "") || null },
  send_message: { label: "Message", icon: Note, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "meta", sourceTone: "success", getTarget: a => String(a.to ?? a.workerId ?? "") || null },
  broadcast: { label: "Broadcast", icon: Note, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "meta", sourceTone: "success" },
  report_status: { label: "Status", icon: Circle, badgeCls: "border-cyan-400/25 bg-cyan-400/12 text-cyan-200", category: "meta", sourceTone: "info", getTarget: a => String(a.workerId ?? "") || null },
  report_result: { label: "Result", icon: CheckCircle, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "meta", sourceTone: "success", getTarget: a => String(a.workerId ?? "") || null },
  report_validation: { label: "Validation", icon: Checks, badgeCls: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200", category: "meta", sourceTone: "success", getTarget: a => String(a.workerId ?? a.targetWorkerId ?? "") || null },
};

export function isCodeChangeTool(toolName: string): boolean {
  return getToolMeta(toolName).category === "write";
}

export function describeToolVerb(
  toolName: string,
  status: "running" | "completed" | "failed" | "interrupted",
): string {
  const meta = getToolMeta(toolName);
  const past = status === "running" ? null : status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "complete";
  const isShell = meta.category === "exec" || meta.label === "Shell";
  const isRead = meta.category === "read"
    || meta.label === "Read"
    || meta.label === "List Files"
    || meta.label === "List"
    || meta.label === "Find Files";
  const isSearch = meta.label === "Search" || meta.label === "Find Files";
  const isWeb = meta.category === "web";
  if (isShell) {
    if (status === "running") return "Running command…";
    return past === "complete" ? "Command run complete" : `Command ${past}`;
  }
  if (isWeb) {
    if (status === "running") return "Fetching…";
    return past === "complete" ? "Fetch complete" : `Fetch ${past}`;
  }
  if (isSearch && !isRead) {
    if (status === "running") return "Searching…";
    return past === "complete" ? "Search complete" : `Search ${past}`;
  }
  if (isRead) {
    if (status === "running") return "Reading…";
    return past === "complete" ? "Read complete" : `Read ${past}`;
  }
  if (meta.category === "plan") {
    if (status === "running") return "Planning…";
    return past === "complete" ? "Plan updated" : `Plan ${past}`;
  }
  if (status === "running") return "Running…";
  return past === "complete" ? "Complete" : past!.charAt(0).toUpperCase() + past!.slice(1);
}

export function getToolMeta(toolName: string): ToolMeta {
  const direct = TOOL_META[toolName];
  if (direct) return direct;

  const candidateKeys = [
    toolName.split(".").at(-1) ?? "",
    toolName.split("__").at(-1) ?? "",
  ].filter(Boolean);
  for (const candidate of candidateKeys) {
    const candidateMeta = TOOL_META[candidate];
    if (candidateMeta) return candidateMeta;
  }

  return {
    label: describeToolIdentifier(toolName).label,
    icon: Warning,
    badgeCls: "border-[color:color-mix(in_srgb,var(--chat-accent)_24%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)] text-fg/78",
    category: "meta",
    sourceTone: "muted",
  };
}
