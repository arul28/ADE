import { tool } from "ai";
import { z } from "zod";
import fs from "node:fs";

export const readFileRangeTool = tool({
  description:
    "Read a file's contents with line numbers. Can read specific ranges for large files.",
  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to the file"),
    offset: z
      .number()
      .optional()
      .describe("Starting line number (1-based). Defaults to 1."),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of lines to read. Defaults to all lines."),
  }),
  execute: async ({ file_path, offset, limit }) => {
    try {
      if (!fs.existsSync(file_path)) {
        return { content: "", totalLines: 0, error: `File not found: ${file_path}` };
      }

      const raw = fs.readFileSync(file_path, "utf-8");
      const allLines = raw.split("\n");
      const totalLines = allLines.length;

      const start = Math.max(1, offset ?? 1);
      const end = limit != null ? Math.min(start + limit - 1, totalLines) : totalLines;

      const selected = allLines.slice(start - 1, end);
      const numbered = selected
        .map((line, i) => `${String(start + i).padStart(6, " ")}\t${line}`)
        .join("\n");

      return {
        content: numbered,
        totalLines,
        startLine: start,
        endLine: end,
      };
    } catch (err) {
      return {
        content: "",
        totalLines: 0,
        error: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
