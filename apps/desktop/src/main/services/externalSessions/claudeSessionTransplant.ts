import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { claudeProjectSlugForCwd, isPathInside } from "./discoveryUtils";

function defaultClaudeConfigDir(): string {
  return path.join(os.homedir(), ".claude");
}

function ensureInside(root: string, target: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isPathInside(resolvedRoot, resolvedTarget)) {
    throw new Error(`${label} escapes Claude projects storage.`);
  }
  return resolvedTarget;
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === code);
}

function targetExistsError(targetPath: string): Error {
  return new Error(`Claude target session already exists at ${targetPath}.`);
}

async function linkWithoutClobber(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await fs.promises.link(sourcePath, targetPath);
  } catch (error) {
    if (isErrno(error, "EEXIST")) throw targetExistsError(targetPath);
    throw error;
  }
}

async function rewriteClaudeSessionFile(args: {
  sourcePath: string;
  targetPath: string;
  newSessionId: string;
}): Promise<void> {
  const tempPath = `${args.targetPath}.${process.pid}.${Date.now()}.tmp`;
  let input: fs.ReadStream | null = null;
  let output: fs.WriteStream | null = null;
  try {
    await fs.promises.mkdir(path.dirname(args.targetPath), { recursive: true });

    input = fs.createReadStream(args.sourcePath, { encoding: "utf8" });
    output = fs.createWriteStream(tempPath, { encoding: "utf8", flags: "wx" });
    const writeStream = output;
    const outputError = new Promise<never>((_resolve, reject) => {
      writeStream.once("error", reject);
    });

    const writeChunk = async (chunk: string): Promise<void> => {
      if (writeStream.write(chunk)) return;
      await Promise.race([
        new Promise<void>((resolve) => writeStream.once("drain", resolve)),
        outputError,
      ]);
    };

    const endOutput = async (): Promise<void> => {
      await Promise.race([
        new Promise<void>((resolve) => writeStream.end(resolve)),
        outputError,
      ]);
    };

    await Promise.race([
      (async () => {
        const lines = readline.createInterface({ input: input!, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (!line.trim()) {
              await writeChunk("\n");
              continue;
            }
            let nextLine = line;
            try {
              const parsed = JSON.parse(line);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                nextLine = JSON.stringify({ ...parsed, sessionId: args.newSessionId });
              }
            } catch {
              nextLine = line;
            }
            await writeChunk(`${nextLine}\n`);
          }
        } finally {
          lines.close();
        }
        await endOutput();
      })(),
      outputError,
    ]);

    await linkWithoutClobber(tempPath, args.targetPath);
    await fs.promises.unlink(tempPath);
  } catch (error) {
    input?.destroy();
    output?.destroy();
    throw error;
  } finally {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Best-effort cleanup: the temp file may not exist or may have been renamed.
    }
  }
}

export async function transplantClaudeSession(args: {
  sessionId: string;
  sourceCwd: string;
  targetCwd: string;
  fork: boolean;
  configDir?: string;
}): Promise<{ newSessionId: string; targetPath: string }> {
  const sessionId = args.sessionId.trim();
  const sourceCwd = args.sourceCwd.trim();
  const targetCwd = args.targetCwd.trim();
  if (!sessionId || !sourceCwd || !targetCwd) {
    throw new Error("Claude transplant requires sessionId, sourceCwd, and targetCwd.");
  }

  const configDir = path.resolve(args.configDir?.trim() || defaultClaudeConfigDir());
  const projectsDir = path.join(configDir, "projects");
  const sourceDir = path.join(projectsDir, claudeProjectSlugForCwd(sourceCwd));
  const targetDir = path.join(projectsDir, claudeProjectSlugForCwd(targetCwd));
  const sourcePath = ensureInside(sourceDir, path.join(sourceDir, `${sessionId}.jsonl`), "Claude source path");
  await fs.promises.access(sourcePath, fs.constants.R_OK);

  const newSessionId = args.fork ? randomUUID() : sessionId;
  const targetPath = ensureInside(targetDir, path.join(targetDir, `${newSessionId}.jsonl`), "Claude target path");
  await fs.promises.mkdir(targetDir, { recursive: true });

  if (args.fork) {
    await rewriteClaudeSessionFile({ sourcePath, targetPath, newSessionId });
    return { newSessionId, targetPath };
  }

  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return { newSessionId, targetPath };
  }
  await linkWithoutClobber(sourcePath, targetPath);
  await fs.promises.unlink(sourcePath);
  return { newSessionId, targetPath };
}
