// cd apps/ade-cli && npx tsx ../../scripts/perf/service/tree-watcher.bench.mts <directory>
// For a watcher over <directory>: time until ready, time to close, the longest event-loop
// block, and CPU at idle, for the native tree watcher and for chokidar in polling mode.
// WITH_NATIVE_CHOKIDAR=1 adds chokidar's own native mode, which shows the close stall
// that polling was chosen to avoid. Read-only. macOS only.
import chokidar from "../../../apps/desktop/node_modules/chokidar/index.js";
import { watchTree } from "../../../apps/desktop/src/main/services/shared/treeWatcher";
const root = process.argv[2]!; const ignored = [/(^|[/\\])\.git($|[/\\])/, /(^|[/\\])node_modules($|[/\\])/, /(^|[/\\])\.ade($|[/\\])/];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function run(label: string, make: () => any, closeEarly: boolean) {
  let worst = 0; let last = performance.now(); const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 5); last = now; }, 5);
  const cpu0 = process.cpuUsage(); const t0 = performance.now();
  const w = make(); let readyMs: number | null = null;
  const ready = new Promise<void>((r) => w.once("ready", () => { readyMs = performance.now() - t0; r(); }));
  if (closeEarly) await sleep(40); else await ready;
  const c0 = performance.now(); await w.close(); const closeMs = performance.now() - c0;
  await sleep(1500); clearInterval(tick);
  const cpu = process.cpuUsage(cpu0);
  console.log(label.padEnd(44), JSON.stringify({ readyMs: readyMs && Math.round(readyMs), closeMs: Math.round(closeMs), worstLoopBlockMs: Math.round(worst), cpuMs: Math.round((cpu.user + cpu.system) / 1000) }));
}
const opts = { ignoreInitial: true, ignored };
for (const early of [false, true]) {
  const tag = early ? "closed 40 ms after open" : "closed after ready";
  await run(`new native watcher, ${tag}`, () => watchTree(root, opts), early);
  await run(`chokidar polling, ${tag}`, () => chokidar.watch(root, { ...opts, usePolling: true, interval: 1000, binaryInterval: 2000 }), early);
  if (process.env.WITH_NATIVE_CHOKIDAR) await run(`chokidar native (before 5a0fc6158), ${tag}`, () => chokidar.watch(root, opts), early);
}
// idle cost of the new watcher: 5 s with the watcher open and nothing changing
const w = watchTree(root, opts); await new Promise<void>((r) => w.once("ready", () => r()));
const c0 = process.cpuUsage(); await sleep(5000); const c = process.cpuUsage(c0);
console.log("new native watcher idle, 5 s".padEnd(44), JSON.stringify({ cpuMs: Math.round((c.user + c.system) / 1000) }));
await w.close();
const p = chokidar.watch(root, { ...opts, usePolling: true, interval: 1000, binaryInterval: 2000 }); await new Promise<void>((r) => p.once("ready", () => r()));
const d0 = process.cpuUsage(); await sleep(5000); const d = process.cpuUsage(d0);
console.log("chokidar polling idle, 5 s".padEnd(44), JSON.stringify({ cpuMs: Math.round((d.user + d.system) / 1000) }));
await p.close(); process.exit(0);
