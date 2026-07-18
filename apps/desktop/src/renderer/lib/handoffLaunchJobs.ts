import type { OpenProjectBinding, TerminalToolType } from "../../shared/types";

export type HandoffLaunchJobStatus = "preparing-summary" | "forking-history" | "creating-chat" | "sending-handoff";

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
  if (status === "preparing-summary") return "Summarizing chat & creating handoff...";
  if (status === "forking-history") return "Forking chat history...";
  if (status === "creating-chat") return "Creating chat...";
  return "Sending handoff...";
}

/**
 * True when a real session row plausibly IS the chat this in-flight handoff job
 * is creating: same lane, same tool type, and started at/after the job began
 * (small slack absorbs renderer-vs-runtime clock drift). The sidebar hides the
 * placeholder as soon as such a row is visible so a handoff never reads as two
 * new sessions with one vanishing (ADE-122). A same-provider chat launched
 * concurrently in the same lane can hide the placeholder a moment early, which
 * is a harmless cosmetic trade.
 */
export function handoffJobLikelyMaterialized(
  job: HandoffLaunchJob,
  session: { laneId: string; toolType: string | null; startedAt: string },
): boolean {
  if (session.laneId !== job.laneId) return false;
  if (!session.toolType || session.toolType !== job.targetToolType) return false;
  const startedAtMs = Date.parse(session.startedAt);
  return Number.isFinite(startedAtMs) && startedAtMs >= job.createdAtMs - 15_000;
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
