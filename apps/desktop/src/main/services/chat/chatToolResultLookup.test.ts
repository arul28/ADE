import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types/chat";
import { chatToolResultRowId, findStoredToolResult } from "./chatToolResultLookup";

const SESSION_ID = "session-tool-result";

let tmpRoot = "";
let transcriptPath = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tool-result-lookup-"));
  transcriptPath = path.join(tmpRoot, `${SESSION_ID}.chat.jsonl`);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function write(events: AgentChatEvent[], sessionId = SESSION_ID): void {
  const lines = events.map((event, index) => {
    const envelope: AgentChatEventEnvelope = {
      sessionId,
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
      sequence: index + 1,
      event,
    };
    return JSON.stringify(envelope);
  });
  fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8");
}

const toolResult = (itemId: string, result: unknown, extra: Partial<AgentChatEvent> = {}): AgentChatEvent => ({
  type: "tool_result",
  tool: "Bash",
  result,
  itemId,
  status: "completed",
  ...extra,
} as AgentChatEvent);

describe("chatToolResultRowId", () => {
  it("prefers logicalItemId, the id tool_call/tool_result pairs are correlated on", () => {
    expect(chatToolResultRowId(toolResult("item-1", "x", { logicalItemId: "logical-1" }))).toBe("logical-1");
    expect(chatToolResultRowId(toolResult("item-1", "x"))).toBe("item-1");
    expect(chatToolResultRowId({ type: "text", text: "hi" })).toBeNull();
  });
});

describe("findStoredToolResult", () => {
  it("answers the exact generation when the row names its sequence", async () => {
    // Regression: a retry reuses the logical item id, so the backward scan
    // returned the NEWEST result for every row and an older retry row showed
    // the newer attempt's output as its own.
    write([
      toolResult("item-1", "old"),
      { type: "text", text: "retrying" },
      toolResult("item-1", "new"),
    ]);

    const older = await findStoredToolResult({
      transcriptPath,
      sessionId: SESSION_ID,
      itemId: "item-1",
      resultSequence: 1,
    });
    expect(older?.event.result).toBe("old");
    expect(older?.envelope.sequence).toBe(1);

    const newer = await findStoredToolResult({
      transcriptPath,
      sessionId: SESSION_ID,
      itemId: "item-1",
      resultSequence: 3,
    });
    expect(newer?.event.result).toBe("new");

    // A generation that is not there is "not found", never the nearest other
    // attempt's output.
    expect(await findStoredToolResult({
      transcriptPath,
      sessionId: SESSION_ID,
      itemId: "item-1",
      resultSequence: 99,
    })).toBeNull();

    // A client that omits the sequence keeps the newest-match behaviour.
    const legacy = await findStoredToolResult({ transcriptPath, sessionId: SESSION_ID, itemId: "item-1" });
    expect(legacy?.event.result).toBe("new");
  });

  it("returns the stored result for the requested row", async () => {
    write([
      toolResult("item-1", "first"),
      { type: "text", text: "between" },
      toolResult("item-2", { rows: [1, 2, 3] }),
    ]);
    const hit = await findStoredToolResult({ transcriptPath, sessionId: SESSION_ID, itemId: "item-2" });
    expect(hit?.event.result).toEqual({ rows: [1, 2, 3] });
  });

  it("matches on logicalItemId when the event carries one", async () => {
    write([toolResult("item-1", "payload", { logicalItemId: "logical-9" })]);
    expect((await findStoredToolResult({ transcriptPath, sessionId: SESSION_ID, itemId: "logical-9" }))?.event.result)
      .toBe("payload");
    // The raw itemId is not the row id once a logical one exists, so a client
    // that sent the wrong one gets a miss rather than a stale payload.
    expect(await findStoredToolResult({ transcriptPath, sessionId: SESSION_ID, itemId: "item-1" })).toBeNull();
  });

  it("returns the newest result when an id repeats after a retry", async () => {
    write([toolResult("item-1", "old"), { type: "text", text: "retry" }, toolResult("item-1", "new")]);
    expect((await findStoredToolResult({ transcriptPath, sessionId: SESSION_ID, itemId: "item-1" }))?.event.result)
      .toBe("new");
  });

  it("finds a result that sits far behind the tail", async () => {
    const filler: AgentChatEvent[] = Array.from({ length: 4_000 }, (_, index) => ({
      type: "text",
      text: `${index}`.padEnd(200, "x"),
    } as AgentChatEvent));
    write([toolResult("item-deep", "deep payload"), ...filler]);
    expect((await findStoredToolResult({ transcriptPath, sessionId: SESSION_ID, itemId: "item-deep" }))?.event.result)
      .toBe("deep payload");
  });

  it("misses cleanly for an unknown id and an empty id", async () => {
    write([toolResult("item-1", "x")]);
    expect(await findStoredToolResult({ transcriptPath, sessionId: SESSION_ID, itemId: "nope" })).toBeNull();
    expect(await findStoredToolResult({ transcriptPath, sessionId: SESSION_ID, itemId: "  " })).toBeNull();
  });

  it("throws on a filesystem error rather than reporting the result as gone", async () => {
    // "I could not read" and "it is not there" are different answers on the
    // phone: the first is retryable, the second is final. The caller turns
    // this into `unavailable`, not `found: false`.
    await expect(findStoredToolResult({
      transcriptPath: path.join(tmpRoot, "missing.jsonl"),
      sessionId: SESSION_ID,
      itemId: "item-1",
    })).rejects.toThrow();
  });

  it("never reads another session's rows out of a shared transcript", async () => {
    write([toolResult("item-1", "mine")], "other-session");
    expect(await findStoredToolResult({ transcriptPath, sessionId: SESSION_ID, itemId: "item-1" })).toBeNull();
  });
});
