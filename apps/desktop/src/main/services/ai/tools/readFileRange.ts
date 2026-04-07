import { tool } from "ai";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { getErrorMessage, readFileWithinRootSecure, resolvePathWithinRoot } from "../../shared/utils";

function toDisplayPath(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

export function createReadFileRangeTool(cwd: string) {
  return tool({
    description:
      "Read a file's contents with line numbers. Accepts an absolute path or a path relative to the active repo root.",
    inputSchema: z.object({
      file_path: z.string().describe("Absolute path or repo-relative path to the file"),
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
        const root = fs.realpathSync(cwd);
        let resolvedPath: string;
        try {
          resolvedPath = resolvePathWithinRoot(root, file_path, { allowMissing: false });
        } catch (error) {
          const message = getErrorMessage(error);
          if (message.startsWith("Path does not exist:")) {
            return { content: "", totalLines: 0, error: `File not found: ${file_path}` };
          }
          if (message === "Path escapes root") {
            return { content: "", totalLines: 0, error: `Read path is outside the repo root: ${file_path}` };
          }
          return { content: "", totalLines: 0, error: `Error reading file: ${message}` };
        }

        const raw = readFileWithinRootSecure(root, file_path).toString("utf-8");
        const allLines = raw.split("\n");
        const totalLines = allLines.length;

        const start = Math.max(1, offset ?? 1);
        const end = limit != null ? Math.min(start + limit - 1, totalLines) : totalLines;

        const selected = allLines.slice(start - 1, end);
        const numbered = selected
          .map((line, i) => `${String(start + i).padStart(6, " ")}\t${line}`)
          .join("\n");

        return {
          path: resolvedPath,
          displayPath: toDisplayPath(root, resolvedPath),
          content: numbered,
          totalLines,
          startLine: start,
          endLine: end,
        };
      } catch (err) {
        return {
          content: "",
          totalLines: 0,
          error: `Error reading file: ${getErrorMessage(err)}`,
        };
      }
    },
  });
}

export const readFileRangeTool = createReadFileRangeTool(process.cwd());
