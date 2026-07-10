import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  repairSplicedEnvelopeFileSync,
  repairSplicedEnvelopeLines,
} from "./chatEnvelopeSpliceRepair";

const textEnvelope = (
  text: string,
  messageId: string,
  options: { turnId?: string; sequence?: number; sessionId?: string } = {},
) => JSON.stringify({
  sessionId: options.sessionId ?? "chat-1",
  timestamp: "2026-07-10T12:00:00.000Z",
  sequence: options.sequence ?? 1,
  event: {
    type: "text",
    text,
    messageId,
    turnId: options.turnId ?? "turn-1",
  },
});

const eventEnvelope = (event: Record<string, unknown>, sequence: number) => JSON.stringify({
  sessionId: "chat-1",
  timestamp: "2026-07-10T12:00:00.000Z",
  sequence,
  event,
});

const assistantMessage = (id: string, text: string): SessionMessage => ({
  type: "assistant",
  uuid: `wire-${id}`,
  session_id: "sdk-1",
  parent_tool_use_id: null,
  message: { id, role: "assistant", content: [{ type: "text", text }] },
} as SessionMessage);

const splicedRun = (turnId = "turn-1", sequenceStart = 1) => [
  textEnvelope("Hello", "wire-1", { turnId, sequence: sequenceStart }),
  textEnvelope(" ", "wire-2", { turnId, sequence: sequenceStart + 1 }),
  textEnvelope("from", "wire-3", { turnId, sequence: sequenceStart + 2 }),
  textEnvelope(" the", "wire-4", { turnId, sequence: sequenceStart + 3 }),
  textEnvelope(" SDK", "wire-5", { turnId, sequence: sequenceStart + 4 }),
];

describe("repairSplicedEnvelopeLines", () => {
  it("rebuilds five distinct fragments as one SDK-backed message", () => {
    const input = splicedRun();
    const result = repairSplicedEnvelopeLines(input, [assistantMessage("msg-stable", "Hello from the SDK")]);

    expect(result.changed).toBe(true);
    expect(result.repairedTurns).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(JSON.parse(result.lines[0]!)).toMatchObject({
      sequence: 1,
      event: { type: "text", text: "Hello from the SDK", messageId: "msg-stable", turnId: "turn-1" },
    });
  });

  it("leaves healthy fragments sharing one message id byte-identical", () => {
    const input = [
      textEnvelope("one", "msg-stable", { sequence: 1 }),
      textEnvelope("two", "msg-stable", { sequence: 2 }),
      textEnvelope("three", "msg-stable", { sequence: 3 }),
    ];
    expect(repairSplicedEnvelopeLines(input, [])).toEqual({
      lines: input,
      changed: false,
      repairedTurns: 0,
    });
  });

  it("does not join separate assistant messages across a tool call", () => {
    const tool = eventEnvelope({ type: "tool_call", tool: "Read", args: {}, itemId: "tool-1", turnId: "turn-1" }, 2);
    const input = [
      textEnvelope("first", "msg-1", { sequence: 1 }),
      tool,
      textEnvelope("second", "msg-2", { sequence: 3 }),
    ];
    expect(repairSplicedEnvelopeLines(input, [])).toEqual({
      lines: input,
      changed: false,
      repairedTurns: 0,
    });
  });

  it("leaves a two-fragment run below the detector threshold untouched", () => {
    const input = [
      textEnvelope("one", "wire-1", { sequence: 1 }),
      textEnvelope("two", "wire-2", { sequence: 2 }),
    ];
    expect(repairSplicedEnvelopeLines(input, [])).toEqual({
      lines: input,
      changed: false,
      repairedTurns: 0,
    });
  });

  it("preserves ADE-only and unparseable lines byte-identically around repaired runs", () => {
    const before = eventEnvelope({ type: "approval_request", itemId: "approval-1", kind: "tool_call", description: "Allow?" }, 1);
    const between = eventEnvelope({ type: "scheduled_work_update", id: "schedule-1", kind: "wakeup", status: "scheduled", origin: "schedule_wakeup", title: "Later" }, 8);
    const unknown = "{ definitely-not-json";
    const input = [
      before,
      ...splicedRun("turn-1", 2),
      between,
      unknown,
      ...splicedRun("turn-2", 9),
    ];
    const result = repairSplicedEnvelopeLines(input, []);

    expect(result.changed).toBe(true);
    expect(result.repairedTurns).toBe(2);
    expect(result.lines).toContain(before);
    expect(result.lines).toContain(between);
    expect(result.lines).toContain(unknown);
    expect(result.lines.indexOf(before)).toBeLessThan(result.lines.indexOf(between));
    expect(result.lines.indexOf(between)).toBeLessThan(result.lines.indexOf(unknown));
  });

  it("uses SDK stable ids and full text for each matched assistant message", () => {
    const input = [
      textEnvelope("Alpha", "wire-1", { sequence: 11 }),
      textEnvelope("Beta", "wire-2", { sequence: 12 }),
      textEnvelope("Gamma", "wire-3", { sequence: 13 }),
    ];
    const result = repairSplicedEnvelopeLines(input, [
      assistantMessage("msg-a", "AlphaBeta"),
      assistantMessage("msg-b", "Gamma"),
    ]);

    expect(result.lines.map((line) => JSON.parse(line).event)).toEqual([
      expect.objectContaining({ text: "AlphaBeta", messageId: "msg-a" }),
      expect.objectContaining({ text: "Gamma", messageId: "msg-b" }),
    ]);
    expect(result.lines.map((line) => JSON.parse(line).sequence)).toEqual([11, 12]);
  });

  it("rebuilds three SDK assistant messages without breaking idempotency", () => {
    const input = [
      textEnvelope("Alpha", "wire-1", { sequence: 21 }),
      textEnvelope("Beta", "wire-2", { sequence: 22 }),
      textEnvelope("Gamma", "wire-3", { sequence: 23 }),
    ];
    const sdkMessages = [
      assistantMessage("msg-a", "Alpha"),
      assistantMessage("msg-b", "Beta"),
      assistantMessage("msg-c", "Gamma"),
    ];
    const once = repairSplicedEnvelopeLines(input, sdkMessages);
    const twice = repairSplicedEnvelopeLines(once.lines, sdkMessages);

    expect(once.lines.map((line) => JSON.parse(line).event.messageId)).toEqual(["msg-a", "msg-b", "msg-c"]);
    expect(twice).toEqual({ lines: once.lines, changed: false, repairedTurns: 0 });
  });

  it("falls back to a local merge when SDK text extends beyond the run", () => {
    // The SDK message is a superset ("Hello from the SDK, and more") of the
    // run's text. Rebuilding from it would splice content the ADE transcript
    // never showed into history — the repair must keep the exact ADE text.
    const input = splicedRun();
    const result = repairSplicedEnvelopeLines(input, [assistantMessage("msg-super", "Hello from the SDK, and more")]);
    expect(result.lines).toHaveLength(1);
    expect(JSON.parse(result.lines[0]!).event).toMatchObject({
      text: "Hello from the SDK",
      messageId: "wire-1",
    });
  });

  it("falls back to a local merge when SDK messages cover only a prefix of the run", () => {
    // The SDK transcript is missing the run's tail (" the SDK"). A rebuild from
    // the partial SDK match would silently drop that tail — the repair must
    // prefer the lossless local merge instead.
    const input = splicedRun();
    const result = repairSplicedEnvelopeLines(input, [assistantMessage("msg-prefix", "Hello from")]);
    expect(result.lines).toHaveLength(1);
    expect(JSON.parse(result.lines[0]!).event).toMatchObject({
      text: "Hello from the SDK",
      messageId: "wire-1",
    });
  });

  it("falls back to a local merge when SDK text does not overlap", () => {
    const input = splicedRun();
    const result = repairSplicedEnvelopeLines(input, [assistantMessage("msg-other", "Unrelated")]);
    expect(result.lines).toHaveLength(1);
    expect(JSON.parse(result.lines[0]!).event).toMatchObject({
      text: "Hello from the SDK",
      messageId: "wire-1",
    });
  });

  it("is idempotent and byte-identical on the second pass", () => {
    const once = repairSplicedEnvelopeLines(splicedRun(), [assistantMessage("msg-stable", "Hello from the SDK")]);
    const twice = repairSplicedEnvelopeLines(once.lines, [assistantMessage("msg-stable", "Hello from the SDK")]);
    expect(twice.changed).toBe(false);
    expect(twice.repairedTurns).toBe(0);
    expect(twice.lines).toEqual(once.lines);
  });
});

