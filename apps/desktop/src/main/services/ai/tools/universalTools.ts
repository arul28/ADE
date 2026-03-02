import { tool, type Tool } from "ai";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { editFileTool } from "./editFile";
import { readFileRangeTool } from "./readFileRange";
import { grepSearchTool } from "./grepSearch";
import { globSearchTool } from "./globSearch";
import { webFetchTool } from "./webFetch";
import { webSearchTool } from "./webSearch";
import { createMemoryTools } from "./memoryTools";
import type { createMemoryService } from "../../memory/memoryService";

const execFileAsync = promisify(execFile);

export type PermissionMode = "plan" | "edit" | "full-auto";

export interface UniversalToolSetOptions {
  permissionMode: PermissionMode;
  memoryService?: ReturnType<typeof createMemoryService>;
  projectId?: string;
  /** Callback invoked when askUser tool is called; must return the user's response */
  onAskUser?: (question: string) => Promise<string>;
}

// ── Permission helpers ──────────────────────────────────────────────

type ToolCategory = "read" | "write" | "bash";

function requiresApproval(mode: PermissionMode, category: ToolCategory): boolean {
  switch (mode) {
    case "plan":
      return category !== "read";
    case "edit":
      return category === "bash";
    case "full-auto":
      return false;
  }
}

function makeApproval(mode: PermissionMode, category: ToolCategory) {
  const needs = requiresApproval(mode, category);
  if (!needs) return undefined;
  // Return a static async function so the AI SDK gates execution
  return async () => true;
}

// ── New tool implementations ────────────────────────────────────────

function createBashTool(cwd: string, mode: PermissionMode) {
  return tool({
    description:
      "Execute a shell command and return stdout/stderr. " +
      "Commands run in a non-interactive shell with a 120-second timeout.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
      timeout: z
        .number()
        .optional()
        .default(120_000)
        .describe("Timeout in milliseconds (max 600000)"),
    }),
    ...((() => { const a = makeApproval(mode, "bash"); return a ? { needsApproval: a } : {}; })()),
    execute: async ({ command, timeout }) => {
      const clampedTimeout = Math.min(timeout, 600_000);
      try {
        const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
          (resolve, reject) => {
            const proc = spawn("bash", ["-c", command], {
              cwd,
              timeout: clampedTimeout,
              stdio: ["ignore", "pipe", "pipe"],
              env: { ...process.env, TERM: "dumb" },
            });

            let stdout = "";
            let stderr = "";

            proc.stdout.on("data", (d: Buffer) => {
              stdout += d.toString();
              // Cap output at 1MB
              if (stdout.length > 1_000_000) {
                proc.kill("SIGTERM");
              }
            });
            proc.stderr.on("data", (d: Buffer) => {
              stderr += d.toString();
              if (stderr.length > 1_000_000) {
                proc.kill("SIGTERM");
              }
            });

            proc.on("close", (code) => {
              resolve({
                stdout: stdout.slice(0, 200_000),
                stderr: stderr.slice(0, 50_000),
                exitCode: code ?? 1,
              });
            });
            proc.on("error", reject);
          }
        );
        return result;
      } catch (err) {
        return {
          stdout: "",
          stderr: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
        };
      }
    },
  });
}

