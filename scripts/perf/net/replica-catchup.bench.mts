// cd apps/ade-cli && npx tsx ../../scripts/perf/net/replica-catchup.bench.mts --db <copy of ade.db> [--profiles 3g,lte,lan] [--runs 3] [--cap-ms 300000]
//
// What a phone's first replica costs on one project database: a real sync host (production
// createSyncHostService, real kvDb, its real changeset pump, mobile filters and reseed) serves the
// database, and a phone that never had it connects through the slow-network proxy, acks every batch
// and stops when it holds hello_ok's serverDbVersion (or at --cap-ms). Lane and PR services are inert
// stubs, so nothing runs git or touches a worktree: point it at a COPY of a real project's ade.db
// (`sqlite3 <db> ".backup <copy>"` reads the original without writing it). Prints numbers only.
//
// Per run: time to hello_ok and to caught-up, batches, rows, wire bytes per message type, whether
// the host sent a reseed (the only path that labels a batch "catchup"; the incremental pump says
// "broadcast"), and the batch rate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  catchUpMeasurementPhone,
  helloMeasurementPhone,
  pairMeasurementPhone,
  startMeasurementSyncHost,
} from "../../../apps/ade-cli/src/test/phoneWireHarness";
// @ts-expect-error plain ESM helper without types
import { startSlowProxy, NETWORK_PROFILES } from "./slow-proxy.mjs";

const argv = process.argv.slice(2);
const read = (name: string): string | null => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
};
const dbSource = read("--db");
if (!dbSource) throw new Error("--db <copy of a project ade.db> is required");
const profiles = (read("--profiles") ?? "3g,lte,lan").split(",").filter(Boolean);
for (const profile of profiles) if (!NETWORK_PROFILES[profile]) throw new Error(`Unknown profile ${profile}`);
const runs = Number(read("--runs") ?? 3);
const capMs = Number(read("--cap-ms") ?? 300_000);
const json = read("--json");

// The host opens (and migrates) the database it serves, so it gets a throwaway copy every run.
const scratch = fs.mkdtempSync(path.join(path.dirname(path.resolve(dbSource)), "replica-catchup-"));
const projectRoot = path.join(scratch, "project");
fs.mkdirSync(path.join(projectRoot, ".ade"), { recursive: true });

const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
};

type Row = { profile: string; run: number; helloOkMs: number; caughtUpMs: number | null; serverDbVersion: number; applied: number; batches: number; rows: number; reseed: boolean; wireKB: number; byTypeKB: Record<string, number>; proxyDownKB: number };
const rows: Row[] = [];
try {
  for (let run = 1; run <= runs; run += 1) {
    for (const profile of profiles) {
      const dbPath = path.join(projectRoot, ".ade", "ade.db");
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
      fs.copyFileSync(dbSource, dbPath);
      const host = await startMeasurementSyncHost({ projectRoot, projectId: "measure-project", secretsDir: path.join(scratch, `secrets-${run}-${profile}`) });
      const proxy = await startSlowProxy({ targetPort: host.port, profile });
      const url = `ws://127.0.0.1:${proxy.port}`;
      try {
        const identity = await pairMeasurementPhone(`ws://127.0.0.1:${host.port}`, host.pin, `CATCHUP-${run}-${profile}`, `catchupsite${run}${profile}`.padEnd(32, "0"));
        proxy.resetStats();
        const t0 = performance.now();
        const { phone, hello } = await helloMeasurementPhone(url, identity, 0);
        const helloOkMs = performance.now() - t0;
        const serverDbVersion = Number(hello.payload.serverDbVersion);
        let caughtUpMs: number | null = null;
        let result = { applied: 0, batches: 0, rows: 0 };
        try {
          result = await Promise.race([
            catchUpMeasurementPhone(phone, 0, serverDbVersion, capMs),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cap")), capMs)),
          ]);
          caughtUpMs = performance.now() - t0;
        } catch {
          const batches = phone.received.filter((message) => message.type === "changeset_batch");
          result = {
            applied: Math.max(0, ...batches.map((message) => Number(message.payload.toDbVersion))),
            batches: batches.length,
            rows: batches.reduce((sum, message) => sum + (message.payload.changes?.length ?? 0), 0),
          };
        }
        const byType = phone.bytesByType();
        const row: Row = {
          profile,
          run,
          helloOkMs: Math.round(helloOkMs),
          caughtUpMs: caughtUpMs == null ? null : Math.round(caughtUpMs),
          serverDbVersion,
          applied: result.applied,
          batches: result.batches,
          rows: result.rows,
          reseed: phone.received.some((message) => message.type === "changeset_batch" && message.payload.reason === "catchup"),
          wireKB: +(phone.bytes() / 1024).toFixed(1),
          byTypeKB: Object.fromEntries(Object.entries(byType).map(([type, bytes]) => [type, +(bytes / 1024).toFixed(1)])),
          proxyDownKB: +(proxy.stats().downBytes / 1024).toFixed(1),
        };
        console.log(JSON.stringify(row));
        rows.push(row);
        if (json) fs.appendFileSync(json, `${JSON.stringify(row)}\n`);
        await phone.close();
      } finally {
        await proxy.close();
        await host.dispose();
      }
    }
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ loadavg: os.loadavg().map((value) => +value.toFixed(2)) }));
for (const profile of profiles) {
  const group = rows.filter((row) => row.profile === profile);
  console.log(JSON.stringify({
    summary: profile,
    runs: group.length,
    helloOkMs: median(group.map((row) => row.helloOkMs)),
    caughtUpMs: median(group.map((row) => row.caughtUpMs ?? Number.NaN)),
    notCaughtUp: group.filter((row) => row.caughtUpMs == null).length,
    serverDbVersion: median(group.map((row) => row.serverDbVersion)),
    batches: median(group.map((row) => row.batches)),
    rows: median(group.map((row) => row.rows)),
    wireKB: median(group.map((row) => row.wireKB)),
    proxyDownKB: median(group.map((row) => row.proxyDownKB)),
    reseed: group.some((row) => row.reseed),
  }));
}
process.exit(0);
