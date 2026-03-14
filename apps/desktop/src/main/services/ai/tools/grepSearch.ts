import { tool } from "ai";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

type GrepMatch = {
  file: string;
  line: number;
  content: string;
};

export const grepSearchTool = tool({
  description:
    "Search file contents using regex patterns. Returns matching lines with file paths and line numbers.",
  inputSchema: z.object({
    pattern: z.string().describe("Regular expression pattern to search for"),
    path: z
      .string()
      .optional()
      .describe("Directory or file to search in. Defaults to the working directory."),
    glob: z
      .string()
      .optional()
      .describe("File pattern filter (e.g., '*.ts', '*.{js,jsx}')"),
    context: z
      .number()
      .optional()
      .default(0)
      .describe("Number of context lines around each match"),
  }),
  execute: async ({ pattern, path: searchPath, glob: fileGlob, context }) => {
    const target = searchPath || process.cwd();

    try {
      const matches = await tryRipgrep(pattern, target, fileGlob, context);
      return { matches, matchCount: matches.length };
    } catch {
      // ripgrep not available — fall back to JS search
    }

    try {
      const matches = await jsFallbackGrep(pattern, target, fileGlob);
      return { matches, matchCount: matches.length };
    } catch (err) {
      return {
        matches: [],
        matchCount: 0,
        error: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

async function tryRipgrep(
  pattern: string,
  target: string,
  fileGlob: string | undefined,
  context: number
): Promise<GrepMatch[]> {
  const args = ["--line-number", "--no-heading", "--color=never"];
  if (context > 0) args.push(`-C`, String(context));
  if (fileGlob) args.push("--glob", fileGlob);
  args.push(pattern, target);

  const { stdout } = await execFileAsync("rg", args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });

  return parseRgOutput(stdout);
}

function parseRgOutput(stdout: string): GrepMatch[] {
  const results: GrepMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    // rg output: file:line:content
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (match) {
      results.push({
        file: match[1],
        line: parseInt(match[2], 10),
        content: match[3],
      });
    }
  }
  return results.slice(0, 500);
}

async function jsFallbackGrep(
  pattern: string,
  target: string,
  fileGlob: string | undefined
): Promise<GrepMatch[]> {
  const regex = new RegExp(pattern);
  const results: GrepMatch[] = [];
  const files = await collectFiles(target, fileGlob);

  for (const filePath of files) {
    if (results.length >= 500) break;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push({ file: filePath, line: i + 1, content: lines[i] });
          if (results.length >= 500) break;
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return results;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

async function collectFiles(
  dir: string,
  fileGlob: string | undefined,
  maxFiles = 5000
): Promise<string[]> {
  const stat = fs.statSync(dir);
  if (stat.isFile()) return [dir];

  const files: string[] = [];
  const globRegex = fileGlob ? globToRegex(fileGlob) : null;

  async function walk(current: string): Promise<void> {
    if (files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(path.join(current, entry.name));
        }
      } else if (entry.isFile()) {
        const fullPath = path.join(current, entry.name);
        if (!globRegex || globRegex.test(entry.name)) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(dir);
  return files;
}

function globToRegex(glob: string): RegExp {
  // Escape special regex chars except * and ? first, BEFORE brace expansion.
  // This avoids escaping the parens/pipe that brace expansion introduces.
  let pattern = glob.replace(/[.+^$[\]\\]/g, "\\$&");
  // Replace glob wildcards
  pattern = pattern.replace(/\*/g, ".*");
  pattern = pattern.replace(/\?/g, ".");
  // Handle {a,b} patterns (after escaping, so parens/pipe stay unescaped)
  pattern = pattern.replace(/\{([^}]+)\}/g, (_m, inner: string) => {
    return `(${inner.split(",").join("|")})`;
  });
  return new RegExp(`^${pattern}$`);
}
