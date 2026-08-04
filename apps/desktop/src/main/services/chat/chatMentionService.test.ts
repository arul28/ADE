import { describe, expect, it, vi } from "vitest";

import { createChatMentionService, type ChatMentionServiceDeps } from "./chatMentionService";
import { renderChatMentionBlock } from "../../../shared/chatMentions";
import type { AgentChatSessionSummary } from "../../../shared/types/chat";
import type { LaneStatus, LaneSummary } from "../../../shared/types/lanes";
import type { ChatTerminalSession } from "../../../shared/types/sessions";

/** Real `LaneStatus` shape — it is an object, never a string. */
const laneStatus = (over: Partial<LaneStatus> = {}): LaneStatus => ({
  dirty: false,
  ahead: 0,
  behind: 0,
  remoteBehind: 0,
  rebaseInProgress: false,
  ...over,
});

const session = (over: Partial<AgentChatSessionSummary> & { sessionId: string }) =>
  ({
    laneId: "lane-1",
    provider: "claude",
    model: "anthropic/claude-opus-5",
    status: "idle",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-08-01T00:00:00.000Z",
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
    ...over,
  }) as AgentChatSessionSummary;

const lane = (over: Partial<LaneSummary> & { id: string; name: string }) =>
  ({
    laneType: "worktree",
    baseRef: "main",
    branchRef: `ade/${over.name}`,
    worktreePath: `/repo/.ade/worktrees/${over.name}`,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: laneStatus(),
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  }) as LaneSummary;

const terminal = (over: Partial<ChatTerminalSession> & { terminalId: string; title: string }) =>
  ({
    ptyId: "pty-1",
    chatSessionId: null,
    laneId: "lane-1",
    laneName: "fix-login",
    toolType: null,
    goal: null,
    status: "running",
    runtimeState: "running",
    active: true,
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: null,
    exitCode: null,
    pid: 1,
    resumeCommand: null,
    lastOutputPreview: null,
    summary: null,
    ...over,
  }) as ChatTerminalSession;

function makeService(over: Partial<ChatMentionServiceDeps> = {}) {
  const deps: ChatMentionServiceDeps = {
    listChatSessions: async () => [
      session({ sessionId: "s-old", title: "Old chat", lastActivityAt: "2026-08-01T00:00:00.000Z" }),
      session({ sessionId: "s-new", title: "Login redirect", lastActivityAt: "2026-08-03T00:00:00.000Z" }),
    ],
    readChatTranscript: async () => ({ entries: [] }),
    listLanes: async () => [lane({ id: "lane-1", name: "fix-login" })],
    listPrs: null,
    listTerminals: () => [terminal({ terminalId: "t-1", title: "npm test" })],
    previewTerminal: null,
    ...over,
  };
  return { service: createChatMentionService(deps), deps };
}

