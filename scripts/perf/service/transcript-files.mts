// Chat transcripts for the chat benches: the largest ones in a project, and their events.
// Transcripts live in <project>/.ade/transcripts/chat/<session>.jsonl, gzipped once settled
// (<session>.jsonl.gz); older projects also have <project>/.ade/transcripts/<session>.chat.jsonl.
// <project> is $ADE_PROJECT_ROOT or the checkout these scripts are in. Only read.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { AgentChatEventEnvelope } from "../../../apps/desktop/src/shared/types/chat";

function projectRoot(): string {
  if (process.env.ADE_PROJECT_ROOT) return process.env.ADE_PROJECT_ROOT;
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  // A lane worktree lives under <project>/.ade/worktrees/<lane>.
  const marker = `${path.sep}.ade${path.sep}worktrees${path.sep}`;
  return checkout.includes(marker) ? checkout.slice(0, checkout.indexOf(marker)) : checkout;
}

/** A gzip file ends with its uncompressed size (mod 2^32), so ranking needs no decompression. */
function uncompressedSize(file: string): number {
  if (!file.endsWith(".gz")) return statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const trailer = Buffer.alloc(4);
    readSync(fd, trailer, 0, 4, statSync(file).size - 4);
    return trailer.readUInt32LE(0);
  } finally {
    closeSync(fd);
  }
}

/** The `count` largest chats (by uncompressed size) of `project`, default $ADE_PROJECT_ROOT or this checkout's project. */
export function largestTranscripts(count = 5, project = projectRoot()): string[] {
  const root = path.join(project, ".ade", "transcripts");
  const files: string[] = [];
  const chatDir = path.join(root, "chat");
  if (existsSync(chatDir)) {
    for (const name of readdirSync(chatDir)) if (/\.jsonl(\.gz)?$/.test(name)) files.push(path.join(chatDir, name));
  }
  if (existsSync(root)) {
    for (const name of readdirSync(root)) if (name.endsWith(".chat.jsonl")) files.push(path.join(root, name));
  }
  return files
    .map((file) => ({ file, size: uncompressedSize(file) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, count)
    .map((entry) => entry.file);
}

export function loadTranscript(file: string): AgentChatEventEnvelope[] {
  const text = file.endsWith(".gz") ? gunzipSync(readFileSync(file)).toString("utf8") : readFileSync(file, "utf8");
  return text.split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed?.event?.type ? [parsed as AgentChatEventEnvelope] : [];
    } catch {
      return [];
    }
  });
}
