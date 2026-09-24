import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCopilotSessions, parseFlatYaml } from "./discoverCopilot";
import { discoverGrokSessions } from "./discoverGrok";
import { discoverKimiSessions } from "./discoverKimi";
import { discoverQwenSessions, qwenProjectSlugForCwd } from "./discoverQwen";

// Fixtures mirror the real on-disk shapes of Qwen Code 0.22.3, Grok 1.0.40 and
// Copilot CLI 1.0.88. Kimi's are derived from the 0.39.1 bundle (no real
// session existed to copy from).

let root: string;
let homeDir: string;
let repo: string;
let elsewhere: string;
// An empty env keeps a developer's own QWEN_HOME / GROK_HOME / … out of the test.
const env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-acp-discovery-")));
  homeDir = path.join(root, "home");
  repo = path.join(root, "repo");
  elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJsonl(filePath: string, rows: unknown[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return filePath;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function setMtime(filePath: string, isoTime: string): void {
  const at = new Date(isoTime);
  fs.utimesSync(filePath, at, at);
}

const ADE_GUIDANCE = "## ADE\nADE is a local-first dev environment for lanes, chats, terminals, PRs, proof, apps, iOS, and browsers.\n\nUser request:\nReply with exactly ping.";

describe("Qwen discovery", () => {
  function qwenFile(qwenRoot: string, cwd: string, id: string): string {
    return path.join(qwenRoot, "projects", qwenProjectSlugForCwd(cwd), "chats", `${id}.jsonl`);
  }

  function envelope(id: string, cwd: string, at: string, extra: Record<string, unknown>) {
    return { uuid: `${id}-${at}`, parentUuid: null, sessionId: id, timestamp: at, cwd, version: "0.22.3", ...extra };
  }

  function handRunSession(qwenRoot: string, cwd: string, id: string, options: { title?: string } = {}): string {
    return writeJsonl(qwenFile(qwenRoot, cwd, id), [
      envelope(id, cwd, "2026-09-01T10:00:00.000Z", {
        type: "user",
        provenance: "real_user",
        message: { role: "user", parts: [{ text: "Fix the flaky login test" }] },
      }),
      envelope(id, cwd, "2026-09-01T10:00:00.100Z", {
        type: "system", subtype: "attribution_snapshot", provenance: "system", systemPayload: { snapshot: {} },
      }),
      envelope(id, cwd, "2026-09-01T10:00:01.000Z", {
        type: "assistant",
        provenance: "assistant_output",
        model: "gpt-5.5",
        message: {
          role: "model",
          parts: [
            { text: "Planning the fix", thought: true },
            { text: "Fixed the race in the login test." },
            { functionCall: { name: "edit", args: { file_path: "login.test.ts" } } },
          ],
        },
      }),
      envelope(id, cwd, "2026-09-01T10:00:02.000Z", {
        type: "tool_result",
        provenance: "tool_output",
        message: { role: "user", parts: [{ functionResponse: { name: "edit", response: { output: "ok" } } }] },
      }),
      envelope(id, cwd, "2026-09-01T10:00:03.000Z", {
        type: "user",
        provenance: "real_user",
        message: { role: "user", parts: [{ text: "Now run it" }] },
      }),
      ...(options.title
        ? [envelope(id, cwd, "2026-09-01T10:00:04.000Z", {
            type: "system", subtype: "custom_title", provenance: "system",
            systemPayload: { customTitle: options.title, titleSource: "manual" },
          })]
        : []),
    ]);
  }

  it("reads a hand-run session: title, preview, messages, count, model, size", async () => {
    const qwenRoot = path.join(homeDir, ".qwen");
    const id = "d497b997-c316-41f0-8b2b-2a5807c1473b";
    const filePath = handRunSession(qwenRoot, repo, id, { title: "Flaky login test" });

    const [session] = await discoverQwenSessions({ homeDir, env, scopeRoots: [repo], limit: 10 });
    expect(session).toMatchObject({
      provider: "qwen",
      id,
      cwd: repo,
      title: "Flaky login test",
      preview: "Fix the flaky login test",
      messageCount: 2,
      launch: { model: "gpt-5.5" },
      createdAt: Date.parse("2026-09-01T10:00:00.000Z"),
      sourcePath: filePath,
      sizeBytes: fs.statSync(filePath).size,
    });
    // Reasoning parts and tool calls stay out of the sampled text.
    expect(session?.messages?.map((message) => `${message.role}:${message.text}`)).toEqual([
      "user:Fix the flaky login test",
      "assistant:Fixed the race in the login test.",
      "user:Now run it",
    ]);
  });

  it("falls back to no title when the session was never renamed", async () => {
    const id = "c04c33c1-71ca-4eb8-b6c1-ac3f0a5034b7";
    handRunSession(path.join(homeDir, ".qwen"), repo, id);
    const [session] = await discoverQwenSessions({ homeDir, env, limit: 10 });
    expect(session).toMatchObject({ id, title: null, preview: "Fix the flaky login test" });
  });

  it("leaves out ADE-launched ACP chats and sessions with no prompt", async () => {
    const qwenRoot = path.join(homeDir, ".qwen");
    const adeId = "921507f0-e35d-46b4-8e3d-92708441c35f";
    writeJsonl(qwenFile(qwenRoot, repo, adeId), [
      envelope(adeId, repo, "2026-09-02T10:00:00.000Z", {
        type: "system", subtype: "session_model", provenance: "system", systemPayload: { modelId: "gpt-5.5" },
      }),
      envelope(adeId, repo, "2026-09-02T10:00:01.000Z", {
        type: "user", provenance: "real_user", message: { role: "user", parts: [{ text: ADE_GUIDANCE }] },
      }),
    ]);
    const emptyId = "03a78f61-d0a5-4bd8-b143-ecb0fc117a52";
    writeJsonl(qwenFile(qwenRoot, repo, emptyId), [
      envelope(emptyId, repo, "2026-09-02T11:00:00.000Z", {
        type: "system", subtype: "session_model", provenance: "system", systemPayload: { modelId: "gpt-5.5" },
      }),
    ]);
    const keptId = "da45f6af-fdd9-498e-9448-f37cb1bbf258";
    handRunSession(qwenRoot, repo, keptId);

    const sessions = await discoverQwenSessions({ homeDir, env, limit: 10 });
    expect(sessions.map((session) => session.id)).toEqual([keptId]);
  });

  it("keeps a hand-run session whose prompt happens to start like ADE's guidance", async () => {
    const qwenRoot = path.join(homeDir, ".qwen");
    const id = "11111111-2222-4333-8444-555555555555";
    writeJsonl(qwenFile(qwenRoot, repo, id), [
      envelope(id, repo, "2026-09-03T10:00:00.000Z", {
        type: "user", provenance: "real_user", message: { role: "user", parts: [{ text: "## ADE notes please summarize" }] },
      }),
      envelope(id, repo, "2026-09-03T10:00:00.100Z", {
        type: "system", subtype: "attribution_snapshot", provenance: "system", systemPayload: { snapshot: {} },
      }),
    ]);
    const sessions = await discoverQwenSessions({ homeDir, env, limit: 10 });
    expect(sessions.map((session) => session.id)).toEqual([id]);
  });

  it("filters by scope, resolves exact lookups past the recent budget, and honours QWEN_HOME", async () => {
    const qwenRoot = path.join(root, "custom-qwen");
    const qwenEnv = { QWEN_HOME: qwenRoot };
    const inScope = "aaaaaaaa-0000-4000-8000-000000000001";
    const outOfScope = "aaaaaaaa-0000-4000-8000-000000000002";
    const older = "aaaaaaaa-0000-4000-8000-000000000003";
    setMtime(handRunSession(qwenRoot, repo, inScope), "2026-09-05T00:00:00.000Z");
    setMtime(handRunSession(qwenRoot, elsewhere, outOfScope), "2026-09-06T00:00:00.000Z");
    setMtime(handRunSession(qwenRoot, repo, older), "2026-08-01T00:00:00.000Z");

    const scoped = await discoverQwenSessions({ homeDir, env: qwenEnv, scopeRoots: [repo], limit: 1 });
    expect(scoped.map((session) => session.id)).toEqual([inScope]);
    const unscoped = await discoverQwenSessions({ homeDir, env: qwenEnv, limit: 10 });
    expect(unscoped.map((session) => session.id).sort()).toEqual([inScope, outOfScope, older].sort());
    const [exact] = await discoverQwenSessions({ homeDir, env: qwenEnv, sessionId: older, limit: 1 });
    expect(exact?.id).toBe(older);
    // The default location is not read when QWEN_HOME points elsewhere.
    expect(await discoverQwenSessions({ homeDir, env, limit: 10 })).toEqual([]);
    expect(await discoverQwenSessions({ homeDir, env: qwenEnv, sessionId: "../escape", limit: 1 })).toEqual([]);
  });
});

describe("Grok discovery", () => {
  function grokSessionDir(grokHome: string, cwd: string, id: string): string {
    return path.join(grokHome, "sessions", encodeURIComponent(cwd), id);
  }

  const userInfo = "<user_info>\nOS Version: macos\nShell: /bin/zsh\nWorkspace Path: /repo\n</user_info>\n<rules>\n</rules>";

  function writeGrokSession(grokHome: string, cwd: string, id: string, options: {
    summary?: Record<string, unknown>;
    history?: unknown[];
    acp?: boolean;
  } = {}): string {
    const dir = grokSessionDir(grokHome, cwd, id);
    writeJson(path.join(dir, "summary.json"), {
      info: { id, cwd },
      session_summary: "",
      created_at: "2026-08-31T20:59:36.858521Z",
      updated_at: "2026-08-31T21:05:00.000000Z",
      num_chat_messages: 6,
      current_model_id: "grok-4.5",
      agent_name: "grok-build-plan",
      reasoning_effort: "medium",
      ...options.summary,
    });
    const historyPath = writeJsonl(path.join(dir, "chat_history.jsonl"), options.history ?? [
      { type: "system", content: "You are Grok." },
      { type: "user", content: [{ type: "text", text: userInfo }] },
      { type: "user", content: [{ type: "text", text: "<system-reminder>\nskills\n</system-reminder>" }], synthetic_reason: "system_reminder" },
      { type: "user", content: [{ type: "text", text: "<user_query>\nRefactor the config parser\n</user_query>" }], prompt_index: 0 },
      { type: "reasoning", id: "r1", summary: null, encrypted_content: "x", status: "completed" },
      {
        type: "assistant",
        content: "Refactored the parser.",
        tool_calls: [{ id: "call-1", name: "write", arguments: "{\"file_path\":\"parser.ts\"}" }],
        model_id: "grok-4.5",
      },
      { type: "tool_result", tool_call_id: "call-1", content: "ok" },
    ]);
    if (options.acp) writeJsonl(path.join(dir, "updates.jsonl"), [{ sessionUpdate: "agent_message_chunk" }]);
    return historyPath;
  }

  it("reads a hand-run TUI session and skips Grok's context block and synthetic rows", async () => {
    const grokHome = path.join(homeDir, ".grok");
    const id = "01a0599e-d5f9-7ee0-b0a7-9611a779ee63";
    const historyPath = writeGrokSession(grokHome, repo, id, {
      summary: { generated_title: "Config parser refactor", last_active_at: "2026-08-31T21:10:00.000000Z" },
    });

    const [session] = await discoverGrokSessions({ homeDir, env, scopeRoots: [repo], limit: 10 });
    expect(session).toMatchObject({
      provider: "grok",
      id,
      cwd: repo,
      title: "Config parser refactor",
      preview: "Refactor the config parser",
      messageCount: 1,
      launch: { model: "grok-4.5" },
      createdAt: Date.parse("2026-08-31T20:59:36.858Z"),
      sourcePath: historyPath,
      sizeBytes: fs.statSync(historyPath).size,
    });
    expect(session?.messages?.map((message) => `${message.role}:${message.text}`)).toEqual([
      "user:Refactor the config parser",
      "assistant:Refactored the parser.",
    ]);
  });

  it("leaves out ADE ACP sessions, subagents, and sessions without a prompt", async () => {
    const grokHome = path.join(homeDir, ".grok");
    writeGrokSession(grokHome, repo, "01a05adf-eea3-79e3-b424-e97868ea4bc2", { acp: true });
    writeGrokSession(grokHome, repo, "01a06e82-0000-7000-8000-000000000001", { summary: { session_kind: "subagent" } });
    writeGrokSession(grokHome, repo, "01a05adf-e67b-79a0-bf4f-38c5b47abbbf", {
      history: [
        { type: "system", content: "You are Grok." },
        { type: "user", content: [{ type: "text", text: "<system-reminder>\nskills\n</system-reminder>" }], synthetic_reason: "system_reminder" },
      ],
    });
    const kept = "01a0cda4-0000-7000-8000-000000000002";
    writeGrokSession(grokHome, repo, kept);

    const sessions = await discoverGrokSessions({ homeDir, env, limit: 10 });
    expect(sessions.map((session) => session.id)).toEqual([kept]);
    // Title falls back to nothing when Grok never generated one.
    expect(sessions[0]).toMatchObject({ title: null, preview: "Refactor the config parser" });
  });

  it("filters by the folder cwd, resolves exact lookups, and honours GROK_HOME", async () => {
    const grokHome = path.join(root, "custom-grok");
    const grokEnv = { GROK_HOME: grokHome };
    const inScope = "01a0aaaa-0000-7000-8000-000000000001";
    const outOfScope = "01a0aaaa-0000-7000-8000-000000000002";
    writeGrokSession(grokHome, repo, inScope);
    writeGrokSession(grokHome, elsewhere, outOfScope);

    expect((await discoverGrokSessions({ homeDir, env: grokEnv, scopeRoots: [repo] })).map((session) => session.id))
      .toEqual([inScope]);
    expect((await discoverGrokSessions({ homeDir, env: grokEnv })).map((session) => session.id).sort())
      .toEqual([inScope, outOfScope].sort());
    const [exact] = await discoverGrokSessions({ homeDir, env: grokEnv, sessionId: outOfScope, limit: 1 });
    expect(exact?.cwd).toBe(elsewhere);
    expect(await discoverGrokSessions({ homeDir, env, limit: 10 })).toEqual([]);
  });
});

describe("Copilot discovery", () => {
  function writeCopilotSession(copilotHome: string, id: string, options: {
    yaml?: string;
    events?: unknown[] | null;
    cwd?: string;
  } = {}): string | null {
    const dir = path.join(copilotHome, "session-state", id);
    const cwd = options.cwd ?? repo;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "workspace.yaml"), options.yaml ?? [
      `id: ${id}`,
      `cwd: ${cwd}`,
      `git_root: ${cwd}`,
      "repository: arul28/ADE",
      "host_type: github",
      "branch: main",
      "summary: Investigate Chat Latency",
      "summary_count: 0",
      "created_at: 2026-03-12T17:37:01.580Z",
      "updated_at: 2026-03-12T17:39:06.905Z",
      "",
    ].join("\n"));
    if (options.events === null) return null;
    return writeJsonl(path.join(dir, "events.jsonl"), options.events ?? [
      {
        type: "session.start",
        data: { sessionId: id, copilotVersion: "1.0.88", startTime: "2026-03-12T17:37:01.579Z", context: { cwd } },
        id: "e1",
        timestamp: "2026-03-12T17:37:01.580Z",
      },
      { type: "session.model_change", data: { previousModel: null, newModel: "gpt-5.4" }, id: "e2", timestamp: "2026-03-12T17:37:01.600Z" },
      { type: "user.message", data: { content: "why is sending a message slow", source: "user" }, id: "e3", timestamp: "2026-03-12T17:39:01.953Z" },
      {
        type: "assistant.message",
        data: { messageId: "m1", content: "", toolRequests: [{ toolCallId: "call_1", name: "view", arguments: { path: "a.ts" } }] },
        id: "e4",
        timestamp: "2026-03-12T17:39:02.000Z",
      },
      { type: "tool.execution_start", data: { toolCallId: "call_1", toolName: "view", arguments: { path: "a.ts" } }, id: "e5", timestamp: "2026-03-12T17:39:02.100Z" },
      { type: "tool.execution_complete", data: { toolCallId: "call_1", success: true, result: { content: "..." } }, id: "e6", timestamp: "2026-03-12T17:39:02.200Z" },
      { type: "assistant.message", data: { messageId: "m2", content: "The composer re-renders on every keystroke." }, id: "e7", timestamp: "2026-03-12T17:39:05.000Z" },
      { type: "user.message", data: { content: "Continue working on the task.", source: "autopilot" }, id: "e8", timestamp: "2026-03-12T17:39:06.000Z" },
    ]);
  }

  it("parses flat YAML including block scalars and quoted values", () => {
    expect(parseFlatYaml([
      "id: abc",
      "name: |-",
      "  first line",
      "  second line",
      "summary: \"Quoted: value\"",
      "other: 'it''s'",
      "nested:",
      "  child: ignored",
      "branch: main # trailing comment",
    ].join("\n"))).toEqual({
      id: "abc",
      name: "first line\nsecond line",
      summary: "Quoted: value",
      other: "it's",
      branch: "main",
    });
  });

  it("reads a hand-run session and does not count autopilot turns as prompts", async () => {
    const copilotHome = path.join(homeDir, ".copilot");
    const id = "9e80f413-ab88-4f92-af30-a8a384e1d6b9";
    const eventsPath = writeCopilotSession(copilotHome, id)!;

    const [session] = await discoverCopilotSessions({ homeDir, env, scopeRoots: [repo], limit: 10 });
    expect(session).toMatchObject({
      provider: "copilot",
      id,
      cwd: repo,
      title: "Investigate Chat Latency",
      preview: "why is sending a message slow",
      messageCount: 1,
      launch: { model: "gpt-5.4" },
      createdAt: Date.parse("2026-03-12T17:37:01.580Z"),
      sourcePath: eventsPath,
      sizeBytes: fs.statSync(eventsPath).size,
    });
    expect(session?.messages?.map((message) => `${message.role}:${message.text}`)).toEqual([
      "user:why is sending a message slow",
      "assistant:The composer re-renders on every keystroke.",
    ]);
  });

  it("uses the model the user selected, never the model that auto mode chose", async () => {
    const copilotHome = path.join(homeDir, ".copilot");
    const start = (selectedModel: string) => ({ type: "session.start", data: { selectedModel, context: { cwd: repo } }, id: "s", timestamp: "2026-03-12T17:37:01.580Z" });
    const prompt = { type: "user.message", data: { content: "hi", source: "user" }, id: "u", timestamp: "2026-03-12T17:37:02.000Z" };
    const shutdown = { type: "session.shutdown", data: { currentModel: "gpt-5.6-luna" }, id: "x", timestamp: "2026-03-12T17:38:00.000Z" };
    const auto = "bbbbbbbb-0000-4000-8000-000000000001";
    const picked = "bbbbbbbb-0000-4000-8000-000000000002";
    const legacy = "bbbbbbbb-0000-4000-8000-000000000003";
    writeCopilotSession(copilotHome, auto, {
      events: [start("gpt-5.2"), { type: "session.model_change", data: { newModel: "auto" }, id: "m", timestamp: "2026-03-12T17:37:01.700Z" }, prompt, shutdown],
    });
    writeCopilotSession(copilotHome, picked, { events: [start("claude-sonnet-4.6"), prompt, shutdown] });
    writeCopilotSession(copilotHome, legacy, { events: [{ type: "session.start", data: { context: { cwd: repo } }, id: "s", timestamp: "2026-03-12T17:37:01.580Z" }, prompt, shutdown] });

    const sessions = await discoverCopilotSessions({ homeDir, env, limit: 10 });
    const launchById = Object.fromEntries(sessions.map((session) => [session.id, session.launch ?? null]));
    expect(launchById[auto]).toBeNull();
    expect(launchById[picked]).toEqual({ model: "claude-sonnet-4.6" });
    expect(launchById[legacy]).toEqual({ model: "gpt-5.6-luna" });
  });

  it("leaves out ADE clients, folders without events, and sessions with no prompt", async () => {
    const copilotHome = path.join(homeDir, ".copilot");
    for (const [id, client] of [
      ["80d02b47-a9ed-4fd0-be7b-697e1ecdce6c", "ade"],
      ["21bb0ce1-0000-4000-8000-000000000001", "ade-probe"],
      ["6dec4a02-0000-4000-8000-000000000002", "ade-telemetry-probe"],
    ] as const) {
      writeCopilotSession(copilotHome, id, {
        yaml: `id: ${id}\ncwd: ${repo}\nclient_name: ${client}\nname: |-\n  ${ADE_GUIDANCE.split("\n")[0]}\n`,
      });
    }
    writeCopilotSession(copilotHome, "02d4d613-0000-4000-8000-000000000003", { events: null });
    writeCopilotSession(copilotHome, "5516aba7-0000-4000-8000-000000000004", {
      events: [{ type: "session.start", data: { context: { cwd: repo } }, id: "e1", timestamp: "2026-03-12T17:37:01.580Z" }],
    });
    const kept = "d26fc721-0000-4000-8000-000000000005";
    writeCopilotSession(copilotHome, kept);

    const sessions = await discoverCopilotSessions({ homeDir, env, limit: 10 });
    expect(sessions.map((session) => session.id)).toEqual([kept]);
  });

  it("filters by scope, resolves exact lookups, falls back to the start event cwd, and honours COPILOT_HOME", async () => {
    const copilotHome = path.join(root, "custom-copilot");
    const copilotEnv = { COPILOT_HOME: copilotHome };
    const inScope = "aaaaaaaa-1111-4000-8000-000000000001";
    const outOfScope = "aaaaaaaa-1111-4000-8000-000000000002";
    const noYamlCwd = "aaaaaaaa-1111-4000-8000-000000000003";
    writeCopilotSession(copilotHome, inScope);
    writeCopilotSession(copilotHome, outOfScope, { cwd: elsewhere });
    writeCopilotSession(copilotHome, noYamlCwd, { yaml: `id: ${noYamlCwd}\nsummary: Untitled work\n` });

    expect((await discoverCopilotSessions({ homeDir, env: copilotEnv, scopeRoots: [repo] })).map((session) => session.id).sort())
      .toEqual([inScope, noYamlCwd].sort());
    const [exact] = await discoverCopilotSessions({ homeDir, env: copilotEnv, sessionId: outOfScope, limit: 1 });
    expect(exact?.cwd).toBe(elsewhere);
    expect(await discoverCopilotSessions({ homeDir, env, limit: 10 })).toEqual([]);
  });
});

