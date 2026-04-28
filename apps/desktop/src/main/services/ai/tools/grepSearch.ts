import { executableTool as tool } from "./executableTool";
import { z } from "zod";
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getErrorMessage, resolvePathWithinRoot } from "../../shared/utils";

/** Swappable for Vitest — defaults to Node's `execFile`. */
let execFileForRipgrep: typeof execFile = execFile;

/** @internal Used by grepSearch.test.ts to force the JS fallback path. */
export function __testSetRipgrepExecFile(fn: typeof execFile): void {
  execFileForRipgrep = fn;
}

/** @internal */
export function __testResetRipgrepExecFile(): void {
  execFileForRipgrep = execFile;
}

function execFileAsync(
  file: string,
  args: readonly string[] | null | undefined,
  options: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileForRipgrep(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

type GrepMatch = {
  path: string;
  displayPath: string;
  file: string;
  line: number;
  content: string;
};

function toDisplayPath(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function normalizeMatch(root: string, filePath: string, line: number, content: string): GrepMatch {
  return {
    path: filePath,
    displayPath: toDisplayPath(root, filePath),
    file: filePath,
    line,
    content,
  };
}

export function createGrepSearchTool(cwd: string) {
  return tool({
    description:
      "Search file contents using regex patterns. Accepts an absolute or repo-relative target path and returns absolute paths plus displayPath values.",
    inputSchema: z.object({
      pattern: z.string().describe("Regular expression pattern to search for"),
      path: z
        .string()
        .optional()
        .describe("Directory or file to search in. Defaults to the active repo root."),
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
      const root = fs.realpathSync(cwd);
      let target: string;
      try {
        target = resolvePathWithinRoot(root, searchPath ?? ".", { allowMissing: false });
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          matches: [],
          matchCount: 0,
          error: message === "Path escapes root"
            ? `Search path is outside the repo root: ${searchPath ?? "."}`
            : `Search failed: ${message}`,
        };
      }

      try {
        const matches = await tryRipgrep(root, pattern, target, fileGlob, context);
        return { matches, matchCount: matches.length, root: target };
      } catch {
        // ripgrep not available — fall back to JS search
      }

      try {
        const matches = jsFallbackGrep(root, pattern, target, fileGlob);
        return { matches, matchCount: matches.length, root: target };
      } catch (err) {
        const message = getErrorMessage(err);
        return {
          matches: [],
          matchCount: 0,
          error: message.startsWith("Invalid regex pattern")
            ? message
            : `Search failed: ${message}`,
        };
      }
    },
  });
}

async function tryRipgrep(
  root: string,
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

  return parseRgOutput(root, stdout);
}

function parseRgOutput(root: string, stdout: string): GrepMatch[] {
  const results: GrepMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    // rg output: file:line:content
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (match) {
      results.push(normalizeMatch(root, path.resolve(match[1]), parseInt(match[2], 10), match[3]));
    }
  }
  return results.slice(0, 500);
}

function jsFallbackGrep(
  root: string,
  pattern: string,
  target: string,
  fileGlob: string | undefined
): GrepMatch[] {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    // Surface a user-facing message distinct from generic "Search failed".
    // Ripgrep itself returns a descriptive error for malformed patterns; match that ergonomic on the fallback path.
    throw new Error(`Invalid regex pattern: ${getErrorMessage(error)}`);
  }
  const results: GrepMatch[] = [];
  const searchWholeRepo = path.resolve(target) === path.resolve(root);
  const files = collectFiles(target, fileGlob, searchWholeRepo);

  for (const filePath of files) {
    if (results.length >= 500) break;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(normalizeMatch(root, filePath, i + 1, lines[i]));
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

/** Hidden first-segment dirs under the repo root we still want repo-wide search to enter. */
const ALLOW_HIDDEN_ROOT_DIRS = new Set([".github"]);

function shouldSkipHiddenDirUnderRepoRoot(
  rootReal: string,
  parentAbs: string,
  dirName: string,
  searchWholeRepo: boolean,
): boolean {
  if (!searchWholeRepo) return false;
  if (!dirName.startsWith(".") || dirName === "." || dirName === "..") return false;
  if (ALLOW_HIDDEN_ROOT_DIRS.has(dirName)) return false;
  const childAbs = path.resolve(path.join(parentAbs, dirName));
  const rel = path.relative(rootReal, childAbs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const first = rel.split(path.sep)[0] ?? "";
  // Only skip direct children of the repo root (e.g. `.ade`, `.env`) — not `src/.cache`.
  return first === dirName;
}

function collectFiles(
  dir: string,
  fileGlob: string | undefined,
  searchWholeRepo: boolean,
  maxFiles = 5000
): string[] {
  const stat = fs.statSync(dir);
  if (stat.isFile()) return [dir];

  const files: string[] = [];
  const normalizedFileGlob = fileGlob?.replace(/\\/g, "/");
  const globRegex = normalizedFileGlob ? globToRegex(normalizedFileGlob) : null;
  const globIncludesDirectory = normalizedFileGlob?.includes("/") ?? false;
  const rootReal = fs.realpathSync(dir);

  function walk(current: string): void {
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
        if (SKIP_DIRS.has(entry.name)) continue;
        const next = path.join(current, entry.name);
        if (
          shouldSkipHiddenDirUnderRepoRoot(rootReal, current, entry.name, searchWholeRepo)
        ) {
          continue;
        }
        walk(next);
      } else if (entry.isFile()) {
        const fullPath = path.join(current, entry.name);
        const relativeFilePath = path.relative(rootReal, fullPath).replace(/\\/g, "/");
        const globTarget = globIncludesDirectory ? relativeFilePath : entry.name;
        if (!globRegex || globRegex.test(globTarget)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return files;
}

function globToRegex(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    const next = glob[i + 1];

    if (char === "*" && next === "*") {
      if (glob[i + 2] === "/") {
        pattern += "(?:.*/)?";
        i += 2;
      } else {
        pattern += ".*";
        i += 1;
      }
      continue;
    }

    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    if (char === "{") {
      const close = glob.indexOf("}", i + 1);
      if (close !== -1) {
        const alternatives = glob
          .slice(i + 1, close)
          .split(",")
          .map((part) => part.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"));
        pattern += `(${alternatives.join("|")})`;
        i = close;
        continue;
      }
    }

    pattern += char.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

export const grepSearchTool = createGrepSearchTool(process.cwd());