describe("repairSplicedEnvelopeFileSync", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-envelope-splice-"));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("atomically rewrites and keeps the original one-time backup", () => {
    const filePath = path.join(directory, "chat.jsonl");
    const original = `${splicedRun().join("\n")}\n`;
    fs.writeFileSync(filePath, original, "utf8");

    expect(repairSplicedEnvelopeFileSync(filePath, [assistantMessage("msg-stable", "Hello from the SDK")]))
      .toEqual({ changed: true, repairedTurns: 1 });
    expect(fs.readFileSync(`${filePath}.splice.bak`, "utf8")).toBe(original);
    expect(fs.readFileSync(filePath, "utf8").endsWith("\n")).toBe(true);
    expect(fs.readdirSync(directory).some((name) => name.includes(".tmp"))).toBe(false);

    const firstBackup = fs.readFileSync(`${filePath}.splice.bak`, "utf8");
    fs.writeFileSync(filePath, original.replaceAll("wire-", "again-"), "utf8");
    expect(repairSplicedEnvelopeFileSync(filePath, [])).toEqual({ changed: true, repairedTurns: 1 });
    expect(fs.readFileSync(`${filePath}.splice.bak`, "utf8")).toBe(firstBackup);
  });

  it("skips a file larger than 64 MB", () => {
    const filePath = path.join(directory, "oversize.jsonl");
    fs.writeFileSync(filePath, "", "utf8");
    fs.truncateSync(filePath, 64 * 1024 * 1024 + 1);
    const skips: string[] = [];
    expect(repairSplicedEnvelopeFileSync(filePath, [], { onSkip: (reason) => skips.push(reason) }))
      .toEqual({ changed: false, repairedTurns: 0 });
    expect(skips).toEqual(["oversize"]);
    expect(fs.existsSync(`${filePath}.splice.bak`)).toBe(false);
  });

  it("returns a no-op for a missing file", () => {
    expect(repairSplicedEnvelopeFileSync(path.join(directory, "missing.jsonl"), []))
      .toEqual({ changed: false, repairedTurns: 0 });
  });
});