describe("Kimi discovery (bundle-derived layout)", () => {
  const workspaceId = "wd_repo_2151c536b962";

  function writeKimiSession(kimiHome: string, id: string, options: {
    state?: Record<string, unknown> | null;
    wire?: unknown[];
    legacyContext?: unknown[];
    bucket?: string;
  } = {}): string {
    const dir = path.join(kimiHome, "sessions", options.bucket ?? workspaceId, id);
    fs.mkdirSync(dir, { recursive: true });
    if (options.state !== null) writeJson(path.join(dir, "state.json"), options.state ?? { title: "Readme work", isCustomTitle: true });
    if (options.legacyContext) return writeJsonl(path.join(dir, "context.jsonl"), options.legacyContext);
    return writeJsonl(path.join(dir, "agents", "main", "wire.jsonl"), options.wire ?? [
      { type: "turn_begin", time: 1788205417.469, userInput: "Add a README" },
      { type: "context.append_message", time: 1788205417.5, message: { role: "user", content: [{ type: "text", text: "Add a README" }] } },
      { type: "context.append_message", time: 1788205420.0, message: { role: "assistant", content: [{ type: "text", text: "Added README.md." }] } },
      {
        type: "context.append_message",
        time: 1788205421.0,
        message: { role: "user", content: [{ type: "text", text: "cron tick" }], origin: { kind: "cron_job" } },
      },
    ]);
  }

  function writeWorkspaces(kimiHome: string, entries: Record<string, string>): void {
    writeJson(path.join(kimiHome, "workspaces.json"), {
      version: 1,
      workspaces: Object.fromEntries(Object.entries(entries).map(([id, workspaceRoot]) => [
        id,
        { root: workspaceRoot, name: path.basename(workspaceRoot), created_at: "2026-08-31T19:37:53.623Z" },
      ])),
      deleted_workspace_ids: [],
    });
  }

  it("reads wire.jsonl sessions with the workspace root as cwd and counts only typed prompts", async () => {
    const kimiHome = path.join(homeDir, ".kimi-code");
    writeWorkspaces(kimiHome, { [workspaceId]: repo });
    const id = "01K5ZQ4Y3N8W2V7T6R5P4M3K2J";
    const wirePath = writeKimiSession(kimiHome, id);

    const [session] = await discoverKimiSessions({ homeDir, env, scopeRoots: [repo], limit: 10 });
    expect(session).toMatchObject({
      provider: "kimi",
      id,
      cwd: repo,
      title: "Readme work",
      preview: "Add a README",
      messageCount: 1,
      createdAt: 1788205417469,
      sourcePath: wirePath,
      sizeBytes: fs.statSync(wirePath).size,
    });
    expect(session?.messages?.map((message) => `${message.role}:${message.text}`)).toEqual([
      "user:Add a README",
      "assistant:Added README.md.",
    ]);
  });

  it("reads legacy context.jsonl sessions and the state workDir", async () => {
    const kimiHome = path.join(homeDir, ".kimi-code");
    const id = "legacy-session-0001";
    writeKimiSession(kimiHome, id, {
      bucket: "wd_unknown_000000000000",
      state: { workDir: repo },
      legacyContext: [
        { role: "_system_prompt", content: "You are Kimi." },
        { role: "user", content: "hello kimi" },
        { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
        { role: "_usage", token_count: 10 },
      ],
    });
    const [session] = await discoverKimiSessions({ homeDir, env, limit: 10 });
    expect(session).toMatchObject({ id, cwd: repo, title: null, preview: "hello kimi", messageCount: 1 });
  });

  it("leaves out child, archived, deleted, ADE-launched, and empty sessions", async () => {
    const kimiHome = path.join(homeDir, ".kimi-code");
    writeWorkspaces(kimiHome, { [workspaceId]: repo });
    writeKimiSession(kimiHome, "child-session-0001", { state: { custom: { child_session_kind: "child", parent_session_id: "x" } } });
    writeKimiSession(kimiHome, "archived-session-01", { state: { archived: true } });
    writeKimiSession(kimiHome, "deleted-session-001");
    writeJsonl(path.join(kimiHome, "session_index.jsonl"), [
      { sessionId: "deleted-session-001", sessionDir: "x", workDir: repo },
      { sessionId: "deleted-session-001", deleted: true },
    ]);
    writeKimiSession(kimiHome, "ade-acp-session-01", {
      wire: [{ type: "context.append_message", time: 1788205417, message: { role: "user", content: [{ type: "text", text: ADE_GUIDANCE }] } }],
    });
    writeKimiSession(kimiHome, "empty-session-0001", { wire: [{ type: "forked", time: 1788205417 }] });
    const kept = "kept-session-00001";
    writeKimiSession(kimiHome, kept);

    const sessions = await discoverKimiSessions({ homeDir, env, limit: 10 });
    expect(sessions.map((session) => session.id)).toEqual([kept]);
  });

  it("filters workspaces out of scope, resolves exact lookups, and honours KIMI_CODE_HOME", async () => {
    const kimiHome = path.join(root, "custom-kimi");
    const kimiEnv = { KIMI_CODE_HOME: kimiHome };
    writeWorkspaces(kimiHome, { [workspaceId]: repo, wd_elsewhere_111111111111: elsewhere });
    writeKimiSession(kimiHome, "in-scope-session-1");
    writeKimiSession(kimiHome, "out-scope-session-1", { bucket: "wd_elsewhere_111111111111" });

    expect((await discoverKimiSessions({ homeDir, env: kimiEnv, scopeRoots: [repo] })).map((session) => session.id))
      .toEqual(["in-scope-session-1"]);
    const [exact] = await discoverKimiSessions({ homeDir, env: kimiEnv, sessionId: "out-scope-session-1", limit: 1 });
    expect(exact?.cwd).toBe(elsewhere);
    expect(await discoverKimiSessions({ homeDir, env, limit: 10 })).toEqual([]);
  });
});
