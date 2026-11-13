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
 * never rewritten.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AdeExpectedError } from "../../../shared/expectedError";
import { resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";

const XCODEGEN_SPEC = "project.yml";
const XCODEGEN_TIMEOUT_MS = 5 * 60_000;

export type XcodeGenRun = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

async function listDir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const execFileAsync = promisify(execFile);

/** Whether git tracks anything under `target` (false outside a repo or without git). */
async function gitTracks(dir: string, target: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--", target], { cwd: dir, windowsHide: true, timeout: 10_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Folders under `projectRoot` whose `project.yml` needs XcodeGen before a build. */
export async function xcodeGenFoldersToGenerate(projectRoot: string): Promise<string[]> {
  const appsRoot = path.join(projectRoot, "apps");
  const childFolders = async (dir: string): Promise<string[]> => (await listDir(dir))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => path.join(dir, entry.name));
  // The root, each folder in it (`ios/`, `MyApp/`) and each app under `apps/`:
  // where a person puts a small app's spec.
  const candidates = [...new Set([projectRoot, ...await childFolders(projectRoot), ...await childFolders(appsRoot)])];
  const folders: string[] = [];
  for (const dir of candidates) {
    const entries = await listDir(dir);
    if (!entries.some((entry) => entry.isFile() && entry.name === XCODEGEN_SPEC)) continue;
    const projects = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"));
    if (projects.length === 0) {
      folders.push(dir);
      continue;
    }
    const tracked = await Promise.all(projects.map((entry) => gitTracks(dir, entry.name)));
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
export async function generateXcodeGenProjects(projectRoot: string, run: XcodeGenRun): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const folders = await xcodeGenFoldersToGenerate(projectRoot);
  if (!folders.length) return [];
  const xcodegen = resolveExecutableFromKnownLocations("xcodegen")?.path ?? null;
  const relative = (dir: string): string => path.relative(projectRoot, dir) || ".";
  if (!xcodegen) {
    const missing = [];
    for (const dir of folders) {
      if (!(await listDir(dir)).some((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"))) missing.push(relative(dir));
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
      output = await run(xcodegen, ["generate", "--spec", XCODEGEN_SPEC, "--use-cache"], { cwd: dir, timeoutMs: XCODEGEN_TIMEOUT_MS });
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
