import { tool } from "ai";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { getErrorMessage, resolvePathWithinRoot } from "../../shared/utils";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

type GlobMatch = {
  path: string;
  displayPath: string;
};

function toDisplayPath(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

export function createGlobSearchTool(cwd: string) {
  return tool({
    description: "Find files matching a glob pattern within the active repo root. Returns absolute paths plus displayPath values.",
    inputSchema: z.object({
      pattern: z
        .string()
        .describe("Glob pattern (e.g., '**/*.ts', 'src/**/*.test.tsx')"),
      path: z
        .string()
        .optional()
        .describe("Base directory to search from. Defaults to the active repo root."),
    }),
    execute: async ({ pattern, path: basePath }) => {
      const root = fs.realpathSync(cwd);
      let searchRoot: string;
      try {
        searchRoot = resolvePathWithinRoot(root, basePath ?? ".", { allowMissing: false });
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          files: [],
          count: 0,
          error: message === "Path escapes root"
            ? `Glob search path is outside the repo root: ${basePath ?? "."}`
            : `Glob search failed: ${message}`,
        };
      }

      try {
        const files = walkAndMatch(searchRoot, pattern);
        files.sort();
        const matches: GlobMatch[] = files.map((filePath) => ({
          path: filePath,
          displayPath: toDisplayPath(root, filePath),
        }));
        return {
          root: searchRoot,
          files,
          displayFiles: matches.map((match) => match.displayPath),
          matches,
          count: files.length,
        };
      } catch (err) {
        return {
          files: [],
          count: 0,
          error: `Glob search failed: ${getErrorMessage(err)}`,
        };
      }
    },
  });
}

function walkAndMatch(root: string, globPattern: string, maxFiles = 5000): string[] {
  const results: string[] = [];
  const regex = globPatternToRegex(globPattern);

  function walk(dir: string): void {
    if (results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (regex.test(relativePath)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(root);
  return results;
}

function globPatternToRegex(glob: string): RegExp {
  // Split into segments and process
  const segments = glob.split("/");
  const regexParts: string[] = [];

  for (const seg of segments) {
    if (seg === "**") {
      regexParts.push("(?:.+/)?");
    } else {
      let part = seg;
      // Escape regex special chars except *, ?, and {} first
      part = part.replace(/[.+^$[\]\\]/g, "\\$&");
      // Replace glob wildcards
      part = part.replace(/\*/g, "[^/]*");
      part = part.replace(/\?/g, "[^/]");
      // Handle {a,b} patterns AFTER escaping so parens/pipe stay unescaped
      part = part.replace(/\{([^}]+)\}/g, (_m, inner: string) => {
        return `(${inner.split(",").join("|")})`;
      });
      regexParts.push(part);
    }
  }

  // Join with / and anchor
  const joined = regexParts.join("/").replace(/\/\(\?:\.\+\/\)\?\//g, "/(?:.+/)?");
  return new RegExp(`^${joined}$`);
}

export const globSearchTool = createGlobSearchTool(process.cwd());
