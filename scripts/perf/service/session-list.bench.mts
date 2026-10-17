// cd apps/ade-cli && npx tsx ../../scripts/perf/service/session-list.bench.mts [--parity-out <file.json>]
// What one `sessions.list` call costs the brain: the handler
// (`listSessionsWithChatProjection`, sessions/chatSessionProjection.ts) over the
// real chat service (`createAgentChatService`), a real SQLite session table and
// real chat metadata files in a temp project. Nothing under ~/.ade is read.
//
// The fixture is synthetic but sized like a real ADE project: 617 chat metadata
// files, 8.1 MB, p50 4.5 KB, p90 33 KB, max 152 KB (lognormal sizes, seeded).
// Chats are spread over six lanes with a skew (lane-1 holds 40%). One CTO
// identity chat sits in the 500-row chat window but outside the 200-row page,
// with three children in the page, so the identity lookup is exercised.
//
// Three timed scenarios, each 1 warm-up + 7 timed runs, reported as a median:
//   unscoped  {limit: 500}
//   lane      {laneId: "lane-1", limit: 200}
//   chat      {chatSessionId: <chat with three shells>, limit: null}
//
// Per scenario it also reports the work done in one run:
//   metadataReads  reads of <chat-sessions>/<id>.json: one readPersistedState per
//                  chat row the handler summarizes, so this is the summary count
//   configReads    projectConfigService.get() calls made while summarizing
//
// `--parity-out <file>` writes the projected rows of the timed scenarios plus a
// few extra shapes (small page, lane page that cuts off the CTO, lane pages whose
// child's parent sits in another lane, a chat that names itself) as JSON, so two
// checkouts can be diffed byte for byte.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAdeLayout } from "../../../apps/desktop/src/shared/adeLayout";
import { createAgentChatService } from "../../../apps/desktop/src/main/services/chat/agentChatService";
import { listSessionsWithChatProjection } from "../../../apps/desktop/src/main/services/sessions/chatSessionProjection";
import { createSessionService } from "../../../apps/desktop/src/main/services/sessions/sessionService";
import { createProjectConfigService } from "../../../apps/desktop/src/main/services/config/projectConfigService";
import { openKvDb } from "../../../apps/desktop/src/main/services/state/kvDb";

const parityOutIndex = process.argv.indexOf("--parity-out");
const parityOut = parityOutIndex >= 0 ? process.argv[parityOutIndex + 1] : null;

const CHATS = 617;
const SHELLS = 150;
const RUNS = 7;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const MINUTE = 60_000;

// Seeded PRNG so before and after runs see the same fixture.
let seed = 7;
function random(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss(): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}
// Lognormal, median ~4.5 KB on disk, sigma 1.554 (p90 ≈ 33 KB), clipped to [400 B, 152 KB].
function metadataBytes(): number {
  return Math.min(152_000, Math.max(400, Math.round(Math.exp(Math.log(5_000) + 1.554 * gauss()))));
}
function pickLane(): string {
  const roll = random();
  if (roll < 0.4) return "lane-1";
  if (roll < 0.6) return "lane-2";
  if (roll < 0.75) return "lane-3";
  if (roll < 0.85) return "lane-4";
  if (roll < 0.95) return "lane-5";
  return "lane-6";
}
function pickChatTool(): { toolType: string; provider: string; model: string } {
  const roll = random();
  if (roll < 0.6) return { toolType: "claude-chat", provider: "claude", model: "sonnet" };
  if (roll < 0.9) return { toolType: "codex-chat", provider: "codex", model: "gpt-5-codex" };
  return { toolType: "opencode-chat", provider: "opencode", model: "opencode/anthropic/claude-sonnet-5" };
}

const projectRoot = mkdtempSync(path.join(tmpdir(), "ade-perf-session-list-"));
const adeDir = path.join(projectRoot, ".ade");
const layout = resolveAdeLayout(projectRoot);
mkdirSync(layout.chatSessionsDir, { recursive: true });
mkdirSync(layout.chatTranscriptsDir, { recursive: true });
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const db = await openKvDb(path.join(adeDir, "ade.db"), silentLogger as never);
const now = new Date(T0).toISOString();
db.run(
  "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
  ["project-1", projectRoot, "Perf", "main", now, now],
);
const LANES = ["lane-1", "lane-2", "lane-3", "lane-4", "lane-5", "lane-6"];
for (const laneId of LANES) {
  db.run(
    `insert into lanes(id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, is_edit_protected, status, created_at)
     values (?, 'project-1', ?, 'worktree', 'main', ?, ?, 0, 'active', ?)`,
    [laneId, laneId, `feature/${laneId}`, path.join(projectRoot, ".ade", "worktrees", laneId), now],
  );
}

