import { executableTool as tool } from "./executableTool";
import { z } from "zod";

export const webSearchTool = tool({
  description: "Search the web for information. Returns relevant results.",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    count: z
      .number()
      .optional()
      .default(5)
      .describe("Number of results to return"),
  }),
  execute: async (_args) => {
    return {
      results: [],
      message:
        "Web search requires a Tavily API key. Configure it in Settings > Providers.",
    };
  },
});
