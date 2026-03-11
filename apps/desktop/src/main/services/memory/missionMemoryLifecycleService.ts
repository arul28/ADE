import type { Logger } from "../logging/logger";
import type { Memory, MemoryStatus, UnifiedMemoryService } from "./unifiedMemoryService";

function cleanIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter((value) => value.length > 0))];
}

function normalizeStatuses(status?: MemoryStatus | ReadonlyArray<MemoryStatus> | "all"): MemoryStatus[] | undefined {
  if (status === "all" || status === undefined) return undefined;
  return Array.isArray(status) ? [...status] : [status];
}

export function createMissionMemoryLifecycleService(args: {
  logger?: Pick<Logger, "warn"> | null;
  memoryService: Pick<
    UnifiedMemoryService,
    "writeMemory" | "addMemory" | "listMemories" | "getMemory" | "archiveMemory"
  >;
}) {
  const { memoryService } = args;

  const listMissionEntries = (input: {
    projectId: string;
    missionId: string;
    runId?: string | null;
    status?: MemoryStatus | ReadonlyArray<MemoryStatus> | "all";
  }): Memory[] => {
    return memoryService.listMemories({
      projectId: input.projectId,
      scope: "mission",
      scopeOwnerIds: cleanIds([input.missionId, input.runId]),
      ...(normalizeStatuses(input.status) ? { status: normalizeStatuses(input.status) } : {}),
      limit: 500,
    });
  };

  const startMission = (input: {
    projectId: string;
    missionId: string;
    runId: string;
    initialDecision?: string | null;
  }): void => {
    const existing = listMissionEntries({
      projectId: input.projectId,
      missionId: input.missionId,
      runId: input.runId,
      status: "all",
    });
    if (existing.length > 0) return;

    if (input.initialDecision && input.initialDecision.trim().length > 0) {
      memoryService.writeMemory({
        projectId: input.projectId,
        scope: "mission",
        scopeOwnerId: input.missionId,
        category: "decision",
        content: input.initialDecision.trim(),
        importance: "high",
        confidence: 1,
        status: "promoted",
        sourceType: "system",
        sourceRunId: input.runId,
        sourceId: `mission-start:${input.missionId}`,
      });
    }
  };

  const recordFailureGotcha = (input: {
    projectId: string;
    missionId: string;
    runId: string;
    content: string;
    confidence?: number;
  }): Memory | null => {
    const result = memoryService.writeMemory({
      projectId: input.projectId,
      scope: "mission",
      scopeOwnerId: input.missionId,
      category: "gotcha",
      content: input.content,
      importance: "high",
      confidence: input.confidence ?? 0.9,
      status: "promoted",
      sourceType: "system",
      sourceRunId: input.runId,
      sourceId: `mission-failure:${input.runId}`,
      writeGateMode: "strict",
    });
    return result.memory ?? null;
  };

  const copyToProjectMemory = (memory: Memory, missionId: string): Memory | null => {
    const result = memoryService.writeMemory({
      projectId: memory.projectId,
      scope: "project",
      category: memory.category,
      content: memory.content,
      importance: memory.importance,
      confidence: memory.confidence,
      status: "promoted",
      pinned: memory.pinned,
      sourceSessionId: memory.sourceSessionId ?? undefined,
      sourcePackKey: memory.sourcePackKey ?? undefined,
      agentId: memory.agentId ?? undefined,
      sourceRunId: memory.sourceRunId ?? undefined,
      sourceType: "mission_promotion",
      sourceId: missionId,
      fileScopePattern: memory.fileScopePattern ?? undefined,
    });
    return result.memory ?? null;
  };

  const promoteMissionMemoryEntry = (input: {
    memoryId: string;
    missionId: string;
  }): Memory | null => {
    const memory = memoryService.getMemory(input.memoryId);
    if (!memory || memory.scope !== "mission") return null;
    const promoted = copyToProjectMemory(memory, input.missionId);
    memoryService.archiveMemory(memory.id);
    return promoted;
  };

  const finalizeMission = (input: {
    projectId: string;
    missionId: string;
    runId: string;
    finalStatus: "succeeded" | "failed" | "canceled";
  }): {
    promotedMemoryIds: string[];
    archivedMemoryIds: string[];
  } => {
    const missionEntries = listMissionEntries({
      projectId: input.projectId,
      missionId: input.missionId,
      runId: input.runId,
      status: "all",
    });
    const promotedMemoryIds: string[] = [];
    const archivedMemoryIds: string[] = [];

    if (input.finalStatus === "succeeded") {
      for (const entry of missionEntries) {
        if (entry.confidence < 0.7) continue;
        if (entry.status !== "promoted") continue;
        const promoted = copyToProjectMemory(entry, input.missionId);
        if (promoted) {
          promotedMemoryIds.push(promoted.id);
          try {
            memoryService.archiveMemory(entry.id);
            archivedMemoryIds.push(entry.id);
          } catch (error) {
            args.logger?.warn?.("mission_memory.archive_failed", {
              missionId: input.missionId,
              runId: input.runId,
              memoryId: entry.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } else {
      for (const entry of missionEntries) {
        try {
          memoryService.archiveMemory(entry.id);
          archivedMemoryIds.push(entry.id);
        } catch (error) {
          args.logger?.warn?.("mission_memory.archive_failed", {
            missionId: input.missionId,
            runId: input.runId,
            memoryId: entry.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return {
      promotedMemoryIds,
      archivedMemoryIds,
    };
  };

  return {
    startMission,
    listMissionEntries,
    recordFailureGotcha,
    promoteMissionMemoryEntry,
    finalizeMission,
  };
}

export type MissionMemoryLifecycleService = ReturnType<typeof createMissionMemoryLifecycleService>;
