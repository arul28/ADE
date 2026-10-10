// cd apps/ade-cli && npx tsx ../../scripts/perf/service/tree-watcher-parity.mts
// Runs the native tree watcher (macOS) and chokidar in polling mode side by side on a temp
// tree, performs file operations one at a time (STEPS, SEED, ONLY=<op>), and compares the
// events each reports. Exit 1 on a difference. One difference is known and intended: a file
// replaced by a directory of the same name, which the poller reports as one wrong `change`.
// That operation (`fileToDir`) runs only with FILE_TO_DIR=1. macOS only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chokidar from "../../../apps/desktop/node_modules/chokidar/index.js";
import { watchTree } from "../../../apps/desktop/src/main/services/shared/treeWatcher";
const STEPS = Number(process.env.STEPS ?? 60);
let seed = Number(process.env.SEED ?? 7);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-watchdiff-")));
const root = path.join(base, "root");
const outside = path.join(base, "outside");
fs.mkdirSync(root);
fs.mkdirSync(outside);
const w = (p: string, c = "x\n") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
for (let d = 0; d < 12; d++)
  for (let f = 0; f < 10; f++)
    w(path.join(root, `d${d}`, d % 3 === 0 ? `sub${f % 3}` : "", `f${f}.txt`));
w(path.join(root, "node_modules", "pkg", "index.js"));
w(path.join(root, ".git", "HEAD"));
fs.symlinkSync(path.join(root, "d1"), path.join(root, "link-in"));
w(path.join(outside, "ext", "e0.txt"));
fs.symlinkSync(path.join(outside, "ext"), path.join(root, "link-out"));
const options = { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 50 }, ignored: [/(^|[/\\])\.git($|[/\\])/, /(^|[/\\])node_modules($|[/\\])/] };
const log = { a: new Set<string>(), b: new Set<string>() };
const kinds = ["add", "change", "unlink", "addDir", "unlinkDir"] as const;
const a = chokidar.watch(root, { ...options, usePolling: true, interval: 1000, binaryInterval: 2000 });
const b = watchTree(root, options);
for (const k of kinds) {
  a.on(k, (p: string) => log.a.add(`${k} ${path.relative(root, p)}`));
  (b as any).on(k, (p: string) => log.b.add(`${k} ${path.relative(root, p)}`));
}
await Promise.all([new Promise<void>((r) => a.once("ready", () => r())), new Promise<void>((r) => b.once("ready", () => r()))]);
await sleep(1500);
const files = () => { const out: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  if (e.name === ".git" || e.name === "node_modules" || e.isSymbolicLink())
    continue;
  const p = path.join(d, e.name);
  if (e.isDirectory())
    walk(p);
  else
    out.push(p);
} }; walk(root); return out; };
const dirs = () => { const out: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  if (e.name === ".git" || e.name === "node_modules" || e.isSymbolicLink() || !e.isDirectory())
    continue;
  const p = path.join(d, e.name);
  out.push(p);
  walk(p);
} }; walk(root); return out; };
let n = 0;
const ops: Record<string, () => void | Promise<void>> = {
  create: () => w(path.join(pick(dirs()), `new${n++}.txt`)),
  modify: () => fs.appendFileSync(pick(files()), `more ${n++}\n`),
  remove: () => fs.rmSync(pick(files())),
  mkdirEmpty: () => fs.mkdirSync(path.join(pick(dirs()), `empty${n++}`)),
  mkdirWithFiles: () => { const d = path.join(pick(dirs()), `tree${n++}`); w(path.join(d, "a.txt")); w(path.join(d, "deep", "b.txt")); },
  rmTree: () => { const ds = dirs().filter((d) => path.relative(root, d).includes(path.sep) || /tree|empty|moved/.test(d)); if (ds.length)
    fs.rmSync(pick(ds), { recursive: true }); },
  renameFile: () => { const f = pick(files()); fs.renameSync(f, path.join(path.dirname(f), `ren${n++}.txt`)); },
  renameDir: () => { const ds = dirs().filter((d) => !d.endsWith("d1")); const d = pick(ds); fs.renameSync(d, path.join(path.dirname(d), `rd${n++}`)); },
  moveIn: () => { const src = path.join(outside, `in${n}`); w(path.join(src, "x.txt")); w(path.join(src, "y", "z.txt")); fs.renameSync(src, path.join(root, `moved${n++}`)); },
  moveOut: () => { const ds = dirs().filter((d) => /moved|tree/.test(path.basename(d))); if (ds.length)
    fs.renameSync(pick(ds), path.join(outside, `out${n++}`)); },
  atomicSave: () => { const f = pick(files()); const tmp = `${f}.tmp${n++}`; fs.writeFileSync(tmp, `atomic ${n}\n`.repeat(3)); fs.renameSync(tmp, f); },
  touch: () => { const f = pick(files()); const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t); },
  ignored: () => w(path.join(root, "node_modules", "pkg", `i${n++}.js`)),
  slowWrite: async () => { const f = path.join(pick(dirs()), `slow${n++}.txt`); for (let i = 0; i < 4; i++) {
    fs.appendFileSync(f, "chunk\n");
    await sleep(60);
  } },
  fileToDir: () => { const f = pick(files()); fs.rmSync(f); w(path.join(f, "inner.txt")); },
  viaLinkIn: () => w(path.join(root, "link-in", `l${n++}.txt`)),
  viaLinkOut: () => w(path.join(outside, "ext", `o${n++}.txt`)),
  burst: () => { const d = pick(dirs()); for (let i = 0; i < 25; i++)
    w(path.join(d, `b${n}-${i}.txt`)); n++; },
};
const names = Object.keys(ops).filter((name) => name !== "fileToDir" || process.env.FILE_TO_DIR === "1");
let mismatches = 0;
const counts: Record<string, number> = {};
for (let step = 0; step < STEPS; step++) {
  const name = process.env.ONLY ?? names[step % names.length]!;
  log.a.clear();
  log.b.clear();
  try {
    await ops[name]!();
  }
  catch (e) {
    console.log("op failed", name, String(e).slice(0, 80));
  }
  await sleep(Number(process.env.WAIT ?? 2600));
  // A `change` right after the `add` of the same file is a matter of timing on both sides: the
  // file was written in pieces, and whether the last piece lands before or after the `add` is
  // reported depends on the poll phase (chokidar) or the write-finish wait (native).
  const redundantChange = (x: string, other: Set<string>, own: Set<string>) => x.startsWith("change ") && own.has(`add ${x.slice(7)}`) && other.has(`add ${x.slice(7)}`);
  const onlyA = [...log.a].filter((x) => !log.b.has(x) && !redundantChange(x, log.b, log.a)).sort();
  const onlyB = [...log.b].filter((x) => !log.a.has(x) && !redundantChange(x, log.a, log.b)).sort();
  counts[name] = (counts[name] ?? 0) + log.a.size;
  if (onlyA.length || onlyB.length) {
    mismatches++;
    console.log(`STEP ${step} ${name}: chokidar-only ${JSON.stringify(onlyA.slice(0, 6))} native-only ${JSON.stringify(onlyB.slice(0, 6))} (sizes ${log.a.size}/${log.b.size})`);
  }
}
console.log(JSON.stringify({ steps: STEPS, mismatches, eventsPerOp: counts }));
await a.close();
await b.close();
fs.rmSync(base, { recursive: true, force: true });
process.exit(mismatches ? 1 : 0);
