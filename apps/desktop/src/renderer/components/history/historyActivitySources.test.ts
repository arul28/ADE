import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentChatSessionSummary,
  CtoSnapshot,
} from "../../../shared/types";
import { getEventMeta } from "./eventTaxonomy";
import {
  buildSupplementalTimelineRecords,
  fetchSupplementalTimelineRecords,
} from "./historyActivitySources";
import { enrichEvent } from "./useTimelineStore";

const chat: AgentChatSessionSummary = {
  sessionId: "chat-1",
  laneId: "lane-1",
  provider: "codex",
  model: "gpt-5.5",
  title: "Fix checkout bug",
  status: "active",
  startedAt: "2026-05-22T00:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-05-22T00:10:00.000Z",
  lastOutputPreview: "Working on the fix",
  summary: "Investigating the checkout failure",
  nextWakeAt: null,
};

const ctoSnapshot: CtoSnapshot = {
  identity: {
    name: "CTO",
    version: 1,
    persona: "Coordinator",
    modelPreferences: { provider: "codex", model: "gpt-5.5" },
    updatedAt: "2026-05-22T00:00:00.000Z",
  },
  recentSessions: [
    {
      id: "cto-log-1",
      sessionId: "cto-chat-1",
      summary: "Reviewed the plan",
      startedAt: "2026-05-22T00:01:00.000Z",
      endedAt: "2026-05-22T00:02:00.000Z",
      provider: "codex",
      modelId: "gpt-5.5",
      capabilityMode: "full_tooling",
      createdAt: "2026-05-22T00:02:00.000Z",
    },
  ],
};

describe("history supplemental activity sources", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps chats and CTO logs into timeline records", () => {
    const records = buildSupplementalTimelineRecords({
      chats: [chat],
      ctoSnapshot,
    });

    expect(records.map((record) => record.kind)).toEqual(expect.arrayContaining([
      "chat.session",
      "cto.session",
    ]));
    expect(records.find((record) => record.id === "chat:chat-1")?.status).toBe("running");
    expect(records.find((record) => record.id === "cto-session:cto-log-1")?.status).toBe("succeeded");
  });

  it("uses source metadata labels when enriching supplemental records", () => {
    const [record] = buildSupplementalTimelineRecords({ chats: [chat] });

    expect(record).toBeDefined();
    const event = enrichEvent(record!);

    expect(event.label).toBe("Chat: Fix checkout bug");
    expect(event.category).toBe("session");
    expect(event.metadata?.sessionId).toBe("chat-1");
  });

  it("fetches chats and CTO state through renderer APIs", async () => {
    const agentChatList = vi.fn(async () => [chat]);
    const ctoGetState = vi.fn(async () => ctoSnapshot);
    vi.stubGlobal("window", {
      ade: {
        agentChat: { list: agentChatList },
        cto: {
          getState: ctoGetState,
        },
      },
    });

    const records = await fetchSupplementalTimelineRecords(1000);

    expect(agentChatList).toHaveBeenCalledWith({ includeAutomation: true });
    expect(ctoGetState).toHaveBeenCalledWith({ recentLimit: 100 });
    expect(records.map((record) => record.kind)).toEqual(expect.arrayContaining([
      "chat.session",
      "cto.session",
    ]));
  });

  it("keeps git operation records visible under the git category", () => {
    for (const kind of [
      "git_fetch",
      "git_sync_rebase",
      "git_tag_create",
      "git_reset_hard",
      "git_stash_pop",
      "git_undo_head_change",
      "git_redo_head_change",
      "git_rebase_continue",
      "git_merge_abort",
    ]) {
      const meta = getEventMeta(kind);

      expect(meta.category).toBe("git");
      expect(meta.importance).not.toBe("noise");
    }
  });
});
