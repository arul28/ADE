// cd apps/ade-cli && npx tsx ../../scripts/perf/service/chat-text-coalesce.bench.mts --project <copy root> [--chars 6200]
// Bytes a streamed reply costs on the wire, with and without the brain's 100 ms text
// buffer, at 10, 25 and 50 ms delta cadences. Outside target: a synthetic
// stream of the same reply; serialized bytes fall 79.8% at 10 ms and 49.9% at 25 ms,
// and a 6,200-byte reply ends at 21,121 decoded bytes on the socket.
//
// The two percentages are not like for like: the target's updates each carry the whole
// reply so far, ADE's carry only the new text, so ADE's uncoalesced baseline is already
// much smaller. Compare the absolute bytes (`coalescedBytes`) first.
//
// The envelope shape (ids, timestamps, sequence) is copied from the newest real `text`
// event in the copy's transcripts, so the per-event overhead is ADE's own. The buffer
// is replayed as agentChatService runs it: the first delta starts a 100 ms timer, every
// delta of the same stream joins the pending text, the timer flushes it.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { appendBufferedAssistantText, type BufferedAssistantText } from "../../../apps/desktop/src/main/services/chat/chatTextBatching";
import type { AgentChatEventEnvelope } from "../../../apps/desktop/src/shared/types/chat";
import { loadTranscript } from "./transcript-files.mts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const project = flag("--project");
if (!project) throw new Error("usage: chat-text-coalesce.bench.mts --project <copy root> [--chars 6200]");
const chars = Number(flag("--chars") ?? 6_200);
/** Mirrors BUFFERED_TEXT_FLUSH_MS in agentChatService. */
const FLUSH_MS = 100;

const dir = path.join(project, ".ade", "transcripts", "chat");
const newest = readdirSync(dir)
  .map((name) => path.join(dir, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  .slice(0, 20);
let sample: AgentChatEventEnvelope | null = null;
for (const file of newest) {
  sample = loadTranscript(file).reverse()
    .find((envelope) => envelope.event.type === "text" && Boolean((envelope.event as { messageId?: string }).messageId)) ?? null;
  if (sample) break;
}
if (!sample) throw new Error(`no text event with a messageId in ${dir}`);
const base = sample.event as Extract<AgentChatEventEnvelope["event"], { type: "text" }>;

// A reply of English-like text, cut into ~62-character deltas (6,200 / 100, as the target's burst).
const words = "the brain streams this reply to every client that watches the chat while it runs ".split(" ");
let reply = "";
for (let index = 0; reply.length < chars; index += 1) reply += `${words[index % words.length]} `;
reply = reply.slice(0, chars);
const DELTAS = 100;
const deltaSize = Math.ceil(chars / DELTAS);
const deltas: string[] = [];
for (let offset = 0; offset < reply.length; offset += deltaSize) deltas.push(reply.slice(offset, offset + deltaSize));

const envelopeBytes = (text: string, sequence: number, atMs: number) => Buffer.byteLength(JSON.stringify({
  ...sample,
  sequence,
  timestamp: new Date(Date.parse(sample!.timestamp) + atMs).toISOString(),
  event: { ...base, text },
}));

for (const cadenceMs of [10, 25, 50]) {
  const uncoalescedBytes = deltas.reduce((sum, delta, index) => sum + envelopeBytes(delta, index, index * cadenceMs), 0);
  let pending: BufferedAssistantText | null = null;
  let flushAt = 0;
  let sent = 0;
  let coalescedBytes = 0;
  const flush = () => {
    if (!pending) return;
    coalescedBytes += envelopeBytes(pending.text, sent, flushAt);
    sent += 1;
    pending = null;
  };
  deltas.forEach((delta, index) => {
    const at = index * cadenceMs;
    if (pending && at >= flushAt) flush();
    if (!pending) flushAt = at + FLUSH_MS;
    pending = appendBufferedAssistantText(pending, { ...base, text: delta });
  });
  flush();
  console.log(JSON.stringify({
    cadenceMs,
    replyChars: reply.length,
    deltas: deltas.length,
    events: sent,
    uncoalescedBytes,
    coalescedBytes,
    savedPct: +(100 * (1 - coalescedBytes / uncoalescedBytes)).toFixed(1),
    target: cadenceMs === 10 ? "-79.8%" : cadenceMs === 25 ? "-49.9%" : "0%",
  }));
}
