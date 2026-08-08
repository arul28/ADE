import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPiSessions, piResumeCommandForSession } from "./discoverPi";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Pi external session discovery", () => {
  it("reads native JSONL messages and preserves a resumable id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-discovery-"));
    roots.push(root);
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const id = "019fd86d-f40d-76c6-a194-d5ba030cbad3";
    fs.writeFileSync(path.join(root, `2026-04-01T00-00-00-000Z_${id}.jsonl`), [
      JSON.stringify({ type: "session", id, cwd, timestamp: "2026-04-01T00:00:00.000Z" }),
      JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-04-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Inspect this repo" }] } }),
      JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-04-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "I will inspect it." }] } }),
      JSON.stringify({ type: "session_info", id: "i1", parentId: "a1", timestamp: "2026-04-01T00:00:03.000Z", name: "Repo inspection" }),
    ].join("\n") + "\n");

    const [session] = await discoverPiSessions({
      env: { PI_CODING_AGENT_SESSION_DIR: root },
      scopeRoots: [root],
      limit: 10,
    });
    expect(session).toMatchObject({
      provider: "pi",
      id,
      cwd,
      title: "Repo inspection",
      preview: "Inspect this repo",
      messageCount: 1,
      sourcePath: path.join(root, `2026-04-01T00-00-00-000Z_${id}.jsonl`),
    });
    expect(session?.messages?.map((message) => message.text)).toEqual(["Inspect this repo", "I will inspect it."]);
    const [exact] = await discoverPiSessions({
      env: { PI_CODING_AGENT_SESSION_DIR: root },
      scopeRoots: [root],
      sessionId: id,
    });
    expect(exact?.id).toBe(id);
    expect(piResumeCommandForSession(id)).toBe(`pi --session ${id}`);
  });

  it("uses header ids for exact lookup even when the session is older than the recent budget", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-discovery-exact-"));
    roots.push(root);
    const cwd = path.join(root, "repo");
    fs.mkdirSync(path.join(root, "nested", "sessions"), { recursive: true });
    const targetId = "019fd86d-f40d-76c6-a194-d5ba030cbad4";
    const recentId = "019fd86d-f40d-76c6-a194-d5ba030cbaaa";
    const target = path.join(root, "nested", "sessions", `2026-03-01T00-00-00-000Z_${targetId}.jsonl`);
    const recent = path.join(root, `2026-04-01T00-00-00-000Z_${recentId}.jsonl`);
    fs.writeFileSync(target, `${JSON.stringify({ type: "session", id: targetId, cwd, timestamp: "2026-03-01T00:00:00.000Z" })}\n`);
    fs.writeFileSync(recent, `${JSON.stringify({ type: "session", id: recentId, cwd, timestamp: "2026-04-01T00:00:00.000Z" })}\n`);

    const recentOnly = await discoverPiSessions({
      env: { PI_CODING_AGENT_SESSION_DIR: root },
      scopeRoots: [cwd],
      limit: 1,
    });
    expect(recentOnly.map((entry) => entry.id)).toEqual([recentId]);

    const exact = await discoverPiSessions({
      env: { PI_CODING_AGENT_SESSION_DIR: root },
      scopeRoots: [cwd],
      sessionId: targetId,
      limit: 1,
    });
    expect(exact[0]).toMatchObject({ id: targetId, sourcePath: target });
  });

  it("walks the full native session tree without following symlinked directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-discovery-deep-"));
    roots.push(root);
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const nested = Array.from({ length: 7 }, (_, index) => `level-${index}`)
      .reduce((current, segment) => path.join(current, segment), root);
    fs.mkdirSync(nested, { recursive: true });
    const id = "019fd86d-f40d-76c6-a194-d5ba030cbad5";
    fs.writeFileSync(
      path.join(nested, `2026-05-01T00-00-00-000Z_${id}.jsonl`),
      `${JSON.stringify({ type: "session", id, cwd, timestamp: "2026-05-01T00:00:00.000Z" })}\n`,
    );

    if (process.platform !== "win32") {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-discovery-outside-"));
      roots.push(outside);
      const outsideId = "019fd86d-f40d-76c6-a194-d5ba030cbad6";
      fs.writeFileSync(
        path.join(outside, `2026-05-02T00-00-00-000Z_${outsideId}.jsonl`),
        `${JSON.stringify({ type: "session", id: outsideId, cwd, timestamp: "2026-05-02T00:00:00.000Z" })}\n`,
      );
      fs.symlinkSync(outside, path.join(root, "linked-sessions"), "dir");
    }

    const sessions = await discoverPiSessions({
      env: { PI_CODING_AGENT_SESSION_DIR: root },
      scopeRoots: [cwd],
      limit: 10,
    });
    expect(sessions.map((session) => session.id)).toEqual([id]);
  });
});
