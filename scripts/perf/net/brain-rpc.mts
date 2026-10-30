// Helpers for benches that drive an isolated measurement brain (measure-brain.mjs) over JSON-RPC.
//   startMeasureBrain  starts one with extra preloads and env, returns its record (pid, socket, syncPort)
//   stopMeasureBrain   stops it (only the pid measure-brain started)
//   connectBrain       opens its pipe or socket, sends ade/initialize as a cto client, one JSON message per line
//   prepareCopyForBrain  readies a make-real-load-copy copy for a new brain (run it by hand with
//                      `npx tsx scripts/perf/net/brain-rpc.mts --prepare <copy root>`)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdeDb } from "../../../apps/desktop/src/main/services/state/kvDb";

const measureBrain = path.resolve(import.meta.dirname, "measure-brain.mjs");

export type MeasureBrainRecord = { pid: number; socket: string; syncPort: number | null; home: string; log: string };

// `cli` measures another build (a saved perfdist-<name> folder's cli.cjs) with the same isolation.
export function startMeasureBrain(opts: { dir: string; n: string; cli?: string; preloads?: string[]; env?: Record<string, string> }): MeasureBrainRecord {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  if (opts.preloads?.length) env.ADE_PERF_EXTRA_REQUIRE = opts.preloads.join(path.delimiter);
  const cliArgs = opts.cli ? ["--cli", opts.cli] : [];
  const started = spawnSync(process.execPath, [measureBrain, "start", "--dir", opts.dir, "--n", opts.n, ...cliArgs], { encoding: "utf8", env });
  if (started.status !== 0) throw new Error(`measurement brain did not start: ${started.stderr || started.stdout}`);
  return JSON.parse(started.stdout.trim().split("\n").pop()!) as MeasureBrainRecord;
}

export function stopMeasureBrain(opts: { dir: string; n: string }): void {
  spawnSync(process.execPath, [measureBrain, "stop", "--dir", opts.dir, "--n", opts.n], { encoding: "utf8" });
}

export type BrainClient = {
  request(method: string, params?: unknown): Promise<any>;
  /** `ade/actions/call` for the project registered by `addProject`; throws on a tool error. */
  action(name: string, args?: Record<string, unknown>): Promise<any>;
  addProject(rootPath: string): Promise<string>;
  close(): void;
};

export async function connectBrain(socketPath: string, clientName: string): Promise<BrainClient> {
  const socket = net.createConnection(socketPath);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let buffer = "";
  let nextId = 1;
  let projectId: string | null = null;
  let connectionError: Error | null = null;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: { id?: number; result?: unknown; error?: { message: string } };
      try {
        message = JSON.parse(line);
      } catch {
        // A thrown parse here would end the bench before its cleanup and leave the brain running.
        socket.destroy(new Error(`the brain sent a line that is not JSON: ${line.slice(0, 120)}`));
        return;
      }
      const waiter = message.id == null ? undefined : pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id!);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  // A brain that dies or drops the connection mid-bench fails every waiting request, so the bench
  // reaches its cleanup instead of hanging with the brain left running.
  const failAll = (error: Error) => {
    connectionError ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.on("error", (error) => failAll(error));
  socket.on("close", () => failAll(new Error("the brain closed the connection")));
  const request = (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    // A request made after the connection failed would wait forever on a socket that never answers.
    if (connectionError || socket.destroyed) {
      return Promise.reject(connectionError ?? new Error("the brain closed the connection"));
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  await request("ade/initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: clientName, version: "0" },
    identity: { callerId: clientName, role: "cto" },
  });
  return {
    request,
    async action(name, args = {}) {
      const result = await request("ade/actions/call", { name, arguments: args, ...(projectId ? { projectId } : {}) });
      if (result?.isError) throw new Error(`${name} failed: ${JSON.stringify(result).slice(0, 300)}`);
      return result;
    },
    async addProject(rootPath) {
      // Registered as `ade projects add` does, so a paired phone sees it in its catalog.
      const registered = await request("projects.add", { rootPath, catalogVisibility: "recent", registrationSource: "cli-explicit" });
      projectId = registered?.projectId as string;
      return projectId;
    },
    close: () => socket.end(),
  };
}

/**
 * Chat-record fields that point at the source's provider threads: every field `persistedPointerState`
 * reads (`ThreadPointerFields` in apps/desktop/src/main/services/chat/providerThreadContinuity.ts), plus
 * Claude's background resume id. Keep this in step with that type.
 */
const RESUME_ID_KEYS = [
  "threadId",
  "sdkSessionId",
  "claudeBackgroundResumeSessionId",
  "providerSessionId",
  "droidSdkSessionId",
  "copilotSdkSessionId",
  "piSessionId",
  "piSessionFile",
  "cursorSdkAgentId",
  "cursorCloudAgentId",
  "acpSessionId",
  "museSessionId",
];

/**
 * A copy carries the source's running chats as running, and any brain that opens it (a dev app, a
 * measurement brain with its own HOME) resumes them: one relaunched a live chat on a shared ADE home and
 * appended to its Claude session, another resumed a chat inside its fake home. End them as a stopped
 * brain's reconcile does (running -> detached), and drop the provider resume ids from the chat records
 * in <copy>/.ade/cache/chat-sessions, so a chat reopened from the copy starts a new provider session.
 * Returns how many chats were ended and how many records changed.
 */
export function retireCopiedChats(db: AdeDb, copyAde: string): { endedChats: number; records: number } {
  const endedChats = db.runChanged(
    "update terminal_sessions set status = 'detached', ended_at = coalesce(ended_at, ?), pty_id = null where status = 'running'",
    [new Date().toISOString()],
  );
  const sessionsDir = path.join(copyAde, "cache", "chat-sessions");
  let records = 0;
  for (const file of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []) {
    const full = path.join(sessionsDir, file);
    if (!fs.statSync(full).isFile()) continue;
    const body = fs.readFileSync(full, "utf8");
    if (!RESUME_ID_KEYS.some((key) => body.includes(`"${key}"`))) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(body);
    } catch {
      continue; // a partial write; its chat row is ended above either way
    }
    for (const key of RESUME_ID_KEYS) delete record[key];
    fs.rmSync(full); // a clone shares blocks with its source until written; write a new file
    fs.writeFileSync(full, JSON.stringify(record));
    records += 1;
  }
  return { endedChats, records };
}

/**
 * Ready a make-real-load-copy copy for a new brain. A copy another measurement brain opened names that
 * brain as its sync host, and a new brain (a new device) then follows it and refuses to host, so the
 * record is cleared, as make-real-load-copy does; and chats left running (a copy made before
 * make-real-load-copy ended them, or a brain that stopped mid-chat) are ended. Copies only.
 */
export async function prepareCopyForBrain(projectRoot: string): Promise<{ endedChats: number; records: number }> {
  if (!fs.existsSync(path.join(projectRoot, ".ade", "real-load-copy.json"))) {
    throw new Error(`${projectRoot} is not a make-real-load-copy copy; refusing to write to it`);
  }
  const { openKvDb } = await import("../../../apps/desktop/src/main/services/state/kvDb");
  const silent = { debug() {}, info() {}, warn() {}, error() {} } as never;
  const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), silent);
  try {
    db.run("delete from sync_cluster_state");
    const retired = retireCopiedChats(db, path.join(projectRoot, ".ade"));
    db.flushNow();
    return retired;
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--prepare") {
  const root = process.argv[3];
  if (!root) throw new Error("usage: brain-rpc.mts --prepare <copy root>");
  console.log(JSON.stringify({ prepared: path.resolve(root), ...(await prepareCopyForBrain(path.resolve(root))) }));
}
