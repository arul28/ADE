// cd apps/ade-cli && npx tsx ../../scripts/perf/service/chat-status.bench.mts --project <copy root> [--runs 5] [--chats 5] [--cli <built cli.cjs>]
// What one CTO operator action costs through the brain: `getChatStatus` (what `ade chat status` and an
// agent's chat tools ask), round trip over JSON-RPC to an isolated measurement brain on <copy root>
// (a make-real-load-copy copy). The project is opened and left to settle 45 s first, so its start-up
// work is not in the numbers. Each run asks about the <chats> most recent chats 10 times each; a run's
// value is the median of those calls. Prints each run and the median of the runs with the worst.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { connectBrain, prepareCopyForBrain, startMeasureBrain, stopMeasureBrain } from "../net/brain-rpc.mts";
import { flag, median, requireCopyRoot } from "./bench-kit.mts";

const projectRoot = requireCopyRoot(flag("--project"));
const runs = Number(flag("--runs") ?? 5);
const chatCount = Number(flag("--chats") ?? 5);

const db = new DatabaseSync(path.join(projectRoot, ".ade", "ade.db"), { readOnly: true });
const chats = (db.prepare("select id from terminal_sessions where tool_type like '%chat%' order by started_at desc limit ?").all(chatCount) as Array<{ id: string }>).map((row) => row.id);
db.close();
if (!chats.length) throw new Error("the copy has no chats");

await prepareCopyForBrain(projectRoot);
const brain = { dir: fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-status-")), n: "cs" };
const record = startMeasureBrain({ ...brain, cli: flag("--cli") });
const runMedians: number[] = [];
let slowest = 0;
try {
  const client = await connectBrain(record.socket, "chat-status-bench");
  await client.addProject(projectRoot);
  await client.action("getChatStatus", { sessionId: chats[0]! });
  await new Promise((resolve) => setTimeout(resolve, 45_000));
  for (let run = 1; run <= runs; run++) {
    const ms: number[] = [];
    for (const sessionId of chats) {
      for (let i = 0; i < 10; i++) {
        const started = performance.now();
        await client.action("getChatStatus", { sessionId });
        ms.push(performance.now() - started);
      }
    }
    runMedians.push(median(ms));
    slowest = Math.max(slowest, ...ms);
    console.log(JSON.stringify({ run, calls: ms.length, medianMs: +median(ms).toFixed(1), maxMs: +Math.max(...ms).toFixed(1) }));
  }
  client.close();
} finally {
  stopMeasureBrain(brain);
  fs.rmSync(brain.dir, { recursive: true, force: true });
}
console.log(JSON.stringify({
  bench: "chat-status",
  platform: process.platform,
  runs: runMedians.length,
  chats: chats.length,
  medianMs: +median(runMedians).toFixed(1),
  worstRunMs: +Math.max(...runMedians).toFixed(1),
  slowestCallMs: +slowest.toFixed(1),
}));
process.exit(0);
