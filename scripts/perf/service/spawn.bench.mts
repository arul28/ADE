// cd apps/ade-cli && npx tsx ../../scripts/perf/service/spawn.bench.mts [repoDir | --project <copy root>] [--runs 5]
// What a process spawn costs on this machine (Windows is where it hurts):
//   resolve  the brain's CLI lookup (resolveExecutableFromKnownLocations) for the
//            CLIs ADE looks for, cold (listing cache dropped) and warm
//   spawn    `git --version` (bare process start), `git status --porcelain` in
//            <repoDir> (default: the current repository), `node -e 0`, and a `.cmd`
//            shim (`npx --version`) launched the way the brain launches one
//            (resolveCliSpawnInvocation, so cmd.exe on Windows)
//   runGit   200 `git rev-parse HEAD` through ADE's own runGit and the git it
//            resolves (on macOS, Apple's git behind the /usr/bin/git shim;
//            ADE_GIT_EXECUTABLE=/usr/bin/git forces the shim for comparison), F3 against
//            T3: <runs> runs of 200, each run's median, the median of those and the
//            slowest run
// Prints median and max per row. Read-only.
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  invalidateExecutableLookupCache,
  resolveExecutableFromKnownLocations,
} from "../../../apps/desktop/src/main/services/ai/cliExecutableResolver";
import { resolveCliSpawnInvocation } from "../../../apps/desktop/src/main/services/shared/processExecution";
import { resolveGitExecutable, runGit } from "../../../apps/desktop/src/main/services/git/git";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
const repo = path.resolve(flag("--project") ?? positional ?? path.join(import.meta.dirname, "../../.."));
const runs = Number(flag("--runs") ?? 5);
const clis = ["claude", "codex", "copilot", "agent", "cursor-agent", "gemini", "opencode", "droid", "npx", "npm", "node", "git", "gh", "bun"];
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const r1 = (x: number) => Math.round(x * 10) / 10;
const time = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t; };

const resolved: Record<string, string | null> = {};
const cold: number[] = []; const warm: number[] = [];
for (let i = 0; i < 5; i++) {
  invalidateExecutableLookupCache();
  cold.push(time(() => { for (const c of clis) resolved[c] = resolveExecutableFromKnownLocations(c)?.path ?? null; }));
  warm.push(time(() => { for (const c of clis) resolveExecutableFromKnownLocations(c); }));
}
console.log(JSON.stringify({ row: "resolve all CLIs", clis: clis.length, coldMs: r1(med(cold)), coldMaxMs: r1(Math.max(...cold)), warmMs: r1(med(warm)), pathEntries: (process.env.PATH ?? "").split(path.delimiter).length, found: Object.fromEntries(Object.entries(resolved).filter(([, v]) => v)) }));

function bench(row: string, n: number, command: string, args: string[], opts: { cwd?: string; verbatim?: boolean } = {}) {
  const ms: number[] = []; let status: number | null = null;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const r = spawnSync(command, args, { cwd: opts.cwd, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: opts.verbatim, maxBuffer: 64 * 1024 * 1024 });
    ms.push(performance.now() - t); status = r.status;
    if (r.error) { console.log(JSON.stringify({ row, error: r.error.message })); return; }
  }
  console.log(JSON.stringify({ row, n, medianMs: r1(med(ms)), maxMs: r1(Math.max(...ms)), firstMs: r1(ms[0]!), exit: status }));
}

const git = resolved.git ?? "git";
bench("git --version", 10, git, ["--version"]);
bench("git status --porcelain", 10, git, ["status", "--porcelain"], { cwd: repo });
bench("node -e 0", 5, process.execPath, ["-e", "0"]);
if (resolved.npx) {
  const inv = resolveCliSpawnInvocation(resolved.npx, ["--version"]);
  bench(`.cmd shim: npx --version (${path.basename(inv.command)})`, 5, inv.command, inv.args, { verbatim: inv.windowsVerbatimArguments });
}
{
  const executable = await resolveGitExecutable();
  const runMedians: number[] = [];
  let maxMs = 0;
  for (let run = 0; run < runs; run++) {
    const ms: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      await runGit(["rev-parse", "HEAD"], { cwd: repo });
      ms.push(performance.now() - t);
    }
    runMedians.push(med(ms));
    maxMs = Math.max(maxMs, ...ms);
  }
  console.log(JSON.stringify({ row: "runGit rev-parse HEAD", executable, n: 200, runs, runMediansMs: runMedians.map(r1), medianMs: r1(med(runMedians)), worstRunMs: r1(Math.max(...runMedians)), maxMs: r1(maxMs) }));
}
console.log(JSON.stringify({ repo }));
