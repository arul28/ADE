import type {
  ChatTerminalSession,
  TerminalRuntimeState,
  TerminalSessionStatus,
  TerminalSessionSummary,
} from "../../../../shared/types";

type SessionLike = Partial<TerminalSessionSummary> & {
  id?: string | null;
  sessionId?: string | null;
  ptyId?: string | null;
};

export class TerminalRegistry {
  private readonly ptyToSession = new Map<string, string>();
  private readonly sessionToPty = new Map<string, string>();
  private readonly summaries = new Map<string, SessionLike>();

  register(sessionId: string | null | undefined, ptyId: string | null | undefined): void {
    if (!sessionId) return;
    if (ptyId) {
      this.ptyToSession.set(ptyId, sessionId);
      this.sessionToPty.set(sessionId, ptyId);
    }
  }

  registerSummary(summary: SessionLike | null | undefined): void {
    if (!summary) return;
    const sessionId = summary.id ?? summary.sessionId;
    if (!sessionId) return;
    this.summaries.set(sessionId, summary);
    this.register(sessionId, summary.ptyId);
  }

  registerSummaries(summaries: unknown): void {
    if (!Array.isArray(summaries)) return;
    for (const summary of summaries) this.registerSummary(summary as SessionLike);
  }

  sessionForPty(ptyId: string | null | undefined): string | null {
    if (!ptyId) return null;
    return this.ptyToSession.get(ptyId) ?? null;
  }

  ptyForSession(sessionId: string | null | undefined): string | null {
    if (!sessionId) return null;
    return this.sessionToPty.get(sessionId) ?? (this.summaries.get(sessionId)?.ptyId ?? null);
  }

  summaryForSession(sessionId: string | null | undefined): SessionLike | null {
    if (!sessionId) return null;
    return this.summaries.get(sessionId) ?? null;
  }

  resolveSessionId(input: {
    terminalId?: string | null;
    sessionId?: string | null;
    ptyId?: string | null;
    chatSessionId?: string | null;
  }): string | null {
    if (input.sessionId) return input.sessionId;
    if (input.ptyId) return this.sessionForPty(input.ptyId);
    if (input.terminalId) {
      return this.sessionForPty(input.terminalId) ?? input.terminalId;
    }
    if (input.chatSessionId) {
      for (const [sessionId, summary] of this.summaries) {
        if (summary.chatSessionId === input.chatSessionId) return sessionId;
      }
    }
    return null;
  }
}

export function chatTerminalFromSummary(
  sessionId: string,
  summary: SessionLike | null,
  ptyId: string | null
): ChatTerminalSession {
  const record = (summary ?? {}) as Record<string, unknown>;
  const startedAt =
    (typeof record.startedAt === "string" && record.startedAt) ||
    (typeof record.createdAt === "string" && record.createdAt) ||
    new Date(0).toISOString();
  return {
    terminalId: sessionId,
    ptyId,
    chatSessionId: (summary?.chatSessionId as string | null | undefined) ?? null,
    laneId: (summary?.laneId as string | undefined) ?? "",
    laneName: (summary?.laneName as string | undefined) ?? "",
    title: (summary?.title as string | undefined) ?? "",
    toolType: (summary?.toolType as ChatTerminalSession["toolType"] | undefined) ?? null,
    goal: (summary?.goal as string | null | undefined) ?? null,
    status: ((summary?.status as TerminalSessionStatus | undefined) ?? "running") as TerminalSessionStatus,
    runtimeState: ((summary?.runtimeState as TerminalRuntimeState | undefined) ?? "running") as TerminalRuntimeState,
    active: (record.active as boolean | undefined) ?? true,
    startedAt,
    endedAt: (record.endedAt as string | null | undefined) ?? null,
    exitCode: (record.exitCode as number | null | undefined) ?? null,
    pid: (record.ownerPid as number | null | undefined) ?? null,
    resumeCommand: (record.resumeCommand as string | null | undefined) ?? null,
    resumeMetadata: (record.resumeMetadata as ChatTerminalSession["resumeMetadata"] | undefined) ?? null,
    lastOutputPreview: (record.lastOutputPreview as string | null | undefined) ?? null,
    summary: (record.summary as string | null | undefined) ?? null,
  };
}
