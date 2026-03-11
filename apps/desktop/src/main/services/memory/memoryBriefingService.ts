import type { Memory, UnifiedMemoryService } from "./unifiedMemoryService";

export type MemoryBriefingLevel = "lite" | "standard" | "deep";

export type MemoryBriefingSection = {
  title: string;
  entries: Memory[];
};

export type BuildMemoryBriefingArgs = {
  projectId: string;
  missionId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  includeAgentMemory?: boolean;
  taskDescription?: string | null;
  phaseContext?: string | null;
  handoffSummaries?: string[];
  filePatterns?: string[];
  mode?: "mission_worker" | "heartbeat" | "wake_on_demand" | "prompt_preview";
};

export type MemoryBriefing = {
  l0: MemoryBriefingSection;
  l1: MemoryBriefingSection;
  l2: MemoryBriefingSection;
  mission: MemoryBriefingSection;
  sharedFacts: Array<{
    id: string;
    factType: string;
    content: string;
    createdAt: string;
  }>;
  usedProcedureIds: string[];
  usedDigestIds: string[];
  usedMissionMemoryIds: string[];
};

const BUDGET_LIMITS: Record<MemoryBriefingLevel, number> = {
  lite: 3,
  standard: 8,
  deep: 20,
};

function cleanParts(values: Array<string | null | undefined>): string[] {
  return values.map((value) => String(value ?? "").trim()).filter((value) => value.length > 0);
}

function buildQuery(args: BuildMemoryBriefingArgs): string {
  return cleanParts([
    args.taskDescription,
    args.phaseContext,
    ...(args.handoffSummaries ?? []),
    ...(args.filePatterns ?? []),
  ]).join(" ");
}

function uniqueMemories(entries: readonly Memory[]): Memory[] {
  const seen = new Set<string>();
  const unique: Memory[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

function mapMemoryCategoryToFactType(category: Memory["category"]): string {
  switch (category) {
    case "pattern":
      return "api_pattern";
    case "gotcha":
      return "gotcha";
    case "convention":
    case "preference":
      return "config";
    case "digest":
      return "schema_change";
    default:
      return "architectural";
  }
}

function pickLevel(mode: BuildMemoryBriefingArgs["mode"]): {
  l0: MemoryBriefingLevel;
  l1: MemoryBriefingLevel;
  l2: MemoryBriefingLevel;
  mission: MemoryBriefingLevel;
} {
  switch (mode) {
    case "heartbeat":
      return { l0: "lite", l1: "lite", l2: "lite", mission: "lite" };
    case "wake_on_demand":
      return { l0: "standard", l1: "standard", l2: "lite", mission: "standard" };
    case "prompt_preview":
      return { l0: "deep", l1: "standard", l2: "lite", mission: "standard" };
    default:
      return { l0: "deep", l1: "standard", l2: "lite", mission: "standard" };
  }
}

export function createMemoryBriefingService(args: {
  memoryService: Pick<UnifiedMemoryService, "getMemoryBudget" | "search" | "searchAcrossScopeOwners" | "listMemories">;
}) {
  const { memoryService } = args;

  const buildBriefing = async (input: BuildMemoryBriefingArgs): Promise<MemoryBriefing> => {
    const levels = pickLevel(input.mode);
    const query = buildQuery(input);
    const missionOwnerIds = cleanParts([input.missionId, input.runId]);

    const l0 = memoryService
      .getMemoryBudget(input.projectId, levels.l0, { scope: "project" })
      .filter((entry) => entry.tier === 1 || entry.pinned)
      .slice(0, BUDGET_LIMITS[levels.l0]);

    const l1Base = query.length > 0
      ? await memoryService.search({
          projectId: input.projectId,
          query,
          scope: "project",
          status: "promoted",
          limit: BUDGET_LIMITS[levels.l1],
          tiers: [1, 2],
        })
      : memoryService
          .getMemoryBudget(input.projectId, levels.l1, { scope: "project" })
          .filter((entry) => entry.tier <= 2);

    const l1 = uniqueMemories(
      l1Base.filter((entry) =>
        entry.category === "procedure"
        || entry.category === "digest"
        || entry.category === "pattern"
        || entry.category === "gotcha"
        || entry.category === "decision"
        || entry.category === "convention"
        || entry.category === "preference"
        || entry.pinned
      )
    ).slice(0, BUDGET_LIMITS[levels.l1]);

    const l2 = input.includeAgentMemory && input.agentId
      ? await memoryService.searchAcrossScopeOwners({
          projectId: input.projectId,
          query: query || input.agentId,
          scope: "agent",
          scopeOwnerIds: [input.agentId],
          status: ["promoted", "candidate"],
          limit: BUDGET_LIMITS[levels.l2],
          tiers: [1, 2, 3],
        })
      : [];

    const mission = missionOwnerIds.length > 0
      ? uniqueMemories(
          [
            ...memoryService.listMemories({
              projectId: input.projectId,
              scope: "mission",
              scopeOwnerIds: missionOwnerIds,
              status: ["promoted", "candidate"],
              tiers: [1, 2, 3],
              limit: BUDGET_LIMITS[levels.mission] * 2,
            }),
          ]
        ).slice(0, BUDGET_LIMITS[levels.mission])
      : [];

    const sharedFacts = mission
      .filter((entry) =>
        entry.category === "fact"
        || entry.category === "decision"
        || entry.category === "gotcha"
        || entry.category === "handoff"
        || entry.category === "digest"
        || entry.category === "pattern"
        || entry.category === "procedure"
      )
      .map((entry) => ({
        id: entry.id,
        factType: mapMemoryCategoryToFactType(entry.category),
        content: entry.content,
        createdAt: entry.createdAt,
      }));

    return {
      l0: { title: "Project Memory", entries: l0 },
      l1: { title: "Relevant Project Knowledge", entries: l1 },
      l2: { title: "Agent Memory", entries: l2 },
      mission: { title: "Mission Memory", entries: mission },
      sharedFacts,
      usedProcedureIds: uniqueMemories(l1.filter((entry) => entry.category === "procedure")).map((entry) => entry.id),
      usedDigestIds: uniqueMemories(l1.filter((entry) => entry.category === "digest")).map((entry) => entry.id),
      usedMissionMemoryIds: mission.map((entry) => entry.id),
    };
  };

  return {
    buildBriefing,
  };
}

export type MemoryBriefingService = ReturnType<typeof createMemoryBriefingService>;
