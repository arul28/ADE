import { tool } from "ai";
import { z } from "zod";
import type {
  createUnifiedMemoryService,
} from "../../memory/unifiedMemoryService";

export function createMemoryTools(
  memoryService: ReturnType<typeof createUnifiedMemoryService>,
  projectId: string,
  opts?: { runId?: string; stepId?: string; agentScopeOwnerId?: string }
) {
  const resolveScopeOwnerId = (scope: "project" | "agent" | "mission", explicit?: string) => {
    if (explicit && explicit.trim().length > 0) return explicit.trim();
    if (scope === "agent" && opts?.agentScopeOwnerId?.trim()) return opts.agentScopeOwnerId.trim();
    if (scope === "mission" && opts?.runId) return opts.runId;
    return undefined;
  };

  const memorySearch = tool({
    description: "Search project memory BEFORE starting work that might repeat past mistakes. Use at session start for orientation, before architectural decisions, and when you hit unexpected behavior that might be a known gotcha. Do NOT search for things you can find with grep, git log, or by reading code directly.",
    inputSchema: z.object({
      query: z.string().describe("Search query for finding relevant memories"),
      scope: z.enum(["project", "agent", "mission"]).optional().describe("Scope to search within"),
      scopeOwnerId: z.string().optional().describe("Optional owner id for agent/mission scope"),
      limit: z.number().optional().default(5).describe("Maximum results to return")
    }),
    execute: async ({ query, scope, scopeOwnerId, limit }) => {
      const memories = await memoryService.search({
        projectId,
        query,
        scope,
        ...(scope ? { scopeOwnerId: resolveScopeOwnerId(scope, scopeOwnerId) ?? null } : {}),
        limit
      });
      return {
        memories: memories.map(m => ({
          id: m.id,
          scope: m.scope,
          tier: m.tier,
          pinned: m.pinned,
          category: m.category,
          content: m.content,
          importance: m.importance,
          confidence: m.confidence,
          compositeScore: m.compositeScore,
          createdAt: m.createdAt
        })),
        count: memories.length
      };
    }
  });

  const memoryAdd = tool({
    description: `Save a durable insight that would help a developer who has never seen this project before.

GOOD memories (save these):
- "Convention: always use snake_case for database columns — the ORM breaks with camelCase"
- "Decision: chose PostgreSQL over MongoDB because we need ACID transactions for payment processing"
- "Pitfall: the CI pipeline silently skips tests if the test file doesn't match *.test.ts pattern"
- "Pattern: all API routes must call validateSession() before accessing req.user — middleware doesn't cover /internal/* paths"

BAD memories (never save these):
- File paths or doc paths (derivable from the project with search)
- Raw error messages without a lesson learned
- Task progress or status updates
- Things findable via git log or git blame
- Obvious patterns already visible in the codebase

Format: Lead with the concrete rule or fact, then brief context for WHY it matters. One actionable insight per memory, not a paragraph of narrative.`,
    inputSchema: z.object({
      content: z.string().describe("The information to remember"),
      category: z.enum(["fact", "convention", "pattern", "decision", "gotcha", "preference"]).describe("Category of the memory"),
      scope: z.enum(["project", "agent", "mission"]).optional().default("project").describe("Scope to write into"),
      scopeOwnerId: z.string().optional().describe("Optional owner id for agent/mission scope"),
      importance: z.enum(["low", "medium", "high"]).optional().default("medium").describe("How important this memory is"),
      pin: z.boolean().optional().default(false).describe("Pin as Tier-1 memory"),
      writeMode: z.enum(["default", "strict"]).optional().default("default").describe("Write-gate mode")
    }),
    execute: async ({ content, category, scope, scopeOwnerId, importance, pin, writeMode }) => {
      const resolvedScopeOwnerId = resolveScopeOwnerId(scope, scopeOwnerId);
      const result = memoryService.writeMemory({
        projectId,
        scope,
        scopeOwnerId: resolvedScopeOwnerId,
        tier: pin ? 1 : 2,
        category,
        content,
        importance,
        pinned: pin,
        status: "promoted",
        confidence: 1,
        writeGateMode: writeMode
      });

      if (!result.accepted || !result.memory) {
        return {
          saved: false,
          reason: result.reason ?? "write gate rejected memory"
        };
      }

      const memory = result.memory;
      return {
        saved: true,
        id: memory.id,
        tier: memory.tier,
        deduped: result.deduped === true,
        mergedIntoId: result.mergedIntoId ?? null
      };
    }
  });

  const memoryPin = tool({
    description: "Pin or unpin an existing durable memory entry (Tier-1 when pinned).",
    inputSchema: z.object({
      id: z.string().describe("Memory id"),
      pinned: z.boolean().optional().default(true).describe("Whether to pin or unpin the memory")
    }),
    execute: async ({ id, pinned }) => {
      const updated = pinned ? memoryService.pinMemory(id) : memoryService.unpinMemory(id);
      return {
        ok: !!updated,
        id,
        pinned: updated?.pinned ?? false,
        tier: updated?.tier ?? null
      };
    }
  });

  return { memorySearch, memoryAdd, memoryPin };
}
