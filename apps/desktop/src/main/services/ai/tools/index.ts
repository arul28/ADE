import type { Tool } from "ai";
import { editFileTool } from "./editFile";
import { readFileRangeTool } from "./readFileRange";
import { grepSearchTool } from "./grepSearch";
import { globSearchTool } from "./globSearch";
import { webFetchTool } from "./webFetch";
import { webSearchTool } from "./webSearch";

export type CodingToolSet = Record<string, Tool>;

export function createCodingToolSet(_cwd: string): CodingToolSet {
  return {
    edit: editFileTool,
    readRange: readFileRangeTool,
    grep: grepSearchTool,
    glob: globSearchTool,
    webFetch: webFetchTool,
    webSearch: webSearchTool,
  };
}

export { buildCodingAgentSystemPrompt } from "./systemPrompt";
export { loadMcpTools } from "./mcpBridge";
