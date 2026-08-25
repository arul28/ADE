import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLUGIN_SKILL_NEXT_TURN_NOTE } from "../../../shared/plugins/clientRendering";
import {
  canonicalApprovalSource,
  isPluginInstallPreapproved,
  recordPluginInstallApproval,
  requestPluginInstallApproval,
  resetPluginInstallApprovalsForTests,
  type PluginInstallApprovalChat,
} from "./pluginInstallApproval";
import { resolvePluginInstallSource } from "./pluginInstallService";

const scratchDirs: string[] = [];

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function pluginDir(manifest: Record<string, unknown>): string {
  const root = scratchDir("ade-approval-src-");
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify(manifest), "utf8");
  return root;
}

/** A plugin that declares enough for the "Adds:" list to be non-trivial. */
function tipsyManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "ade-tipsy",
    version: "0.3.0",
    displayName: "Tipsy",
    description: "A drink counter.",
    entry: "index.js",
    surfaces: [{ kind: "tab", id: "tipsy", title: "Tipsy", panelId: "main" }],
    panels: [{ id: "main", title: "Tipsy" }],
    sockets: [{ socket: "composer-action", surface: "work", id: "drink", label: "Take a drink", actionId: "drink" }],
    cli: ["status"],
    skills: ["skills/tipsy"],
    ...overrides,
  };
}

type ChatCall = Parameters<PluginInstallApprovalChat["requestChatInput"]>[0];

function chatMock(response: {
  decision?: string;
  answers?: Record<string, string[]>;
  /** Never resolve, so the timeout branch runs. */
  hang?: boolean;
}): { chat: PluginInstallApprovalChat; calls: ChatCall[]; responded: Array<{ itemId: string; decision?: string }> } {
  const calls: ChatCall[] = [];
  const responded: Array<{ itemId: string; decision?: string }> = [];
  const chat: PluginInstallApprovalChat = {
    requestChatInput: vi.fn(async (args: ChatCall) => {
      calls.push(args);
      args.onItemId?.("item-1");
      if (response.hang) await new Promise(() => undefined);
      return {
        decision: response.decision ?? "accept",
        answers: response.answers ?? { plugin_install: ["install"] },
        responseText: null,
      };
    }),
    respondToInput: vi.fn(async ({ itemId, decision }) => {
      responded.push({ itemId, ...(decision ? { decision } : {}) });
    }),
  };
  return { chat, calls, responded };
}

