import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  ExternalSessionDetail,
  ExternalSessionDetailArgs,
  ExternalSessionHome,
  ExternalSessionImportArgs,
  ExternalSessionImportResult,
  ExternalSessionListArgs,
  ExternalSessionProvider,
  ExternalSessionSummary,
} from "../shared/types";
import { EXTERNAL_SESSION_PROVIDER_CAPABILITIES } from "../shared/types/externalSessions";

/**
 * Import-session data for the Vite-only preview: one or more sessions per
 * provider, spread over the snapshot's real lanes, with previews that include
 * tool calls — enough to judge the dialog without a host.
 */

type MockLane = { id: string; name: string; branchRef?: string | null; color?: string | null; laneType?: string | null; worktreePath?: string | null };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Seed = {
  provider: ExternalSessionProvider;
  id: string;
  title: string;
  laneHint: string | "outside" | "removed";
  ageMs: number;
  prompts: number;
  sizeBytes: number;
  model: string | null;
  live?: boolean;
  atLaneRoot?: boolean;
  opening: string;
};

const SEEDS: Seed[] = [
  { provider: "claude", id: "bf585b75-48d8-43b7-8f8a-7e3dccc71123", title: "Apple sim preview and live stream", laneHint: "apple", ageMs: 13 * MINUTE, prompts: 1100, sizeBytes: 40_300_000, model: "claude-opus-5-5", live: true, opening: "The Apple pane shows a stuck loader after the device boots. Find out why." },
  { provider: "claude", id: "04af504d-9e07-488b-9188-764c8bbd0f04", title: "ADE mobile-first environment for Apple device development", laneHint: "apple", ageMs: 1 * DAY + 3 * HOUR, prompts: 1586, sizeBytes: 37_300_000, model: "claude-opus-5-5", opening: "Plan the mobile-first Apple device environment." },
  { provider: "codex", id: "019a1c3e-0000-7000-8000-00000000c0de", title: "Tighten PR detail header on iOS", laneHint: "pr", ageMs: 42 * MINUTE, prompts: 23, sizeBytes: 2_100_000, model: "gpt-6-sol", opening: "The PR detail header wraps on small phones." },
  { provider: "cursor", id: "5d1f2c9a-3b7e-4c1d-9a8e-2f6b7c8d9e0f", title: "Lane sidebar keyboard navigation", laneHint: "lane", ageMs: 3 * HOUR, prompts: 14, sizeBytes: 640_000, model: "composer-2", opening: "Arrow keys skip archived lanes in the sidebar." },
  { provider: "grok", id: "0199f3a2-7c41-7d2e-9b1a-6f0e5d4c3b2a", title: "Audit relay reconnect backoff", laneHint: "primary", ageMs: 5 * HOUR, prompts: 9, sizeBytes: 380_000, model: "grok-5", opening: "The relay reconnect loop hammers the server after sleep." },
  { provider: "copilot", id: "7e2d9c4b-1a3f-4e5d-8c7b-6a5f4e3d2c1b", title: "Windows path tests for the importer", laneHint: "outside", ageMs: 1 * DAY + 6 * HOUR, prompts: 6, sizeBytes: 210_000, model: "gpt-5.3-codex", opening: "Add Windows path cases for the session importer." },
  { provider: "qwen", id: "3c8f1e2d-9b4a-4c7e-8d6f-5a4b3c2d1e0f", title: "Stream latency probe", laneHint: "removed", ageMs: 3 * DAY, prompts: 4, sizeBytes: 120_000, model: "qwen3-coder-plus", opening: "Measure the frame latency of the device stream." },
  { provider: "droid", id: "a7b6c5d4-e3f2-4a1b-9c8d-7e6f5a4b3c2d", title: "Release notes generator", laneHint: "primary", ageMs: 2 * DAY, prompts: 11, sizeBytes: 450_000, model: "claude-sonnet-5", opening: "Draft the v1.2.78 release notes from the merged PRs." },
  { provider: "opencode", id: "ses_4f3e2d1c0b9a8f7e6d5c4b3a", title: "Speed up lane status polling", laneHint: "lane", ageMs: 7 * HOUR, prompts: 8, sizeBytes: 300_000, model: "deepseek-v4.1-flash", atLaneRoot: false, opening: "Lane status polling runs git status twice per tick." },
  { provider: "pi", id: "2026-09-21T10-12-44-pi", title: "Pi SDK worker restart", laneHint: "pr", ageMs: 2 * DAY + 4 * HOUR, prompts: 5, sizeBytes: 90_000, model: null, opening: "The Pi worker does not restart after a crash." },
  { provider: "kimi", id: "01K5Z9Y8X7W6V5T4S3R2Q1P0NM", title: "Kimi config controls smoke test", laneHint: "primary", ageMs: 9 * DAY, prompts: 3, sizeBytes: 40_000, model: "kimi-k2.5", opening: "Check that the Kimi reasoning toggle reaches the CLI." },
];

