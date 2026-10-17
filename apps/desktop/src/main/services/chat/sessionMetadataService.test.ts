import { describe, expect, it, vi } from "vitest";

import type { AgentChatSession } from "../../../shared/types/chat";
import { getAvailableModels } from "../../../shared/modelRegistry";
import type { Logger } from "../logging/logger";
import { createSessionMetadataRegenerator, type SessionMetadataManagedSession } from "./sessionMetadataService";
import type { SessionMetadataConversationEntry, SessionMetadataLaneThread, SessionMetadataPromptRunner } from "./sessionNaming";

const ANTHROPIC_MODELS = getAvailableModels([
  { type: "cli-subscription", cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
] as never).filter((descriptor) => descriptor.id.startsWith("anthropic/") && !descriptor.deprecated);

const normalizeTitle = (value: string): string | null => {
  const words = value.trim().split(/\s+/u).filter(Boolean);
  return words.length >= 2 ? words.slice(0, 6).join(" ") : null;
};
const normalizeStatusLine = (value: string): string | null => {
  const summary = value.trim().replace(/\s+/g, " ");
  return summary.length ? summary.slice(0, 72) : null;
};

function createHarness(args?: {
  runPrompt?: SessionMetadataPromptRunner;
  summary?: string | null;
  autoTitleSeed?: string | null;
  preview?: string | null;
  resolveModelCandidates?: () => Promise<string[]>;
  conversation?: SessionMetadataConversationEntry[];
  laneThreads?: SessionMetadataLaneThread[];
  laneWork?: {
    baseRef: string;
    commits?: string | null;
    changedFiles?: string | null;
    uncommitted?: string | null;
  } | null;
}) {
  const managed = {
    session: {
      id: "sess-1",
      provider: "cursor",
      modelId: "cursor/grok-4.6",
      model: "grok-4.6",
      laneId: "lane-1",
      goal: null,
    } as AgentChatSession,
    laneWorktreePath: "/tmp/lane",
    preview: args?.preview ?? null,
    autoTitleSeed: args?.autoTitleSeed ?? "start skill using aws other",
    deleted: false,
    sessionMetadataGenerationVersion: 0,
    sessionMetadataTitleRevision: 0,
  } satisfies SessionMetadataManagedSession;
  const sessionRow = {
    title: "Start Skill Using Aws Other",
    laneName: "Start Skill Using Aws Other",
    statusNote: null as string | null,
    lastOutputPreview: args?.preview ?? null,
    summary: args?.summary ?? null,
  };
  const applyTitle = vi.fn(async (_managed: typeof managed, title: string) => title);
  const setStatusNote = vi.fn(() => {
    sessionRow.statusNote = "applied";
    return true;
  });
  const renameLane = vi.fn();
  const collectConversationEntries = vi.fn(() => args?.conversation ?? []);
  const listLaneThreads = vi.fn(() => args?.laneThreads ?? []);
  const gatherLaneWorkVersusRemote = vi.fn(async () => args?.laneWork ?? null);
  const runPrompt = vi.fn<Parameters<SessionMetadataPromptRunner>, ReturnType<SessionMetadataPromptRunner>>(
    args?.runPrompt ?? (async () => ({
      text: JSON.stringify({
        chatTitle: "Wire Rag Search",
        laneName: "Search Answer Path",
        statusLine: "Sources show before generate",
      }),
    })),
  );
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const regenerate = createSessionMetadataRegenerator<typeof managed>({
    ensureManagedSession: () => managed,
    getSession: () => sessionRow,
    getLaneSummary: async () => ({ name: sessionRow.laneName, worktreePath: managed.laneWorktreePath }),
    resolveModelCandidates: args?.resolveModelCandidates ?? (async () => [ANTHROPIC_MODELS[0]!.id]),
    collectConversationEntries,
    listLaneThreads,
    gatherLaneWorkVersusRemote,
    runPrompt,
    normalizeTitle,
    normalizeStatusLine,
    applyTitle,
    setStatusNote,
    renameLane,
    persistChatState: vi.fn(),
    logger,
  });
  return {
    regenerate,
    managed,
    sessionRow,
    applyTitle,
    setStatusNote,
    renameLane,
    runPrompt,
    collectConversationEntries,
    listLaneThreads,
    gatherLaneWorkVersusRemote,
  };
}

describe("createSessionMetadataRegenerator", () => {
  it("applies metadata when the model wraps JSON and adds extra keys", async () => {
    const { regenerate, applyTitle, setStatusNote, renameLane } = createHarness({
      runPrompt: vi.fn(async () => ({
        text: [
          "Sure — here you go:",
          "```json",
          JSON.stringify({
            chatTitle: "Wire Rag Search",
            laneName: "Search Answer Path",
            statusLine: "Sources show before generate",
            commentary: "extra grok field",
          }),
          "```",
        ].join("\n"),
        structuredOutput: {
          chatTitle: "Wire Rag Search",
          laneName: "Search Answer Path",
          statusLine: "Sources show before generate",
          commentary: "extra grok field",
        },
      })),
    });

    await expect(regenerate({ sessionId: "sess-1" })).resolves.toMatchObject({
      applied: ["title", "statusLine", "laneName"],
      skipped: [],
      generationError: null,
    });
    expect(applyTitle).toHaveBeenCalledWith(expect.anything(), "Wire Rag Search");
    expect(setStatusNote).toHaveBeenCalledWith("sess-1", "Sources show before generate");
    expect(renameLane).toHaveBeenCalledWith({ laneId: "lane-1", name: "Search Answer Path" });
  });

  it.each([
    {
      label: "every model returns unusable JSON",
      runPrompt: async () => ({ text: "I named it. Hope that helps!" }),
      candidates: undefined,
      error: "The AI returned no usable names.",
    },
    {
      label: "no naming model is available",
      runPrompt: undefined,
      candidates: [] as string[],
      error: "No AI model is available to generate names.",
    },
    {
      label: "the account hit its usage limit",
      runPrompt: async () => {
        throw new Error("Claude failed: You've hit your weekly limit · resets 6am (America/New_York) (HTTP 429)");
      },
      candidates: undefined,
      error: "Claude failed: You've hit your weekly limit · resets 6am (America/New_York) (HTTP 429)",
    },
    {
      label: "the runtime cannot sandbox the model",
      runPrompt: async () => {
        throw new Error("Local SDK sandboxing was requested, but sandboxing is not supported in this environment.");
      },
      candidates: undefined,
      error: "This ADE runtime can't provide the sandbox this agent asked for.",
    },
  ])("keeps the current names and reports why when $label", async ({ runPrompt, candidates, error }) => {
    const { regenerate, applyTitle, setStatusNote, renameLane } = createHarness({
      summary: "Wired project aiSummary into RAG excerpts so Cmd+K answers from the overview",
      conversation: [
        { role: "user", text: "stop one-shot AI from picking Haiku" },
        { role: "assistant", text: "…(earlier omitted) every local change is queued then replayed" },
      ],
      ...(runPrompt ? { runPrompt: vi.fn(runPrompt) } : {}),
      ...(candidates ? { resolveModelCandidates: async () => candidates } : {}),
    });

    for (const fields of [undefined, ["laneName"] as const]) {
      const result = await regenerate({ sessionId: "sess-1", ...(fields ? { fields: [...fields] } : {}) });
      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual(fields ? [...fields] : ["title", "laneName", "statusLine"]);
      expect(result.generationError).toBe(error);
    }
    expect(applyTitle).not.toHaveBeenCalled();
    expect(setStatusNote).not.toHaveBeenCalled();
    expect(renameLane).not.toHaveBeenCalled();
  });

  it("sends the full thread, latest assistant paragraphs, lane threads, and git work in one call", async () => {
    const { regenerate, runPrompt } = createHarness({
      conversation: [
        { role: "user", text: "stop one-shot AI from picking Haiku" },
        { role: "assistant", text: "Looked at executeTask.\n\nRemoved the default namer.\n\nTests are running on the skip path." },
      ],
      laneThreads: [
        { title: "Stop Haiku default", statusNote: "Tests are running on the skip path.", isCurrent: true },
        { title: "Conflict picker", summary: "Added the settings row" },
      ],
      laneWork: {
        baseRef: "origin/main",
        changedFiles: "M apps/desktop/src/main/services/ai/aiIntegrationService.ts",
        commits: "c9685fa Stop one-shot AI from picking Haiku",
        uncommitted: "",
      },
    });

    await regenerate({ sessionId: "sess-1" });
    expect(runPrompt).toHaveBeenCalledTimes(1);
    const prompt = String(runPrompt.mock.calls[0]?.[0]?.prompt ?? "");
    expect(prompt).toContain("stop one-shot AI from picking Haiku");
    expect(prompt).toContain("Tests are running on the skip path.");
    expect(prompt).toContain("Conflict picker");
    expect(prompt).toContain("aiIntegrationService.ts");
  });

  it("does not gather sibling threads or git work for a status-only refresh", async () => {
    const {
      regenerate,
      runPrompt,
      listLaneThreads,
      gatherLaneWorkVersusRemote,
    } = createHarness({
      conversation: [
        { role: "user", text: "rewrite every naming prompt" },
        { role: "assistant", text: "Looked at executeTask.\n\nRemoved the default namer.\n\nTests are running on the skip path." },
      ],
      laneThreads: [{ title: "Conflict picker", isCurrent: false }],
      laneWork: {
        baseRef: "origin/main",
        changedFiles: "M apps/desktop/src/main/services/ai/aiIntegrationService.ts",
      },
    });

    await regenerate({ sessionId: "sess-1", fields: ["statusLine"] });
    expect(listLaneThreads).not.toHaveBeenCalled();
    expect(gatherLaneWorkVersusRemote).not.toHaveBeenCalled();
    expect(runPrompt).toHaveBeenCalledTimes(1);
    const call = runPrompt.mock.calls[0]?.[0];
    const prompt = String(call?.prompt ?? "");
    expect(prompt).toContain("Worktree: lane");
    expect(prompt).toContain("Tests are running on the skip path.");
    expect(prompt).not.toContain("rewrite every naming prompt");
    expect(prompt).not.toContain("Conflict picker");
    expect(prompt).not.toContain("aiIntegrationService.ts");
    expect(String(call?.systemPrompt ?? "")).toContain(
      "Copy these current values unchanged: chatTitle, laneName.",
    );
  });

  it("does not gather git work for a title-only refresh", async () => {
    const { regenerate, runPrompt, listLaneThreads, gatherLaneWorkVersusRemote } = createHarness({
      conversation: [
        { role: "user", text: "stop one-shot AI from picking Haiku" },
        { role: "assistant", text: "Removed the default namer." },
      ],
      laneThreads: [{ title: "Conflict picker" }],
      laneWork: {
        baseRef: "origin/main",
        changedFiles: "M apps/desktop/src/main/services/ai/aiIntegrationService.ts",
      },
    });

    await regenerate({ sessionId: "sess-1", fields: ["title"] });
    expect(listLaneThreads).not.toHaveBeenCalled();
    expect(gatherLaneWorkVersusRemote).not.toHaveBeenCalled();
    const prompt = String(runPrompt.mock.calls[0]?.[0]?.prompt ?? "");
    expect(prompt).toContain("stop one-shot AI from picking Haiku");
    expect(prompt).not.toContain("aiIntegrationService.ts");
    expect(prompt).not.toContain("Conflict picker");
  });

  it("does not collect the transcript when only the lane name is requested", async () => {
    const { regenerate, collectConversationEntries, listLaneThreads, gatherLaneWorkVersusRemote } = createHarness({
      conversation: [{ role: "user", text: "rewrite every naming prompt" }],
      laneThreads: [{ title: "Conflict picker" }],
      laneWork: {
        baseRef: "origin/main",
        changedFiles: "M apps/desktop/src/auth.ts",
      },
    });

    await regenerate({ sessionId: "sess-1", fields: ["laneName"] });
    expect(collectConversationEntries).not.toHaveBeenCalled();
    expect(listLaneThreads).toHaveBeenCalled();
    expect(gatherLaneWorkVersusRemote).toHaveBeenCalled();
  });
});
