/**
 * What a provider's agent receives when an ADE chat starts, as the machine
 * that runs this code sees it: ADE's own text (exact, from the real builders),
 * the user's and the project's files the provider loads by its documented
 * rules (estimated), the provider's own prompt and tools (unknown, or the rest
 * of the measured first turn), and the median first-turn size of recent chats
 * from the turn ledger. Read-only and bounded: no provider or MCP server is
 * started, no credential or config value is read into the result, and a
 * missing file is simply not listed.
 *
 * Runs on the brain of the machine the Settings page names (the
 * `ai.getProviderContextInventory` action), because every path here is that
 * machine's.
 *
 * This file is the coordinator: the provider table and the entry point. The
 * reads live in `providerContext/fsScan.ts`, the shared item builders in
 * `providerContext/items.ts`, and each provider's discovery rules in
 * `providerContext/providers/`.
 */

import os from "node:os";
import path from "node:path";

import type { AdeTurnUsageRecord } from "../../../shared/types/turnUsage";
import {
  PROVIDER_CONTEXT_PROVIDER_IDS,
  type ProviderContextCoverage,
  type ProviderContextItem,
  type ProviderContextMeasurement,
  type ProviderContextInventory,
  type ProviderContextProvider,
} from "../../../shared/types/providerContext";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { AdeChatContextPreview } from "../chat/adeChatContextPreview";
import { isRecord } from "../mcp/mcpProviderConfigScan";
import { getSharedTurnUsageLedger } from "../usage/turnUsageLedger";
import { adeItems } from "./providerContext/adeItems";
import { medianFirstTurnContext, readFirstTurnRows } from "./providerContext/firstTurnMeasurement";
import { displayPath, findGitRoot, findMainRoot, type Ctx, type ProviderContextLogger } from "./providerContext/fsScan";
import { skillItems, type ProviderItems } from "./providerContext/items";
import { configMcpOnlyItems, museItems } from "./providerContext/providers/basic";
import { claudeItems } from "./providerContext/providers/claude";
import { codexItems } from "./providerContext/providers/codex";
import { copilotItems } from "./providerContext/providers/copilot";
import { cursorItems } from "./providerContext/providers/cursor";
import { droidItems } from "./providerContext/providers/droid";
import { kimiItems } from "./providerContext/providers/kimi";
import { openCodeItems } from "./providerContext/providers/opencode";
import { piItems } from "./providerContext/providers/pi";
import { qwenItems } from "./providerContext/providers/qwen";

const MEASURE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ProviderContextInventoryDeps = {
  projectRoot: string;
  agentChatService?: {
    previewNewChatAdeContext?: (args: { provider: string; laneId?: string | null }) => Promise<AdeChatContextPreview>;
  } | null;
  logger?: ProviderContextLogger | null;
  /** The turn ledger's rows since `sinceMs`. Defaults to this machine's shared ledger. */
  readTurns?: (sinceMs: number) => Promise<AdeTurnUsageRecord[]>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  nowMs?: () => number;
};

// ---------------------------------------------------------------------------
// The providers
// ---------------------------------------------------------------------------

type ProviderContextSpec = {
  name: string;
  coverage: ProviderContextCoverage;
  /** One plain sentence on what the list can and cannot show. */
  note: string;
  discover: (ctx: Ctx, preview: AdeChatContextPreview | null) => Promise<ProviderItems>;
};

