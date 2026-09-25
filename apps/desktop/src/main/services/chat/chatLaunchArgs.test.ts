import { describe, expect, it } from "vitest";
import {
  parseAgentChatFileRefs,
  parseChatLaunchArgs,
  parseChatLaunchCompleteClientArgs,
  parseChatLaunchIdArgs,
  parseChatLaunchLaneConfig,
  parseChatLaunchQueueMessageArgs,
} from "./chatLaunchArgs";

const LAUNCH_ID = "6f1c2a4e-1b2c-4d5e-8f90-123456789abc";

function rawLaunch(chat: Record<string, unknown>) {
  return { kind: "chat", mode: "foreground", launchId: LAUNCH_ID, prompt: "fix it", chat };
}

describe("chatLaunchArgs (desktop action + sync host share this parser)", () => {
  it("requires the chat's provider and a string opening message", () => {
    expect(() => parseChatLaunchArgs(rawLaunch({ create: { model: "" }, message: { text: "x" } }))).toThrow(/provider/);
    expect(() => parseChatLaunchArgs(rawLaunch({ create: { provider: "codex" }, message: {} }))).toThrow(/message\.text/);
    expect(() => parseChatLaunchArgs(rawLaunch({ create: { provider: "codex" } }))).toThrow(/chat\.create and chat\.message/);
    expect(() => parseChatLaunchArgs(null)).toThrow(/object payload/);
  });

  it("keeps what the desktop composer sends: harness ids, context-only messages, cursor runtime", () => {
    const parsed = parseChatLaunchArgs(rawLaunch({
      create: { provider: "cursor", model: "", presetId: " preset-1 ", codexSandbox: "workspace-write", laneId: "ignored", identityKey: "cto" },
      message: {
        text: "",
        displayText: "Selected visual app context",
        contextAttachments: [{ kind: "linear_issue", id: "ADE-1" }, "junk"],
        runtime: "local",
        attachments: [{ path: "/tmp/a.png", type: "image" }, { path: "", type: "file" }],
      },
    }));
    expect(parsed.chat?.create).toMatchObject({ provider: "cursor", model: "", presetId: "preset-1", codexSandbox: "workspace-write" });
    // Fields a launch must not set from outside are dropped.
    expect(parsed.chat?.create).not.toHaveProperty("laneId");
    expect(parsed.chat?.create).not.toHaveProperty("identityKey");
    expect(parsed.chat?.message).toEqual({
      text: "",
      displayText: "Selected visual app context",
      attachments: [{ path: "/tmp/a.png", type: "image" }],
      contextAttachments: [{ kind: "linear_issue", id: "ADE-1" }],
      runtime: "local",
    });
  });

  it("CLI launches carry no chat", () => {
    const parsed = parseChatLaunchArgs({ kind: "cli", launchId: LAUNCH_ID, mode: "background", prompt: "p", laneId: " abc " });
    expect(parsed).toMatchObject({ kind: "cli", mode: "background", laneId: "abc" });
    expect(parsed.chat).toBeUndefined();
  });

  it("parses the id, queue and complete-client payloads", () => {
    expect(parseChatLaunchIdArgs({ launchId: ` ${LAUNCH_ID} ` }, "chat.cancelLaunch")).toEqual({ launchId: LAUNCH_ID });
    expect(() => parseChatLaunchIdArgs({}, "chat.cancelLaunch")).toThrow("chat.cancelLaunch requires launchId.");
    expect(parseChatLaunchQueueMessageArgs({ launchId: LAUNCH_ID, text: 5, displayText: " shown ", attachments: [{ path: "/f", type: "file" }] }))
      .toEqual({ launchId: LAUNCH_ID, text: "", displayText: "shown", attachments: [{ path: "/f", type: "file" }] });
    expect(parseChatLaunchCompleteClientArgs({ launchId: LAUNCH_ID, sessionId: " pty-1 ", error: "" }))
      .toEqual({ launchId: LAUNCH_ID, sessionId: "pty-1" });
  });
});

describe("parseChatLaunchLaneConfig (composer's configured new lane)", () => {
  it("keeps a valid recipe, trimming strings and dropping empty ones", () => {
    expect(parseChatLaunchLaneConfig({
      mode: "child",
      parentLaneId: " lane-1 ",
      templateId: " tpl-1 ",
      color: "#abcdef",
      branchRef: "   ",
    })).toEqual({ mode: "child", parentLaneId: "lane-1", templateId: "tpl-1", color: "#abcdef" });
  });

  it("keeps a well-formed Linear issue but drops a malformed one", () => {
    const validIssue = {
      id: "issue-1",
      identifier: "ADE-1",
      title: "Ship it",
      teamId: "team-1",
      teamKey: "ADE",
      stateId: "state-1",
      stateName: "In Progress",
      stateType: "started",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(parseChatLaunchLaneConfig({ mode: "root", linearIssue: validIssue })?.linearIssue)
      .toMatchObject({ id: "issue-1", identifier: "ADE-1", title: "Ship it" });
    // Only an id: the canonical parser rejects it, so it never reaches lane creation.
    expect(parseChatLaunchLaneConfig({ mode: "root", linearIssue: { id: "issue-1" } })).toEqual({ mode: "root" });
  });

  it("rejects an unknown mode", () => {
    expect(parseChatLaunchLaneConfig({ mode: "nope", parentLaneId: "lane-1" })).toBeUndefined();
    expect(parseChatLaunchLaneConfig("not-an-object")).toBeUndefined();
  });
});

describe("parseAgentChatFileRefs", () => {
  it("keeps pasted image links (image-url) alongside local files", () => {
    expect(parseAgentChatFileRefs([
      { type: "image", path: "/tmp/a.png" },
      { type: "image-url", url: "https://example.com/b.png" },
      { type: "image-url", url: "javascript:alert(1)" },
      { type: "file", path: "" },
    ])).toEqual([
      { type: "image", path: "/tmp/a.png" },
      { type: "image-url", path: "https://example.com/b.png", url: "https://example.com/b.png" },
    ]);
  });
});
