// cd apps/ade-cli && npx tsx ../../scripts/perf/service/chat-open-bytes.bench.mts --project <copy root> [--limit 2000]
// Bytes a client receives when it opens each chat: one `chat.getChatEventHistory` per chat with the
// desktop's opening window (maxEvents 1,000, maxBytes 256 KB, from chatHistoryWindow.ts), through an
// isolated measurement brain on a make-real-load-copy copy (never a live project). Outside target:
// cold opens of 1,321 real chats at p50 / p90 / p99 56 / 275 / 739 KB of JSON, 143 MB in total.
//
// Chats are every chat the brain lists (`session.list`, all rows, chat tool types); a transcript file
// whose chat is gone from the session table is not a chat a client can open. Reports the JSON and gzip
// size percentiles over every chat that answered, the total, and the chats that failed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { connectBrain, prepareCopyForBrain, startMeasureBrain, stopMeasureBrain, type BrainClient } from "../net/brain-rpc.mts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const projectRoot = flag("--project");
if (!projectRoot || !fs.existsSync(path.join(projectRoot, ".ade", "ade.db"))) {
  throw new Error("usage: chat-open-bytes.bench.mts --project <make-real-load-copy root> [--limit 2000]");
}
const limit = Number(flag("--limit") ?? 2_000);
/** Mirrors INITIAL_SELECTED_CHAT_HISTORY_EVENTS and CHAT_HISTORY_PAGE_MAX_BYTES (chatHistoryWindow.ts). */
const OPEN_WINDOW = { maxEvents: 1_000, maxBytes: 256 * 1024 };


const brain = { dir: fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-open-")), n: "co" };
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
const kb = (bytes: number) => +(bytes / 1024).toFixed(1);

// A copy must not hold running chats or a followed sync record when a brain opens it.
await prepareCopyForBrain(projectRoot);
const record = startMeasureBrain(brain);
let client: BrainClient | null = null;
const json: number[] = [];
const gz: number[] = [];
let failed = 0;
let firstError: string | null = null;
try {
  client = await connectBrain(record.socket, "chat-open-bytes-bench");
  await client.addProject(projectRoot);
  await sleep(10_000);
  const listed = await client.action("run_ade_action", { domain: "session", action: "list", args: { limit: null } });
  if (listed?.ok === false) throw new Error(`session.list failed: ${JSON.stringify(listed.error)}`);
  const sessionIds = ((listed?.result ?? []) as Array<{ id?: string; toolType?: string | null }>)
    .filter((row) => String(row.toolType ?? "").endsWith("-chat") && row.id)
    .map((row) => row.id!)
    .slice(0, limit);
  for (const sessionId of sessionIds) {
    try {
      const result = await client.action("run_ade_action", { domain: "chat", action: "getChatEventHistory", args: { sessionId, ...OPEN_WINDOW } });
      if (result?.ok === false) throw new Error(JSON.stringify(result.error));
      if (result?.result?.sessionFound === false) throw new Error("chat not found");
      const payload = result?.result ?? result;
      const text = JSON.stringify(payload);
      json.push(Buffer.byteLength(text));
      gz.push(gzipSync(text).length);
    } catch (error) {
      failed += 1;
      firstError ??= `${sessionId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
    }
  }
} finally {
  client?.close();
  stopMeasureBrain(brain);
}
const sj = [...json].sort((a, b) => a - b);
const sg = [...gz].sort((a, b) => a - b);
console.log(JSON.stringify({
  bench: "chat-open-bytes",
  platform: process.platform,
  chats: json.length,
  failed,
  firstError,
  jsonKB: { p50: kb(percentile(sj, 0.5)), p90: kb(percentile(sj, 0.9)), p99: kb(percentile(sj, 0.99)), max: kb(sj.at(-1) ?? 0) },
  gzipKB: { p50: kb(percentile(sg, 0.5)), p90: kb(percentile(sg, 0.9)), p99: kb(percentile(sg, 0.99)), max: kb(sg.at(-1) ?? 0) },
  totalJsonMB: +(json.reduce((s, x) => s + x, 0) / 1048576).toFixed(1),
  target: "p50/p90/p99 56/275/739 KB JSON",
}));
