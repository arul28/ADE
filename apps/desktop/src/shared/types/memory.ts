export type MemorySweepTrigger = "manual" | "startup";

export type MemoryLifecycleSweepResult = {
  sweepId: string;
  projectId: string;
  reason: MemorySweepTrigger;
  startedAt: string;
  completedAt: string;
  halfLifeDays: number;
  entriesDecayed: number;
  entriesDemoted: number;
  entriesPromoted: number;
  entriesArchived: number;
  entriesOrphaned: number;
  durationMs: number;
};

export type MemorySweepStatusEventPayload =
  | {
      type: "memory-sweep-started";
      projectId: string;
      reason: MemorySweepTrigger;
      sweepId: string;
      startedAt: string;
    }
  | {
      type: "memory-sweep-completed";
      projectId: string;
      reason: MemorySweepTrigger;
      sweepId: string;
      startedAt: string;
      completedAt: string;
      result: MemoryLifecycleSweepResult;
    }
  | {
      type: "memory-sweep-failed";
      projectId: string;
      reason: MemorySweepTrigger;
      sweepId: string;
      startedAt: string;
      completedAt: string;
      durationMs: number;
      error: string;
    };
