// cd apps/ade-cli && npx tsx ../../scripts/perf/net/make-real-load-copy.mts --source <project root> --out <empty dir> [--no-worktrees]
//
// A runnable copy of one real ADE project, for measuring under real load (a heavy user's
// database) without touching the original. Read-only on the source:
//   - the project database through SQLite's backup API (`sqlite3 ... .backup`, safe while a brain
//     writes it);
//   - chat transcripts, chat-session records and project icons as APFS clones (`cp -c`);
//   - the git repository through `git clone --local`, then the clone's origin is pointed at a path
//     that does not exist, so nothing in the copy can fetch from or push to the original;
//   - one worktree per active lane, checked out from the lane's branch in the clone.
// Every path in the copied database and chat-session records that names the source root is rewritten
// to the copy (through ADE's own kvDb, so cr-sqlite's triggers run), so a measurement brain that
// opens the copy runs git and shells only inside it. Not copied: secrets, ade.yaml / local.yaml
// (automations and processes), caches other than chat sessions.
//
// Prints the copy's scale as JSON. Never commit, upload or show a copy: numbers only, delete when done.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { openKvDb } from "../../../apps/desktop/src/main/services/state/kvDb";

const argv = process.argv.slice(2);
const read = (name: string): string | null => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
};
const source = read("--source");
const out = read("--out");
if (!source || !out) throw new Error("--source <project root> and --out <empty dir> are required");
const sourceRoot = fs.realpathSync(source);
const copyRoot = path.resolve(out);
if (copyRoot.startsWith(`${sourceRoot}${path.sep}`) || copyRoot === sourceRoot) throw new Error("--out must be outside the source project");
if (fs.existsSync(copyRoot) && fs.readdirSync(copyRoot).length > 0) throw new Error(`${copyRoot} is not empty`);
const withWorktrees = !argv.includes("--no-worktrees");
// --clone: the source is a copy this script made (a "golden" copy no brain opens). The whole tree is
// cloned with APFS clonefile (instant, no load on the source's disk), then paths and git worktree links
// are rewritten. Copying a live database again is what this mode avoids.
const cloneMode = argv.includes("--clone");
const markerName = "real-load-copy.json";
if (cloneMode && !fs.existsSync(path.join(sourceRoot, ".ade", markerName))) throw new Error("--clone needs a source made by make-real-load-copy (no .ade/real-load-copy.json)");

const isWindows = process.platform === "win32";
// A clone of a tree: APFS clonefile on macOS, a plain copy on Windows (NTFS has no clones).
const cloneTree = (from: string, to: string) => {
  if (isWindows) fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
  else execFileSync("cp", ["-cR", from, to], { stdio: "inherit" });
};
// Windows stores a path as C:\x, C:/x and, inside JSON text, C:\\x. Each form of the source root is
// rewritten to the same form of the copy root.
// The copy root itself, or a path under it (not a sibling folder that only shares the prefix).
const insideCopy = (candidate: string) => {
  const resolved = path.resolve(candidate);
  return resolved === copyRoot || resolved.startsWith(`${copyRoot}${path.sep}`);
};
const rootForms = (root: string): string[] =>
  isWindows ? [root, root.replaceAll("\\", "/"), JSON.stringify(root).slice(1, -1)] : [root];

// Git for Windows cannot open os.devNull (\\.\nul) as a config file; an empty file reads the same.
const noGitConfig = isWindows ? path.join(os.tmpdir(), "ade-real-load-copy-empty.gitconfig") : os.devNull;
if (isWindows) fs.writeFileSync(noGitConfig, "");
const quietGit = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: noGitConfig, GIT_CONFIG_SYSTEM: noGitConfig, GIT_TERMINAL_PROMPT: "0" } });

