import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  createPluginChatPresenceRegistry,
  describePluginChatRuntime,
  findPluginChatRuntimeWriterForProjectRoot,
  getPluginChatRuntimeDelivery,
  registerPluginChatRuntimeWriter,
  requirePluginChatWriteTarget,
  resetPluginChatRuntimeForTests,
  setPluginChatRuntimeDelivery,
  type PluginChatRuntimeWriter,
} from "./pluginChatRuntime";
import { PluginSdkError } from "../../../shared/plugins/sdk";
import type { AgentChatRuntimeRef } from "../../../shared/types/chat";

function makeWriter(
  projectRoot: string,
  owners: Record<string, AgentChatRuntimeRef>,
): PluginChatRuntimeWriter {
  return {
    projectRoot,
    ownerOf: (sessionId) => owners[sessionId] ?? null,
    createSession: vi.fn(async () => ({
      sessionId: "created",
      runtimeId: "cloud",
      externalId: "ext",
      created: true,
    })),
    appendAssistant: vi.fn(async () => undefined),
    appendUser: vi.fn(async () => undefined),
    emitStatus: vi.fn(async () => undefined),
    setArtifacts: vi.fn(async () => undefined),
    attachBranch: vi.fn(async () => undefined),
    hydrate: vi.fn(async () => undefined),
  };
}

const OWNED: AgentChatRuntimeRef = { pluginId: "ade-cursor-cloud", runtimeId: "cloud", externalId: "bc-1" };