function pickLane(lanes: MockLane[], hint: string): MockLane | null {
  if (!lanes.length) return null;
  if (hint === "primary") return lanes.find((lane) => lane.laneType === "primary") ?? lanes[0] ?? null;
  const match = lanes.find((lane) => lane.name.toLowerCase().includes(hint));
  if (match) return match;
  const others = lanes.filter((lane) => lane.laneType !== "primary");
  const index = Math.abs([...hint].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % Math.max(1, others.length);
  return others[index] ?? lanes[0] ?? null;
}

function homeFor(seed: Seed, lanes: MockLane[]): { home: ExternalSessionHome; cwd: string } {
  if (seed.laneHint === "outside") {
    return {
      home: { kind: "outside", laneId: null, laneName: null, branchRef: null, color: null, laneType: null, atLaneRoot: false },
      cwd: "/Users/you/scratch/importer-windows",
    };
  }
  if (seed.laneHint === "removed") {
    return {
      home: { kind: "removed-lane", laneId: null, laneName: null, branchRef: null, color: null, laneType: null, atLaneRoot: false },
      cwd: "/Users/you/Projects/ADE/.ade/worktrees/stream-latency-probe-8a1b2c3d",
    };
  }
  const lane = pickLane(lanes, seed.laneHint);
  const root = lane?.worktreePath || `/Users/you/Projects/ADE/.ade/worktrees/${lane?.id ?? "lane"}`;
  const atLaneRoot = seed.atLaneRoot ?? true;
  return {
    home: {
      kind: "lane",
      laneId: lane?.id ?? null,
      laneName: lane?.name ?? null,
      branchRef: lane?.branchRef ?? null,
      color: lane?.color ?? null,
      laneType: lane?.laneType ?? null,
      atLaneRoot,
    },
    cwd: atLaneRoot ? root : `${root}/apps/desktop`,
  };
}

function summaries(lanes: MockLane[], now: number): ExternalSessionSummary[] {
  return SEEDS.map((seed) => {
    const { home, cwd } = homeFor(seed, lanes);
    const updatedAt = now - seed.ageMs;
    return {
      provider: seed.provider,
      id: seed.id,
      cwd,
      title: seed.title,
      preview: seed.opening,
      messages: [
        { role: "user", text: seed.opening, at: updatedAt - 20 * MINUTE },
        { role: "assistant", text: "I found the cause and have a fix ready.", at: updatedAt },
      ],
      createdAt: updatedAt - seed.prompts * 4 * MINUTE,
      updatedAt,
      messageCount: seed.prompts,
      launch: seed.model ? { model: seed.model } : null,
      alreadyImported: false,
      possiblyActive: Boolean(seed.live),
      importedBefore: seed.provider === "codex" ? true : undefined,
      cwdMatchesRequestedLane: null,
      capabilities: EXTERNAL_SESSION_PROVIDER_CAPABILITIES[seed.provider],
      home,
      sizeBytes: seed.sizeBytes,
    } satisfies ExternalSessionSummary;
  });
}

function previewEvents(summary: ExternalSessionSummary, page: number): AgentChatEventEnvelope[] {
  const sessionId = `external-preview:${summary.provider}:${summary.id}`;
  const base = (summary.updatedAt ?? Date.now()) - (page + 1) * 2 * HOUR;
  const events: AgentChatEvent[] = [];
  const turns = 6;
  for (let turn = 0; turn < turns; turn += 1) {
    const itemId = `mock-${page}-${turn}`;
    events.push({
      type: "user_message",
      text: turn === 0 && page === 0 ? summary.preview ?? "Continue." : `Step ${page * turns + turn + 1}: check the next part and keep going.`,
    });
    events.push({ type: "tool_call", tool: "Read", args: { file_path: "apps/desktop/src/main/services/pty/ptyService.ts" }, itemId });
    events.push({ type: "tool_result", tool: "Read", result: "export function createPtyService(...) { … }", itemId });
    events.push({
      type: "tool_call",
      tool: "Bash",
      args: { command: "npx vitest run src/main/services/pty" },
      itemId: `${itemId}-bash`,
    });
    events.push({ type: "tool_result", tool: "Bash", result: "Test Files  4 passed (4)\n     Tests  61 passed (61)", itemId: `${itemId}-bash` });
    events.push({
      type: "text",
      text: turn === turns - 1 && page === 0
        ? "Both bugs are fixed. The loader now ends on the **streaming** event, and a status re-read every 8 s catches a lost reply. The stream tests pass."
        : "The change works. I move on to the next part.",
    });
  }
  return events.map((event, index) => ({
    sessionId,
    timestamp: new Date(base + index * 30_000).toISOString(),
    event,
  }));
}

export function createMockExternalSessionsApi(getLanes: () => MockLane[]) {
  const now = Date.now();
  const list = async (args?: ExternalSessionListArgs): Promise<ExternalSessionSummary[]> => {
    const rows = summaries(getLanes(), now);
    const providers = args?.providers?.length ? new Set(args.providers) : null;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return rows.filter((row) => !providers || providers.has(row.provider));
  };
  const getDetail = async (args: ExternalSessionDetailArgs): Promise<ExternalSessionDetail> => {
    const summary = summaries(getLanes(), now).find((row) => row.provider === args.provider && row.id === args.sessionId);
    if (!summary) throw new Error("Session not found.");
    const page = args.before ? Number(args.before) : 0;
    return {
      provider: summary.provider,
      id: summary.id,
      cwd: summary.cwd,
      title: summary.title,
      model: summary.launch?.model ?? null,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      messageCount: summary.messageCount,
      messages: summary.messages ?? [],
      sourcePath: null,
      watchable: false,
      events: previewEvents(summary, page),
      hasOlder: page < 2,
      olderCursor: page < 2 ? String(page + 1) : null,
    };
  };
  return {
    list,
    getDetail,
    import: async (args: ExternalSessionImportArgs): Promise<ExternalSessionImportResult> => ({
      kind: "cli",
      sessionId: `mock-import-${args.sessionId.slice(0, 8)}`,
      ptyId: "mock-pty",
      laneId: args.laneId,
    }),
  };
}
