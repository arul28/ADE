import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types";
import { readChatEventsAfterSequence, readTurnAlignedTranscriptTail } from "./chatLogResume";

const SESSION = "chat-log";
let dir = "";
let file = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-log-"));
  file = path.join(dir, `${SESSION}.jsonl`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function row(sequence: number | null, event: Record<string, unknown>, extra: Partial<AgentChatEventEnvelope> = {}): string {
  return `${JSON.stringify({
    sessionId: SESSION,
    timestamp: `2026-09-23T10:00:00.${String(sequence ?? 0).padStart(3, "0")}Z`,
    ...(sequence != null ? { sequence } : {}),
    event,
    ...extra,
  })}\n`;
}
const text = (sequence: number, size = 0) => row(sequence, { type: "text", text: `t${sequence}${"x".repeat(size)}` });

describe("readChatEventsAfterSequence", () => {
  it("returns every persisted event after the client's last sequence, in order, skipping unsequenced rows", async () => {
    fs.writeFileSync(file, [
      text(1), text(2), text(3),
      row(null, { type: "session_meta_updated" }),
      text(4), text(5),
      row(6, { type: "text", text: "nested" }, { provenance: { targetKind: "codex_subagent" } }),
      text(7),
    ].join(""));
    const read = await readChatEventsAfterSequence({ transcriptPath: file, sessionId: SESSION, sinceSequence: 3 });
    expect(read).toMatchObject({ status: "ok", maxSequence: 7 });
    expect(read.status === "ok" && read.events.map((event) => event.sequence)).toEqual([4, 5, 7]);
  });

  it("serves a fresh client from the head, and a current client nothing", async () => {
    fs.writeFileSync(file, [text(1), text(2)].join(""));
    const fresh = await readChatEventsAfterSequence({ transcriptPath: file, sessionId: SESSION, sinceSequence: 0 });
    expect(fresh.status === "ok" && fresh.events.map((event) => event.sequence)).toEqual([1, 2]);
    const current = await readChatEventsAfterSequence({ transcriptPath: file, sessionId: SESSION, sinceSequence: 2 });
    expect(current).toEqual({ status: "ok", events: [], maxSequence: 2 });
  });

  it("reports a gap when the missed span exceeds the cap", async () => {
    const lines = [text(1)];
    for (let sequence = 2; sequence <= 200; sequence += 1) lines.push(text(sequence, 1_000));
    fs.writeFileSync(file, lines.join(""));
    const read = await readChatEventsAfterSequence({
      transcriptPath: file,
      sessionId: SESSION,
      sinceSequence: 1,
      maxBytes: 64 * 1024,
    });
    expect(read).toEqual({ status: "gap", reason: "resume_too_large" });
  });

  it("reports a gap for a sequence ahead of the log, a missing file, or restarted numbering", async () => {
    fs.writeFileSync(file, [text(1), text(2)].join(""));
    expect(await readChatEventsAfterSequence({ transcriptPath: file, sessionId: SESSION, sinceSequence: 9 }))
      .toEqual({ status: "gap", reason: "ahead_of_log" });
    expect(await readChatEventsAfterSequence({ transcriptPath: path.join(dir, "missing.jsonl"), sessionId: SESSION, sinceSequence: 4 }))
      .toEqual({ status: "gap", reason: "unknown_sequence" });
    // Legacy numbering restarted: a scan that crosses the seam is refused,
    // and a client from the older epoch is ahead of the newest numbering.
    fs.writeFileSync(file, [text(1), text(2), text(3), text(1), text(2)].join(""));
    expect(await readChatEventsAfterSequence({ transcriptPath: file, sessionId: SESSION, sinceSequence: 0 }))
      .toEqual({ status: "gap", reason: "non_monotonic" });
    expect(await readChatEventsAfterSequence({ transcriptPath: file, sessionId: SESSION, sinceSequence: 3 }))
      .toEqual({ status: "gap", reason: "ahead_of_log" });
  });

  it("reports a gap when the log starts after the client's sequence", async () => {
    fs.writeFileSync(file, [text(5), text(6)].join(""));
    expect(await readChatEventsAfterSequence({ transcriptPath: file, sessionId: SESSION, sinceSequence: 2 }))
      .toEqual({ status: "gap", reason: "unknown_sequence" });
    const exact = await readChatEventsAfterSequence({ transcriptPath: file, sessionId: SESSION, sinceSequence: 4 });
    expect(exact.status === "ok" && exact.events.map((event) => event.sequence)).toEqual([5, 6]);
  });
});

describe("readTurnAlignedTranscriptTail", () => {
  it("starts the window at the turn boundary and reports old unresolved approvals as pinned", async () => {
    const lines = [
      row(1, { type: "approval_request", itemId: "old-approval", kind: "command", description: "Run it" }),
      row(2, { type: "user_message", text: "Go" }),
      ...[3, 4, 5, 6, 7, 8].map((sequence) => text(sequence, 150)),
    ];
    fs.writeFileSync(file, lines.join(""));
    const tail = await readTurnAlignedTranscriptTail({ transcriptPath: file, sessionId: SESSION, maxBytes: 1_024 });
    expect(tail.events.map((event) => event.sequence)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(tail.pinnedEvents.map((event) => event.sequence)).toEqual([1]);
    expect(tail.tailStartOffset).toBe(Buffer.byteLength(lines[0]!));
    expect(tail.truncated).toBe(true);
  });
});