/** One row per provider: everything the list knows about it. The key order is the order Settings lists them in. */
const PROVIDER_CONTEXT_SPECS: Record<ProviderContextProvider, ProviderContextSpec> = {
  claude: {
    name: "Claude Code",
    coverage: "good",
    note: "ADE's text is exact; CLAUDE.md files, rules, memory, skills, agents, plugins and MCP servers follow Claude Code's documented rules, so their sizes are estimates and MCP tool sizes are unknown until the servers connect.",
    discover: claudeItems,
  },
  codex: {
    name: "Codex",
    coverage: "good",
    note: "ADE's text is exact; AGENTS.md files, skills and MCP servers follow Codex's documented rules, so their sizes are estimates and Codex's own prompt and tools are only known from measured chats.",
    discover: codexItems,
  },
  cursor: {
    name: "Cursor",
    coverage: "good",
    note: "ADE's text is exact; project rules, AGENTS.md, skills and MCP servers follow Cursor's documented rules, while user and team rules kept in Cursor's settings cannot be read here.",
    discover: cursorItems,
  },
  droid: {
    name: "Droid",
    coverage: "good",
    note: "ADE's text is exact; AGENTS.md and CLAUDE.md files, skills, custom droids and MCP servers follow Droid's rules, so their sizes are estimates.",
    discover: droidItems,
  },
  opencode: {
    name: "OpenCode",
    coverage: "good",
    note: "ADE's text is exact; AGENTS.md, skills, agents, plugins and MCP servers follow OpenCode's documented rules, so their sizes are estimates and plugins can change the prompt in ways no list can show.",
    discover: openCodeItems,
  },
  pi: {
    name: "Pi",
    coverage: "good",
    note: "ADE replaces Pi's base prompt, so most of it is exact; context files, the append file and ADE's skills follow Pi's loader, and Pi's own tools are not counted.",
    discover: (ctx) => piItems(ctx),
  },
  muse: {
    name: "Muse",
    coverage: "basic",
    note: "Only ADE's own text is listed: Muse lists its skills and plugins only inside a running session.",
    discover: museItems,
  },
  qwen: {
    name: "Qwen Code",
    coverage: "good",
    note: "ADE's text is exact; QWEN.md files, skills and MCP servers follow Qwen Code's documented settings, so their sizes are estimates.",
    discover: qwenItems,
  },
  kimi: {
    name: "Kimi Code",
    coverage: "good",
    note: "ADE's text is exact; AGENTS.md files, skills and MCP servers follow Kimi Code's documented rules, so their sizes are estimates.",
    discover: kimiItems,
  },
  grok: {
    name: "Grok",
    coverage: "basic",
    note: "Only ADE's own text and the MCP servers in Grok's config are listed: Grok does not document what else it loads.",
    discover: configMcpOnlyItems("grok"),
  },
  copilot: {
    name: "Copilot",
    coverage: "good",
    note: "ADE's text is exact; instruction files, skills, agents and MCP servers follow Copilot's documented rules, so their sizes are estimates.",
    discover: copilotItems,
  },
  devin: {
    name: "Devin",
    coverage: "basic",
    note: "Only ADE's own text and the MCP servers in Devin's config are listed: Devin does not document what else it loads.",
    discover: configMcpOnlyItems("devin"),
  },
  antigravity: {
    name: "Antigravity",
    coverage: "basic",
    note: "Only ADE's own text and the MCP servers in Antigravity's config are listed: its harness does not document what else it loads.",
    discover: configMcpOnlyItems("antigravity"),
  },
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(value: unknown): { provider: ProviderContextProvider; laneId: string | null } {
  const record = isRecord(value) ? value : {};
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  if (!Object.hasOwn(PROVIDER_CONTEXT_SPECS, provider)) {
    throw new Error(`getProviderContextInventory needs a provider: one of ${PROVIDER_CONTEXT_PROVIDER_IDS.join(", ")}.`);
  }
  const laneId = typeof record.laneId === "string" && record.laneId.trim() ? record.laneId.trim() : null;
  return { provider: provider as ProviderContextProvider, laneId };
}

/** `input` is the raw IPC or action input (`GetProviderContextInventoryArgs`), checked here. */
export async function getProviderContextInventory(
  deps: ProviderContextInventoryDeps,
  input: unknown,
): Promise<ProviderContextInventory> {
  const { provider, laneId } = parseArgs(input);
  const spec = PROVIDER_CONTEXT_SPECS[provider];
  const nowMs = deps.nowMs?.() ?? Date.now();
  const logger = deps.logger ?? null;

  let preview: AdeChatContextPreview | null = null;
  const previewFn = deps.agentChatService?.previewNewChatAdeContext;
  if (typeof previewFn === "function") {
    try {
      preview = await previewFn({ provider, laneId });
    } catch (error) {
      logger?.warn("provider_context.ade_preview_failed", { provider, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const home = path.resolve(deps.homeDir ?? os.homedir());
  const env: NodeJS.ProcessEnv = { ...(deps.env ?? process.env), ...(preview?.providerHomeEnv ?? {}) };
  const cwd = path.resolve(preview?.laneWorktreePath ?? deps.projectRoot);
  let counter = 0;
  const gitRoot = await findGitRoot(cwd);
  const ctx: Ctx = {
    env,
    home,
    cwd,
    gitRoot,
    mainRoot: await findMainRoot({ logger }, gitRoot),
    logger,
    nextId: (prefix) => `${prefix}-${(counter += 1)}`,
    jsonCache: new Map(),
  };

  let discovered: ProviderItems;
  try {
    discovered = await spec.discover(ctx, preview);
  } catch (error) {
    logger?.warn("provider_context.discovery_failed", { provider, error: error instanceof Error ? error.message : String(error) });
    discovered = { items: [], adeSkillsNative: false };
  }

  const items: ProviderContextItem[] = [];
  if (preview) items.push(...adeItems(ctx, preview));
  if (preview && discovered.adeSkillsNative) {
    // ADE's own skill roots, ahead of the user's: a same-named user skill is a
    // different skill, but listing ADE's first matches the catalogue order.
    items.push(...await skillItems(ctx, preview.adeSkillRoots.map((dir) => ({ dir, label: "ADE skills", owner: "ade" as const })), {
      detail: "ADE's bundled skills, handed to the provider as its own; names and descriptions are listed.",
    }));
  }
  items.push(...discovered.items);

  let measured: ProviderContextMeasurement | null = null;
  try {
    const sinceMs = nowMs - MEASURE_WINDOW_DAYS * DAY_MS;
    // A little earlier than the window, so a session that began just before it
    // is seen as older and left out rather than counted from a later turn.
    const readTurns = deps.readTurns
      ?? ((since: number) => readFirstTurnRows(getSharedTurnUsageLedger(resolveMachineAdeDir(), logger).store.dir, since, logger));
    measured = medianFirstTurnContext(await readTurns(sinceMs - 7 * DAY_MS), provider, sinceMs, deps.projectRoot);
  } catch (error) {
    logger?.warn("provider_context.measure_failed", { provider, error: error instanceof Error ? error.message : String(error) });
  }

  const known = items.reduce((total, entry) => total + (entry.timing === "on-demand" ? 0 : entry.tokens ?? 0), 0);
  items.unshift({
    id: "harness",
    owner: "harness",
    kind: "system-prompt",
    label: `${spec.name}'s own prompt and tools`,
    source: null,
    tokens: measured ? Math.max(0, measured.firstTurnTokens - known) : null,
    sizeKind: measured ? "measured" : "unknown",
    timing: "every-request",
    detail: measured
      ? measured.firstTurnTokens > known
        ? `The rest of the measured first request: ${spec.name}'s own prompt, its tool definitions, MCP tools and your first message.`
        : `The items above add up to more than the measured first request, so nothing is left to show for ${spec.name}'s own prompt and tools.`
      : `${spec.name} does not report its own prompt and tools before a chat starts; their size shows here after a few chats.`,
  });

  return {
    provider,
    generatedAt: new Date(nowMs).toISOString(),
    cwd: displayPath(home, cwd),
    laneId: preview?.laneId ?? laneId,
    coverage: spec.coverage,
    coverageNote: spec.note,
    items,
    listedTokens: known,
    measured,
  };
}
