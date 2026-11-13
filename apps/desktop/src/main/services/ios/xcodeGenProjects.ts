/**
 * XcodeGen projects: a `project.yml` with no `.xcodeproj` beside it (what a
 * person on Windows or Linux can write for an iOS app) is turned into one
 * before ADE builds, so `ade apple launch|install|test` work on it like on any
 * Xcode project.
 *
 * Looked for in the build root, each folder in it, and each folder under
 * `apps/`. A folder is generated when it has a `project.yml` and
 * either no `.xcodeproj`, or only ones git does not track (an earlier
 * generation, which a changed spec has to refresh; `--use-cache` makes an
 * unchanged spec a no-op). A tracked `.xcodeproj` is the project's own and is
 * never rewritten. When the caller names a project, only its folder is looked
 * at, so an unrelated spec elsewhere cannot hold up its build.
 */
import fs from "node:fs";
import path from "node:path";
import { AdeExpectedError } from "../../../shared/expectedError";
import { resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";
import type { Logger } from "../logging/logger";

const XCODEGEN_SPEC = "project.yml";
const XCODEGEN_TIMEOUT_MS = 5 * 60_000;

export type XcodeGenRun = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

export type XcodeGenOptions = {
  run: XcodeGenRun;
  logger?: Pick<Logger, "warn"> | null;
  /**
   * The project the caller named (a `.xcodeproj` or `.xcworkspace`, its
   * folder, or its `project.yml`; relative to the root or absolute). Only that
   * folder is generated. Null: every folder that needs it.
   */
  projectPath?: string | null;
};

/** How long the `git ls-files` that tells a project's own `.xcodeproj` from a generated one may take. */
const GIT_TRACKS_TIMEOUT_MS = 10_000;

async function listDir(dir: string, logger: XcodeGenOptions["logger"]): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A folder that is not there (no `apps/`) is expected.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      logger?.warn("apple.xcodegen_list_dir_failed", { dir, error: error instanceof Error ? error.message : String(error) });
    }
    return [];
  }
}

/**
 * Whether git tracks anything under `target`. When git cannot say (an error,
 * a timeout, no repo) it counts as tracked: a project that might be the
 * person's own is never overwritten.
 */
async function gitTracks(dir: string, target: string, options: XcodeGenOptions): Promise<boolean> {
  try {
    const { stdout } = await options.run("git", ["ls-files", "--", target], { cwd: dir, timeoutMs: GIT_TRACKS_TIMEOUT_MS });
    return stdout.trim().length > 0;
  } catch (error) {
    options.logger?.warn("apple.xcodegen_git_tracks_failed", { dir, target, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

/** The folder a named project lives in: a `.xcodeproj`, `.xcworkspace` or spec's parent, else the folder itself. */
function namedProjectFolder(projectRoot: string, projectPath: string): string {
  const resolved = path.resolve(projectRoot, projectPath);
  return /\.(xcodeproj|xcworkspace|ya?ml)$/iu.test(resolved) ? path.dirname(resolved) : resolved;
}

/** Folders under `projectRoot` whose `project.yml` needs XcodeGen before a build. */
export async function xcodeGenFoldersToGenerate(projectRoot: string, options: XcodeGenOptions): Promise<string[]> {
  const childFolders = async (dir: string): Promise<string[]> => (await listDir(dir, options.logger))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => path.join(dir, entry.name));
  // The root, each folder in it (`ios/`, `MyApp/`) and each app under `apps/`:
  // where a person puts a small app's spec.
  const named = options.projectPath?.trim();
  const candidates = named
    ? [namedProjectFolder(projectRoot, named)]
    : [...new Set([projectRoot, ...await childFolders(projectRoot), ...await childFolders(path.join(projectRoot, "apps"))])];
  const folders: string[] = [];
  for (const dir of candidates) {
    const entries = await listDir(dir, options.logger);
    if (!entries.some((entry) => entry.isFile() && entry.name === XCODEGEN_SPEC)) continue;
    const projects = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"));
    if (projects.length === 0) {
      folders.push(dir);
      continue;
    }
    const tracked = await Promise.all(projects.map((entry) => gitTracks(dir, entry.name, options)));
    if (!tracked.some(Boolean)) folders.push(dir);
  }
  return folders;
}

/**
 * Run XcodeGen in each folder that needs it. Answers the folders whose
 * project it created or changed (relative to `projectRoot`), for the result
 * to say so. Without XcodeGen, a folder with no project at all is an error
 * that says how to install it; one with an earlier generation builds as it is.
 */
export async function generateXcodeGenProjects(projectRoot: string, options: XcodeGenOptions): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const folders = await xcodeGenFoldersToGenerate(projectRoot, options);
  if (!folders.length) return [];
  const xcodegen = resolveExecutableFromKnownLocations("xcodegen")?.path ?? null;
  const relative = (dir: string): string => path.relative(projectRoot, dir) || ".";
  if (!xcodegen) {
    const missing = [];
    for (const dir of folders) {
      if (!(await listDir(dir, options.logger)).some((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"))) missing.push(relative(dir));
    }
    if (!missing.length) return [];
    throw new AdeExpectedError(
      `${missing.map((dir) => path.join(dir, XCODEGEN_SPEC)).join(", ")} has no Xcode project, and XcodeGen is not installed on this Mac to make one. `
      + "Install it (`brew install xcodegen`), or run `xcodegen generate` there, then run the command again.",
      "environment",
    );
  }
  const generated: string[] = [];
  for (const dir of folders) {
    let output: { stdout: string; stderr: string };
    try {
      output = await options.run(xcodegen, ["generate", "--spec", XCODEGEN_SPEC, "--use-cache"], { cwd: dir, timeoutMs: XCODEGEN_TIMEOUT_MS });
    } catch (error) {
      const detail = error && typeof error === "object"
        ? String((error as { stderr?: unknown }).stderr || (error as { stdout?: unknown }).stdout || (error as Error).message || "")
        : String(error);
      throw new AdeExpectedError(
        `XcodeGen could not make the Xcode project from ${path.join(relative(dir), XCODEGEN_SPEC)}: ${detail.trim().split("\n").slice(-4).join(" ")}`,
        "user",
      );
    }
    // An unchanged spec says "has not changed since cache was written".
    if (!/has not changed/i.test(`${output.stdout}\n${output.stderr}`)) generated.push(relative(dir));
  }
  return generated;
}
