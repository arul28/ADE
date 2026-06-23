import type { OpenProjectBinding, TerminalToolType } from "../../shared/types";

export type HandoffLaunchJobStatus = "preparing-summary" | "creating-chat" | "sending-handoff";

export type HandoffLaunchJob = {
  id: string;
  sourceSessionId: string;
  laneId: string;
  laneName: string;
  targetModelId: string;
  targetModelLabel: string;
  targetToolType: TerminalToolType;
  status: HandoffLaunchJobStatus;
  createdAtMs: number;
};

export function createHandoffLaunchJobId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // crypto.randomUUID may throw in insecure contexts; fall through.
  }
  return `handoff-launch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildHandoffLaunchJobsScopeKey(args: {
  projectBinding?: Pick<OpenProjectBinding, "key"> | null;
  projectRoot?: string | null;
}): string {
  return [
    "handoff-launch-jobs",
    args.projectBinding?.key ?? (args.projectRoot?.trim() || "project"),
  ].map(encodeURIComponent).join(":");
}

export function handoffLaunchStatusMessage(status: HandoffLaunchJobStatus): string {
  if (status === "preparing-summary") return "Preparing summary...";
  if (status === "creating-chat") return "Creating chat...";
  return "Sending handoff...";
}

export function handoffLaunchTitle(job: HandoffLaunchJob): string {
  return `Handoff to ${job.targetModelLabel}`;
}

export function handoffLaunchMatchesQuery(job: HandoffLaunchJob, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (needle.startsWith("lane:")) {
    return job.laneName.toLowerCase().includes(needle.slice(5).trim());
  }
  if (needle.startsWith("type:")) {
    return job.targetToolType.toLowerCase().includes(needle.slice(5).trim());
  }
  if (needle.startsWith("tracked:")) return false;
  return [
    handoffLaunchTitle(job),
    job.laneName,
    job.targetToolType,
    handoffLaunchStatusMessage(job.status),
  ].some((value) => value.toLowerCase().includes(needle));
}
