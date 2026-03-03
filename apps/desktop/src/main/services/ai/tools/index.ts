import type { Tool } from "ai";
import { editFileTool } from "./editFile";
import { readFileRangeTool } from "./readFileRange";
import { grepSearchTool } from "./grepSearch";
import { globSearchTool } from "./globSearch";
import { webFetchTool } from "./webFetch";
import { webSearchTool } from "./webSearch";
import { createMemoryTools } from "./memoryTools";
import type { createMemoryService } from "../../memory/memoryService";

export type CodingToolSet = Record<string, Tool>;

export function createCodingToolSet(
  _cwd: string,
  opts?: { memoryService?: ReturnType<typeof createMemoryService>; projectId?: string; runId?: string }
): CodingToolSet {
  const tools: CodingToolSet = {
    edit: editFileTool,
    readRange: readFileRangeTool,
    grep: grepSearchTool,
    glob: globSearchTool,
    webFetch: webFetchTool,
    webSearch: webSearchTool,
  };
  if (opts?.memoryService && opts?.projectId) {
    const memTools = createMemoryTools(opts.memoryService, opts.projectId, opts.runId);
    Object.assign(tools, memTools);
  }
  return tools;
}

export { createUniversalToolSet } from "./universalTools";
export type { PermissionMode, UniversalToolSetOptions } from "./universalTools";
export { buildCodingAgentSystemPrompt } from "./systemPrompt";
export { loadMcpTools } from "./mcpBridge";