function createWriteFileTool(mode: PermissionMode) {
  return tool({
    description:
      "Create or overwrite a file with the given content. " +
      "Parent directories are created automatically.",
    inputSchema: z.object({
      file_path: z.string().describe("Absolute path to the file"),
      content: z.string().describe("The full content to write"),
    }),
    ...((() => { const a = makeApproval(mode, "write"); return a ? { needsApproval: a } : {}; })()),
    execute: async ({ file_path, content }) => {
      try {
        const dir = path.dirname(file_path);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(file_path, content, "utf-8");
        return { success: true, message: `Wrote ${content.length} characters to ${file_path}` };
      } catch (err) {
        return {
          success: false,
          message: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
}

function createListDirTool() {
  return tool({
    description:
      "List directory contents with file types and sizes. " +
      "Returns entries sorted alphabetically, directories first.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the directory"),
      recursive: z
        .boolean()
        .optional()
        .default(false)
        .describe("List recursively (max 1000 entries)"),
    }),
    execute: async ({ path: dirPath, recursive }) => {
      try {
        if (!fs.existsSync(dirPath)) {
          return { entries: [], error: `Directory not found: ${dirPath}` };
        }
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) {
          return { entries: [], error: `Not a directory: ${dirPath}` };
        }

        const entries: Array<{ name: string; type: "file" | "directory"; size?: number }> = [];
        const maxEntries = 1000;

        function walk(dir: string, prefix: string) {
          if (entries.length >= maxEntries) return;
          let items: fs.Dirent[];
          try {
            items = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          // Sort: directories first, then alphabetically
          items.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });
          for (const item of items) {
            if (entries.length >= maxEntries) return;
            const relName = prefix ? `${prefix}/${item.name}` : item.name;
            if (item.isDirectory()) {
              entries.push({ name: relName, type: "directory" });
              if (recursive && !item.name.startsWith(".") && item.name !== "node_modules") {
                walk(path.join(dir, item.name), relName);
              }
            } else {
              let size: number | undefined;
              try {
                size = fs.statSync(path.join(dir, item.name)).size;
              } catch {
                // skip
              }
              entries.push({ name: relName, type: "file", size });
            }
          }
        }

        walk(dirPath, "");
        return { entries, count: entries.length, truncated: entries.length >= maxEntries };
      } catch (err) {
        return {
          entries: [],
          error: `Error listing directory: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
}

function createGitStatusTool(cwd: string) {
  return tool({
    description: "Show the working tree status (staged, unstaged, untracked files).",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-u"], {
          cwd,
          timeout: 15_000,
        });
        const { stdout: branch } = await execFileAsync(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd, timeout: 5_000 }
        );
        return { branch: branch.trim(), status: stdout.trim(), clean: stdout.trim() === "" };
      } catch (err) {
        return { error: `git status failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}

function createGitDiffTool(cwd: string) {
  return tool({
    description:
      "Show file diffs. By default shows unstaged changes. " +
      "Use staged=true for staged changes, or provide a ref to diff against.",
    inputSchema: z.object({
      staged: z.boolean().optional().default(false).describe("Show staged changes"),
      ref: z.string().optional().describe("Git ref to diff against (e.g., 'HEAD~1', 'main')"),
      path: z.string().optional().describe("Limit diff to a specific file or directory"),
    }),
    execute: async ({ staged, ref, path: filePath }) => {
      try {
        const args = ["diff", "--stat", "--patch"];
        if (staged && !ref) args.push("--cached");
        if (ref) args.push(ref);
        if (filePath) {
          args.push("--");
          args.push(filePath);
        }
        const { stdout } = await execFileAsync("git", args, {
          cwd,
          timeout: 30_000,
          maxBuffer: 5 * 1024 * 1024,
        });
        const truncated = stdout.length > 200_000;
        return { diff: stdout.slice(0, 200_000), truncated };
      } catch (err) {
        return { diff: "", error: `git diff failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}

function createGitLogTool(cwd: string) {
  return tool({
    description: "Show recent commit history.",
    inputSchema: z.object({
      count: z.number().optional().default(10).describe("Number of commits to show"),
      oneline: z.boolean().optional().default(true).describe("One-line format"),
      ref: z.string().optional().describe("Branch or ref to show log for"),
    }),
    execute: async ({ count, oneline, ref }) => {
      try {
        const args = ["log", `-${Math.min(count, 100)}`];
        if (oneline) {
          args.push("--oneline");
        } else {
          args.push("--format=%H %an %ad %s", "--date=short");
        }
        if (ref) args.push(ref);
        const { stdout } = await execFileAsync("git", args, { cwd, timeout: 15_000 });
        return { log: stdout.trim() };
      } catch (err) {
        return { log: "", error: `git log failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}

function createAskUserTool(onAskUser?: (question: string) => Promise<string>) {
  return tool({
    description:
      "Ask the user a clarifying question when you need more information to proceed. " +
      "Use sparingly — only when truly blocked.",
    inputSchema: z.object({
      question: z.string().describe("The question to ask the user"),
    }),
    execute: async ({ question }) => {
      if (!onAskUser) {
        return { answer: "", error: "askUser callback not configured" };
      }
      try {
        const answer = await onAskUser(question);
        return { answer };
      } catch (err) {
        return {
          answer: "",
          error: `Failed to get user response: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
}

// ── Public factory ──────────────────────────────────────────────────

export function createUniversalToolSet(
  cwd: string,
  opts: UniversalToolSetOptions
): Record<string, Tool> {
  const { permissionMode, memoryService, projectId, onAskUser } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, Tool<any, any>> = {
    // Read-only tools (auto-allowed in all modes)
    readFile: readFileRangeTool,
    grep: grepSearchTool,
    glob: globSearchTool,
    listDir: createListDirTool(),
    gitStatus: createGitStatusTool(cwd),
    gitDiff: createGitDiffTool(cwd),
    gitLog: createGitLogTool(cwd),
    webFetch: webFetchTool,
    webSearch: webSearchTool,

    // Write tools (auto in edit+full-auto, gated in plan)
    editFile: editFileTool,
    writeFile: createWriteFileTool(permissionMode),

    // Bash (auto only in full-auto, gated in plan+edit)
    bash: createBashTool(cwd, permissionMode),

    // Interactive
    askUser: createAskUserTool(onAskUser),
  };

  // Conditionally add memory tools
  if (memoryService && projectId) {
    const memTools = createMemoryTools(memoryService, projectId);
    Object.assign(tools, memTools);
  }

  return tools;
}
