import { tool } from "ai";
import { z } from "zod";
import type { SharedFact, createMemoryService } from "../../memory/memoryService";

function mapCategoryToFactType(category: "fact" | "pattern" | "decision" | "gotcha"): SharedFact["factType"] {
  switch (category) {
    case "pattern":
      return "api_pattern";
    case "gotcha":
      return "gotcha";
    case "decision":
    case "fact":
    default:
      return "architectural";
  }
}

export function createMemoryTools(
  memoryService: ReturnType<typeof createMemoryService>,
  projectId: string,
  runId?: string
) {
  const memorySearch = tool({
    description: "Search project memory for relevant context, patterns, decisions, or gotchas from previous sessions.",
    inputSchema: z.object({
      query: z.string().describe("Search query for finding relevant memories"),
      scope: z.enum(["user", "project", "lane", "mission"]).optional().describe("Scope to search within"),
      limit: z.number().optional().default(5).describe("Maximum results to return")
    }),
    execute: async ({ query, scope, limit }) => {
      const memories = memoryService.searchMemories(query, projectId, scope as any, limit);
      return {
        memories: memories.map(m => ({
          category: m.category,
          content: m.content,
          importance: m.importance,
          createdAt: m.createdAt
        })),
        count: memories.length
      };
    }
  });

  const memoryAdd = tool({
    description: "Save an important finding, decision, pattern, or gotcha to project memory for future reference.",
    inputSchema: z.object({
      content: z.string().describe("The information to remember"),
      category: z.enum(["fact", "pattern", "decision", "gotcha"]).describe("Category of the memory"),
      importance: z.enum(["low", "medium", "high"]).optional().default("medium").describe("How important this memory is")
    }),
    execute: async ({ content, category, importance }) => {
      const memory = memoryService.addMemory({
        projectId,
        scope: "project",
        category,
        content,
        importance
      });

      if (runId) {
        try {
          memoryService.addSharedFact({
            runId,
            factType: mapCategoryToFactType(category),
            content
          });
        } catch {
          // Best-effort: project memory writes must not fail if shared facts persistence fails.
        }
      }

      return { saved: true, id: memory.id };
    }
  });

  return { memorySearch, memoryAdd };
}
