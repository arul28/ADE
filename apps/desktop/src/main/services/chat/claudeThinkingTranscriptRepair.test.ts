import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isCorruptThinkingTranscriptError,
  repairClaudeTranscriptFileSync,
  repairClaudeTranscriptLines,
  resolveClaudeSdkTranscriptPath,
} from "./claudeThinkingTranscriptRepair";

// Deterministic id factory so assertions are stable.
const makeCounter = () => {
  let n = 0;
  return () => `msg_fixed_${(n += 1)}`;
};

const assistant = (id: string, uuid: string, block: Record<string, unknown>) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid: `p-${uuid}`,
    message: {
      id,
      role: "assistant",
      model: "claude-opus-4-8",
      stop_reason: "end_turn",
      content: [block],
    },
  });

const toolResult = (uuid: string, toolUseId: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    parentUuid: `p-${uuid}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
  });

const thinking = (sig: string) => ({ type: "thinking", thinking: "", signature: sig });
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });

const idOf = (line: string): string | null => JSON.parse(line).message?.id ?? null;
const firstBlock = (line: string) => JSON.parse(line).message.content[0];

describe("repairClaudeTranscriptLines", () => {
  // Mirrors the real corruption: one reused message id (msg_DUP) spans three
  // model responses separated by tool_result messages.
  const corruptLines = () => [
    JSON.stringify({ type: "user", uuid: "u0", message: { role: "user", content: [text("go")] } }),
    assistant("msg_DUP", "a1", thinking("SIG-A")), // response 1 begins
    assistant("msg_DUP", "a2", text("exploring")),
    assistant("msg_DUP", "a3", toolUse("toolu_1", "Bash")),
    toolResult("u1", "toolu_1"),
    assistant("msg_DUP", "a4", toolUse("toolu_2", "Grep")), // response 2 (reused id)
    toolResult("u2", "toolu_2"),
    assistant("msg_DUP", "a5", thinking("SIG-B")), // response 3 (reused id)
    assistant("msg_DUP", "a6", toolUse("toolu_3", "Read")),
    toolResult("u3", "toolu_3"),
  ];

  it("un-merges responses that share a reused message id", () => {
    const { changed, lines, result } = repairClaudeTranscriptLines(corruptLines(), makeCounter());

    expect(changed).toBe(true);
    expect(result.reusedMessageIds).toBe(1);
    expect(result.responsesRekeyed).toBe(2);

    // Response 1 (a1..a3) keeps the original id.
    expect(idOf(lines[1])).toBe("msg_DUP");
    expect(idOf(lines[2])).toBe("msg_DUP");
    expect(idOf(lines[3])).toBe("msg_DUP");

    // Response 2 (a4) and response 3 (a5,a6) each get a fresh, distinct id.
    const r2 = idOf(lines[5]);
    const r3a = idOf(lines[7]);
    const r3b = idOf(lines[8]);
    expect(r2).not.toBe("msg_DUP");
    expect(r3a).not.toBe("msg_DUP");
    expect(r2).not.toBe(r3a);
    // Both blocks of response 3 share the same new id (one message, not two).
    expect(r3a).toBe(r3b);
  });

  it("preserves thinking text, signatures, tool ids and uuids verbatim", () => {
    const { lines } = repairClaudeTranscriptLines(corruptLines(), makeCounter());

    // Signatures untouched (they are bound to thinking content, never the id).
    expect(firstBlock(lines[1]).signature).toBe("SIG-A");
    expect(firstBlock(lines[7]).signature).toBe("SIG-B");
    expect(firstBlock(lines[1]).type).toBe("thinking");

    // tool_use ids and the line-level uuid/parentUuid threading are unchanged.
    expect(firstBlock(lines[5]).id).toBe("toolu_2");
    expect(JSON.parse(lines[5]).uuid).toBe("a4");
    expect(JSON.parse(lines[5]).parentUuid).toBe("p-a4");
    // tool_result user lines are never modified.
    expect(lines[4]).toBe(corruptLines()[4]);
  });

  it("is idempotent — a repaired transcript reports no further change", () => {
    const once = repairClaudeTranscriptLines(corruptLines(), makeCounter());
    const twice = repairClaudeTranscriptLines(once.lines, makeCounter());
    expect(twice.changed).toBe(false);
    expect(twice.lines).toEqual(once.lines);
  });

  it("leaves a healthy transcript byte-for-byte unchanged", () => {
    const healthy = [
      JSON.stringify({ type: "user", uuid: "u0", message: { role: "user", content: [text("go")] } }),
      assistant("msg_1", "a1", thinking("SIG-A")),
      assistant("msg_1", "a2", toolUse("toolu_1", "Bash")),
      toolResult("u1", "toolu_1"),
      assistant("msg_2", "a3", thinking("SIG-B")),
      assistant("msg_2", "a4", toolUse("toolu_2", "Grep")),
      toolResult("u2", "toolu_2"),
    ];
    const { changed, lines, result } = repairClaudeTranscriptLines(healthy, makeCounter());
    expect(changed).toBe(false);
    expect(result.responsesRekeyed).toBe(0);
    expect(lines).toEqual(healthy);
  });

  it("ignores non-message metadata lines and blank lines", () => {
    const withMeta = [
      JSON.stringify({ type: "user", uuid: "u0", message: { role: "user", content: [text("go")] } }),
      assistant("msg_DUP", "a1", thinking("SIG-A")),
      JSON.stringify({ type: "attachment", uuid: "att1" }), // metadata between blocks
      assistant("msg_DUP", "a2", toolUse("toolu_1", "Bash")),
      "",
      toolResult("u1", "toolu_1"),
      assistant("msg_DUP", "a3", toolUse("toolu_2", "Grep")), // new response, reused id
      toolResult("u2", "toolu_2"),
    ];
    const { changed, lines } = repairClaudeTranscriptLines(withMeta, makeCounter());
    expect(changed).toBe(true);
    // The attachment line did not start a new response: a1 and a2 stay merged.
    expect(idOf(lines[1])).toBe("msg_DUP");
    expect(idOf(lines[3])).toBe("msg_DUP");
    expect(lines[2]).toBe(withMeta[2]); // metadata untouched
    // a3 is a genuinely separate response → rekeyed.
    expect(idOf(lines[6])).not.toBe("msg_DUP");
  });
});

describe("repairClaudeTranscriptFileSync", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-repair-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rewrites a corrupted file, keeps a backup, and no-ops on rerun", () => {
    const file = path.join(dir, "session.jsonl");
    const corrupt = [
      JSON.stringify({ type: "user", uuid: "u0", message: { role: "user", content: [{ type: "text", text: "go" }] } }),
      assistant("msg_DUP", "a1", thinking("SIG-A")),
      toolResult("u1", "toolu_1"),
      assistant("msg_DUP", "a2", toolUse("toolu_1", "Bash")),
      "",
    ].join("\n");
    fs.writeFileSync(file, corrupt, "utf8");

    const result = repairClaudeTranscriptFileSync(file, makeCounter());
    expect(result.repaired).toBe(true);
    expect(fs.existsSync(`${file}.corrupt.bak`)).toBe(true);
    expect(fs.readFileSync(`${file}.corrupt.bak`, "utf8")).toBe(corrupt);

    const repaired = fs.readFileSync(file, "utf8");
    expect(repaired.endsWith("\n")).toBe(true); // trailing newline preserved
    const lines = repaired.split("\n");
    expect(idOf(lines[3])).not.toBe("msg_DUP");

    // Re-running does nothing and does not throw.
    const second = repairClaudeTranscriptFileSync(file, makeCounter());
    expect(second.repaired).toBe(false);
  });

  it("returns a no-op result for a missing file", () => {
    const result = repairClaudeTranscriptFileSync(path.join(dir, "nope.jsonl"));
    expect(result.repaired).toBe(false);
  });
});

describe("resolveClaudeSdkTranscriptPath", () => {
  it("rejects malformed session ids that could escape the projects dir", () => {
    expect(resolveClaudeSdkTranscriptPath("../../etc/passwd", "/tmp/cwd")).toBeNull();
    expect(resolveClaudeSdkTranscriptPath("a/b", "/tmp/cwd")).toBeNull();
    expect(resolveClaudeSdkTranscriptPath("", "/tmp/cwd")).toBeNull();
    expect(resolveClaudeSdkTranscriptPath(null, "/tmp/cwd")).toBeNull();
  });

  it("accepts a UUID-like id but returns null when no transcript exists", () => {
    // Valid id shape, but the file won't exist under a random cwd → null (no throw).
    expect(
      resolveClaudeSdkTranscriptPath("3d17aa71-f011-4880-9665-5c577a638886", "/nonexistent/cwd/xyz"),
    ).toBeNull();
  });
});

describe("isCorruptThinkingTranscriptError", () => {
  it("matches the Anthropic 400 for modified thinking blocks", () => {
    expect(
      isCorruptThinkingTranscriptError(
        new Error(
          "API Error: 400 messages.1.content.12: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
        ),
      ),
    ).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isCorruptThinkingTranscriptError(new Error("429 rate limited"))).toBe(false);
    expect(isCorruptThinkingTranscriptError(new Error("session not found"))).toBe(false);
    expect(isCorruptThinkingTranscriptError(null)).toBe(false);
  });
});
