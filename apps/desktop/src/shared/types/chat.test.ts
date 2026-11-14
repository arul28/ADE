import { describe, expect, it } from "vitest";
import { ACTIVE_TURN_DISPATCH_MODES, providerSupportsLiveRedirect, droidPermissionModeFromLegacyPermissionMode, isAgentChatDroidPermissionMode, legacyPermissionModeFromDroidPermissionMode, activeTurnDispatchModes, activeTurnInlineAttachmentBlock, activeTurnInterruptContinues, cursorSessionRunsInCloud, defaultActiveTurnDispatchMode, inferAttachmentType, isHeicAttachment, mergeAttachments, providerSupportsCrossMachineHandoffFork, providerSupportsHandoffFork, supportsActiveTurnDispatchMode, unsupportedActiveTurnDispatchModeMessage, spawnCompletedNoticeMessage, spawnCompletionDeliveryFailedNoticeMessage, spawnParentGoneNoticeMessage, type AgentChatFileRef } from "./chat";

describe("Droid permission vocabulary", () => {
  it("validates native tiers and converts the shared legacy ladder", () => {
    expect(isAgentChatDroidPermissionMode("auto-high")).toBe(true);
    expect(isAgentChatDroidPermissionMode("AUTO-HIGH")).toBe(false);
    expect(isAgentChatDroidPermissionMode("unknown")).toBe(false);
    expect(droidPermissionModeFromLegacyPermissionMode("default")).toBe("auto-medium");
    expect(droidPermissionModeFromLegacyPermissionMode("full-auto")).toBe("auto-high");
    expect(legacyPermissionModeFromDroidPermissionMode("auto-medium")).toBe("default");
    expect(legacyPermissionModeFromDroidPermissionMode("agi")).toBeUndefined();
  });
});

