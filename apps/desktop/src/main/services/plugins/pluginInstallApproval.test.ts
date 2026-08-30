import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLUGIN_SKILL_NEXT_TURN_NOTE } from "../../../shared/plugins/clientRendering";
import { parsePluginManifestJson, type PluginManifest } from "../../../shared/plugins/manifest";
import {
  canonicalApprovalSource,
  isPluginInstallPreapproved,
  recordPluginInstallApproval,
  requestPluginInstallApproval,
  requestPluginRemovalApproval,
  resetPendingPluginInstallCardsForTests,
  resetPluginInstallApprovalsForTests,
  PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS,
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
    resetPendingPluginInstallCardsForTests();
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

  /**
   * The card outlives the CALLER, and a retry must not stack a second one.
   *
   * A live dogfood run failed here twice: `ade actions run` gave up on its own
   * RPC while the user was away, the agent retried, and a second card appeared
   * over a first that was still live and still waiting. Answering either left
   * the other standing with nobody behind it.
   */
  describe("a re-request while a card is already up", () => {
    it("joins the standing card for the same install instead of raising a second", async () => {
      const source = pluginDir(tipsyManifest());
      let answer: (() => void) | null = null;
      const held = new Promise<void>((resolve) => { answer = resolve; });
      const calls: ChatCall[] = [];
      const chat: PluginInstallApprovalChat = {
        requestChatInput: vi.fn(async (args: ChatCall) => {
          calls.push(args);
          args.onItemId?.(`item-${calls.length}`);
          await held;
          return { decision: "accept", answers: { plugin_install: ["install"] }, responseText: null };
        }),
        respondToInput: vi.fn(async () => undefined),
      };

      const first = requestPluginInstallApproval({
        chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
      });
      // The retry the agent makes after its own deadline expires.
      const second = requestPluginInstallApproval({
        chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
      });
      answer!();
      const [a, b] = await Promise.all([first, second]);

      expect(calls).toHaveLength(1);
      expect(a.allow).toBe(true);
      // One card, one answer, both callers told what the user decided.
      expect(b).toEqual(a);
    });

    it("settles the standing card before raising a different one, never orphaning it", async () => {
      const first = pluginDir(tipsyManifest());
      const second = pluginDir(tipsyManifest({ name: "ade-other", displayName: "Other" }));
      const calls: ChatCall[] = [];
      const responded: Array<{ itemId: string; decision?: string }> = [];
      const chat: PluginInstallApprovalChat = {
        requestChatInput: vi.fn(async (args: ChatCall) => {
          calls.push(args);
          const itemId = `item-${calls.length}`;
          args.onItemId?.(itemId);
          // Only an explicit `respondToInput` settles this one, exactly as the
          // real chat behaves.
          return await new Promise((resolve) => {
            settle.set(itemId, () => resolve({
              decision: "cancel",
              answers: {},
              responseText: null,
            }));
            if (calls.length === 2) {
              resolve({ decision: "accept", answers: { plugin_install: ["install"] }, responseText: null });
            }
          });
        }),
        respondToInput: vi.fn(async ({ itemId, decision }) => {
          responded.push({ itemId, ...(decision ? { decision } : {}) });
          settle.get(itemId)?.();
        }),
      };
      const settle = new Map<string, () => void>();

      const firstCall = requestPluginInstallApproval({
        chat, chatSessionId: "chat-1", projectId: "project-1", source: first, builtinPluginsRoot: null,
      });
      await Promise.resolve();
      const secondCall = requestPluginInstallApproval({
        chat, chatSessionId: "chat-1", projectId: "project-1", source: second, builtinPluginsRoot: null,
      });

      const firstResult = await firstCall;
      const secondResult = await secondCall;

      // The first card was settled, by the host, with a receipt — not abandoned.
      expect(responded).toEqual([{ itemId: "item-1", decision: "cancel" }]);
      expect(firstResult.allow).toBe(false);
      if (firstResult.allow) throw new Error("expected the superseded request to refuse");
      expect(firstResult.reason).toBe("cancelled");
      expect(secondResult.allow).toBe(true);
      expect(calls).toHaveLength(2);
    });

    it("forgets the card once it is answered, so the next install asks again", async () => {
      const source = pluginDir(tipsyManifest());
      const { chat, calls } = chatMock({ decision: "decline", answers: { plugin_install: ["deny"] } });
      const args = {
        chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
      } as const;

      await requestPluginInstallApproval({ ...args });
      await requestPluginInstallApproval({ ...args });

      expect(calls).toHaveLength(2);
    });
  });

  it("gives the user an hour to come back to the desk, not ten minutes", () => {
    // The ten-minute window settled the card twice in a live run while the user
    // was away from the keyboard, and the agent read a cancellation nobody made.
    expect(PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS).toBe(60 * 60 * 1000);
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

/* ── Disclosure and the grant a remembered approval is keyed on ─────────── */

describe("requestPluginInstallApproval — network and provider keys", () => {
  /** Approve once and remember it, the way the RPC server does. */
  async function approveAndRemember(
    chat: PluginInstallApprovalChat,
    source: string,
  ): Promise<void> {
    const approved = await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });
    if (approved.allow && approved.pluginId && approved.canonicalSource) {
      recordPluginInstallApproval({
        projectId: "project-1",
        pluginId: approved.pluginId,
        canonicalSource: approved.canonicalSource,
        grant: approved.grant,
      });
    }
  }

  it("puts the hosts and the provider key on the card before anyone agrees", async () => {
    const source = pluginDir(tipsyManifest({
      network: { hosts: ["api.cursor.com"] },
      providerKeys: ["cursor"],
    }));
    const { chat, calls } = chatMock({});

    await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    expect(calls[0]!.body).toContain("Talks to api.cursor.com");
    expect(calls[0]!.body).toContain("Uses your Cursor API key");
  });

  it("asks again when a later save widens the declared hosts", async () => {
    const source = pluginDir(tipsyManifest({ network: { hosts: ["api.cursor.com"] } }));
    const { chat, calls } = chatMock({});

    await approveAndRemember(chat, source);
    // The remembered approval deliberately lets the CODE at this path change.
    // It does not let the DECLARATION change: this is a host the person never
    // saw on the card they answered.
    fs.writeFileSync(
      path.join(source, "plugin.json"),
      JSON.stringify(tipsyManifest({ network: { hosts: ["api.cursor.com", "telemetry.test"] } })),
      "utf8",
    );
    await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain("telemetry.test");
  });

  it("asks again when a later save adds a provider key", async () => {
    const source = pluginDir(tipsyManifest());
    const { chat, calls } = chatMock({});

    await approveAndRemember(chat, source);
    fs.writeFileSync(
      path.join(source, "plugin.json"),
      JSON.stringify(tipsyManifest({ providerKeys: ["cursor"] })),
      "utf8",
    );
    await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    expect(calls).toHaveLength(2);
  });

  it("puts the declared project secrets on the card before anyone agrees", async () => {
    const source = pluginDir(tipsyManifest({ projectSecrets: ["STRIPE_API_KEY"] }));
    const { chat, calls } = chatMock({});

    await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    expect(calls[0]!.body).toContain("Reads this project's secrets (.env): STRIPE_API_KEY");
  });

  it("asks again when a later save adds a project secret", async () => {
    const source = pluginDir(tipsyManifest({ projectSecrets: ["STRIPE_API_KEY"] }));
    const { chat, calls } = chatMock({});

    await approveAndRemember(chat, source);
    // The reader agreed to one secret by name. A second one is a widening of
    // the most sensitive read on the card, so the card comes back and prints it.
    fs.writeFileSync(
      path.join(source, "plugin.json"),
      JSON.stringify(tipsyManifest({ projectSecrets: ["STRIPE_API_KEY", "OPENAI_API_KEY"] })),
      "utf8",
    );
    await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain("OPENAI_API_KEY");
  });

  it("still skips the card when only the plugin's code changed", async () => {
    const source = pluginDir(tipsyManifest({ network: { hosts: ["api.cursor.com"] } }));
    const { chat, calls } = chatMock({});

    await approveAndRemember(chat, source);
    // A new version at the same path with the same declarations is the
    // build-test-fix loop, and re-approving every save would make it unusable.
    fs.writeFileSync(
      path.join(source, "plugin.json"),
      JSON.stringify(tipsyManifest({ version: "0.3.1", network: { hosts: ["api.cursor.com"] } })),
      "utf8",
    );
    const second = await requestPluginInstallApproval({
      chat, chatSessionId: "chat-1", projectId: "project-1", source, builtinPluginsRoot: null,
    });

    expect(second.allow && second.reason).toBe("preapproved");
    expect(calls).toHaveLength(1);
  });
});

describe("plugin removal, disable and enable approval", () => {
  beforeEach(() => {
    resetPluginInstallApprovalsForTests();
  });

  afterEach(() => {
    while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  /** The parsed manifest a host would have on disk for an installed plugin. */
  function installedManifest(overrides: Record<string, unknown> = {}): PluginManifest {
    const parsed = parsePluginManifestJson(JSON.stringify(tipsyManifest(overrides)));
    if (!parsed.manifest) throw new Error(`fixture manifest did not parse: ${parsed.errors.join(", ")}`);
    return parsed.manifest;
  }

  function removalChat(response: {
    decision?: string;
    answers?: Record<string, string[]>;
    hang?: boolean;
  }): ReturnType<typeof chatMock> {
    return chatMock({
      answers: { plugin_lifecycle: ["proceed"] },
      ...response,
    });
  }

  it("asks with the plugin's own name, version and surfaces, and proceeds on accept", async () => {
    const { chat, calls } = removalChat({});

    const result = await requestPluginRemovalApproval({
      chat,
      chatSessionId: "session-1",
      kind: "uninstall",
      pluginId: "ade-tipsy",
      displayName: "Tipsy",
      version: "0.3.0",
      manifest: installedManifest({ collections: { drinks: { sync: true } } }),
    });

    expect(result.allow).toBe(true);
    const card = calls[0]!;
    expect(card.title).toBe("Remove Tipsy 0.3.0?");
    expect(card.operatorOnly).toBe(true);
    expect(card.body).toContain("Removes:");
    expect(card.body).toContain("- Tipsy tab");
    expect(card.body).toContain("- Its addition to Work");
    expect(card.body).toContain("- One agent skill");
    expect(card.body).toContain("- Terminal commands: ade ade-tipsy status");
    // The line that decides whether this is a cheap yes.
    expect(card.body).toContain("deleted here and on your other devices");
    // The card IS the disclosure: without `description` the composer falls back
    // to the question, and the reader approves a deletion having read a title.
    expect(card.description).toBe(card.body);
    expect(card.questions?.[0]?.options?.map((option) => option.label)).toEqual(["Remove", "Keep"]);
  });

  it("refuses with a verb-specific kind when the person declines", async () => {
    const { chat } = removalChat({ decision: "decline", answers: { plugin_lifecycle: ["keep"] } });

    const result = await requestPluginRemovalApproval({
      chat,
      chatSessionId: "session-1",
      kind: "uninstall",
      pluginId: "ade-tipsy",
      displayName: "Tipsy",
      version: "0.3.0",
      manifest: installedManifest(),
    });

    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("unreachable");
    expect(result.reason).toBe("denied");
    expect(result.data.kind).toBe("plugin_uninstall_denied");
    expect(result.message).toContain("Don't retry");
  });

  it("reads an accept decision that names the deny option as a refusal", async () => {
    // Both gates have to agree, exactly as the install card requires.
    const { chat } = removalChat({ decision: "accept", answers: { plugin_lifecycle: ["keep"] } });

    const result = await requestPluginRemovalApproval({
      chat,
      chatSessionId: "session-1",
      kind: "disable",
      pluginId: "ade-tipsy",
      displayName: "Tipsy",
      version: null,
      manifest: installedManifest(),
    });

    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("unreachable");
    expect(result.data.kind).toBe("plugin_disable_denied");
  });

  it("settles the card and reports a verb-specific timeout when nobody answers", async () => {
    const { chat, responded } = removalChat({ hang: true });

    const result = await requestPluginRemovalApproval({
      chat,
      chatSessionId: "session-1",
      kind: "enable",
      pluginId: "ade-tipsy",
      displayName: "Tipsy",
      version: null,
      manifest: installedManifest(),
      timeoutMs: 5,
    });

    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("unreachable");
    expect(result.data.kind).toBe("plugin_enable_approval_timed_out");
    expect(responded).toEqual([{ itemId: "item-1", decision: "cancel" }]);
  });

  it("words disable and enable as switches that keep the data", async () => {
    const manifest = installedManifest({ collections: { drinks: { sync: false } } });

    const off = removalChat({});
    await requestPluginRemovalApproval({
      chat: off.chat,
      chatSessionId: "session-1",
      kind: "disable",
      pluginId: "ade-tipsy",
      displayName: "Tipsy",
      version: "0.3.0",
      manifest,
    });
    expect(off.calls[0]?.title).toBe("Turn off Tipsy?");
    expect(off.calls[0]?.body).toContain("Turns off:");
    expect(off.calls[0]?.body).toContain("Its stored data and settings stay.");
    expect(off.calls[0]?.questions?.[0]?.options?.map((option) => option.label))
      .toEqual(["Turn off", "Leave on"]);

    const on = removalChat({});
    await requestPluginRemovalApproval({
      chat: on.chat,
      chatSessionId: "session-1",
      kind: "enable",
      pluginId: "ade-tipsy",
      displayName: "Tipsy",
      version: "0.3.0",
      manifest,
    });
    expect(on.calls[0]?.title).toBe("Turn on Tipsy?");
    expect(on.calls[0]?.body).toContain("Turns on:");
    expect(on.calls[0]?.questions?.[0]?.options?.map((option) => option.label))
      .toEqual(["Turn on", "Leave off"]);
  });

  it("says so when it cannot read the plugin's manifest, rather than listing nothing", async () => {
    const { chat, calls } = removalChat({});

    await requestPluginRemovalApproval({
      chat,
      chatSessionId: "session-1",
      kind: "uninstall",
      pluginId: "ade-tipsy",
      displayName: "ade-tipsy",
      version: null,
      manifest: null,
    });

    expect(calls[0]?.body).toContain("ADE can't read ade-tipsy's plugin.json");
  });

  it("is never pre-approved by an approved install of the same plugin", async () => {
    // The install of this exact plugin from this exact directory is approved and
    // remembered, so a second install would not ask. Removal still asks.
    const source = pluginDir(tipsyManifest());
    const installChat = chatMock({});
    const installed = await requestPluginInstallApproval({
      chat: installChat.chat,
      chatSessionId: "session-1",
      projectId: "project-1",
      source,
    });
    expect(installed.allow).toBe(true);
    if (!installed.allow) throw new Error("unreachable");
    recordPluginInstallApproval({
      projectId: "project-1",
      pluginId: installed.pluginId!,
      canonicalSource: installed.canonicalSource!,
      grant: installed.grant,
    });
    expect(isPluginInstallPreapproved({
      projectId: "project-1",
      pluginId: "ade-tipsy",
      canonicalSource: installed.canonicalSource!,
      grant: installed.grant,
    })).toBe(true);

    const removal = removalChat({});
    const result = await requestPluginRemovalApproval({
      chat: removal.chat,
      chatSessionId: "session-1",
      kind: "uninstall",
      pluginId: "ade-tipsy",
      displayName: "Tipsy",
      version: "0.3.0",
      manifest: installedManifest(),
    });

    expect(result.allow).toBe(true);
    // The whole assertion: it ASKED. A remembered install approval is not
    // consent to delete, and there is no branch here that could make it one.
    expect(removal.calls).toHaveLength(1);
    expect(removal.calls[0]?.title).toBe("Remove Tipsy 0.3.0?");
  });

  it("records nothing, so a second removal of the same plugin asks again", async () => {
    for (const _ of [0, 1]) {
      const { chat, calls } = removalChat({});
      await requestPluginRemovalApproval({
        chat,
        chatSessionId: "session-1",
        kind: "uninstall",
        pluginId: "ade-tipsy",
        displayName: "Tipsy",
        version: "0.3.0",
        manifest: installedManifest(),
      });
      expect(calls).toHaveLength(1);
    }
  });
});

/**
 * Who the card says is asking.
 *
 * Every one of these gates travels as `source: "ade"` — the host is the one
 * raising it — so without an origin the reader gets ADE's mark and the word
 * "ADE" above a decision about somebody else's code. Reported three rounds
 * running before this existed.
 */
describe("plugin approval card identity", () => {
  beforeEach(() => {
    resetPluginInstallApprovalsForTests();
  });

  afterEach(() => {
    while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  function manifestOf(overrides: Record<string, unknown> = {}): PluginManifest {
    const parsed = parsePluginManifestJson(JSON.stringify(tipsyManifest(overrides)));
    if (!parsed.manifest) throw new Error(`fixture manifest did not parse: ${parsed.errors.join(", ")}`);
    return parsed.manifest;
  }

  it("names the plugin, not the host, on the install card", async () => {
    const source = pluginDir(tipsyManifest({ icon: "timer", accent: "#7C6FF0" }));
    const { chat, calls } = chatMock({});

    await requestPluginInstallApproval({
      chat,
      chatSessionId: "chat-1",
      projectId: "project-1",
      source,
      builtinPluginsRoot: null,
    });

    expect(calls[0]?.source).toBe("ade");
    expect(calls[0]?.origin).toEqual({
      kind: "plugin",
      pluginId: "ade-tipsy",
      displayName: "Tipsy",
      icon: "timer",
      accent: "#7C6FF0",
    });
  });

  it("carries the identity on the remove, turn-off and turn-on cards too", async () => {
    for (const kind of ["uninstall", "disable", "enable"] as const) {
      const { chat, calls } = chatMock({ answers: { plugin_lifecycle: ["proceed"] } });
      await requestPluginRemovalApproval({
        chat,
        chatSessionId: "session-1",
        kind,
        pluginId: "ade-tipsy",
        displayName: "Tipsy",
        version: "0.3.0",
        manifest: manifestOf({ icon: "timer" }),
      });
      expect(calls[0]?.origin, kind).toEqual({
        kind: "plugin",
        pluginId: "ade-tipsy",
        displayName: "Tipsy",
        icon: "timer",
      });
    }
  });

  it("omits the icon a manifest never declared rather than inventing one", async () => {
    // Absent means "derive it from the id", which is what the Marketplace does
    // for the same plugin. A default written in here would be a second answer.
    const source = pluginDir(tipsyManifest());
    const { chat, calls } = chatMock({});
    await requestPluginInstallApproval({
      chat,
      chatSessionId: "chat-1",
      projectId: null,
      source,
      builtinPluginsRoot: null,
    });
    expect(calls[0]?.origin).toEqual({
      kind: "plugin",
      pluginId: "ade-tipsy",
      displayName: "Tipsy",
    });
  });

  it("names nobody for a git source, because nothing has read its manifest", async () => {
    // The honest branch: this card genuinely does not know which plugin it is
    // about, so it falls back to ADE's own mark instead of drawing a name the
    // host cannot vouch for.
    const { chat, calls } = chatMock({});
    await requestPluginInstallApproval({
      chat,
      chatSessionId: "chat-1",
      projectId: "project-1",
      source: "https://github.com/someone/some-plugin",
      builtinPluginsRoot: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.origin).toBeUndefined();
  });
});