const sessionService = createSessionService({ db, logger: silentLogger as never });

// Chat rows, newest first. Index 0 is the newest chat.
type ChatFixture = { id: string; index: number; laneId: string; toolType: string; provider: string; model: string; startedAt: string; identityKey?: string; parentIndex?: number; surface?: string; archived?: boolean; selfChat?: boolean };
const chats: ChatFixture[] = [];
for (let index = 0; index < CHATS; index += 1) {
  const tool = pickChatTool();
  chats.push({
    id: `chat-${String(index).padStart(4, "0")}`,
    index,
    laneId: pickLane(),
    ...tool,
    startedAt: new Date(T0 - index * 10 * MINUTE).toISOString(),
  });
}
const CTO_INDEX = 450;
const chatByIndex = (index: number) => chats[index]!;
chatByIndex(CTO_INDEX).identityKey = "cto";
chatByIndex(CTO_INDEX).laneId = "lane-1";
for (const child of [2, 9, 16]) {
  chatByIndex(child).laneId = "lane-1";
  chatByIndex(child).parentIndex = CTO_INDEX;
}
// A child whose parent is an ordinary chat outside the page.
chatByIndex(3).laneId = "lane-1";
chatByIndex(3).parentIndex = 300;
chatByIndex(300).laneId = "lane-1";
// Cross-lane parents: a CTO child in lane-2 (its CTO sits in lane-1), and an
// ordinary-chat child in lane-3 whose parent sits in lane-4.
chatByIndex(4).laneId = "lane-2";
chatByIndex(4).parentIndex = CTO_INDEX;
chatByIndex(8).laneId = "lane-3";
chatByIndex(8).parentIndex = 301;
chatByIndex(301).laneId = "lane-4";
chatByIndex(20).surface = "automation";
chatByIndex(30).archived = true;
chatByIndex(31).archived = true;
chatByIndex(2).selfChat = true;

// Shells, interleaved with the chats in start time. Chat 5 owns three of them.
const shellIds: string[] = [];
for (let index = 0; index < SHELLS; index += 1) {
  const id = `shell-${String(index).padStart(4, "0")}`;
  shellIds.push(id);
  const startedAt = new Date(T0 - (index * 10 + 5) * MINUTE).toISOString();
  sessionService.create({
    sessionId: id,
    laneId: pickLane(),
    ptyId: null,
    tracked: true,
    title: `Shell ${index}`,
    startedAt,
    transcriptPath: path.join(layout.chatTranscriptsDir, `${id}.log`),
    toolType: "shell",
    chatSessionId: index < 3 ? chatByIndex(5).id : null,
  });
}

for (const chat of chats) {
  const sizeTarget = metadataBytes();
  sessionService.create({
    sessionId: chat.id,
    laneId: chat.laneId,
    ptyId: null,
    tracked: true,
    title: `Chat ${chat.index}`,
    startedAt: chat.startedAt,
    transcriptPath: path.join(layout.chatTranscriptsDir, `${chat.id}.jsonl`),
    toolType: chat.toolType as never,
    chatSessionId: chat.selfChat ? chat.id : null,
  });
  if (chat.archived) {
    db.run("update terminal_sessions set archived_at = ? where id = ?", [new Date(T0 + MINUTE).toISOString(), chat.id]);
  }
  const parent = chat.parentIndex != null ? chatByIndex(chat.parentIndex) : null;
  const state = {
    version: 2,
    sessionId: chat.id,
    laneId: chat.laneId,
    provider: chat.provider,
    model: chat.model,
    title: `Chat ${chat.index}`,
    updatedAt: new Date(T0 - chat.index * 10 * MINUTE + MINUTE).toISOString(),
    ...(chat.identityKey ? { identityKey: chat.identityKey } : {}),
    ...(chat.surface ? { surface: chat.surface } : {}),
    ...(parent ? { orchestrationParentSessionId: parent.id, spawnKind: "subagent" } : {}),
    padding: "x".repeat(Math.max(0, sizeTarget - 300)),
  };
  writeFileSync(path.join(layout.chatSessionsDir, `${chat.id}.json`), JSON.stringify(state));
}

const sizes = chats.map((chat) => fs.statSync(path.join(layout.chatSessionsDir, `${chat.id}.json`)).size).sort((a, b) => a - b);
const pct = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))]!;
const fixture = {
  chatMetadataFiles: sizes.length,
  totalMB: +(sizes.reduce((sum, size) => sum + size, 0) / 1e6).toFixed(2),
  p50KB: +(pct(0.5) / 1000).toFixed(1),
  p90KB: +(pct(0.9) / 1000).toFixed(1),
  maxKB: +(sizes[sizes.length - 1]! / 1000).toFixed(1),
  lanes: Object.fromEntries(LANES.map((laneId) => [laneId, chats.filter((chat) => chat.laneId === laneId).length])),
};