describe("listChatMentionSuggestions", () => {
  it("returns most-recent-first per kind for an empty query", async () => {
    const { service } = makeService();
    const { suggestions } = await service.listChatMentionSuggestions({ query: "" });
    const chats = suggestions.filter((s) => s.kind === "chat");
    expect(chats.map((s) => s.id)).toEqual(["s-new", "s-old"]);
    expect(suggestions.some((s) => s.kind === "lane" && s.id === "lane-1")).toBe(true);
    expect(suggestions.some((s) => s.kind === "terminal" && s.id === "t-1")).toBe(true);
  });

  it("filters by fuzzy title match when a query is typed", async () => {
    const { service } = makeService();
    const { suggestions } = await service.listChatMentionSuggestions({ query: "redirect" });
    expect(suggestions.map((s) => s.id)).toEqual(["s-new"]);
  });

  it("excludes archived and personal chats and the calling session", async () => {
    const { service } = makeService({
      listChatSessions: async () => [
        session({ sessionId: "keep", title: "Keep me" }),
        session({ sessionId: "self", title: "Self" }),
        session({ sessionId: "archived", title: "Archived", archivedAt: "2026-08-02T00:00:00.000Z" }),
        session({ sessionId: "personal", title: "Personal", surface: "personal" }),
      ],
    });
    const { suggestions } = await service.listChatMentionSuggestions({
      query: "",
      excludeSessionId: "self",
    });
    expect(suggestions.filter((s) => s.kind === "chat").map((s) => s.id)).toEqual(["keep"]);
  });

  it("excludes archived lanes", async () => {
    const { service } = makeService({
      listLanes: async () => [
        lane({ id: "l-live", name: "live" }),
        lane({ id: "l-gone", name: "gone", archivedAt: "2026-08-02T00:00:00.000Z" }),
      ],
    });
    const { suggestions } = await service.listChatMentionSuggestions({});
    expect(suggestions.filter((s) => s.kind === "lane").map((s) => s.id)).toEqual(["l-live"]);
  });

  it("caps results per kind so one kind cannot crowd out the others", async () => {
    const { service } = makeService({
      listChatSessions: async () =>
        Array.from({ length: 30 }, (_, i) =>
          session({ sessionId: `s${i}`, title: `Chat ${i}` })),
    });
    const { suggestions } = await service.listChatMentionSuggestions({ query: "" });
    expect(suggestions.filter((s) => s.kind === "chat")).toHaveLength(8);
    expect(suggestions.filter((s) => s.kind === "lane").length).toBeGreaterThan(0);
  });

  // Lanes reach this service without a status probe (includeStatus:false), and
  // laneService fills an indistinguishable default in that mode — so no git
  // state may be derived from `lane.status` at all, only the branch shown.
  it("never derives subtitle text from the unmeasured LaneStatus object", async () => {
    const { service } = makeService({
      listLanes: async () => [
        lane({ id: "l-dirty", name: "fix-login", status: laneStatus({ dirty: true, ahead: 2 }) }),
        lane({ id: "l-clean", name: "chore", status: laneStatus({ behind: 3 }) }),
      ],
    });
    const { suggestions } = await service.listChatMentionSuggestions({});
    const byId = new Map(suggestions.map((s) => [s.id, s.subtitle]));
    expect(byId.get("l-dirty")).toBe("ade/fix-login");
    expect(byId.get("l-clean")).toBe("ade/chore");
    for (const subtitle of byId.values()) expect(subtitle).not.toContain("[object Object]");
  });

  // The @-menu fires per keystroke and each roster read costs per-session JSON
  // reads on the main process, so a burst must collapse to one read.
  it("reuses one roster read across calls inside the cache window", async () => {
    const listChatSessions = vi.fn(async () => [session({ sessionId: "s-1", title: "One" })]);
    const listLanes = vi.fn(async () => [lane({ id: "lane-1", name: "fix-login" })]);
    const listTerminals = vi.fn(() => [terminal({ terminalId: "t-1", title: "npm test" })]);
    const { service } = makeService({ listChatSessions, listLanes, listTerminals });

    await service.listChatMentionSuggestions({ query: "o" });
    await service.listChatMentionSuggestions({ query: "on" });

    expect(listChatSessions).toHaveBeenCalledTimes(1);
    // Both the chat section's lane lookup and the lane section share it too.
    expect(listLanes).toHaveBeenCalledTimes(1);
    expect(listTerminals).toHaveBeenCalledTimes(1);
  });

  it("does no transcript or PTY reads at menu time", async () => {
    const readChatTranscript = vi.fn(async () => ({ entries: [] }));
    const previewTerminal = vi.fn(async () => null);
    const { service } = makeService({ readChatTranscript, previewTerminal });
    await service.listChatMentionSuggestions({ query: "log" });
    expect(readChatTranscript).not.toHaveBeenCalled();
    expect(previewTerminal).not.toHaveBeenCalled();
  });

  it("degrades to the remaining kinds when one roster throws", async () => {
    const { service } = makeService({
      listTerminals: () => {
        throw new Error("pty unavailable");
      },
    });
    const { suggestions } = await service.listChatMentionSuggestions({ query: "" });
    expect(suggestions.some((s) => s.kind === "chat")).toBe(true);
    expect(suggestions.some((s) => s.kind === "terminal")).toBe(false);
  });

  it("reports no terminals when the runtime has no pty surface", async () => {
    const { service } = makeService({ listTerminals: null });
    const { suggestions } = await service.listChatMentionSuggestions({});
    expect(suggestions.filter((s) => s.kind === "terminal")).toEqual([]);
  });
});

