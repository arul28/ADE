// Helpers for benches that drive an isolated measurement brain (measure-brain.mjs) over JSON-RPC.
//   startMeasureBrain  starts one with extra preloads and env, returns its record (pid, socket, syncPort)
//   stopMeasureBrain   stops it (only the pid measure-brain started)
//   connectBrain       opens its pipe or socket, sends ade/initialize as a cto client, one JSON message per line
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";

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
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
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
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.on("error", (error) => failAll(error));
  socket.on("close", () => failAll(new Error("the brain closed the connection")));
  const request = (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
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
 * A copy that another measurement brain opened names that brain as its sync host, and a new brain (a new
 * device) then follows it and refuses to host. Clear the record, as make-real-load-copy does. Copies only.
 */
export async function releaseCopySyncHost(projectRoot: string): Promise<void> {
  const fs = await import("node:fs");
  if (!fs.existsSync(path.join(projectRoot, ".ade", "real-load-copy.json"))) {
    throw new Error(`${projectRoot} is not a make-real-load-copy copy; refusing to write to it`);
  }
  const { openKvDb } = await import("../../../apps/desktop/src/main/services/state/kvDb");
  const silent = { debug() {}, info() {}, warn() {}, error() {} } as never;
  const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), silent);
  try {
    db.run("delete from sync_cluster_state");
    db.flushNow();
  } finally {
    db.close();
  }
}
