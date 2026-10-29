// Counts the git processes a bench's own process starts, for benches that run ADE's git code in-process.
//   macOS / Linux: an ADE_GIT_EXECUTABLE wrapper script that logs its arguments, then runs git.
//   Windows: a wrapper cannot work there (no shebang scripts, and a .cmd cannot be spawned without a
//   shell), so the bench runs itself again with scripts/perf/ui/spawn-trace.cjs preloaded, which records
//   every process start, including those on ADE's off-thread spawn worker.
// Call `gitCounter()` before importing ADE's git code; on Windows the first call does not return in the
// parent process (it exits with the traced child's exit code).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type GitCounter = {
  /** The git the bench itself should run (setup commands, not counted). */
  realGit: string;
  /** Forget everything counted so far. */
  reset(): void;
  /** Each git run since the last reset, as its arguments joined by spaces. */
  runs(): string[];
};

const spawnTrace = path.resolve(import.meta.dirname, "../ui/spawn-trace.cjs");

export function gitCounter(dir: string): GitCounter {
  if (process.platform === "win32") {
    const traceDir = process.env.ADE_BENCH_GIT_TRACE_DIR;
    if (!traceDir) {
      const childTrace = path.join(dir, "git-trace");
      fs.mkdirSync(childTrace, { recursive: true });
      const child = spawnSync(process.execPath, ["--require", spawnTrace, ...process.execArgv, process.argv[1]!, ...process.argv.slice(2)], {
        stdio: "inherit",
        env: { ...process.env, ADE_BENCH_GIT_TRACE_DIR: childTrace, ADE_SPAWN_TRACE_DIR: childTrace },
      });
      fs.rmSync(dir, { recursive: true, force: true });
      process.exit(child.status ?? 1);
    }
    const realGit = execFileSync("where.exe", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0]!.trim();
    let since = 0;
    const isGit = (cmd: string) => /^git(\.exe)?$/i.test(path.basename(cmd));
    return {
      realGit,
      reset: () => { since = Date.now(); },
      runs: () => fs.readdirSync(traceDir).flatMap((file) =>
        fs.readFileSync(path.join(traceDir, file), "utf8").split("\n").filter(Boolean)
          .map((line) => JSON.parse(line) as { at: number; cmd: string; args: string[] })
          .filter((row) => row.at >= since && isGit(row.cmd))
          .map((row) => row.args.join(" "))),
    };
  }
  const counter = path.join(dir, "git-count.log");
  const wrapper = path.join(dir, "git-wrapper.sh");
  const pathGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  // macOS: Apple's git directly, not the /usr/bin/git xcrun shim (as ADE's own resolution does).
  const realGit = process.platform === "darwin"
    ? spawnSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8" }).stdout.trim() || pathGit
    : pathGit;
  fs.writeFileSync(wrapper, `#!/bin/sh\necho "$*" >> ${JSON.stringify(counter)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(counter, "");
  process.env.ADE_GIT_EXECUTABLE = wrapper;
  return {
    realGit,
    reset: () => fs.writeFileSync(counter, ""),
    runs: () => fs.readFileSync(counter, "utf8").split("\n").filter(Boolean),
  };
}

export const benchTempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