describe("resolveChatMentionDetails", () => {
  it("builds a chat detail with the last exchange as preview", async () => {
    const { service } = makeService({
      readChatTranscript: async () => ({
        entries: [
          { role: "user", text: "first", timestamp: "2026-08-01T00:00:00.000Z" },
          { role: "assistant", text: "middle", timestamp: "2026-08-01T00:01:00.000Z" },
          { role: "user", text: "why is it looping?", timestamp: "2026-08-01T00:02:00.000Z" },
          { role: "assistant", text: "the redirect never settles", timestamp: "2026-08-01T00:03:00.000Z" },
        ],
      }),
    });
    const details = await service.resolveChatMentionDetails([{ kind: "chat", id: "s-new" }]);
    const detail = details.get("chat:s-new");
    expect(detail?.title).toBe("Login redirect");
    expect(detail?.preview).toBe("user: why is it looping?\nassistant: the redirect never settles");
    expect(detail?.hint).toContain("ade chat read s-new --limit 20 --max-chars 8000 --text");
    expect(detail?.hint).toContain("--page --cursor");
    expect(Object.fromEntries(detail!.attributes)).toMatchObject({
      lane: "fix-login",
      provider: "claude",
      state: "idle",
    });
  });

  // A trailing unanswered user message must not read as an answered exchange:
  // the earlier assistant reply renders before it, in transcript order.
  it("keeps transcript order when the newest message is an unanswered user turn", async () => {
    const { service } = makeService({
      readChatTranscript: async () => ({
        entries: [
          { role: "assistant", text: "the redirect never settles", timestamp: "2026-08-01T00:01:00.000Z" },
          { role: "user", text: "ok now fix the cookie path too", timestamp: "2026-08-01T00:02:00.000Z" },
        ],
      }),
    });
    const detail = (await service.resolveChatMentionDetails([{ kind: "chat", id: "s-new" }])).get("chat:s-new");
    expect(detail?.preview).toBe(
      "assistant: the redirect never settles\nuser: ok now fix the cookie path too",
    );
  });

  it("survives a failing transcript read by dropping only the preview", async () => {
    const { service } = makeService({
      readChatTranscript: async () => {
        throw new Error("transcript unavailable");
      },
    });
    const detail = (await service.resolveChatMentionDetails([{ kind: "chat", id: "s-new" }])).get("chat:s-new");
    expect(detail).toBeTruthy();
    expect(detail?.preview).toBeNull();
  });

  it("builds a lane detail with branch, raw worktree path, and PR", async () => {
    const { service } = makeService({
      listLanes: async () => [
        lane({
          id: "lane-1",
          name: "fix-login",
          status: laneStatus({ dirty: true, ahead: 2 }),
          worktreeAvailable: true,
        }),
      ],
      listPrs: () => [
        {
          laneId: "lane-1",
          githubPrNumber: 42,
          state: "open",
          checksStatus: "passing",
          title: "Fix the redirect",
        } as never,
      ],
    });
    const detail = (await service.resolveChatMentionDetails([{ kind: "lane", id: "lane-1" }])).get("lane:lane-1");
    const attrs = Object.fromEntries(detail!.attributes);
    expect(attrs.branch).toBe("ade/fix-login");
    // The raw path is kept copy-pasteable; shortening happens at render time.
    expect(attrs.worktree).toBe("/repo/.ade/worktrees/fix-login");
    expect(attrs.pr).toBe("#42");
    expect(attrs.prState).toBe("open");
    // Never derived from the unmeasured LaneStatus default (see suggestion test).
    expect(attrs.state).toBeUndefined();
    expect(attrs.worktreeAvailable).toBe("true");
    expect(detail?.hint).toContain("ade lanes show lane-1 --text");
  });

  // The cheap roster shape carries no worktree probe, so the block must stay
  // silent about it instead of asserting availability it never checked.
  it("omits worktreeAvailable when the roster did not resolve it", async () => {
    const { service } = makeService({
      listLanes: async () => [lane({ id: "lane-1", name: "fix-login" })],
    });
    const detail = (await service.resolveChatMentionDetails([{ kind: "lane", id: "lane-1" }])).get("lane:lane-1");
    const names = detail!.attributes.map(([name]) => name);
    expect(names).not.toContain("worktreeAvailable");
  });

  it("reports an unavailable worktree explicitly when it was probed", async () => {
    const { service } = makeService({
      listLanes: async () => [lane({ id: "lane-1", name: "fix-login", worktreeAvailable: false })],
    });
    const detail = (await service.resolveChatMentionDetails([{ kind: "lane", id: "lane-1" }])).get("lane:lane-1");
    expect(Object.fromEntries(detail!.attributes).worktreeAvailable).toBe("false");
  });

  it("builds a terminal detail from the bounded snapshot tail", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ text: `row ${i}` }));
    const { service } = makeService({
      previewTerminal: async () => ({
        terminalId: "t-1",
        session: terminal({ terminalId: "t-1", title: "npm test" }),
        source: "snapshot",
        snapshot: { visibleRows: rows } as never,
        transcript: null,
        capturedAt: "2026-08-03T00:00:00.000Z",
      }),
    });
    const detail = (await service.resolveChatMentionDetails([{ kind: "terminal", id: "t-1" }])).get("terminal:t-1");
    const lines = detail!.preview!.split("\n");
    expect(lines).toHaveLength(15);
    expect(lines.at(-1)).toBe("row 39");
    expect(detail?.hint).toContain("ade terminal read --terminal t-1 --text");
  });

  // Windows parity: conpty transcripts are CRLF and worktree paths are
  // backslash-separated drive paths. Neither may leak into the block body.
  it("normalizes a CRLF transcript tail and keeps Windows paths verbatim", async () => {
    const { service } = makeService({
      listLanes: async () => [
        lane({
          id: "lane-win",
          name: "fix-login",
          worktreePath: "C:\\Users\\dev\\repo\\.ade\\worktrees\\fix-login",
        }),
      ],
      previewTerminal: async () => ({
        terminalId: "t-1",
        session: terminal({ terminalId: "t-1", title: "npm test" }),
        source: "transcript",
        snapshot: null,
        transcript: "PS C:\\repo> npm test\r\n> 12 passing\r\n",
        capturedAt: "2026-08-03T00:00:00.000Z",
      } as never),
    });
    const details = await service.resolveChatMentionDetails([
      { kind: "terminal", id: "t-1" },
      { kind: "lane", id: "lane-win" },
    ]);
    // renderChatMentionBlock owns CRLF normalization and the length cap, so
    // assert on the block the provider actually receives.
    const termBlock = renderChatMentionBlock(details.get("terminal:t-1")!);
    expect(termBlock).not.toContain("\r");
    expect(termBlock).toContain("PS C:\\repo> npm test\n> 12 passing");
    const laneAttrs = Object.fromEntries(details.get("lane:lane-win")!.attributes);
    expect(laneAttrs.worktree).toBe("C:\\Users\\dev\\repo\\.ade\\worktrees\\fix-login");
    // Lane search hint uses the id + --lane flag, so a lane name with spaces or
    // quotes can never break the copy-pasted command in any shell.
    expect(details.get("lane:lane-win")?.hint).toContain(
      'ade search "<terms>" --lane lane-win --text',
    );
  });

  it("returns null for ids outside the active project", async () => {
    const { service } = makeService();
    const details = await service.resolveChatMentionDetails([
      { kind: "chat", id: "not-here" },
      { kind: "lane", id: "not-here" },
      { kind: "terminal", id: "not-here" },
    ]);
    expect(details.get("chat:not-here")).toBeNull();
    expect(details.get("lane:not-here")).toBeNull();
    expect(details.get("terminal:not-here")).toBeNull();
  });

  it("shares roster reads across every target in one message", async () => {
    const listLanes = vi.fn(async () => [lane({ id: "lane-1", name: "fix-login" })]);
    const listChatSessions = vi.fn(async () => [session({ sessionId: "s-new", title: "Login redirect" })]);
    const { service } = makeService({ listLanes, listChatSessions });
    await service.resolveChatMentionDetails([
      { kind: "chat", id: "s-new" },
      { kind: "lane", id: "lane-1" },
    ]);
    expect(listChatSessions).toHaveBeenCalledTimes(1);
    expect(listLanes).toHaveBeenCalledTimes(1);
  });
});

