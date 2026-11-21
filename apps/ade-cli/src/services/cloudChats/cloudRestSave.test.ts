import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
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
  const setup = () => {
    const chat = { lastActivityAt: "2026-11-20T10:00:00.000Z" };
    let idle = true;
    let onPrepare = () => {};
    const prepareCloudRestCapsule = vi.fn(async (args: { sourceSessionId: string }) => {
      onPrepare();
      return {
        capsule: {
          version: 1,
          source: { provider: "claude", sessionId: args.sourceSessionId },
          forkTransport: { provider: "claude", kind: "claude-jsonl", nativeSessionId: "native-1", mainFile: { name: "native-1.jsonl", contentBase64Gzip: "aGk=", uncompressedBytes: 2 } },
          transcriptEnvelopes: { contentBase64Gzip: "aGk=", uncompressedBytes: 2, truncated: false },
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
    const saved = JSON.parse(gunzipSync(Buffer.from(rest.uploaded[0]!.bytes)).toString("utf8")) as { v: number; capsule: Record<string, unknown> };
    expect(saved.v).toBe(1);
    expect(saved.capsule.forkTransport).toMatchObject({ kind: "claude-jsonl", nativeSessionId: "native-1" });
    expect(saved.capsule.transcriptEnvelopes).toBeUndefined();

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
});
