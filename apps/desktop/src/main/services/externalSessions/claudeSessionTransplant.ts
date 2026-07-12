import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { claudeProjectSlugForCwd, isPathInside } from "./discoveryUtils";

function defaultClaudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) return configured;
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

function rewriteClaudeJsonlLine(line: string, newSessionId: string, targetCwd: string): string {
  if (!line.trim()) return "";
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return JSON.stringify({
        ...record,
        sessionId: newSessionId,
        ...(typeof record.cwd === "string" ? { cwd: targetCwd } : {}),
      });
    }
  } catch {
    // Preserve malformed rows verbatim; Claude's transcript reader applies its
    // own tolerance and a transplant must not discard source bytes.
  }
  return line;
}

function rewriteClaudeJsonlContent(content: Buffer, newSessionId: string, targetCwd: string): Buffer {
  const raw = content.toString("utf8");
  const lines = raw.split(/\r?\n/);
  const hadTrailingNewline = /\r?\n$/.test(raw);
  if (hadTrailingNewline) lines.pop();
  const rewritten = lines
    .map((line) => rewriteClaudeJsonlLine(line, newSessionId, targetCwd))
    .join("\n");
  return Buffer.from(`${rewritten}${hadTrailingNewline ? "\n" : ""}`, "utf8");
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
  targetCwd: string;
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
            const nextLine = rewriteClaudeJsonlLine(line, args.newSessionId, args.targetCwd);
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

async function copyClaudeSidecarDirectory(args: {
  sourceDir: string;
  targetDir: string;
  newSessionId: string;
  targetCwd: string;
}): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(args.sourceDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }

  await fs.promises.mkdir(args.targetDir, { recursive: true });
  for (const entry of entries) {
    const sourcePath = path.join(args.sourceDir, entry.name);
    const targetPath = ensureInside(args.targetDir, path.join(args.targetDir, entry.name), "Claude sidecar target path");
    if (entry.isDirectory()) {
      await copyClaudeSidecarDirectory({
        ...args,
        sourceDir: sourcePath,
        targetDir: targetPath,
      });
      continue;
    }
    if (!entry.isFile()) continue;
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    if (entry.name.endsWith(".jsonl")) {
      const content = await fs.promises.readFile(sourcePath);
      await fs.promises.writeFile(
        targetPath,
        rewriteClaudeJsonlContent(content, args.newSessionId, args.targetCwd),
        { flag: "wx" },
      );
    } else {
      await fs.promises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    }
  }
}

async function writeClaudeTransportSideFiles(args: {
  targetDir: string;
  sideFiles: Array<{ relPath: string; content: Buffer }>;
  newSessionId: string;
  targetCwd: string;
}): Promise<void> {
  for (const sideFile of args.sideFiles) {
    const targetPath = ensureInside(
      args.targetDir,
      path.join(args.targetDir, sideFile.relPath),
      "Claude sidecar target path",
    );
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    const content = sideFile.relPath.endsWith(".jsonl")
      ? rewriteClaudeJsonlContent(sideFile.content, args.newSessionId, args.targetCwd)
      : sideFile.content;
    await fs.promises.writeFile(targetPath, content, { flag: "wx" });
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
  const sourceSidecarDir = ensureInside(sourceDir, path.join(sourceDir, sessionId), "Claude source sidecar path");
  const targetSidecarDir = ensureInside(targetDir, path.join(targetDir, newSessionId), "Claude target sidecar path");
  await fs.promises.mkdir(targetDir, { recursive: true });

  if (args.fork) {
    await rewriteClaudeSessionFile({ sourcePath, targetPath, newSessionId, targetCwd });
    try {
      await copyClaudeSidecarDirectory({
        sourceDir: sourceSidecarDir,
        targetDir: targetSidecarDir,
        newSessionId,
        targetCwd,
      });
    } catch (error) {
      await fs.promises.rm(targetSidecarDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.promises.unlink(targetPath).catch(() => undefined);
      throw error;
    }
    return { newSessionId, targetPath };
  }

  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return { newSessionId, targetPath };
  }
  await rewriteClaudeSessionFile({ sourcePath, targetPath, newSessionId, targetCwd });
  try {
    await copyClaudeSidecarDirectory({
      sourceDir: sourceSidecarDir,
      targetDir: targetSidecarDir,
      newSessionId,
      targetCwd,
    });
  } catch (error) {
    // Mirror the fork branch: without this rollback the wx-flagged target
    // files block every retry of a move (same sessionId) until cleaned by hand.
    await fs.promises.rm(targetSidecarDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.promises.unlink(targetPath).catch(() => undefined);
    throw error;
  }
  await fs.promises.unlink(sourcePath);
  // A move relocates the session; leaving the source sidecar dir behind would
  // duplicate tool outputs at both project dirs.
  await fs.promises.rm(sourceSidecarDir, { recursive: true, force: true }).catch(() => undefined);
  return { newSessionId, targetPath };
}

export async function placeClaudeForkFromTransport(args: {
  mainContent: Buffer;
  mainSessionIdHint?: string;
  sideFiles: Array<{ relPath: string; content: Buffer }>;
  targetCwd: string;
  configDir?: string;
}): Promise<{ newSessionId: string; targetPath: string }> {
  const targetCwd = args.targetCwd.trim();
  if (!targetCwd || !Buffer.isBuffer(args.mainContent) || args.mainContent.length === 0) {
    throw new Error("Claude fork transport requires transcript content and a target cwd.");
  }

  const configDir = path.resolve(args.configDir?.trim() || defaultClaudeConfigDir());
  const projectsDir = path.join(configDir, "projects");
  const targetDir = path.join(projectsDir, claudeProjectSlugForCwd(targetCwd));
  const newSessionId = randomUUID();
  const targetPath = ensureInside(targetDir, path.join(targetDir, `${newSessionId}.jsonl`), "Claude target path");
  const targetSidecarDir = ensureInside(targetDir, path.join(targetDir, newSessionId), "Claude target sidecar path");
  await fs.promises.mkdir(targetDir, { recursive: true });
  await fs.promises.writeFile(
    targetPath,
    rewriteClaudeJsonlContent(args.mainContent, newSessionId, targetCwd),
    { flag: "wx" },
  );
  try {
    await writeClaudeTransportSideFiles({
      targetDir: targetSidecarDir,
      sideFiles: args.sideFiles,
      newSessionId,
      targetCwd,
    });
  } catch (error) {
    await fs.promises.rm(targetSidecarDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.promises.unlink(targetPath).catch(() => undefined);
    throw error;
  }
  return { newSessionId, targetPath };
}