describe("requirePluginChatWriteTarget", () => {
  beforeEach(() => {
    resetPluginChatRuntimeForTests();
  });

  it("resolves the writer that owns the session for its own plugin", () => {
    const writer = makeWriter("/repo", { "session-1": OWNED });
    registerPluginChatRuntimeWriter(writer);

    const target = requirePluginChatWriteTarget("ade-cursor-cloud", "session-1");
    expect(target.writer).toBe(writer);
    expect(target.ref).toEqual(OWNED);
  });

  it("refuses a session owned by a different plugin", () => {
    registerPluginChatRuntimeWriter(makeWriter("/repo", { "session-1": OWNED }));

    // The whole security story of the seam: a plugin may write words a user
    // reads as an agent's, so the only question that matters is WHICH
    // conversation — and it does not get to answer it.
    expect(() => requirePluginChatWriteTarget("ade-evil", "session-1"))
      .toThrowError(/does not own chat session/i);
    try {
      requirePluginChatWriteTarget("ade-evil", "session-1");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginSdkError);
      expect((error as PluginSdkError).code).toBe("not_permitted");
    }
  });

  it("gives the same refusal for an unowned session, an unknown one, and no host at all", () => {
    const messages: string[] = [];
    const collect = (pluginId: string, sessionId: string): void => {
      try {
        requirePluginChatWriteTarget(pluginId, sessionId);
      } catch (error) {
        messages.push((error as Error).message);
      }
    };

    // No writers registered at all.
    collect("ade-cursor-cloud", "session-1");
    registerPluginChatRuntimeWriter(makeWriter("/repo", { "session-1": OWNED }));
    // A session this writer does not know.
    collect("ade-cursor-cloud", "session-unknown");
    // A session owned by somebody else.
    collect("ade-other", "session-1");

    expect(messages).toHaveLength(3);
    // Identical wording on purpose: a caller that could tell these apart could
    // enumerate the machine's sessions and their owners by probing this verb.
    expect(new Set(messages.map((message) => message.replace(/"[^"]*"/, '"X"')))).toHaveLength(1);
  });

  it("stops at the first writer that claims the session, across projects", () => {
    registerPluginChatRuntimeWriter(makeWriter("/repo-a", {}));
    const owner = makeWriter("/repo-b", { "session-1": OWNED });
    registerPluginChatRuntimeWriter(owner);

    expect(requirePluginChatWriteTarget("ade-cursor-cloud", "session-1").writer).toBe(owner);
  });

  it("stops resolving once a writer detaches", () => {
    const detach = registerPluginChatRuntimeWriter(makeWriter("/repo", { "session-1": OWNED }));
    expect(requirePluginChatWriteTarget("ade-cursor-cloud", "session-1")).toBeTruthy();
    detach();
    expect(() => requirePluginChatWriteTarget("ade-cursor-cloud", "session-1")).toThrowError();
  });
});

describe("findPluginChatRuntimeWriterForProjectRoot", () => {
  beforeEach(() => {
    resetPluginChatRuntimeForTests();
  });

  it("matches on the absolute checkout, and answers null for anything else", () => {
    const writer = makeWriter("/repo-a", {});
    registerPluginChatRuntimeWriter(writer);
    registerPluginChatRuntimeWriter(makeWriter("/repo-b", {}));

    expect(findPluginChatRuntimeWriterForProjectRoot("/repo-a")).toBe(writer);
    expect(findPluginChatRuntimeWriterForProjectRoot("/repo-c")).toBeNull();
    expect(findPluginChatRuntimeWriterForProjectRoot(null)).toBeNull();
    expect(findPluginChatRuntimeWriterForProjectRoot("")).toBeNull();
  });

  it("folds separators and a trailing slash, so Windows spellings still match", () => {
    // The same directory reaches the two sides spelled differently on Windows —
    // `C:\\repo` from one record, `C:/repo/` from another — and an exact
    // compare would answer "no such project" for a project that is plainly open.
    const writer = makeWriter("C:\\repo\\ade", {});
    registerPluginChatRuntimeWriter(writer);
    expect(findPluginChatRuntimeWriterForProjectRoot("C:/repo/ade")).toBe(writer);
    expect(findPluginChatRuntimeWriterForProjectRoot("C:\\repo\\ade\\")).toBe(writer);
    // Case folds only where the filesystem folds it: on Linux `/repo` and
    // `/Repo` really are two directories.
    expect(findPluginChatRuntimeWriterForProjectRoot("c:/repo/ade"))
      .toBe(process.platform === "win32" ? writer : null);
  });
});

describe("describePluginChatRuntime", () => {
  beforeEach(() => {
    resetPluginChatRuntimeForTests();
  });

  it("answers null with no host attached, rather than throwing into a turn path", () => {
    expect(getPluginChatRuntimeDelivery()).toBeNull();
    expect(describePluginChatRuntime(OWNED)).toBeNull();
  });

  it("answers null when the host itself throws mid-teardown", () => {
    setPluginChatRuntimeDelivery({
      deliverTurn: vi.fn(async () => undefined),
      deliverInterrupt: vi.fn(async () => undefined),
      notifyPresence: vi.fn(),
      describe: () => {
        throw new Error("host is going away");
      },
    });
    expect(describePluginChatRuntime(OWNED)).toBeNull();
  });

  it("hands back what the host resolved from the manifest", () => {
    setPluginChatRuntimeDelivery({
      deliverTurn: vi.fn(async () => undefined),
      deliverInterrupt: vi.fn(async () => undefined),
      notifyPresence: vi.fn(),
      describe: () => ({
        displayName: "Cursor Cloud",
        icon: "Cloud",
        pluginDisplayName: "Cursor Cloud",
        capabilities: { followUp: true, interrupt: true, hydrate: true, artifacts: true },
      }),
    });
    expect(describePluginChatRuntime(OWNED)?.displayName).toBe("Cursor Cloud");
    expect(describePluginChatRuntime(null)).toBeNull();
  });
});

describe("createPluginChatPresenceRegistry", () => {
  it("reports only the 0→1 and 1→0 transitions", () => {
    const changes: [string, boolean][] = [];
    const registry = createPluginChatPresenceRegistry({
      onChange: (sessionId, watching) => changes.push([sessionId, watching]),
    });

    // A desktop pane and a phone on the same conversation must produce ONE
    // `chat.opened` between them, or the plugin's poll ladder restarts every
    // time a second viewer appears.
    registry.watch({ sessionId: "s1", watching: true });
    registry.watch({ sessionId: "s1", watching: true });
    expect(changes).toEqual([["s1", true]]);
    expect(registry.isWatched("s1")).toBe(true);

    registry.watch({ sessionId: "s1", watching: false });
    expect(changes).toEqual([["s1", true]]);
    expect(registry.isWatched("s1")).toBe(true);

    registry.watch({ sessionId: "s1", watching: false });
    expect(changes).toEqual([["s1", true], ["s1", false]]);
    expect(registry.isWatched("s1")).toBe(false);
  });

  it("ignores an unwatch for a session nobody opened", () => {
    const changes: [string, boolean][] = [];
    const registry = createPluginChatPresenceRegistry({
      onChange: (sessionId, watching) => changes.push([sessionId, watching]),
    });
    registry.watch({ sessionId: "s1", watching: false });
    expect(changes).toEqual([]);
    expect(registry.isWatched("s1")).toBe(false);
  });

  it("tells the plugin about every session it clears, rather than merely forgetting", () => {
    const changes: [string, boolean][] = [];
    const registry = createPluginChatPresenceRegistry({
      onChange: (sessionId, watching) => changes.push([sessionId, watching]),
    });
    registry.watch({ sessionId: "s1", watching: true });
    registry.watch({ sessionId: "s2", watching: true });
    registry.watch({ sessionId: "s2", watching: true });
    changes.length = 0;

    // A plugin left believing somebody is watching polls a dead conversation
    // until its child restarts.
    registry.clearAll();
    expect(changes.sort()).toEqual([["s1", false], ["s2", false]]);
    expect(registry.isWatched("s1")).toBe(false);
    expect(registry.isWatched("s2")).toBe(false);
  });
});
