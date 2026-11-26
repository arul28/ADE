import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { CLOUD_CAPSULE_MAX_BYTES, CLOUD_CAPSULE_MAX_PART_BYTES } from "../../../../account-directory/src/cloud/contract";
import type { CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import type { AdeRuntime } from "../../bootstrap";
import type { CloudChatUploadPendingResult } from "./cloudChatUploader";
import { createCloudRestSave, splitCapsule } from "./cloudRestSave";

describe("splitCapsule", () => {
  const bytes = (length: number) => Uint8Array.from({ length }, (_, index) => index % 251);

  it.each([
    ["one byte", 1, 1],
    ["exactly one part", CLOUD_CAPSULE_MAX_PART_BYTES, 1],
    ["one byte over a part", CLOUD_CAPSULE_MAX_PART_BYTES + 1, 2],
    ["exactly the capsule cap", CLOUD_CAPSULE_MAX_BYTES, Math.ceil(CLOUD_CAPSULE_MAX_BYTES / CLOUD_CAPSULE_MAX_PART_BYTES)],
  ])("splits %s into parts the server takes, in order, with nothing lost", (_label, length, partCount) => {
    const input = bytes(length);
    const parts = splitCapsule(input)!;
    expect(parts).toHaveLength(partCount);
    for (const part of parts) {
      expect(part.byteLength).toBeGreaterThan(0);
      expect(part.byteLength).toBeLessThanOrEqual(CLOUD_CAPSULE_MAX_PART_BYTES);
    }
    expect(Buffer.concat(parts.map((part) => Buffer.from(part))).equals(Buffer.from(input))).toBe(true);
  });

  it.each([
    ["an empty capsule", 0],
    ["a capsule over the cap", CLOUD_CAPSULE_MAX_BYTES + 1],
  ])("saves no parts for %s (the restore replays the transcript)", (_label, length) => {
    expect(splitCapsule(bytes(length))).toBeNull();
  });
});

describe("createCloudRestSave capsules", () => {
  /** One Claude chat on an open project; the account server keeps what it is sent. */
  const setup = (forkTransport: Record<string, unknown> = { provider: "claude", kind: "claude-jsonl", nativeSessionId: "native-1", mainFile: { name: "native-1.jsonl", contentBase64Gzip: gzipSync("hi").toString("base64"), uncompressedBytes: 2 } }) => {
    const chat = { lastActivityAt: "2026-11-20T10:00:00.000Z" };
    let idle = true;
    let onPrepare = () => {};
    let hang = false;
    // ADE's transcript as the capsule copies it: its newest turn ended at 10:00, event 3.
    const transcript = gzipSync(Buffer.from([
      { sessionId: "chat-1", timestamp: "2026-11-20T09:59:00.000Z", sequence: 2, event: { type: "user_message", text: "Fix it." } },
      { sessionId: "chat-1", timestamp: "2026-11-20T10:00:00.000Z", sequence: 3, event: { type: "done", status: "completed" } },
      { sessionId: "chat-1", timestamp: "2026-11-20T10:00:01.000Z", sequence: 4, event: { type: "status", text: "idle" } },
    ].map((line) => JSON.stringify(line)).join("\n"))).toString("base64");
    const prepareCloudRestCapsule = vi.fn(async (args: { sourceSessionId: string }) => {
      onPrepare();
      // A preparation that never ends: the save's own end comes first.
      if (hang) {
        setImmediate(() => vi.advanceTimersByTime(60_000));
        return await new Promise<never>(() => {});
      }
      return {
        capsule: {
          version: 1,
          source: { provider: "claude", sessionId: args.sourceSessionId },
          forkTransport,
          transcriptEnvelopes: { contentBase64Gzip: transcript, uncompressedBytes: 2, truncated: false },
        },
      };
    });
    const runtime = {
      projectId: "project-1",
      projectRoot: "/nowhere",
      sessionService: {
        list: () => [{ id: "chat-1", toolType: "claude-chat", laneId: "lane-1", tracked: true, transcriptPath: null, status: "completed", startedAt: chat.lastActivityAt, lastActivityAt: chat.lastActivityAt }],
      },
      laneService: { list: async () => [] },
      agentChatService: {
        getSessionSummary: async () => ({ provider: "claude", model: "claude-sonnet-5", modelId: "anthropic/claude-sonnet-5", surface: "work", lastActivityAt: chat.lastActivityAt }),
        prepareCloudRestCapsule,
      },
    } as unknown as AdeRuntime;
    const uploaded: Array<{ part: number; bytes: Uint8Array }> = [];
    const commits: Array<Record<string, unknown>> = [];
    const api = {
      putCapsulePart: vi.fn(async (_machine: string, _chat: string, part: number, _instance: string, bytes: Uint8Array) => {
        uploaded.push({ part, bytes });
        return { ok: true, bytes: bytes.byteLength, uploadId: "0".repeat(32) };
      }),
      commitCapsule: vi.fn(async (_machine: string, _chat: string, body: Record<string, unknown>) => {
        commits.push(body);
        return {};
      }),
      putEventWakes: async () => null,
    } as unknown as CloudApiClient;
    const saver = createCloudRestSave({
      adeHome: fs.mkdtempSync(path.join(os.tmpdir(), "ade-rest-save-")),
      instanceId: "instance-1",
      logger: { info: () => {}, warn: () => {} },
      api: async () => api,
      machineKey: () => "machine-1",
      openRuntimes: async () => [{ projectId: "project-1", runtime }],
      flushChats: async () => ({}) as CloudChatUploadPendingResult,
      accountUserId: () => null,
    });
    const idleSave = () => saver.save({ budgetMs: 60_000, reason: "idle", stillIdle: () => idle });
    return {
      chat,
      hangPrepare: (next: boolean) => {
        hang = next;
      },
      uploaded,
      commits,
      prepareCloudRestCapsule,
      idleSave,
      useComputerWhilePacking: () => {
        onPrepare = () => {
          idle = false;
        };
      },
      leaveIdle: () => {
        onPrepare = () => {};
        idle = true;
      },
    };
  };

  it("the idle step saves a changed chat's history once, and again only after the chat changes", async () => {
    const rest = setup();
    expect((await rest.idleSave()).capsules).toBe(1);
    expect(rest.commits).toEqual([expect.objectContaining({ provider: "claude", transportKind: "claude-jsonl", sessionKind: "chat", laneId: "lane-1", parts: 1 })]);
    // What the restore reads: the provider's history, without the capsule's own transcript copy.
    const saved = JSON.parse(gunzipSync(Buffer.from(rest.uploaded[0]!.bytes)).toString("utf8")) as { v: number; capsule: Record<string, unknown>; transcriptEnd: unknown };
    expect(saved.v).toBe(1);
    expect(saved.capsule.forkTransport).toMatchObject({ kind: "claude-jsonl", nativeSessionId: "native-1" });
    expect(saved.capsule.transcriptEnvelopes).toBeUndefined();
    // Where the chat stood: its newest turn, so a restore can tell the capsule is older than the chat.
    expect(saved.transcriptEnd).toEqual({ at: "2026-11-20T10:00:00.000Z", sequence: 3 });

    expect((await rest.idleSave()).capsules).toBe(0);
    expect(rest.prepareCloudRestCapsule).toHaveBeenCalledTimes(1);

    rest.chat.lastActivityAt = "2026-11-20T11:00:00.000Z";
    expect((await rest.idleSave()).capsules).toBe(1);
    expect(rest.commits).toHaveLength(2);
  });

  it("sends no part once the computer is in use, so the capsule saved before stays whole, and sends it at the next save", async () => {
    const rest = setup();
    rest.useComputerWhilePacking();
    expect((await rest.idleSave()).capsules).toBe(0);
    expect(rest.uploaded).toHaveLength(0);

    rest.leaveIdle();
    expect((await rest.idleSave()).capsules).toBe(1);
    expect(rest.uploaded.map((entry) => entry.part)).toEqual([1]);
  });

  it("waits for a capsule no longer than the save's own time, and tries it again at the next save", async () => {
    const rest = setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      rest.hangPrepare(true);
      expect(await rest.idleSave()).toMatchObject({ capsules: 0, skipped: 1 });
      expect(rest.uploaded).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }

    rest.hangPrepare(false);
    expect((await rest.idleSave()).capsules).toBe(1);
    expect(rest.prepareCloudRestCapsule).toHaveBeenCalledTimes(2);
  });

  it("sends the provider's history redacted: a key in a tool result is gone, and every line still parses for the resume", async () => {
    const key = "sk-ant-api03-" + "a".repeat(40);
    const signature = "Ab+/".repeat(100);
    const pack = (text: string) => ({ contentBase64Gzip: gzipSync(Buffer.from(text, "utf8")).toString("base64"), uncompressedBytes: Buffer.byteLength(text, "utf8") });
    const main = [
      { type: "assistant", uuid: "u1", message: { content: [{ type: "thinking", thinking: "Use the key.", signature }] } },
      { type: "user", uuid: "u2", parentUuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: `ANTHROPIC_API_KEY=${key}` }] }, toolUseResult: { stdout: `export TOKEN=${key}`, token: "plain-value" } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const rest = setup({
      provider: "claude",
      kind: "claude-jsonl",
      nativeSessionId: "native-1",
      mainFile: { name: "native-1.jsonl", ...pack(main) },
      sideFiles: [
        { relPath: "native-1/subagents/agent-1.jsonl", ...pack(`${JSON.stringify({ type: "user", message: { content: `key ${key}` } })}\n`) },
        { relPath: "native-1/tool-results/t1.txt", ...pack(`line one\nkey=${key}\n`) },
      ],
    });
    expect((await rest.idleSave()).capsules).toBe(1);
    const saved = JSON.parse(gunzipSync(Buffer.from(rest.uploaded[0]!.bytes)).toString("utf8")) as {
      capsule: { forkTransport: { mainFile: { contentBase64Gzip: string; uncompressedBytes: number }; sideFiles: Array<{ relPath: string; contentBase64Gzip: string; uncompressedBytes: number }> } };
    };
    const unpack = (file: { contentBase64Gzip: string; uncompressedBytes: number }) => {
      const text = gunzipSync(Buffer.from(file.contentBase64Gzip, "base64")).toString("utf8");
      // The restore refuses a file whose size does not match.
      expect(Buffer.byteLength(text, "utf8")).toBe(file.uncompressedBytes);
      return text;
    };
    const { forkTransport } = saved.capsule;
    const all = [forkTransport.mainFile, ...forkTransport.sideFiles].map(unpack).join("\n");
    expect(all).not.toContain(key);
    expect(all).not.toContain("plain-value");

    const lines = unpack(forkTransport.mainFile).trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    expect(lines).toHaveLength(2);
    // What the resume reads back as it is: ids and the thinking signature.
    expect(lines[0]!.message.content[0].signature).toBe(signature);
    expect(lines[1]).toMatchObject({ uuid: "u2", parentUuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } });
    expect(forkTransport.sideFiles.map((file) => file.relPath)).toEqual(["native-1/subagents/agent-1.jsonl", "native-1/tool-results/t1.txt"]);
    expect(unpack(forkTransport.sideFiles[1]!)).toContain("line one");
  });
});