describe("applyChatMentionExpansion", () => {
  it("pins displayText to the user's literal chips and expands the prompt text", async () => {
    const { service } = makeService();
    const expanded = await service.applyChatMentionExpansion({
      text: "check @lane:lane-1",
      displayText: undefined as string | undefined,
    });
    expect(expanded.text).toContain('<ade-mention kind="lane" id="lane-1"');
    expect(expanded.text.startsWith("check @lane:lane-1")).toBe(true);
    expect(expanded.displayText).toBe("check @lane:lane-1");
  });

  // A send to an active chat reroutes into steer, and both paths expand. The
  // marker — not header sniffing — is what makes the second pass a no-op.
  it("is idempotent across a send→steer reroute", async () => {
    const { service } = makeService();
    const first = await service.applyChatMentionExpansion({ text: "check @lane:lane-1" });
    const second = await service.applyChatMentionExpansion(first);
    expect(second).toBe(first);
    expect(second.text.match(/<ade-mention/g)).toHaveLength(1);
  });

  // Header sniffing used to make this input silently skip expansion.
  it("still expands when the user pasted the block header sentence themselves", async () => {
    const { service } = makeService();
    const pasted =
      "Referenced ADE entities (pointers, not attachments — read more with the commands below):\n"
      + "check @lane:lane-1";
    const expanded = await service.applyChatMentionExpansion({ text: pasted });
    expect(expanded.text).toContain('<ade-mention kind="lane" id="lane-1"');
  });

  // The analytics hook is a coarse adoption fact: exactly one call per send
  // that actually gained blocks — never for mention-free text, never on the
  // idempotent second pass, and a throwing hook must not block the send.
  it("fires onMentionsExpanded once per real expansion and never otherwise", async () => {
    const onMentionsExpanded = vi.fn();
    const { service } = makeService({ onMentionsExpanded });
    const first = await service.applyChatMentionExpansion({
      text: "check @lane:lane-1",
      sessionId: "session-9",
    } as { text: string });
    expect(onMentionsExpanded).toHaveBeenCalledTimes(1);
    expect(onMentionsExpanded).toHaveBeenCalledWith({ sessionId: "session-9" });
    await service.applyChatMentionExpansion(first);
    await service.applyChatMentionExpansion({ text: "no mentions here" });
    expect(onMentionsExpanded).toHaveBeenCalledTimes(1);
  });

  it("still expands when the analytics hook throws", async () => {
    const { service } = makeService({
      onMentionsExpanded: () => {
        throw new Error("analytics down");
      },
    });
    const expanded = await service.applyChatMentionExpansion({ text: "check @lane:lane-1" });
    expect(expanded.text).toContain('<ade-mention kind="lane" id="lane-1"');
  });

  it("leaves mention-free text untouched", async () => {
    const { service } = makeService();
    const args = { text: "no mentions here" };
    expect(await service.applyChatMentionExpansion(args)).toBe(args);
  });
});
