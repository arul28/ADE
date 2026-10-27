// cd apps/ade-cli && npx tsx ../../scripts/perf/net/compression-model.mts <dump.jsonl> [--level 6]
//
// Compares, on envelopes recorded by phone-sync.bench.mts (PHONE_SYNC_DUMP=<file>), the payload bytes
// of today's phone compression (deflate per envelope at >= 512 B, what syncProtocol.ts does) with one
// deflate stream per socket (each envelope flushed with Z_SYNC_FLUSH, the 4-byte flush marker dropped as
// permessage-deflate does). Header bytes are the same in both, so they are left out. Also times both.
import fs from "node:fs";
import zlib from "node:zlib";

const file = process.argv[2];
if (!file) throw new Error("usage: compression-model.mts <dump.jsonl>");
const levelIndex = process.argv.indexOf("--level");
const level = levelIndex > 0 ? Number(process.argv[levelIndex + 1]) : zlib.constants.Z_DEFAULT_COMPRESSION;
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

type Totals = { raw: number; perEnvelope: number; stream: number; count: number };
const byType = new Map<string, Totals>();
const total: Totals = { raw: 0, perEnvelope: 0, stream: 0, count: 0 };
let perEnvelopeMs = 0;
let streamMs = 0;
let inflateStreamMs = 0;
let inflatePerEnvelopeMs = 0;

// One raw deflate context for the whole socket, as zlib's deflate with Z_SYNC_FLUSH keeps it.
const deflater = zlib.createDeflateRaw({ level });
const inflater = zlib.createInflateRaw();
// Write one envelope and flush it (Z_SYNC_FLUSH): the bytes the socket would carry for it.
const collect = (stream: zlib.DeflateRaw | zlib.InflateRaw) => {
  let chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return (input: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
    stream.write(input, (error) => {
      if (error) return reject(error);
      stream.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        const out = Buffer.concat(chunks);
        chunks = [];
        resolve(out);
      });
    });
  });
};
const flushSync = collect(deflater);
const inflateSync = collect(inflater);

for (const row of rows) {
  const json = Buffer.from(JSON.stringify(row.payload ?? null), "utf8");
  let t = process.hrtime.bigint();
  const per = json.byteLength >= 512 ? zlib.deflateSync(json, { level }) : json;
  perEnvelopeMs += Number(process.hrtime.bigint() - t) / 1e6;
  if (json.byteLength >= 512) {
    t = process.hrtime.bigint();
    zlib.inflateSync(per);
    inflatePerEnvelopeMs += Number(process.hrtime.bigint() - t) / 1e6;
  }
  t = process.hrtime.bigint();
  const flushed = await flushSync(json);
  streamMs += Number(process.hrtime.bigint() - t) / 1e6;
  const streamBytes = flushed.byteLength - 4; // 00 00 ff ff
  t = process.hrtime.bigint();
  const back = await inflateSync(flushed);
  inflateStreamMs += Number(process.hrtime.bigint() - t) / 1e6;
  if (!back.equals(json)) throw new Error("stream round trip mismatch");
  const entry = byType.get(row.type) ?? { raw: 0, perEnvelope: 0, stream: 0, count: 0 };
  for (const target of [entry, total]) {
    target.raw += json.byteLength;
    target.perEnvelope += per.byteLength;
    target.stream += streamBytes;
    target.count += 1;
  }
  byType.set(row.type, entry);
}
const kb = (n: number) => Math.round(n / 102.4) / 10;
const out: Record<string, unknown> = {};
for (const [type, t] of [...byType.entries()].sort((a, b) => b[1].perEnvelope - a[1].perEnvelope)) {
  out[type] = { count: t.count, rawKB: kb(t.raw), perEnvelopeKB: kb(t.perEnvelope), streamKB: kb(t.stream), ratio: Math.round((t.perEnvelope / t.stream) * 100) / 100 };
}
console.log(JSON.stringify({
  file, level, envelopes: total.count,
  total: { rawKB: kb(total.raw), perEnvelopeKB: kb(total.perEnvelope), streamKB: kb(total.stream), ratio: Math.round((total.perEnvelope / total.stream) * 100) / 100 },
  cpuMs: { deflatePerEnvelope: Math.round(perEnvelopeMs), deflateStream: Math.round(streamMs), inflatePerEnvelope: Math.round(inflatePerEnvelopeMs), inflateStream: Math.round(inflateStreamMs) },
  byType: out,
}, null, 1));