describe("active-turn dispatch modes", () => {
  it("is the one table every surface reads: OpenCode supports inline and queued turns", () => {
    expect(activeTurnDispatchModes("claude")).toEqual(["inline", "queue", "interrupt"]);
    // Codex's app-server takes `turn/steer` into the running turn — the service
    // has always sent it; the table was the thing that never said so.
    expect(activeTurnDispatchModes("codex")).toEqual(["inline", "queue"]);
    // Cursor gained inline with `Run.steer()` in @cursor/sdk 1.0.31.
    expect(activeTurnDispatchModes("cursor")).toEqual(["inline", "queue", "interrupt"]);
    expect(activeTurnDispatchModes("opencode")).toEqual(["inline", "queue"]);
    for (const provider of ["droid", "pi", "qwen", "unknown-provider", undefined]) {
      expect(activeTurnDispatchModes(provider)).toEqual(["queue"]);
    }
  });

  it("keeps an attachment-bearing Cursor steer off the running turn", () => {
    const image = activeTurnInlineAttachmentBlock("cursor", {
      attachments: [{ path: "shot.png", type: "image" }],
      contextAttachmentCount: 0,
    });
    const file = activeTurnInlineAttachmentBlock("cursor", {
      attachments: [{ path: "notes.txt", type: "file" }],
      contextAttachmentCount: 0,
    });
    expect(image).toMatch(/^Images can't join a running /);
    expect(file).toMatch(/^Attachments can't join a running /);
    expect(activeTurnInlineAttachmentBlock("claude", {
      attachments: [{ path: "shot.png", type: "image" }],
      contextAttachmentCount: 0,
    })).toBeNull();
    expect(activeTurnInlineAttachmentBlock("cursor", {
      attachments: [],
      contextAttachmentCount: 0,
    })).toBeNull();
  });

  it("defaults to the first mode in menu order", () => {
    expect(defaultActiveTurnDispatchMode("claude")).toBe("inline");
    expect(defaultActiveTurnDispatchMode("codex")).toBe("inline");
    expect(defaultActiveTurnDispatchMode("cursor")).toBe("inline");
    expect(defaultActiveTurnDispatchMode("opencode")).toBe("inline");
    expect(defaultActiveTurnDispatchMode("droid")).toBe("queue");
  });

  it("reads a Cursor session as cloud from either field, and never for another provider", () => {
    // The legacy branch is the one that silently regresses: `cursorRuntime` is
    // only ever written as "cloud", so a session promoted before that field
    // existed carries nothing but `cursorCloudAgentId`.
    expect(cursorSessionRunsInCloud({ provider: "cursor", cursorRuntime: "cloud" })).toBe(true);
    expect(cursorSessionRunsInCloud({ provider: "cursor", cursorCloudAgentId: "agent-1" })).toBe(true);
    expect(cursorSessionRunsInCloud({ provider: "cursor", cursorRuntime: "local", cursorCloudAgentId: "agent-1" })).toBe(false);
    expect(cursorSessionRunsInCloud({ provider: "cursor" })).toBe(false);
    // A cloud agent id on another provider means something else entirely.
    expect(cursorSessionRunsInCloud({ provider: "claude", cursorCloudAgentId: "agent-1" })).toBe(false);
    expect(cursorSessionRunsInCloud(null)).toBe(false);
  });

  it("says which providers' interrupt continues the same thread, so all three surfaces label it alike", () => {
    // Cursor's interrupt is cancel + resend on the same agent thread, so the
    // affordance reads "continue"; Claude's redirects a live query.
    expect(activeTurnInterruptContinues("cursor")).toBe(true);
    expect(activeTurnInterruptContinues("claude")).toBe(false);
    expect(activeTurnInterruptContinues(undefined)).toBe(false);
  });

  it("accepts both atomic modes on Cursor and only inline on Codex", () => {
    expect(supportsActiveTurnDispatchMode("cursor", "interrupt")).toBe(true);
    expect(supportsActiveTurnDispatchMode("cursor", "inline")).toBe(true);
    // Codex gained inline, not interrupt: there is no cancel-and-resend.
    expect(supportsActiveTurnDispatchMode("codex", "inline")).toBe(true);
    expect(supportsActiveTurnDispatchMode("codex", "interrupt")).toBe(false);
    // The host rejection the renderer shows verbatim. Cursor now
    // names both modes, so the sentence pluralises.
    expect(unsupportedActiveTurnDispatchModeMessage("cursor", "nonsense"))
      .toBe("Cursor sessions support only the \"inline\" and \"interrupt\" active-turn dispatch modes.");
    expect(unsupportedActiveTurnDispatchModeMessage("codex", "interrupt"))
      .toBe("Codex sessions support only the \"inline\" active-turn dispatch mode.");
    expect(unsupportedActiveTurnDispatchModeMessage("droid", "interrupt"))
      .toContain("don't support");
  });
});

describe("CTO live-redirect providers", () => {
  it.each([
    ["claude", true],
    ["codex", true],
    ["cursor", true],
    ["opencode", true],
    ["  CURSOR ", true],
    ["droid", false],
    ["pi", false],
    ["muse", false],
    ["qwen", false],
    ["kimi", false],
    ["grok", false],
    ["copilot", false],
    ["devin", false],
    ["antigravity", false],
    ["", false],
  ])("providerSupportsLiveRedirect(%j) is %s", (provider, expected) => {
    expect(providerSupportsLiveRedirect(provider)).toBe(expected);
  });

  it("is its own contract, not a read of the composer's dispatch table", () => {
    // No single dispatch mode keys this list. Codex redirects a live turn but
    // has no "interrupt" — it folds a `turn/steer` request in and cannot cancel
    // and resend — so a derivation keyed off either atomic mode would get one
    // provider wrong. Keeping this list a literal is what stops a composer-menu
    // edit from quietly changing who is allowed to be the CTO.
    const interruptCapable = Object.entries(ACTIVE_TURN_DISPATCH_MODES)
      .filter(([, modes]) => modes?.includes("interrupt"))
      .map(([provider]) => provider);
    expect(interruptCapable).not.toContain("codex");
    expect(providerSupportsLiveRedirect("codex")).toBe(true);
  });
});

describe("handoff fork provider support", () => {
  it("forks every handoff-capable provider across machines too, through transcript replay", () => {
    expect(providerSupportsHandoffFork("droid")).toBe(true);
    expect(providerSupportsHandoffFork("cursor")).toBe(true);
    expect(providerSupportsCrossMachineHandoffFork("droid")).toBe(true);
    expect(providerSupportsCrossMachineHandoffFork("claude")).toBe(true);
    expect(providerSupportsCrossMachineHandoffFork("codex")).toBe(true);
    expect(providerSupportsCrossMachineHandoffFork("opencode")).toBe(true);
    expect(providerSupportsCrossMachineHandoffFork("cursor")).toBe(true);
    expect(providerSupportsCrossMachineHandoffFork("unknown-provider")).toBe(false);
  });
});

describe("inferAttachmentType", () => {
  it.each([
    ["an image MIME type", "file.bin", "image/png", "image"],
    ["an upper-case HEIC MIME type", "file.bin", "IMAGE/HEIC", "image"],
    ["an image extension, any case", "photo.PNG", undefined, "image"],
    ["a tif extension", "photo.tif", undefined, "image"],
    ["a non-image extension", "doc.pdf", undefined, "file"],
    ["a non-image MIME with an image extension", "fake.png", "application/octet-stream", "image"],
    ["a non-image MIME with a non-image extension", "file.txt", "application/octet-stream", "file"],
    ["an image MIME over a non-image extension", "file.txt", "image/png", "image"],
    ["a null MIME and a non-image extension", "file.ts", null, "file"],
    ["a null MIME and an image extension", "photo.jpg", null, "image"],
  ])("infers %s", (_name, file, mime, type) => {
    expect(inferAttachmentType(file, mime)).toBe(type);
  });

  it.each([
    ["photo.heic", undefined, true],
    ["photo.HEIF", undefined, true],
    ["photo.bin", "image/heic; codecs=hevc", true],
    ["photo.bin", "image/heif-sequence", true],
    ["photo.jpg", "image/jpeg", false],
  ])("recognizes HEIC/HEIF for %s %s as %s", (file, mime, expected) => {
    expect(isHeicAttachment(file, mime)).toBe(expected);
  });
});

describe("mergeAttachments", () => {
  it("dedupes by path with last write winning, drops blank incoming paths, and keeps current first", () => {
    const current: AgentChatFileRef[] = [
      { path: "/a.ts", type: "file" },
      { path: "/b.png", type: "image" },
    ];
    const incoming: AgentChatFileRef[] = [
      { path: "/b.png", type: "file" },
      { path: "", type: "file" },
      { path: "  ", type: "image" },
      { path: "/c.md", type: "file" },
    ];

    const result = mergeAttachments(current, incoming);
    expect(result.map((a) => a.path)).toEqual(["/a.ts", "/b.png", "/c.md"]);
    expect(result.find((a) => a.path === "/b.png")!.type).toBe("file");
  });

  it("treats an empty side as the other list, still filtering blank paths", () => {
    expect(mergeAttachments([], [])).toEqual([]);
    expect(mergeAttachments([{ path: "/a.ts", type: "file" }], [])).toEqual([{ path: "/a.ts", type: "file" }]);
    expect(mergeAttachments([], [{ path: "", type: "file" }, { path: "/a.ts", type: "file" }])).toEqual([{ path: "/a.ts", type: "file" }]);
  });

  it("deduplicates image-url attachments by path field", () => {
    const incoming: AgentChatFileRef[] = [
      { path: "https://example.com/old.png", type: "image-url", url: "https://example.com/old.png?cache=1" },
    ];
    const result = mergeAttachments(
      [{ path: "https://example.com/old.png", type: "image-url", url: "https://example.com/old.png" }],
      incoming,
    );
    expect(result).toEqual(incoming);
  });
});

describe("spawn parent-gone copy", () => {
  it("keeps user-facing notices free of session ids and recovery commands", () => {
    expect(spawnParentGoneNoticeMessage()).toMatch(/deleted/);
    expect(spawnParentGoneNoticeMessage()).not.toMatch(/messageSession|ADE_PARENT/);
    expect(spawnCompletionDeliveryFailedNoticeMessage()).not.toMatch(/messageSession|ADE_PARENT/);
    expect(spawnCompletedNoticeMessage("Docs")).toBe('Chat "Docs" finished its turn');
  });
});
