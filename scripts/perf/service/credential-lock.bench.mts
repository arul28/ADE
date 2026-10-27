// cd apps/ade-cli && npx tsx ../../scripts/perf/service/credential-lock.bench.mts
// What a synchronous credential read (`getSync`, which the brain calls from
// its event loop: account lease, Linear token, session reads) costs while
// another ADE process holds the store's cross-process lock, as an `ade` CLI
// call does for every credential read it makes. A child process takes the
// lock and holds it for HOLD_MS; a fresh store (no warm cache) then reads one
// key. Everything lives in a temp folder; OS key material is stubbed out.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EncryptedFileCredentialStore } from "../../../apps/ade-cli/src/services/credentials/credentialStore";

const HOLD_MS = Number(process.env.HOLD_MS ?? 3_000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-credential-lock-"));
const keyMaterial = { read: () => null, readAsync: async () => null, peerMayHoldMaterial: false } as never;
const make = () => new EncryptedFileCredentialStore({ secretsDir: dir, keyMaterial });
await make().set("bench.token", "value");
const lockPath = path.join(dir, "credentials.json.enc.lock");
const holder = spawn(process.execPath, ["-e", `
  const fs = require("node:fs");
  fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: "wx" });
  process.stdout.write("held\\n");
  setTimeout(() => { fs.unlinkSync(${JSON.stringify(lockPath)}); process.exit(0); }, ${HOLD_MS});
`], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
const t = performance.now();
const value = make().getSync("bench.token");
const blockedMs = Math.round(performance.now() - t);
console.log(JSON.stringify({ holdMs: HOLD_MS, lockFile: path.basename(lockPath), getSyncBlockedMs: blockedMs, valueRead: value === "value" }));
await new Promise((resolve) => holder.once("exit", resolve));
fs.rmSync(dir, { recursive: true, force: true });
