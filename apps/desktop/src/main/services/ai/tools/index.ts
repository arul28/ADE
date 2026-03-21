import type { Tool } from "ai";
import type { createUnifiedMemoryService } from "../../memory/unifiedMemoryService";
import { createUniversalToolSet } from "./universalTools";

export type CodingToolSet = Record<string, Tool>;

export function createCodingToolSet(
  cwd: string,
  opts?: {
    memoryService?: ReturnType<typeof createUnifiedMemoryService>;
    projectId?: string;
    runId?: string;
    stepId?: string;
    agentScopeOwnerId?: string;
  }
): CodingToolSet {
  const tools: CodingToolSet = createUniversalToolSet(cwd, {
    permissionMode: "edit",
    ...(opts?.memoryService && opts?.projectId
      ? {
          memoryService: opts.memoryService,
          projectId: opts.projectId,
          runId: opts.runId,
          stepId: opts.stepId,
          agentScopeOwnerId: opts.agentScopeOwnerId,
        }
      : {}),
  });
  delete tools.askUser;
  return tools;
}

export { createUniversalToolSet } from "./universalTools";
export type { PermissionMode, UniversalToolSetOptions } from "./universalTools";
export { buildCodingAgentSystemPrompt, composeSystemPrompt } from "./systemPrompt";
