import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CloudSavedChatRowInput } from "../../../../desktop/src/shared/cloudSavedChats";
import { createCloudChatUploader } from "./cloudChatUploader";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the saved copy of a cloud chat", () => {
  it("gets a title set after the last turn, with no new transcript text, before the computer sleeps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-uploader-"));
    dirs.push(root);
    const transcripts = path.join(root, "transcripts");
    fs.mkdirSync(transcripts);
    const sessionId = "chat-1";
    fs.writeFileSync(path.join(transcripts, `${sessionId}.jsonl`), `${JSON.stringify({ sessionId, timestamp: "2026-11-18T00:00:00.000Z", event: { type: "user_message", text: "hi" } })}\n`);

    let title = "";
    const puts: Array<{ url: string; text: string; title: string | null }> = [];
    const uploader = createCloudChatUploader({
      env: { ADE_CLOUD_INSTANCE_ID: "inst1" },
      adeDir: path.join(root, ".ade"),
      chatTranscriptsDir: transcripts,
      directoryBaseUrl: () => "https://account.test",
      getAccessToken: async () => "token",
      getMachineKey: () => "machine1",
      readChatRow: async () => ({ title, laneId: "lane1", laneName: "lane", status: "idle" } as CloudSavedChatRowInput),
      flushTranscript: async () => {},
      redactSecrets: (text) => text,
      fetch: (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text: string; row: { title: string | null } };
        puts.push({ url, text: body.text, title: body.row.title });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });

    uploader.noteTurnEnded(sessionId, "completed");
    await uploader.uploadPending(5_000);
    expect(puts.map((put) => put.title)).toEqual([""]);

    // The name arrives after the turn ended; the transcript does not grow.
    title = "Ready Reply Check";
    uploader.noteRowChanged(sessionId);
    await uploader.uploadPending(5_000);

    expect(puts).toHaveLength(2);
    expect(puts[1]).toMatchObject({ text: "", title: "Ready Reply Check" });
    expect(puts[1]!.url).toMatch(/\/parts\/2$/);
    uploader.dispose();
  });
});
