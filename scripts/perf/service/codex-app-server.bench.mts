/**
 * Codex chats: one app-server per chat vs one shared app-server.
 *
 *   npx tsx ../../scripts/perf/service/codex-app-server.bench.mts [N=5] [--turns]
 *
 * Starts N threads two ways — N `codex app-server` processes with one thread
 * each, and one process with N threads — and reports the process tree's
 * physical footprint and RSS (code-mode hosts included) and the time to a
 * ready thread. Each thread's shell sees its own `ADE_PROBE` value through
 * `shell_environment_policy.set`, the way ADE gives a thread its chat identity.
 *
 * Runs ADE's pinned Codex (newest under ~/.ade/tools, or CODEX_BIN) against a
 * temp CODEX_HOME; nothing in ~/.ade or ~/.codex is written. Without
 * `--turns` no model request is made. `--turns` copies ~/.codex/auth.json into
 * the temp home and runs one short turn per thread (`CODEX_BENCH_MODEL`,
 * default gpt-6-luna), which uses the account's quota and checks that every
 * thread's command printed its own `ADE_PROBE`. macOS only (`footprint`).
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const N = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 5);
const withTurns = args.includes("--turns");
const model = process.env.CODEX_BENCH_MODEL ?? "gpt-6-luna";

function pinnedCodex(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const root = path.join(os.homedir(), ".ade/tools/@openai");
  const platformDir = fs.readdirSync(root).find((name) => name.startsWith("codex-"));
  if (!platformDir) throw new Error(`No pinned Codex under ${root}; set CODEX_BIN.`);
  const versions = fs.readdirSync(path.join(root, platformDir)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const versionDir = path.join(root, platformDir, versions.at(-1)!);
  const found = execFileSync("find", [versionDir, "-type", "f", "-name", "codex", "-perm", "-u+x"]).toString().trim().split("\n")[0];
  if (!found) throw new Error(`No codex binary under ${versionDir}; set CODEX_BIN.`);
  return found;
}

type Client = {
  proc: ChildProcessWithoutNullStreams;
  request: (method: string, params?: unknown) => Promise<any>;
  listeners: Set<(message: any) => void>;
};

function startAppServer(codex: string, home: string, cwd: string): Client {
  const proc = spawn(codex, ["app-server", "-c", "check_for_update_on_startup=false"], {
    cwd,
    env: { ...process.env, CODEX_HOME: home, ADE_PROBE: "process-level" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(message: any) => void>();
  let nextId = 1;
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && !message.method) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry?.reject(new Error(JSON.stringify(message.error)));
      else entry?.resolve(message.result);
    } else if (message.method && message.id != null) {
      proc.stdin.write(`${JSON.stringify({ id: message.id, result: { decision: "accept" } })}\n`);
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  });
  proc.stderr.resume();
  const request = (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return { proc, request, listeners };
}

async function initialize(client: Client): Promise<void> {
  await client.request("initialize", { clientInfo: { name: "ade_bench", version: "0" }, capabilities: { experimentalApi: true } });
  client.proc.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
}

function treeMemory(rootPids: number[]): { processes: number; footprintMb: number; rssMb: number } {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="]).toString().trim().split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of rows) children.set(ppid!, [...(children.get(ppid!) ?? []), pid!]);
  const all: number[] = [];
  const stack = [...rootPids];
  while (stack.length) {
    const pid = stack.pop()!;
    all.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  let footprint = 0;
  let rss = 0;
  for (const pid of all) {
    try {
      const out = execFileSync("footprint", [String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString();
      const match = out.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
      if (match) footprint += Number(match[1]) * (match[2] === "GB" ? 1024 : match[2] === "KB" ? 1 / 1024 : 1);
    } catch { /* exited */ }
    rss += (rows.find((row) => row[0] === pid)?.[2] ?? 0) / 1024;
  }
  return { processes: all.length, footprintMb: Math.round(footprint), rssMb: Math.round(rss) };
}

const TURN_TIMEOUT_MS = 180_000;

function runTurn(client: Client, threadId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const finish = (error?: Error) => {
      clearTimeout(timer);
      client.listeners.delete(listener);
      if (error) reject(error);
      else resolve(output.trim());
    };
    const timer = setTimeout(() => finish(new Error(`turn on ${threadId} did not finish in ${TURN_TIMEOUT_MS} ms`)), TURN_TIMEOUT_MS);
    const listener = (message: any) => {
      const params = message.params ?? {};
      if (params.threadId !== threadId) return;
      if (message.method === "item/completed" && params.item?.type === "commandExecution") output += params.item.aggregatedOutput ?? "";
      if (message.method === "turn/completed") finish();
    };
    client.listeners.add(listener);
    // A refused turn (bad model, expired login, quota) rejects here, so the
    // scenario's cleanup still stops the processes and removes the temp home.
    client.request("turn/start", {
      threadId,
      model,
      input: [{ type: "text", text: "Run the shell command `printenv ADE_PROBE` and reply with only its output." }],
    }).catch((error: Error) => finish(error));
  });
}

async function scenario(codex: string, shared: boolean) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-bench-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-bench-cwd-"));
  if (withTurns) fs.copyFileSync(path.join(os.homedir(), ".codex/auth.json"), path.join(home, "auth.json"));
  const clients: Client[] = [];
  const threads: Array<{ client: Client; threadId: string; probe: string; readyMs: number }> = [];
  try {
    for (let i = 0; i < N; i += 1) {
      const startedAt = performance.now();
      let client = shared ? clients[0] : undefined;
      if (!client) {
        client = startAppServer(codex, home, cwd);
        await initialize(client);
        clients.push(client);
      }
      const probe = `chat-${i}`;
      const started = await client.request("thread/start", {
        cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        config: { shell_environment_policy: { set: { ADE_PROBE: probe } } },
      });
      threads.push({ client, threadId: started.thread.id, probe, readyMs: Math.round(performance.now() - startedAt) });
    }
    let identity = "not checked (pass --turns)";
    if (withTurns) {
      const outputs = await Promise.all(threads.map((thread) => runTurn(thread.client, thread.threadId)));
      const wrong = outputs.filter((output, index) => output !== threads[index]!.probe).length;
      identity = wrong ? `${wrong}/${N} threads saw another value` : `all ${N} threads saw their own`;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const memory = treeMemory(clients.map((client) => client.proc.pid!));
    const ready = threads.map((thread) => thread.readyMs);
    console.log(
      `${shared ? "one shared app-server " : "one app-server per chat"}  N=${N}`
      + `  processes=${memory.processes}  footprint=${memory.footprintMb} MB  rss=${memory.rssMb} MB`
      + `  first thread ready=${ready[0]} ms  later threads (median)=${ready.slice(1).sort((a, b) => a - b)[Math.floor((ready.length - 1) / 2)] ?? "-"} ms`
      + `  identity: ${identity}`,
    );
  } finally {
    for (const client of clients) client.proc.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5 });
  }
}

const codex = pinnedCodex();
console.log(`codex: ${codex}`);
await scenario(codex, false);
await scenario(codex, true);
