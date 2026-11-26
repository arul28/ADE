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
  it("gets a title or a setting changed after the last turn, with no new transcript text, before the computer sleeps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-uploader-"));
    dirs.push(root);
    const transcripts = path.join(root, "transcripts");
    fs.mkdirSync(transcripts);
    const sessionId = "chat-1";
    fs.writeFileSync(path.join(transcripts, `${sessionId}.jsonl`), `${JSON.stringify({ sessionId, timestamp: "2026-11-18T00:00:00.000Z", event: { type: "user_message", text: "hi" } })}\n`);

    let title = "";
    let settings: CloudSavedChatRowInput["settings"] = { reasoningEffort: "high" };
    const puts: Array<{ url: string; text: string; title: string | null; settings?: unknown }> = [];
    const uploader = createCloudChatUploader({
      env: { ADE_CLOUD_INSTANCE_ID: "inst1" },
      adeDir: path.join(root, ".ade"),
      chatTranscriptsDir: transcripts,
      directoryBaseUrl: () => "https://account.test",
      getAccessToken: async () => "token",
      getMachineKey: () => "machine1",
      readChatRow: async () => ({ title, laneId: "lane1", laneName: "lane", status: "idle", settings } as CloudSavedChatRowInput),
      flushTranscript: async () => {},
      redactSecrets: (text) => text,
      fetch: (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text: string; row: { title: string | null; settings?: unknown } };
        puts.push({ url, text: body.text, title: body.row.title, settings: body.row.settings });
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

    // A thinking level picked with nothing sent: no signal, found at the next rest save.
    settings = { reasoningEffort: "xhigh" };
    await uploader.uploadPending(5_000);
    expect(puts).toHaveLength(3);
    expect(puts[2]).toMatchObject({ text: "", settings: { reasoningEffort: "xhigh" } });
    expect(puts[2]!.url).toMatch(/\/parts\/3$/);
    // The same settings again send nothing; settings that went away are an unread summary, not a change.
    await uploader.uploadPending(5_000);
    settings = null;
    await uploader.uploadPending(5_000);
    expect(puts).toHaveLength(3);
    uploader.dispose();
  });

  it("sends a line written after the turn ended (a diff summary, a notice) before the computer rests, and counts it until it is sent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-uploader-"));
    dirs.push(root);
    const transcripts = path.join(root, "transcripts");
    fs.mkdirSync(transcripts);
    const sessionId = "chat-1";
    const file = path.join(transcripts, `${sessionId}.jsonl`);
    const line = (event: unknown) => `${JSON.stringify({ sessionId, timestamp: "2026-11-26T00:00:00.000Z", event })}\n`;
    fs.writeFileSync(file, line({ type: "user_message", text: "hi" }) + line({ type: "done", turnId: "t1", status: "completed" }));

    let failPuts = false;
    const sent: string[] = [];
    const uploader = createCloudChatUploader({
      env: { ADE_CLOUD_INSTANCE_ID: "inst1" },
      adeDir: path.join(root, ".ade"),
      chatTranscriptsDir: transcripts,
      directoryBaseUrl: () => "https://account.test",
      getAccessToken: async () => "token",
      getMachineKey: () => "machine1",
      readChatRow: async () => ({ title: "t", laneId: "lane1", laneName: "lane", status: "idle" } as CloudSavedChatRowInput),
      flushTranscript: async () => {},
      redactSecrets: (text) => text,
      fetch: (async (_url: string, init?: RequestInit) => {
        if (failPuts) return new Response("{}", { status: 503 });
        sent.push((JSON.parse(String(init?.body ?? "{}")) as { text: string }).text);
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    uploader.noteTurnEnded(sessionId, "completed");
    await uploader.uploadPending(5_000);
    expect(sent.join("")).toContain("user_message");

    // The diff summary lands after `done`; nothing marks the chat.
    fs.appendFileSync(file, line({ type: "turn_diff_summary", turnId: "t1", files: [{ path: "a.ts" }] }));
    failPuts = true;
    expect(await uploader.uploadPending(5_000)).toMatchObject({ remaining: 1, timedOut: false });

    failPuts = false;
    expect(await uploader.uploadPending(5_000)).toMatchObject({ uploaded: 1, remaining: 0 });
    expect(sent.join("")).toContain("turn_diff_summary");

    // Nothing new: nothing sent.
    const before = sent.length;
    expect(await uploader.uploadPending(5_000)).toMatchObject({ remaining: 0 });
    expect(sent).toHaveLength(before);
    uploader.dispose();
  });
});
