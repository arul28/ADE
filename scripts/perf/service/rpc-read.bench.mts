// cd apps/ade-cli && npx tsx ../../scripts/perf/service/rpc-read.bench.mts
// Feeds one 10 MB JSON-RPC request to the brain's reader in 64 KB chunks, as a
// socket delivers it, once Content-Length framed and once as a JSONL line, and
// times until the handler receives it.
import { startJsonRpcServer } from "../../../apps/ade-cli/src/jsonrpc";

async function readOnce(payload: Buffer): Promise<number> {
  const callbacks: Array<(chunk: Buffer) => void> = [];
  let received!: () => void;
  const done = new Promise<void>((resolve) => { received = resolve; });
  const stop = startJsonRpcServer(async () => { received(); return { ok: true }; }, {
    onData: (callback: (chunk: Buffer) => void) => { callbacks.push(callback); },
    write: () => {},
    close: () => {},
  } as never, { nonFatal: true });
  const started = performance.now();
  for (let offset = 0; offset < payload.length; offset += 65_536) {
    for (const callback of callbacks) callback(payload.subarray(offset, offset + 65_536));
  }
  await done;
  const ms = performance.now() - started;
  stop();
  return ms;
}

const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { blob: "a".repeat(10 * 1024 * 1024) } });
const framedMs = await readOnce(Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf8"));
const jsonlMs = await readOnce(Buffer.from(`${body}\n`, "utf8"));
console.log(JSON.stringify({ requestMB: 10, chunkKB: 64, framedMs: +framedMs.toFixed(1), jsonlMs: +jsonlMs.toFixed(1) }));
process.exit(0);