// Count the work. readPersistedState reads <chat-sessions>/<id>.json once per
// row the handler summarizes; projectConfigService.get() is counted separately.
let metadataReads = 0;
const realReadFileSync = fs.readFileSync;
(fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
  if (typeof file === "string" && path.dirname(file) === layout.chatSessionsDir && file.endsWith(".json")) metadataReads += 1;
  return (realReadFileSync as (...args: unknown[]) => unknown)(file, ...rest);
}) as typeof fs.readFileSync;

const projectConfigService = createProjectConfigService({ projectRoot, adeDir, projectId: "project-1", db, logger: silentLogger as never });
let configReads = 0;
const countedProjectConfig = {
  get: () => {
    configReads += 1;
    return projectConfigService.get();
  },
  getAll: () => projectConfigService.getAll(),
  set: (...args: Parameters<typeof projectConfigService.set>) => projectConfigService.set(...args),
};

const agentChatService = createAgentChatService({
  getAccountUsage: () => null,
  projectRoot,
  transcriptsDir: path.dirname(layout.chatTranscriptsDir),
  laneService: { list: () => [], get: () => null, getLaneBaseAndBranch: () => null } as never,
  sessionService: sessionService as never,
  projectConfigService: countedProjectConfig as never,
  aiIntegrationService: { getMode: () => "subscription", summarizeTerminal: async () => ({ text: "" }) } as never,
  logger: silentLogger as never,
  appVersion: "0.0.0-perf",
  nativeTitleWaitMs: 0,
  getDirtyFileTextForPath: () => undefined,
  db: db as never,
} as never);

const services = { sessionService: sessionService as never, ptyService: null, agentChatService, logger: silentLogger };

const chatSelected = chatByIndex(5).id;
const scenarios = {
  unscoped: { limit: 500 },
  lane: { laneId: "lane-1", limit: 200 },
  chat: { chatSessionId: chatSelected, limit: null },
} as const;

async function timeScenario(args: Record<string, unknown>) {
  await listSessionsWithChatProjection(services, args as never); // warm-up
  const times: number[] = [];
  let rows = 0;
  let runConfigReads = 0;
  let runMetadataReads = 0;
  for (let run = 0; run < RUNS; run += 1) {
    configReads = 0;
    metadataReads = 0;
    const started = performance.now();
    const result = await listSessionsWithChatProjection(services, args as never);
    times.push(performance.now() - started);
    rows = result.length;
    runConfigReads = configReads;
    runMetadataReads = metadataReads;
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    medianMs: +sorted[Math.floor(sorted.length / 2)]!.toFixed(2),
    minMs: +sorted[0]!.toFixed(2),
    maxMs: +sorted[sorted.length - 1]!.toFixed(2),
    rows,
    metadataReads: runMetadataReads,
    configReads: runConfigReads,
  };
}

const results: Record<string, unknown> = {};
for (const [name, args] of Object.entries(scenarios)) {
  results[name] = await timeScenario(args);
}

// Cost of one projectConfigService.get() on its own, so the config share of a
// call can be read off the table: configReads × this is the config part.
const configCalls = 2_000;
const configStarted = performance.now();
for (let i = 0; i < configCalls; i += 1) projectConfigService.get();
const configUsPerCall = +(((performance.now() - configStarted) * 1000) / configCalls).toFixed(1);

if (parityOut) {
  const extra = {
    smallPage: { limit: 25 },
    laneCutsOffCto: { laneId: "lane-1", limit: 20 },
    crossLaneChildOfCto: { laneId: "lane-2", limit: 200 },
    crossLaneChildOfChat: { laneId: "lane-3", limit: 200 },
    chatNamesItself: { chatSessionId: chatByIndex(2).id, limit: null },
    chatWithNoShells: { chatSessionId: chatByIndex(6).id, limit: null },
  };
  const rows: Record<string, unknown> = {};
  for (const [name, args] of [...Object.entries(scenarios), ...Object.entries(extra)]) {
    rows[name] = await listSessionsWithChatProjection(services, args as never);
  }
  // The temp project directory has a random name; keep it out of the diff.
  writeFileSync(parityOut, `${JSON.stringify(rows, null, 1).split(projectRoot).join("<project>")}\n`);
}

console.log(JSON.stringify({ fixture, configUsPerCall, results }, null, 1));
await db.close();
rmSync(projectRoot, { recursive: true, force: true });
process.exit(0);
