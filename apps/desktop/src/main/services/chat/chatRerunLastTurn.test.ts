import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import {
  findLastTurnUserMessage,
  transcriptHoldsSequenceSync,
  truncateTranscriptFromSequenceSync,
} from "./chatRerunLastTurn";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function transcriptFile(contents: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-rerun-"));
  tempDirs.push(dir);
  const file = path.join(dir, "history.jsonl");
  fs.writeFileSync(file, contents);
  return { dir, file };
}

function envelope(sequence: number, event: Record<string, unknown>): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp: "2026-09-29T00:00:00.000Z",
    sequence,
    event,
  } as unknown as AgentChatEventEnvelope;
}

describe("chat rerun history", () => {
  it("treats a provider-started turn as delivered even when it later fails", () => {
    const last = findLastTurnUserMessage([
      envelope(4, { type: "user_message", text: "Try the operation again." }),
      envelope(5, { type: "status", turnStatus: "started", turnId: "provider-turn" }),
      envelope(6, { type: "error", message: "The provider rejected the turn." }),
      envelope(7, { type: "done", status: "failed", turnId: "provider-turn" }),
    ]);

    expect(last?.delivered).toBe(true);
    expect(last?.turnId).toBe("provider-turn");
    expect(last?.envelope.sequence).toBe(4);
  });

  it("cuts a transcript line spanning the reverse-read chunk boundary", () => {
    const previous = `${JSON.stringify({ sequence: 1, event: "kept" })}\n`;
    const target = `${JSON.stringify({ sequence: 2, payload: "x".repeat(300_000) })}\n`;
    const later = JSON.stringify({ sequence: 3, event: "also removed" });
    const { file } = transcriptFile(previous + target + later);
    const bytesToRemove = Buffer.byteLength(target + later);

    expect(transcriptHoldsSequenceSync(file, 2)).toBe(true);
    expect(truncateTranscriptFromSequenceSync(file, 2)).toBe(bytesToRemove);
    expect(fs.readFileSync(file, "utf8")).toBe(previous);
  });

  it.each([
    [
      "a final line without a newline",
      `${JSON.stringify({ sequence: 1 })}\n${JSON.stringify({ sequence: 2 })}`,
      Buffer.byteLength(JSON.stringify({ sequence: 2 })),
      `${JSON.stringify({ sequence: 1 })}\n`,
    ],
    ["missing the target sequence", `${JSON.stringify({ sequence: 1 })}\n`, null, `${JSON.stringify({ sequence: 1 })}\n`],
  ])("handles history with %s", (_caseName, contents, bytesRemoved, expectedContents) => {
    const { file } = transcriptFile(contents);

    expect(truncateTranscriptFromSequenceSync(file, 2)).toBe(bytesRemoved);
    expect(fs.readFileSync(file, "utf8")).toBe(expectedContents);
    expect(transcriptHoldsSequenceSync(file, 2)).toBe(false);
  });
});