describe("plugin install approval", () => {
  beforeEach(() => {
    resetPluginInstallApprovalsForTests();
  });

  afterEach(() => {
    while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  it("raises a card whose every word comes from the manifest the host parsed", async () => {
    const source = pluginDir(tipsyManifest());
    const { chat, calls } = chatMock({});

    const result = await requestPluginInstallApproval({
      chat,
      chatSessionId: "chat-1",
      projectId: "project-1",
      source,
      builtinPluginsRoot: null,
    });

    expect(result.allow).toBe(true);
    expect(calls).toHaveLength(1);
    const card = calls[0]!;
    // The title names the plugin the way its own manifest does, with the
    // version — not the directory it happens to sit in.
    expect(card.title).toBe("Install Tipsy 0.3.0?");
    expect(card.body).toContain("A drink counter.");
    expect(card.body).toContain(`From this computer: ${source}`);
    // The "Adds:" list is counted off the declarations, so it cannot flatter
    // the plugin: a tab, a socket, a CLI word and a skill each show up.
    expect(card.body).toContain("Tipsy tab");
    expect(card.body).toContain("One addition to Work");
    expect(card.body).toContain("Terminal commands: ade ade-tipsy status");
    expect(card.body).toContain("One agent skill");
    expect(card.body).toContain("Runs code on this machine");
  });

  it("hands the disclosure to the card as its description, not just as a body nothing reads", async () => {
    // The bug this pins: the card's description used to fall back to the first
    // question, which is the title again, so every word above was discarded and
    // the person approving filesystem and network access read only a name.
    const source = pluginDir(tipsyManifest());
    const { chat, calls } = chatMock({});

    await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    const card = calls[0]!;
    expect(card.description).toBe(card.body);
    expect(card.description).toContain("A drink counter.");
    expect(card.description).toContain(`From this computer: ${source}`);
    expect(card.description).toContain("Adds:");
    expect(card.description).toContain("Runs code on this machine");
  });

  it("names its own buttons, and says which decision each one answers", async () => {
    // Without `decision` the card falls back to Accept / Accept all / Decline,
    // and "Accept all" reads as a standing grant this gate never offered.
    const source = pluginDir(tipsyManifest());
    const { chat, calls } = chatMock({});

    await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    const options = calls[0]!.questions?.[0]?.options ?? [];
    expect(options.map((option) => option.label)).toEqual(["Install", "Don't install"]);
    expect(options.map((option) => option.decision)).toEqual(["accept", "decline"]);
    expect(options[0]?.value).toBe("install");
    expect(options[1]?.value).toBe("deny");
    expect(options[0]?.description).toBe("Runs with the same access as tools you install yourself.");
  });

  it("tells the reader when a skill lands, in the same words every other surface uses", async () => {
    // The retrospective's sharpest confusion: the plugin installed, the state
    // changed, and the agent in the visible chat stayed sober. Said BEFORE the
    // person approves, and pinned to the shared constant so this card cannot
    // drift from the CLI, the doctor and the Marketplace.
    const source = pluginDir(tipsyManifest());
    const { chat, calls } = chatMock({});

    await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    expect(calls[0]!.body).toContain(PLUGIN_SKILL_NEXT_TURN_NOTE);
  });

  it("stays quiet about turn timing for a plugin that contributes no skill", async () => {
    const source = pluginDir(tipsyManifest({ skills: [] }));
    const { chat, calls } = chatMock({});

    await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    expect(calls[0]!.body).not.toContain(PLUGIN_SKILL_NEXT_TURN_NOTE);
  });

  it("marks the request operator-only so the agent that raised it cannot answer it", async () => {
    const source = pluginDir(tipsyManifest());
    const { chat, calls } = chatMock({});

    await requestPluginInstallApproval({
      chat,
      chatSessionId: "chat-1",
      projectId: "project-1",
      source,
      builtinPluginsRoot: null,
    });

    // The itemId is written into a transcript the requesting agent can read
    // back, so "whoever knows the id" cannot be the rule for this one.
    expect(calls[0]!.operatorOnly).toBe(true);
  });

  it("never lets a caller-supplied string reach the reader as prose", async () => {
    // The retro's trust break was a card that described itself. Everything but
    // the source string is derived, so a manifest claiming to be official and a
    // caller shouting in the arguments both fail to move the copy.
    const source = pluginDir(tipsyManifest({
      displayName: "Tipsy",
      // `official` in a manifest is the author's claim about themselves.
      official: true,
    }));
    const { chat, calls } = chatMock({});

    await requestPluginInstallApproval({
      chat,
      chatSessionId: "chat-1",
      projectId: "project-1",
      source,
      builtinPluginsRoot: null,
    });

    const rendered = JSON.stringify(calls[0]);
    expect(rendered).not.toContain("Official");
    expect(calls[0]!.body).toContain("Community plugin.");
  });

  it("installs without asking again for the same plugin at the same path", async () => {
    const source = pluginDir(tipsyManifest());
    const { chat, calls } = chatMock({});
    const ask = async () => requestPluginInstallApproval({
      chat,
      chatSessionId: "chat-1",
      projectId: "project-1",
      source,
      builtinPluginsRoot: null,
    });

    const first = await ask();
    expect(first.allow && first.reason).toBe("approved");
    // The caller records the pair; do what the RPC gate does.
    if (first.allow && first.pluginId && first.canonicalSource) {
      recordPluginInstallApproval({
        projectId: "project-1",
        pluginId: first.pluginId,
        canonicalSource: first.canonicalSource,
      });
    }

    // The build-test-fix loop: the code at that path changed, the approval did
    // not. Editing a directory the user's own agent owns must not re-ask.
    fs.writeFileSync(path.join(source, "index.js"), "// fixed\n", "utf8");
    const second = await ask();

    expect(second.allow && second.reason).toBe("preapproved");
    expect(calls).toHaveLength(1);
  });

  it("asks again when the same plugin id arrives from a different path", async () => {
    const first = pluginDir(tipsyManifest());
    const second = pluginDir(tipsyManifest());
    const { chat, calls } = chatMock({});

    const approved = await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source: first, builtinPluginsRoot: null,
    });
    if (approved.allow && approved.pluginId && approved.canonicalSource) {
      recordPluginInstallApproval({
        projectId: "project-1",
        pluginId: approved.pluginId,
        canonicalSource: approved.canonicalSource,
      });
    }

    await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source: second, builtinPluginsRoot: null,
    });

    expect(calls).toHaveLength(2);
  });

  it("asks again when a different plugin id arrives from an approved path", async () => {
    const source = pluginDir(tipsyManifest());
    const { chat, calls } = chatMock({});

    const approved = await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });
    if (approved.allow && approved.pluginId && approved.canonicalSource) {
      recordPluginInstallApproval({
        projectId: "project-1",
        pluginId: approved.pluginId,
        canonicalSource: approved.canonicalSource,
      });
    }

    // Swapping which PLUGIN lives at an approved path is not the iteration the
    // remembered approval was granted for.
    fs.writeFileSync(
      path.join(source, "plugin.json"),
      JSON.stringify(tipsyManifest({ name: "something-else", displayName: "Something Else" })),
      "utf8",
    );
    await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    expect(calls).toHaveLength(2);
  });

  it("keeps one project's approvals out of another's", async () => {
    const source = pluginDir(tipsyManifest());
    recordPluginInstallApproval({ projectId: "project-1", pluginId: "ade-tipsy", canonicalSource: source });

    expect(isPluginInstallPreapproved({
      projectId: "project-1", pluginId: "ade-tipsy", canonicalSource: source,
    })).toBe(true);
    expect(isPluginInstallPreapproved({
      projectId: "project-2", pluginId: "ade-tipsy", canonicalSource: source,
    })).toBe(false);
  });

  it("refuses with a typed decline the agent can act on", async () => {
    const source = pluginDir(tipsyManifest());
    const { chat } = chatMock({ decision: "decline", answers: { plugin_install: ["deny"] } });

    const result = await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason).toBe("denied");
    expect(result.data).toMatchObject({ kind: "plugin_install_denied", pluginId: "ade-tipsy" });
    // A refusal an agent retries verbatim is worse than no refusal.
    expect(result.message).toContain("Don't retry it");
  });

  it("treats a decision without the matching answer as refusal, not consent", async () => {
    // Both gates have to agree. A surface that reports one without the other is
    // not consent, and consent is the one thing that must not be inferred.
    const source = pluginDir(tipsyManifest());
    const { chat } = chatMock({ decision: "accept", answers: { plugin_install: ["deny"] } });

    const result = await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    expect(result.allow).toBe(false);
  });

  it("settles the card when nobody answers, instead of leaving the chat blocked", async () => {
    const source = pluginDir(tipsyManifest());
    const { chat, responded } = chatMock({ hang: true });

    const result = await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
      timeoutMs: 5,
    });

    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason).toBe("timed_out");
    // A live pending input also blocks the user's next message in this chat, so
    // an abandoned prompt would wedge the conversation.
    expect(responded).toEqual([{ itemId: "item-1", decision: "cancel" }]);
  });

  it("refuses a source ADE cannot read rather than asking someone to vouch for it", async () => {
    const { chat, calls } = chatMock({});

    const result = await requestPluginInstallApproval({
      chat,
      chatSessionId: "chat-1",
      projectId: "project-1",
      source: "not-a-directory-not-a-url",
      builtinPluginsRoot: null,
    });

    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.data).toMatchObject({ kind: "plugin_install_source_unreadable" });
    expect(calls).toHaveLength(0);
  });

  it("says it cannot preview a git source instead of inventing a feature list", async () => {
    const { chat, calls } = chatMock({});

    const result = await requestPluginInstallApproval({
      chat,
      chatSessionId: "chat-1",
      projectId: "project-1",
      source: "https://example.invalid/owner/ade-plugin-graph",
      builtinPluginsRoot: null,
    });

    expect(result.allow).toBe(true);
    expect(calls[0]!.body).toContain("From the internet:");
    expect(calls[0]!.body).toContain("ADE can't read this source without downloading it");
    expect(calls[0]!.body).not.toContain("Adds:");
    // Nothing local vouches for what the next fetch brings, so a network source
    // is never remembered — the next install asks again.
    if (!result.allow) throw new Error("expected approval");
    expect(result.canonicalSource).toBeNull();
  });

  it("never remembers a git source", () => {
    expect(canonicalApprovalSource(
      resolvePluginInstallSource("https://example.invalid/x.git", { builtinPluginsRoot: null }),
    )).toBeNull();
  });
});