const sourceAde = path.join(sourceRoot, ".ade");
const copyAde = path.join(copyRoot, ".ade");
fs.mkdirSync(path.dirname(copyRoot), { recursive: true });
if (cloneMode) {
  fs.rmSync(copyRoot, { recursive: true, force: true });
  if (isWindows) {
    // No clonefile or file flags on NTFS. A golden copy made read-only with `attrib +R` passes the
    // attribute on, so clear it.
    fs.cpSync(sourceRoot, copyRoot, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    execFileSync("attrib", ["-R", path.join(copyRoot, "*"), "/S", "/D"], { stdio: "ignore" });
  } else {
    execFileSync("cp", ["-cRp", sourceRoot, copyRoot], { stdio: "inherit" });
    // The golden copy is read-only on disk (chmod -R a-w); clonefile keeps that mode, so open it up.
    // `cp -p` also copies file flags, so the golden copy's `uchg` must come off before the mode can.
    execFileSync("chflags", ["-R", "nouchg", copyRoot], { stdio: "inherit" });
    execFileSync("chmod", ["-R", "u+w", copyRoot], { stdio: "inherit" });
  }
} else {
// 1. Repository: a local clone (hard links on one volume, the source is only read).
// Hard links only work on one volume (e.g. a project on the system disk, copies on another volume).
const sameVolume = fs.statSync(sourceRoot).dev === fs.statSync(path.dirname(copyRoot)).dev;
quietGit(["clone", "--quiet", "--local", ...(sameVolume ? [] : ["--no-hardlinks"]), sourceRoot, copyRoot], path.dirname(copyRoot));
quietGit(["remote", "set-url", "origin", path.join(os.tmpdir(), "ade-real-load-copy-no-origin")], copyRoot);

// 2. Project state: database by backup API, transcripts and chat records as clones.
fs.mkdirSync(copyAde, { recursive: true });
// A live database (a brain may be writing it) is read with mode=ro through its -shm. A frozen, read-only
// copy cannot get a -shm, and mode=ro then spins on SQLITE_BUSY forever; immutable=1 reads it directly
// (safe only because nothing can write a file without write permission).
let sourceWritable = true;
try { fs.accessSync(path.join(sourceAde, "ade.db"), fs.constants.W_OK); } catch { sourceWritable = false; }
// SQLite URIs take forward slashes, with a slash before a drive letter (file:/C:/...).
const sourceDbUri = isWindows ? `/${path.join(sourceAde, "ade.db").replaceAll("\\", "/")}` : path.join(sourceAde, "ade.db");
execFileSync("sqlite3", [`file:${sourceDbUri}?${sourceWritable ? "mode=ro" : "immutable=1"}`, `.backup '${path.join(copyAde, "ade.db").replaceAll("'", "''")}'`], { stdio: "inherit" });
for (const relative of ["transcripts/chat", "cache/chat-sessions", "project-icons"]) {
  const from = path.join(sourceAde, relative);
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(path.dirname(path.join(copyAde, relative)), { recursive: true });
  cloneTree(from, path.join(copyAde, relative));
}
}

// 3. Paths: every text value naming the source root now names the copy.
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const db = await openKvDb(path.join(copyAde, "ade.db"), silentLogger as never);
let rewrittenCells = 0;
const copyForms = rootForms(copyRoot);
const rootPairs = rootForms(sourceRoot).map((form, index) => [form, copyForms[index]] as const);
const namesSource = (body: string) => rootPairs.some(([from]) => body.includes(from));
const rewriteText = (body: string) => rootPairs.reduce((text, [from, to]) => text.split(from).join(to), body);
const tables = db.all<{ name: string }>(
  "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' and name not like 'crsql_%' and name not like '%__crsql_%' and sql not like '%VIRTUAL TABLE%'",
);
for (const { name } of tables) {
  if (db.get("select 1 from sqlite_schema where type = 'table' and name like ? || '_%' and sql like '%VIRTUAL%'", [name])) continue;
  for (const column of db.all<{ name: string; type: string }>(`pragma table_info("${name.replaceAll('"', '""')}")`)) {
    if (column.type && !/text|char|clob|json/i.test(column.type)) continue;
    const quoted = `"${column.name.replaceAll('"', '""')}"`;
    const table = `"${name.replaceAll('"', '""')}"`;
    for (const [from, to] of rootPairs) {
      try {
        rewrittenCells += db.runChanged(`update ${table} set ${quoted} = replace(${quoted}, ?, ?) where typeof(${quoted}) = 'text' and instr(${quoted}, ?) > 0`, [from, to, from]);
      } catch {
        // Shadow tables of full-text indexes and similar refuse writes; they hold no live paths.
      }
    }
  }
}
// The copied cluster record names the source machine's brain, so a measurement brain would treat the copy as
// following that machine (and refuse to host it). Without a record, the brain that opens the copy
// becomes its host; it never dials the source machine.
db.run("delete from sync_cluster_state");
const sessionsDir = path.join(copyAde, "cache", "chat-sessions");
let rewrittenRecords = 0;
if (fs.existsSync(sessionsDir)) {
  for (const file of fs.readdirSync(sessionsDir)) {
    const full = path.join(sessionsDir, file);
    if (!fs.statSync(full).isFile()) continue;
    const body = fs.readFileSync(full, "utf8");
    if (!namesSource(body)) continue;
    fs.rmSync(full); // the clone shares blocks with the original until written; write a new file
    fs.writeFileSync(full, rewriteText(body));
    rewrittenRecords += 1;
  }
}

// 4. Lanes: one worktree per active lane, on its branch when the clone has it.
// A lane can live outside the project (another tool's worktree folder). Point it into the copy, so a
// measurement brain never runs git in the original's files.
if (!cloneMode) {
  for (const lane of db.all<{ id: string; worktree_path: string | null }>("select id, worktree_path from lanes where archived_at is null and worktree_path is not null")) {
    if (insideCopy(lane.worktree_path!)) continue;
    db.run("update lanes set worktree_path = ? where id = ?", [path.join(copyRoot, ".ade", "external-worktrees", lane.id), lane.id]);
    rewrittenCells += 1;
  }
}
const lanes = db.all<{ id: string; branch_ref: string | null; worktree_path: string | null; archived_at: string | null; lane_type: string | null }>(
  "select id, branch_ref, worktree_path, archived_at, lane_type from lanes",
);
let worktrees = 0;
let worktreesFromHead = 0;
if (cloneMode) {
  // The cloned worktree links still name the source on both sides: <copy>/.git/worktrees/*/gitdir and each
  // worktree's .git file. Rewrite them as text inside the copy. (`git worktree repair` follows the old
  // links and writes into the SOURCE's worktrees, so it must never run here.)
  const adminDir = path.join(copyRoot, ".git", "worktrees");
  const relink = (file: string) => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const body = fs.readFileSync(file, "utf8");
    if (!namesSource(body)) return false;
    if (!path.resolve(file).startsWith(`${copyRoot}${path.sep}`)) throw new Error(`refusing to write outside the copy: ${file}`);
    // Git for Windows marks a worktree's .git file hidden, and Windows refuses to replace a hidden
    // file (EPERM); rewrite it in place.
    const fd = fs.openSync(file, "r+");
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, rewriteText(body), 0);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  };
  for (const name of fs.existsSync(adminDir) ? fs.readdirSync(adminDir) : []) {
    const gitdirFile = path.join(adminDir, name, "gitdir");
    relink(gitdirFile);
    if (!fs.existsSync(gitdirFile)) continue;
    const worktreeDotGit = fs.readFileSync(gitdirFile, "utf8").trim();
    if (relink(worktreeDotGit) || fs.existsSync(worktreeDotGit)) worktrees += 1;
  }
} else if (withWorktrees) {
  const remoteBranches = new Set(quietGit(["for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin"], copyRoot).split("\n").filter(Boolean));
  for (const lane of lanes) {
    if (lane.archived_at || !lane.worktree_path || path.resolve(lane.worktree_path) === copyRoot) continue;
    if (!insideCopy(lane.worktree_path) || fs.existsSync(lane.worktree_path)) continue;
    const branch = lane.branch_ref?.replace(/^refs\/heads\//, "") || `perf-copy/${lane.id}`;
    const start = remoteBranches.has(branch) ? `origin/${branch}` : "HEAD";
    if (start === "HEAD") worktreesFromHead += 1;
    quietGit(["worktree", "add", "--quiet", "-B", branch, lane.worktree_path, start], copyRoot);
    worktrees += 1;
  }
}
// A fresh checkout writes files in the same second as its index, so git treats every entry as
// "racily clean" and re-reads all of them on each status until the index is rewritten, and the brain
// runs git without optional locks, so it never rewrites it (5-8 s per status instead of ~0.15 s).
// A real worktree's index settled long ago: wait past that second and refresh each index once.
await new Promise((resolve) => setTimeout(resolve, 1_100));
for (const line of quietGit(["worktree", "list", "--porcelain"], copyRoot).split("\n")) {
  if (!line.startsWith("worktree ")) continue;
  try { quietGit(["update-index", "-q", "--refresh"], line.slice("worktree ".length)); } catch { /* exit 1 lists changed files */ }
}

fs.writeFileSync(path.join(copyAde, markerName), JSON.stringify({ madeBy: "make-real-load-copy", from: sourceRoot, at: new Date().toISOString() }));

// 5. Scale.
const clockTables = db.all<{ name: string }>("select name from sqlite_schema where type = 'table' and name like '%__crsql_clock'");
let maxDbVersion = 0;
let clockRows = 0;
for (const { name } of clockTables) {
  const row = db.get<{ v: number | null; c: number }>(`select max(db_version) as v, count(*) as c from "${name}"`);
  maxDbVersion = Math.max(maxDbVersion, Number(row?.v ?? 0));
  clockRows += Number(row?.c ?? 0);
}
const sessions = db.get<{ total: number; chats: number; running: number }>(
  "select count(*) as total, sum(tool_type like '%chat%') as chats, sum(status = 'running') as running from terminal_sessions",
);
const project = db.get<{ id: string }>("select id from projects limit 1");
db.flushNow();
db.close();

const transcriptsDir = path.join(copyAde, "transcripts", "chat");
const transcripts = fs.existsSync(transcriptsDir) ? fs.readdirSync(transcriptsDir) : [];
let biggest = { file: "", bytes: 0 };
let transcriptBytes = 0;
for (const file of transcripts) {
  const full = path.join(transcriptsDir, file);
  const onDisk = fs.statSync(full).size;
  transcriptBytes += onDisk;
  // Decompressed size decides what a chat open reads; only the larger files can be the biggest.
  if (onDisk < biggest.bytes / 20) continue;
  const bytes = file.endsWith(".gz") ? zlib.gunzipSync(fs.readFileSync(full)).length : onDisk;
  if (bytes > biggest.bytes) biggest = { file, bytes };
}
console.log(JSON.stringify({
  copyRoot,
  projectId: project?.id ?? null,
  dbMB: +(fs.statSync(path.join(copyAde, "ade.db")).size / 1e6).toFixed(1),
  maxDbVersion,
  crrRows: clockRows,
  terminalSessions: sessions,
  chatSessionRecords: fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).length : 0,
  transcripts: transcripts.length,
  transcriptMBOnDisk: +(transcriptBytes / 1e6).toFixed(1),
  biggestChat: { sessionId: biggest.file.replace(/\.jsonl(\.gz)?$/, ""), decompressedMB: +(biggest.bytes / 1e6).toFixed(1) },
  lanes: lanes.length,
  activeLanes: lanes.filter((lane) => !lane.archived_at).length,
  worktrees,
  worktreesFromHead,
  rewrittenCells,
  rewrittenRecords,
}));
process.exit(0);
