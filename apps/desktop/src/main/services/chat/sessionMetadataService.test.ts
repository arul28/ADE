import { describe, expect, it, vi } from "vitest";

import type { AgentChatSession } from "../../../shared/types/chat";
import { getAvailableModels } from "../../../shared/modelRegistry";
import type { Logger } from "../logging/logger";
import { createSessionMetadataRegenerator, type SessionMetadataManagedSession } from "./sessionMetadataService";

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
  runPrompt?: ReturnType<typeof vi.fn>;
  summary?: string | null;
  autoTitleSeed?: string | null;
  preview?: string | null;
  resolveModelCandidates?: () => Promise<string[]>;
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
  const runPrompt = args?.runPrompt ?? vi.fn(async () => ({
    text: JSON.stringify({
      chatTitle: "Wire Rag Search",
      laneName: "Search Answer Path",
      statusLine: "Sources show before generate",
    }),
  }));
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const regenerate = createSessionMetadataRegenerator<typeof managed>({
    ensureManagedSession: () => managed,
    getSession: () => sessionRow,
    getLaneSummary: async () => ({ name: sessionRow.laneName }),
    resolveModelCandidates: args?.resolveModelCandidates ?? (async () => [ANTHROPIC_MODELS[0]!.id]),
    buildRecentConversationContext: () => "",
    runPrompt,
    normalizeTitle,
    normalizeStatusLine,
    applyTitle,
    setStatusNote,
    renameLane,
    persistChatState: vi.fn(),
    logger,
  });
  return { regenerate, managed, sessionRow, applyTitle, setStatusNote, renameLane, runPrompt };
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
    });
    expect(applyTitle).toHaveBeenCalledWith(expect.anything(), "Wire Rag Search");
    expect(setStatusNote).toHaveBeenCalledWith("sess-1", "Sources show before generate");
    expect(renameLane).toHaveBeenCalledWith({ laneId: "lane-1", name: "Search Answer Path" });
  });

  it("uses the conversation summary when every model returns unusable JSON", async () => {
    const { regenerate, applyTitle, setStatusNote, renameLane } = createHarness({
      summary: "Wired project aiSummary into RAG excerpts so Cmd+K answers from the overview",
      runPrompt: vi.fn(async () => ({ text: "I named it. Hope that helps!" })),
    });

    const result = await regenerate({ sessionId: "sess-1" });
    expect(result.applied.length).toBeGreaterThan(0);
    expect(applyTitle).toHaveBeenCalled();
    expect(String(applyTitle.mock.calls[0]?.[1])).not.toMatch(/start skill using aws/i);
    expect(setStatusNote).toHaveBeenCalled();
    expect(renameLane).toHaveBeenCalled();
  });

  it("uses deterministic metadata when no naming model is available", async () => {
    const { regenerate, applyTitle, setStatusNote, renameLane, runPrompt } = createHarness({
      summary: "Wired project aiSummary into RAG excerpts so Cmd+K answers from the overview",
      resolveModelCandidates: async () => [],
    });

    const result = await regenerate({ sessionId: "sess-1" });
    expect(runPrompt).not.toHaveBeenCalled();
    expect(result.applied.length).toBeGreaterThan(0);
    expect(applyTitle).toHaveBeenCalled();
    expect(String(applyTitle.mock.calls[0]?.[1])).not.toMatch(/start skill using aws/i);
    expect(setStatusNote).toHaveBeenCalled();
    expect(renameLane).toHaveBeenCalled();
  });
});
