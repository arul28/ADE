import path from "node:path";
import { type ExecutableTool as Tool } from "./executableTool";
import { CTO_TOOL_PACK_NAMES, CTO_TOOL_PACK_SCOPES, type CtoToolPack } from "./ctoToolPacks";
import { z } from "zod";
import { getModelById, resolveModelDescriptor, resolveChatProviderForDescriptor } from "../../../../shared/modelRegistry";
import type {
  AgentChatCreateArgs,
  AgentChatInterruptArgs,
  AgentChatSendArgs,
  AgentChatSession,
  AgentChatSessionSummary,
  AutomationRuleSummary,
  AutomationRun,
  AutomationRunListArgs,
  GitPullArgs,
  OperatorNavigationSuggestion,
  PtyCreateArgs,
  SessionSettleOverride,
  SessionWakeReason,
  TestRunSummary,
  TestSuiteDefinition,
} from "../../../../shared/types";
import type { IssueTracker } from "../../cto/issueTracker";
import type { createFileService } from "../../files/fileService";
import type { createLaneService } from "../../lanes/laneService";
import type { createPrService } from "../../prs/prService";
import type { createSessionService } from "../../sessions/sessionService";
import { parseSnoozeDeadline } from "../../sessions/sessionRequestValidation";
import type { createCtoStateService } from "../../cto/ctoStateService";
import type { CtoMemoryService } from "../../cto/ctoMemoryService";
import { getErrorMessage, nowIso, parseIsoToEpoch } from "../../shared/utils";
import { buildAdePrUrl } from "../../../../shared/deeplinks";
import { settleAbortMessage } from "../../sessions/settleTerminalSession";
import {
  AGENT_CHAT_DROID_PERMISSION_MODE_VALUES,
  AGENT_CHAT_PERMISSION_MODE_VALUES,
  AGENT_CHAT_SPAWN_KIND_VALUES,
} from "../../../../shared/types/chat";

export interface CtoOperatorToolDeps {
  currentSessionId: string;
  defaultLaneId: string;
  defaultModelId?: string | null;
  defaultReasoningEffort?: string | null;
  resolveExecutionLane: (args: {
    requestedLaneId?: string | null;
    purpose: string;
    freshLaneName?: string | null;
    freshLaneDescription?: string | null;
  }) => Promise<string>;
  laneService: ReturnType<typeof createLaneService>;
  prService?: ReturnType<typeof createPrService> | null;
  fileService?: ReturnType<typeof createFileService> | null;
  sessionService: Pick<
    ReturnType<typeof createSessionService>,
    | "updateMeta"
    | "get"
    | "settleSession"
    | "settleSessionReportingAbort"
    | "unsettleSession"
    | "setSettleOverride"
    | "snoozeSession"
    | "wakeSession"
    | "clearWokeMarker"
  >;
  testService?: {
    listSuites: () => TestSuiteDefinition[];
    run: (args: { laneId: string; suiteId: string }) => Promise<TestRunSummary>;
    stop: (args: { runId: string }) => void;
    listRuns: (args?: { laneId?: string; suiteId?: string; limit?: number }) => TestRunSummary[];
    getLogTail: (args: { runId: string; maxBytes?: number }) => string;
  } | null;
  ptyService?: {
    create: (args: PtyCreateArgs) => Promise<{ ptyId: string; sessionId: string }>;
  } | null;
  automationService?: {
    list: () => AutomationRuleSummary[];
    triggerManually: (args: { id: string; dryRun?: boolean }) => Promise<AutomationRun>;
    listRuns: (args?: AutomationRunListArgs) => AutomationRun[];
  } | null;
  gitService?: {
    getSyncStatus: (args: { laneId: string }) => Promise<any>;
    commit: (args: any) => Promise<any>;
    push: (args: any) => Promise<any>;
    pull: (args: GitPullArgs) => Promise<any>;
    undoLastHeadChange: (args: { laneId: string }) => Promise<any>;
    redoLastHeadChange: (args: { laneId: string }) => Promise<any>;
    fetch: (args: { laneId: string }) => Promise<any>;
    listRecentCommits: (args: { laneId: string; limit?: number }) => Promise<any[]>;
    listBranches: (args: any) => Promise<any[]>;
    checkoutBranch: (args: any) => Promise<any>;
    stashPush: (args: any) => Promise<any>;
    stashPop: (args: any) => Promise<any>;
    listStashes: (args: { laneId: string }) => Promise<any[]>;
    getConflictState: (args: { laneId: string }) => Promise<any>;
    rebaseContinue: (args: { laneId: string }) => Promise<any>;
    rebaseAbort: (args: { laneId: string }) => Promise<any>;
    mergeAbort: (args: { laneId: string }) => Promise<any>;
  } | null;
  conflictService?: {
    getLaneStatus: (args: any) => Promise<any>;
    getRiskMatrix: () => Promise<any[]>;
    simulateMerge: (args: any) => Promise<any>;
    runPrediction: (args?: any) => Promise<any>;
    listProposals: (args: { laneId: string }) => Promise<any[]>;
    requestProposal: (args: any) => Promise<any>;
    applyProposal: (args: any) => Promise<any>;
    undoProposal: (args: any) => Promise<any>;
  } | null;
  steerChat: (args: { sessionId: string; instruction: string }) => Promise<{ steerId: string; queued: boolean }>;
  cancelSteer: (args: { sessionId: string; steerId: string }) => Promise<void>;
  listSubagents: (args: { sessionId: string }) => Promise<any[]>;
  approveToolUse: (args: { sessionId: string; toolUseId: string; decision: "accept" | "accept_for_session" | "decline" | "cancel" }) => Promise<void>;
  computerUseArtifactBrokerService?: {
    listArtifacts: (args?: any) => any[];
    updateArtifactReview: (args: any) => any;
  } | null;
  issueTracker?: IssueTracker | null;
  ctoStateService?: Pick<ReturnType<typeof createCtoStateService>, "getSessionLogs"> | null;
  ctoMemoryService?: Pick<
    CtoMemoryService,
    "appendMemoryFact" | "searchMemory" | "getSnapshot" | "readNewDiscoveries"
  > | null;
  listChats: (laneId?: string, options?: { includeIdentity?: boolean; includeAutomation?: boolean }) => Promise<AgentChatSessionSummary[]>;
  getChatStatus: (sessionId: string) => Promise<AgentChatSessionSummary | null>;
  getChatTranscript: (args: {
    sessionId: string;
    limit?: number;
    maxChars?: number;
  }) => Promise<{
    sessionId: string;
    entries: Array<{
      role: "user" | "assistant";
      text: string;
      timestamp: string;
      turnId?: string;
    }>;
    truncated: boolean;
    totalEntries: number;
  }>;
  createChat: (args: AgentChatCreateArgs) => Promise<AgentChatSession>;
  updateChatSession: (args: {
    sessionId: string;
    title?: string | null;
  }) => Promise<AgentChatSession>;
  sendChatMessage: (args: AgentChatSendArgs) => Promise<void>;
  interruptChat: (args: AgentChatInterruptArgs) => Promise<void>;
  ensureCtoSession: (args: {
    laneId: string;
    modelId?: string | null;
    reasoningEffort?: string | null;
    reuseExisting?: boolean;
  }) => Promise<AgentChatSession>;

  // ───────────────────────────────────────────────────────────────────────────
  // Domain coverage. Every entry below is OPTIONAL: a runtime that does
  // not wire the backing service leaves the method undefined and the tool
  // answers a clean "not available on this runtime" instead of throwing. That
  // is the runtime-backed-null-services rule — `ade code`, the headless brain
  // and the desktop all build this map and they do not wire the same graph.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Raises the user-facing approval card and waits for the decision. Destructive
   * tools route through it; the answer arrives through the same
   * `approveToolUse` path an agent's tool approval does.
   *
   * Absent (CLI/RPC hosts with no renderer) destructive tools proceed — the
   * caller there is already the operator, and blocking forever on a card nobody
   * can see is worse than the write.
   */
  requestApproval?: (args: {
    title: string;
    description: string;
    detail?: Record<string, unknown>;
  }) => Promise<{ approved: boolean; reason?: string | null }>;

  /** Records that the CTO asked for an extension pack, so later turns advertise it in full. */
  onToolPackLoaded?: (pack: CtoToolPack) => void;
  /** Packs already loaded for this session, used by `loadCtoTools` to report state. */
  loadedToolPacks?: () => Iterable<CtoToolPack>;

  automationPlannerService?: {
    parseNaturalLanguage: (req: any) => Promise<any>;
    validateDraft: (req: any) => any;
    saveDraft: (req: any) => any;
    simulate: (req: any) => any;
  } | null;
  /** Automation rule lifecycle beyond the read/trigger pair `automationService` already carries. */
  automationRuleService?: {
    get: (args: { id: string }) => any;
    deleteRule: (args: { id: string }) => any;
    toggleRule: (args: { id: string; enabled: boolean }) => any;
  } | null;
  handoffSession?: (args: {
    sourceSessionId: string;
    targetModelId: string;
    mode?: "brief" | "fork";
    targetLaneId?: string | null;
    handoffNote?: string | null;
    reasoningEffort?: string | null;
  }) => Promise<any>;
  scheduledWorkService?: {
    create: (args: { sessionId: string; prompt: string; cron?: string; runAt?: string; delaySeconds?: number; recurring?: boolean; reason?: string }) => Promise<any>;
    list: (args?: { sessionId?: string; includeTerminal?: boolean }) => Promise<any[]>;
    getState: (args: { sessionId: string }) => Promise<any>;
    cancel: (args: { sessionId: string; scheduleId: string }) => Promise<any>;
    setPaused: (args: { sessionId: string; paused: boolean }) => Promise<any>;
  } | null;
  /** Proof capture. `ingest` is the only write; there is no delete tool on purpose. */
  proofIngestService?: {
    ingest: (args: any) => Promise<any> | any;
  } | null;
  reviewService?: {
    listLaunchContext: () => Promise<any>;
    startRun: (args: any) => Promise<any>;
    rerun: (args: any) => Promise<any>;
    cancelRun: (args: { runId: string }) => Promise<any>;
    listRuns: (args?: any) => Promise<any[]>;
    getRunDetail: (args: { runId: string }) => Promise<any>;
    qualityReport: () => Promise<any>;
  } | null;
  searchService?: {
    query: (args: { query: string; laneId?: string; limit?: number }) => Promise<{ results: unknown[]; totalByKind: unknown; nextCursor?: unknown }>;
    indexStatus?: () => Promise<any> | any;
  } | null;
  usageService?: {
    getAdeUsageStats: (args?: any) => Promise<any> | any;
    getUsageSnapshot: () => Promise<any> | any;
  } | null;
  budgetService?: {
    getConfig: () => any;
    getGlobalCumulativeUsage: () => any;
  } | null;
  projectConfigService?: {
    get: () => any;
  } | null;
  /**
   * NAMES ONLY. There is deliberately no accessor for a secret VALUE on this
   * type — `get`/`exportEnv` are not reachable from any CTO tool, so no tool
   * body can return one even by mistake.
   */
  projectSecretService?: {
    list: () => any;
  } | null;
  iosSimulatorService?: {
    getStatus: (args?: any) => Promise<any> | any;
    listDevices: (args?: any) => Promise<any> | any;
    listLaunchTargets: (args?: any) => Promise<any> | any;
    getScreenSnapshot?: (args?: any) => Promise<any> | any;
  } | null;
  appControlService?: {
    getStatus: (args?: any) => Promise<any> | any;
    listTargets: (args?: any) => Promise<any> | any;
    getSnapshot?: (args?: any) => Promise<any> | any;
  } | null;
  builtInBrowserService?: {
    getStatus: (args?: any) => Promise<any> | any;
    listSessions: (args?: any) => Promise<any> | any;
    getTrace?: (args?: any) => Promise<any> | any;
  } | null;
  /**
   * Orchestration reads. Positional args, matching the real service — the CTO
   * tools adapt, rather than the service being reshaped for one caller.
   */
  orchestrationService?: {
    runList: (laneId?: string, options?: { limit?: number }) => Promise<any[]>;
    bundleRead: (runId: string, bundlePath: string) => Promise<any>;
    bundleRootFor: (laneId: string, runId: string) => string;
  } | null;
}

/**
 * The closed tag vocabulary, mirrored from `ctoMemoryService`. Facts and
 * discoveries share it so a worker's `recordDiscovery` and the CTO's
 * `saveMemory` land in the same index.
 */
const memoryTagsSchema = z.object({
  lane: z.string().trim().min(1).optional().describe("Lane id the fact is about."),
  pr: z.union([z.string().trim().min(1), z.number().int().positive()]).optional().describe("GitHub PR number."),
  path: z.string().trim().min(1).optional().describe("Repo path the fact is about."),
  topic: z.string().trim().min(1).optional().describe("Short topic slug, e.g. 'testing' or 'sync'."),
});

function deriveChatProvider(args: { modelId?: string | null }): { provider: AgentChatCreateArgs["provider"]; model: string } {
  const descriptor = args.modelId ? getModelById(args.modelId) : null;
  if (!descriptor) {
    return { provider: "opencode", model: args.modelId?.trim() || "" };
  }
  return resolveChatProviderForDescriptor(descriptor);
}

function buildIssueBrief(issue: Awaited<ReturnType<IssueTracker["fetchIssueById"]>>): string {
  if (!issue) return "Linear issue not found.";
  return [
    `${issue.identifier}: ${issue.title}`,
    "",
    issue.description?.trim() || "No description provided.",
    "",
    `Project: ${issue.projectSlug || "unknown"}`,
    `State: ${issue.stateName || "unknown"}`,
    `Priority: ${issue.priorityLabel || "unknown"}`,
    `Labels: ${issue.labels.join(", ") || "none"}`,
    `Assignee: ${issue.assigneeName || "unassigned"}`,
    issue.url ? `URL: ${issue.url}` : "",
  ].filter((line) => line.length > 0).join("\n");
}

function buildNavigationSuggestion(args: {
  surface: OperatorNavigationSuggestion["surface"];
  laneId?: string | null;
  sessionId?: string | null;
}): OperatorNavigationSuggestion {
  const laneId = args.laneId?.trim() || null;
  const sessionId = args.sessionId?.trim() || null;
  if (args.surface === "work") {
    const search = new URLSearchParams();
    if (laneId) search.set("laneId", laneId);
    if (sessionId) search.set("sessionId", sessionId);
    const query = search.toString();
    return {
      surface: "work",
      label: "Open in Work",
      href: `/work${query ? `?${query}` : ""}`,
      laneId,
      sessionId,
    };
  }
  if (args.surface === "cto") {
    return {
      surface: "cto",
      label: "Open CTO",
      href: "/cto",
      laneId,
      sessionId,
    };
  }
  const search = new URLSearchParams();
  if (laneId) search.set("laneId", laneId);
  if (sessionId) search.set("sessionId", sessionId);
  const query = search.toString();
  return {
    surface: "lanes",
    label: "Open lane",
    href: `/lanes${query ? `?${query}` : ""}`,
    laneId,
    sessionId,
  };
}

function buildNavigationPayload(
  suggestion: OperatorNavigationSuggestion | null,
  includeSuggestions = true,
): {
  navigation?: OperatorNavigationSuggestion;
  navigationSuggestions?: OperatorNavigationSuggestion[];
} {
  if (!includeSuggestions || !suggestion) return {};
  return {
    navigation: suggestion,
    navigationSuggestions: [suggestion],
  };
}

function resolveWorkspaceIdForLane(
  deps: Pick<CtoOperatorToolDeps, "fileService" | "defaultLaneId">,
  args: { workspaceId?: string | null; laneId?: string | null },
): string {
  if (!deps.fileService) {
    throw new Error("File service is not available.");
  }
  const allWorkspaces = deps.fileService.listWorkspaces({ includeArchived: true });
  const explicitWorkspaceId = args.workspaceId?.trim() || "";
  if (explicitWorkspaceId) {
    const workspace = allWorkspaces.find((entry) => entry.id === explicitWorkspaceId) ?? null;
    if (!workspace) throw new Error(`Workspace not found: ${explicitWorkspaceId}`);
    return workspace.id;
  }
  const laneId = args.laneId?.trim() || deps.defaultLaneId;
  // Prefer active workspaces; fall back to archived only if no active match.
  const activeWorkspaces = deps.fileService.listWorkspaces({ includeArchived: false });
  const laneWorkspace =
    activeWorkspaces.find((entry) => entry.laneId === laneId) ??
    allWorkspaces.find((entry) => entry.laneId === laneId) ??
    null;
  if (laneWorkspace) return laneWorkspace.id;
  throw new Error(`Workspace not found for lane ${laneId}.`);
}

/**
 * The lifecycle slice the CTO needs to triage a row: whether it is settled,
 * whether it is deliberately quiet, and — the load-bearing bit — WHY it came
 * back if a snooze was broken early.
 */
function readSessionLifecycle(
  deps: Pick<CtoOperatorToolDeps, "sessionService">,
  sessionId: string,
): {
  settledAt: string | null;
  settleOverride: SessionSettleOverride | null;
  statusNote: string | null;
  attentionRequestedAt: string | null;
  attentionMessage: string | null;
  lastTurnFailedAt: string | null;
  snoozedUntil: string | null;
  snoozedAt: string | null;
  snoozed: boolean;
  wokeAt: string | null;
  wokeReason: SessionWakeReason | null;
} | null {
  // Not every host wires the full session service (the prompt-manifest preview
  // and older harnesses pass only `updateMeta`), and a missing lifecycle read
  // must degrade to "unknown" rather than break the tool it decorates.
  const session = typeof deps.sessionService?.get === "function"
    ? deps.sessionService.get(sessionId)
    : null;
  if (!session) return null;
  const snoozedUntil = session.snoozedUntil ?? null;
  const snoozedUntilMs = snoozedUntil ? Date.parse(snoozedUntil) : NaN;
  return {
    settledAt: session.settledAt ?? null,
    settleOverride: session.settleOverride ?? null,
    statusNote: session.statusNote ?? null,
    attentionRequestedAt: session.attentionRequestedAt ?? null,
    attentionMessage: session.attentionMessage ?? null,
    lastTurnFailedAt: session.lastTurnFailedAt ?? null,
    snoozedUntil,
    snoozedAt: session.snoozedAt ?? null,
    snoozed: Number.isFinite(snoozedUntilMs) && snoozedUntilMs > Date.now(),
    wokeAt: session.wokeAt ?? null,
    wokeReason: session.wokeReason ?? null,
  };
}

/**
 * Throws on anything that would make the snooze a silent no-op — an
 * unparseable date, a deadline already in the past (`snoozed` is
 * `snoozedUntil > now`, so the write "succeeds" while the row stays visible),
 * or neither argument. Callers surface the message as `{ success: false }`.
 */
function resolveSnoozeDeadline(args: {
  untilIso?: string | null;
  durationMinutes?: number | null;
}): string {
  const raw = args.untilIso?.trim();
  if (raw) return parseSnoozeDeadline(raw);
  const minutes = args.durationMinutes ?? null;
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("Pass a valid future untilIso timestamp or a positive durationMinutes.");
  }
  return new Date(Date.now() + Math.floor(minutes) * 60_000).toISOString();
}

export { CTO_TOOL_PACK_NAMES, CTO_TOOL_PACK_SCOPES, isCtoToolPack } from "./ctoToolPacks";
export type { CtoToolPack } from "./ctoToolPacks";

export type CtoOperatorTool = Tool & {
  /** Which pack this tool belongs to. */
  pack: CtoToolPack;
  /** True only for the core pack. Derived, never hand-set. */
  alwaysLoad: boolean;
};

export type CtoOperatorToolMap = Record<string, CtoOperatorTool>;

/** First sentence (or 180 chars) of a description — enough for ToolSearch to match on. */
function summarizeToolDescription(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const stop = flat.indexOf(". ");
  const head = stop > 0 ? flat.slice(0, stop + 1) : flat;
  return head.length > 180 ? `${head.slice(0, 177)}...` : head;
}

/**
 * The advertised view of the tool map for one session.
 *
 * Core tools are returned untouched. Extension-pack tools keep their full
 * schema and stay callable — only the DESCRIPTION is trimmed to a summary plus
 * a pointer at `loadCtoTools`, so an unloaded pack costs one line instead of a
 * paragraph and the model can still find it by name or topic.
 */
export function applyCtoToolPackVisibility(
  tools: CtoOperatorToolMap,
  loadedPacks: Iterable<CtoToolPack>,
): CtoOperatorToolMap {
  const loaded = new Set<CtoToolPack>(loadedPacks);
  loaded.add("core");
  const out: CtoOperatorToolMap = {};
  for (const [name, definition] of Object.entries(tools)) {
    if (definition.alwaysLoad || loaded.has(definition.pack)) {
      out[name] = definition;
      continue;
    }
    const deferred = `${summarizeToolDescription(definition.description)} `
      + `[pack "${definition.pack}"; loadCtoTools for the rest]`;
    // Deferral must never COST bytes. Most ADE tool descriptions are one line
    // already, and a stub plus its pointer is longer than what it replaces — so
    // a tool that is already as short as its summary keeps its real text.
    // Without this guard the "deferred" catalog measured LARGER than the full
    // one, which is the opposite of the point.
    out[name] = deferred.length < definition.description.length
      ? { ...definition, description: deferred }
      : definition;
  }
  return out;
}

/**
 * Config keys whose VALUE is a credential regardless of where it appears.
 *
 * Word-bounded on purpose: `secretRef` NAMES a secret rather than carrying one,
 * so it stays readable — the CTO needs to know which secret a webhook trigger
 * depends on, and hiding the name protects nothing.
 */
const CREDENTIAL_KEY_PATTERN = /(^|_)(token|secret|password|passphrase|apikey|api_key|credential|privatekey|private_key)($|_)/i;

/**
 * Config keys whose value is a bag of env vars: keys are useful, values are not.
 * Compared against `normalizeConfigKey`, so `envVars` arrives as `env_vars`.
 */
const ENV_BAG_KEYS = new Set(["env", "env_vars", "envvars", "environment"]);

/**
 * Config keys whose value is a MAP of credential name -> credential value, such
 * as `ai.apiKeys` (provider -> API key). The key itself is plural and matches no
 * credential pattern, so without this the recursion walks into the map and
 * returns every provider key verbatim.
 */
const CREDENTIAL_MAP_KEYS = new Set([
  "apikeys", "api_keys", "keys", "credentials", "secrets", "tokens", "passwords",
]);

/**
 * `githubToken` and `accessToken` carry a credential but contain no separator,
 * so an anchored pattern never matched them. Split camelCase into `_` words
 * first, then match, so `githubToken` -> `github_token` -> hit. Matching a bare
 * substring instead would redact innocent keys such as `tokenizer`.
 */
function normalizeConfigKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.-]/g, "_").toLowerCase();
}

/**
 * Keys that look credential-shaped but only NAME a credential. `secretRef`
 * points at a secret in the store; hiding the pointer protects nothing and
 * costs the CTO the ability to say which secret a trigger depends on.
 */
const CREDENTIAL_NAME_KEYS = new Set(["secret_ref", "secret_name", "api_key_ref", "credential_ref"]);

function isCredentialKey(key: string | undefined): boolean {
  if (!key) return false;
  const normalized = normalizeConfigKey(key);
  if (CREDENTIAL_NAME_KEYS.has(normalized)) return false;
  return CREDENTIAL_KEY_PATTERN.test(normalized);
}

/**
 * Strips VALUES out of an ADE project config while keeping its SHAPE.
 *
 * `local.yaml` carries per-user env vars (and is chmod 600 for exactly that
 * reason), and triggers carry credential-shaped fields. The CTO needs to know
 * which keys a project defines, never what they are set to — so env bags become
 * a list of names and credential-shaped strings become a placeholder. Applied
 * recursively, because the config is a nested document and a leak one level
 * down is still a leak.
 */
function redactConfigValues(value: unknown, key?: string): unknown {
  const normalizedKey = key ? normalizeConfigKey(key) : undefined;
  if (normalizedKey && ENV_BAG_KEYS.has(normalizedKey) && value && typeof value === "object" && !Array.isArray(value)) {
    return { __redacted: "env values withheld", names: Object.keys(value as Record<string, unknown>).sort() };
  }
  if (normalizedKey && CREDENTIAL_MAP_KEYS.has(normalizedKey) && value && typeof value === "object" && !Array.isArray(value)) {
    return { __redacted: "credential values withheld", names: Object.keys(value as Record<string, unknown>).sort() };
  }
  if (typeof value === "string") {
    return isCredentialKey(key) ? "[redacted]" : value;
  }
  // A credential container can be a YAML list as easily as a map — `providers`
  // is free-form `Record<string, unknown>`, so `tokens: ["sk-…"]` is reachable.
  // Both container guards above require a non-array object, so without this an
  // array fell through to the element walk, where the PLURAL key (`tokens`,
  // `secrets`, `keys`) matches no credential pattern and every element leaked.
  if (normalizedKey && (CREDENTIAL_MAP_KEYS.has(normalizedKey) || ENV_BAG_KEYS.has(normalizedKey)) && Array.isArray(value)) {
    return { __redacted: "credential values withheld", count: value.length };
  }
  // The parent key travels into the array: `{"apiToken": ["ghp_…"]}` is still a
  // credential, and dropping the key here leaked every element.
  if (Array.isArray(value)) return value.map((entry) => redactConfigValues(entry, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactConfigValues(childValue, childKey);
    }
    return out;
  }
  return value;
}

export function createCtoOperatorTools(deps: CtoOperatorToolDeps): CtoOperatorToolMap {
  const tools: CtoOperatorToolMap = {};

  /**
   * One stamper per pack, so a tool's pack is visible AT its definition site
   * and `grep -n "linear("` finds every Linear tool. The predecessor was a
   * mutable `activePack` reassigned between sections: moving a definition
   * across a section boundary silently re-packed it, which changed both its
   * deferral and whether `applyCtoToolPackVisibility` kept its description.
   * `alwaysLoad` stays derived from the pack — a core tool cannot ship
   * un-loaded because someone forgot a flag.
   */
  const inPack = (pack: CtoToolPack) =>
    <Schema extends z.ZodType, Result>(definition: Tool<Schema, Result>): CtoOperatorTool => ({
      ...(definition as unknown as Tool),
      pack,
      alwaysLoad: pack === "core",
    });
  const core = inPack("core");
  const linear = inPack("linear");
  const files = inPack("files");
  const tests = inPack("tests");
  const conflicts = inPack("conflicts");
  const scheduling = inPack("scheduling");
  const proof = inPack("proof");
  const review = inPack("review");
  const search = inPack("search");
  const insights = inPack("insights");
  const config = inPack("config");
  const devices = inPack("devices");
  const orchestration = inPack("orchestration");

  tools.listLanes = core({
    description: "List all ADE lanes with their status (dirty, ahead/behind, rebase state), branch info, and metadata. Use this to understand what work is happening across the project and choose where to open work.",
    inputSchema: z.object({
      includeArchived: z.boolean().optional().default(false),
    }),
    execute: async ({ includeArchived }) => {
      const lanes = await deps.laneService.list({ includeArchived });
      return {
        success: true,
        count: lanes.length,
        lanes: lanes.map((lane) => ({
          id: lane.id,
          name: lane.name,
          branchRef: lane.branchRef,
          parentLaneId: lane.parentLaneId,
          worktreePath: lane.worktreePath,
          childCount: lane.childCount,
          status: lane.status,
        })),
      };
    },
  });

  tools.inspectLane = core({
    description: "Inspect one ADE lane by ID to understand its branch, worktree, and git state.",
    inputSchema: z.object({
      laneId: z.string(),
    }),
    execute: async ({ laneId }) => {
      const lanes = await deps.laneService.list({ includeArchived: true });
      const lane = lanes.find((entry) => entry.id === laneId.trim()) ?? null;
      if (!lane) {
        return { success: false, error: `Lane not found: ${laneId}` };
      }
      return {
        success: true,
        lane,
        ...buildNavigationPayload(buildNavigationSuggestion({
          surface: "lanes",
          laneId: lane.id,
        })),
      };
    },
  });

  tools.createLane = core({
    description: "Create a new ADE lane for isolated work.",
    inputSchema: z.object({
      name: z.string(),
      description: z.string().optional(),
      parentLaneId: z.string().optional(),
    }),
    execute: async ({ name, description, parentLaneId }) => {
      try {
        const lane = await deps.laneService.create({ name, description, parentLaneId });
        return {
          success: true,
          lane,
          ...buildNavigationPayload(buildNavigationSuggestion({
            surface: "lanes",
            laneId: lane.id,
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listChats = core({
    description:
      "List ADE chat sessions so you can supervise active work and persistent identity threads. Each row carries " +
      "its settle/snooze lifecycle plus `wokeReason` when a snooze broke early, so you can triage what actually " +
      "needs you versus what is deliberately quiet.",
    inputSchema: z.object({
      laneId: z.string().optional(),
      includeIdentity: z.boolean().optional().default(true),
    }),
    execute: async ({ laneId, includeIdentity }) => {
      const chats = await deps.listChats(laneId?.trim() || undefined, {
        includeIdentity,
        includeAutomation: false,
      });
      const withLifecycle = chats.map((chat) => {
        const lifecycle = readSessionLifecycle(deps, chat.sessionId);
        return lifecycle ? { ...chat, lifecycle } : chat;
      });
      return { success: true, count: withLifecycle.length, chats: withLifecycle };
    },
  });

  tools.spawnChat = core({
    description:
      "Create a native ADE work chat session — the primary way to launch an AI agent in ADE. " +
      "IMPORTANT: Always pass modelId when the user specifies a model. Use the full model ID " +
      "(e.g. 'anthropic/claude-opus-5' for Opus, 'anthropic/claude-sonnet-5' for Sonnet, " +
      "'anthropic/claude-haiku-4-5' for Haiku, 'openai/gpt-5.6-sol' for Sol). " +
      "If no modelId is passed, the CTO's default model preference is used. " +
      "Set initialPrompt to seed the chat with a task description — the agent will begin working immediately. " +
      "Pass permissionMode only when the user asks for a specific access level; omitting it keeps the provider's " +
      "own default, which is the safe choice. It accepts ADE's full permission contract, including auto and " +
      "config-toml; for Droid's finer-grained levels, pass droidPermissionMode. " +
      "This creates a full ADE chat with UI, streaming, tool approval, and service integration. " +
      "Use this when the user asks for 'a chat' or 'an agent'. If they explicitly want a terminal or CLI tool, use createTerminal instead.",
    inputSchema: z.object({
      laneId: z.string().optional().describe("Existing lane to run in. Omit this for new work: a dedicated lane is created automatically. Never pass the CTO's own lane — that is the primary lane."),
      modelId: z.string().optional().describe("Full model ID (e.g. 'anthropic/claude-sonnet-5'). MUST be set when user specifies a model."),
      reasoningEffort: z.string().nullable().optional().describe("Reasoning effort advertised by the model, including 'max' or Codex 'ultra' when supported."),
      title: z.string().optional().describe("Display title for the chat session."),
      initialPrompt: z.string().optional().describe("Task description to seed the chat. The agent starts working immediately."),
      permissionMode: z
        .enum(AGENT_CHAT_PERMISSION_MODE_VALUES)
        .optional()
        .describe(
          "Access level for the spawned agent, translated to each provider's native controls: "
          + "'default' uses the provider default, 'auto' delegates approvals where supported, "
          + "'plan' is read-only, 'edit' accepts file edits, 'full-auto' skips every approval, "
          + "and 'config-toml' uses provider config. Omit to inherit the provider default.",
        ),
      droidPermissionMode: z
        .enum(AGENT_CHAT_DROID_PERMISSION_MODE_VALUES)
        .optional()
        .describe("Droid-native access level; use with a Droid model when its read-only/auto/agi tier is important."),
      spawnKind: z
        .enum(AGENT_CHAT_SPAWN_KIND_VALUES)
        .optional()
        .default("subagent")
        .describe(
          "How this chat reports back. 'subagent' (the default) wakes you with a summary when it finishes a turn — "
          + "use it whenever you will need, join, or review the result. 'peer' is fire-and-forget: completions are "
          + "recorded as quiet notes and never wake you.",
        ),
      openInUi: z.boolean().optional().default(true).describe("Whether to open the chat in the ADE UI."),
    }),
    execute: async ({ laneId, modelId, reasoningEffort, title, initialPrompt, permissionMode, droidPermissionMode, spawnKind, openInUi }) => {
      try {
        // Resolve model: supports full IDs (anthropic/claude-sonnet-5), short IDs (sonnet), and aliases (opus)
        const rawModelId = modelId?.trim() || null;
        const descriptor = rawModelId ? resolveModelDescriptor(rawModelId) : null;
        const selectedModelId = descriptor?.id ?? rawModelId ?? deps.defaultModelId ?? null;
        const resolved = deriveChatProvider({ modelId: selectedModelId });
        const executionLaneId = await deps.resolveExecutionLane({
          requestedLaneId: laneId?.trim() || undefined,
          purpose: title?.trim() || "implementation chat",
          freshLaneName: title?.trim() || "implementation chat",
          freshLaneDescription: "Dedicated implementation lane launched from the CTO coordinator chat.",
        });
        const session = await deps.createChat({
          laneId: executionLaneId,
          provider: resolved.provider,
          model: resolved.model,
          ...(selectedModelId ? { modelId: selectedModelId } : {}),
          reasoningEffort: reasoningEffort ?? deps.defaultReasoningEffort ?? null,
          // Absent means absent. Sending a substituted default here would be
          // persisted as a real selection and pin the spawned chat to it.
          ...(permissionMode !== undefined ? { permissionMode } : {}),
          ...(droidPermissionMode !== undefined ? { droidPermissionMode } : {}),
          // Lineage, so the child's completion reports back here instead of
          // ending in silence. The CTO thread is the parent for everything it
          // starts; `spawnKind` decides whether that report wakes it.
          orchestrationParentSessionId: deps.currentSessionId,
          // Defaulted here as well as in the schema: the host rejects a
          // parented chat with no spawn kind, and callers that reach `execute`
          // without parsing the schema first would otherwise fail the create.
          spawnKind: spawnKind ?? "subagent",
          surface: "work",
          sessionProfile: "workflow",
        });
        if (title?.trim()) {
          await deps.updateChatSession({
            sessionId: session.id,
            title: title.trim(),
          });
        }
        if (initialPrompt?.trim()) {
          await deps.sendChatMessage({
            sessionId: session.id,
            text: initialPrompt.trim(),
          });
        }
        return {
          success: true,
          openInUi,
          sessionId: session.id,
          laneId: session.laneId,
          requestedTitle: title?.trim() || null,
          ...buildNavigationPayload(buildNavigationSuggestion({
            surface: "work",
            laneId: session.laneId,
            sessionId: session.id,
          }), openInUi),
          provider: session.provider,
          model: session.model,
          modelId: session.modelId ?? null,
          permissionMode: session.permissionMode ?? null,
          droidPermissionMode: session.droidPermissionMode ?? null,
          spawnKind: session.spawnKind ?? null,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.sendChatMessage = core({
    description: "Send a message to an ADE chat session you are supervising.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      text: z.string().trim().min(1),
    }),
    execute: async ({ sessionId, text }) => {
      try {
        await deps.sendChatMessage({ sessionId, text });
        return { success: true, sessionId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.interruptChat = core({
    description: "Interrupt a running ADE chat turn.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
    }),
    execute: async ({ sessionId }) => {
      try {
        await deps.interruptChat({ sessionId });
        return { success: true, sessionId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getChatStatus = core({
    description:
      "Get the current status for an ADE chat session, including its settle/snooze lifecycle " +
      "and — when it recently came back from a snooze — the reason it woke.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
    }),
    execute: async ({ sessionId }) => {
      const session = await deps.getChatStatus(sessionId);
      if (!session) return { success: false, error: `Chat not found: ${sessionId}` };
      return { success: true, session, lifecycle: readSessionLifecycle(deps, sessionId) };
    },
  });

  tools.getSessionLifecycle = core({
    description:
      "Read the settle/snooze lifecycle for any ADE session (chat or tracked CLI). Use this to triage " +
      "what needs attention: `snoozed` rows are deliberately quiet until `snoozedUntil`, and `wokeReason` " +
      "explains why a snoozed row came back early ('needs_you' = blocked on a human, 'error' = the turn " +
      "failed, 'turn_complete' = the work finished, 'timer' = the snooze simply expired, 'manual' = someone woke it).",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
    }),
    execute: async ({ sessionId }) => {
      const lifecycle = readSessionLifecycle(deps, sessionId);
      if (!lifecycle) return { success: false, error: `Session not found: ${sessionId}` };
      return { success: true, sessionId, ...lifecycle };
    },
  });

  tools.settleSession = core({
    description:
      "Mark an ADE session complete so it drops out of the active tier. Pass `outcome` to record a one-line " +
      "result on the row. Real activity (a new turn, an approval request, a failed turn) un-settles it again.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      outcome: z.string().trim().min(1).optional().describe("Short outcome line, e.g. 'PR #841 merged, CI green'."),
    }),
    execute: async ({ sessionId, outcome }) => {
      try {
        const result = await deps.sessionService.settleSessionReportingAbort(sessionId, {
          ...(outcome ? { outcome } : {}),
          source: "operator",
        });
        if (!result.found) return { success: false, error: `Session not found: ${sessionId}` };
        if (!result.settled) {
          // The reason matters: `teardown_failed` and `joined_in_flight` do not
          // mean the session went active, and saying so misdirects the operator.
          return { success: false, error: settleAbortMessage(sessionId, result.abortedBy) };
        }
        return { success: true, sessionId, ...readSessionLifecycle(deps, sessionId) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.unsettleSession = core({
    description:
      "Return a settled ADE session to the active lifecycle. This clears a declared settle plus a " +
      "'settled' pin; an explicit keep-active pin survives.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
    }),
    execute: async ({ sessionId }) => {
      try {
        const ok = deps.sessionService.unsettleSession(sessionId);
        if (!ok) return { success: false, error: `Session not found: ${sessionId}` };
        return { success: true, sessionId, ...readSessionLifecycle(deps, sessionId) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.setSessionSettleOverride = core({
    description:
      "Pin an ADE session's settle state. 'settled' behaves like a declared settle, 'active' is a keep-active " +
      "pin, and `clear` returns the row to the declared lifecycle state.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      override: z.enum(["settled", "active", "clear"]).describe("'clear' removes the pin."),
    }),
    execute: async ({ sessionId, override }) => {
      try {
        const normalized = override === "clear" ? null : override;
        const ok = deps.sessionService.setSettleOverride(sessionId, normalized, "operator");
        if (!ok) return { success: false, error: `Session not found: ${sessionId}` };
        return { success: true, sessionId, ...readSessionLifecycle(deps, sessionId) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.snoozeSession = core({
    description:
      "Hide an ADE session from the attention surfaces until a deadline. Snooze is a visibility overlay, not a " +
      "lifecycle change: the session keeps running, and a hand-raise (approval request, failed turn, completed " +
      "turn) wakes it early with a recorded reason. Pass either `untilIso` or `durationMinutes`.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      untilIso: z.string().trim().min(1).optional().describe("ISO-8601 deadline. Wins over durationMinutes."),
      durationMinutes: z
        .number()
        .int()
        .positive()
        .max(60 * 24 * 30)
        .optional()
        .describe("Minutes from now. Ignored when untilIso is supplied."),
    }),
    execute: async ({ sessionId, untilIso, durationMinutes }) => {
      try {
        const deadline = resolveSnoozeDeadline({ untilIso, durationMinutes });
        const ok = deps.sessionService.snoozeSession(sessionId, deadline);
        if (!ok) return { success: false, error: `Session not found: ${sessionId}` };
        return { success: true, sessionId, ...readSessionLifecycle(deps, sessionId) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.wakeSession = core({
    description: "Clear a snooze on an ADE session so it resurfaces now. No-op when the session was not snoozed.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      reason: z
        .enum(["timer", "needs_you", "error", "turn_complete", "manual"])
        .optional()
        .describe("Recorded on the row so the surfaces can explain why it came back. Defaults to 'manual'."),
    }),
    execute: async ({ sessionId, reason }) => {
      try {
        const woke = deps.sessionService.wakeSession(sessionId, reason ?? "manual");
        return { success: true, sessionId, woke, ...readSessionLifecycle(deps, sessionId) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getChatTranscript = core({
    description: "Read recent user and assistant turns for an ADE chat session without focusing the UI.",
    inputSchema: z.object({
      sessionId: z.string(),
      limit: z.number().int().positive().max(100).optional().default(20),
      maxChars: z.number().int().positive().max(40000).optional().default(8000),
    }),
    execute: async ({ sessionId, limit, maxChars }) => {
      try {
        const transcript = await deps.getChatTranscript({ sessionId, limit, maxChars });
        return {
          success: true,
          ...transcript,
          count: transcript.entries.length,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listPullRequests = core({
    description: "List ADE-managed pull requests so the CTO can inspect active review state.",
    inputSchema: z.object({
      refresh: z.boolean().optional().default(true),
    }),
    execute: async ({ refresh }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        const prs = refresh ? await deps.prService.refresh() : deps.prService.listAll();
        return { success: true, count: prs.length, prs };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getPullRequestStatus = core({
    description: "Inspect pull request status, checks, reviews, and comments through ADE's PR service.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      includeChecks: z.boolean().optional().default(true),
      includeReviews: z.boolean().optional().default(true),
      includeComments: z.boolean().optional().default(false),
    }),
    execute: async ({ prId, includeChecks, includeReviews, includeComments }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        const summary = deps.prService.listAll().find((entry) => entry.id === prId) ?? null;
        const [status, checks, reviews, comments] = await Promise.all([
          deps.prService.getStatus(prId),
          includeChecks ? deps.prService.getChecks(prId) : Promise.resolve([]),
          includeReviews ? deps.prService.getReviews(prId) : Promise.resolve([]),
          includeComments ? deps.prService.getComments(prId) : Promise.resolve([]),
        ]);
        return {
          success: true,
          prId,
          summary,
          status,
          checks,
          reviews,
          comments,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.commentOnPullRequest = core({
    description: "Post a comment to a pull request through ADE's PR service.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      body: z.string().trim().min(1),
    }),
    execute: async ({ prId, body }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        const comment = await deps.prService.addComment({ prId, body });
        return { success: true, comment };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updatePullRequestTitle = core({
    description: "Update a pull request title through ADE's PR service.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      title: z.string().trim().min(1),
    }),
    execute: async ({ prId, title }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.updateTitle({ prId, title });
        return { success: true, prId, title };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updatePullRequestBody = core({
    description: "Update a pull request body through ADE's PR service.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      body: z.string().min(1),
    }),
    execute: async ({ prId, body }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.updateDescription({ prId, body });
        return { success: true, prId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listFileWorkspaces = files({
    description: "List ADE file workspaces so the CTO can inspect files by lane or attached workspace.",
    inputSchema: z.object({
      includeArchived: z.boolean().optional().default(true),
    }),
    execute: async ({ includeArchived }) => {
      if (!deps.fileService) return { success: false, error: "File service is not available." };
      const workspaces = deps.fileService.listWorkspaces({ includeArchived });
      return { success: true, count: workspaces.length, workspaces };
    },
  });

  tools.readWorkspaceFile = files({
    description: "Read a file from an ADE workspace or lane without opening the renderer editor.",
    inputSchema: z.object({
      workspaceId: z.string().trim().min(1).optional(),
      laneId: z.string().trim().min(1).optional(),
      path: z.string().trim().min(1),
    }),
    execute: async ({ workspaceId, laneId, path }) => {
      if (!deps.fileService) return { success: false, error: "File service is not available." };
      try {
        const resolvedWorkspaceId = resolveWorkspaceIdForLane(deps, {
          workspaceId,
          laneId,
        });
        const file = await deps.fileService.readFile({ workspaceId: resolvedWorkspaceId, path });
        return {
          success: true,
          workspaceId: resolvedWorkspaceId,
          path,
          file,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.searchWorkspaceText = files({
    description: "Search indexed text inside an ADE workspace or lane.",
    inputSchema: z.object({
      workspaceId: z.string().trim().min(1).optional(),
      laneId: z.string().trim().min(1).optional(),
      query: z.string().trim().min(1),
      limit: z.number().int().positive().max(200).optional().default(50),
    }),
    execute: async ({ workspaceId, laneId, query, limit }) => {
      if (!deps.fileService) return { success: false, error: "File service is not available." };
      try {
        const resolvedWorkspaceId = resolveWorkspaceIdForLane(deps, {
          workspaceId,
          laneId,
        });
        const matches = await deps.fileService.searchText({
          workspaceId: resolvedWorkspaceId,
          query,
          limit,
        });
        return {
          success: true,
          workspaceId: resolvedWorkspaceId,
          count: matches.length,
          matches,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.commentOnLinearIssue = linear({
    description: "Post a comment to a Linear issue.",
    inputSchema: z.object({
      issueId: z.string(),
      body: z.string(),
    }),
    execute: async ({ issueId, body }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        const comment = await deps.issueTracker.createComment(issueId, body);
        return { success: true, comment };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updateLinearIssueState = linear({
    description: "Move a Linear issue to a new state by state ID or exact state name.",
    inputSchema: z.object({
      issueId: z.string(),
      stateId: z.string().optional(),
      stateName: z.string().optional(),
    }),
    execute: async ({ issueId, stateId, stateName }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        let resolvedStateId = stateId?.trim() || "";
        if (!resolvedStateId && stateName?.trim()) {
          const issue = await deps.issueTracker.fetchIssueById(issueId);
          if (!issue?.teamKey) {
            return { success: false, error: "Could not resolve the issue team to look up workflow states." };
          }
          const states = await deps.issueTracker.fetchWorkflowStates(issue.teamKey);
          const match = states.find((entry) => entry.name.toLowerCase() === stateName.trim().toLowerCase()) ?? null;
          if (!match) {
            return { success: false, error: `No workflow state named '${stateName}' for team ${issue.teamKey}.` };
          }
          resolvedStateId = match.id;
        }
        if (!resolvedStateId) {
          return { success: false, error: "Provide either stateId or stateName." };
        }
        await deps.issueTracker.updateIssueState(issueId, resolvedStateId);
        return { success: true, issueId, stateId: resolvedStateId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // PR Creation & Management
  // ---------------------------------------------------------------------------

  tools.createPrFromLane = core({
    description: "Create a pull request from an ADE lane against its parent branch.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1),
      title: z.string().trim().min(1),
      body: z.string().optional(),
      draft: z.boolean().optional().default(false),
    }),
    execute: async ({ laneId, title, body, draft }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        const pr = await deps.prService.createFromLane({ laneId, title, body: body ?? "", draft });
        return { success: true, pr, githubUrl: pr.githubUrl, adeUrl: buildAdePrUrl(pr) };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.landPullRequest = core({
    description: "Land (merge) an ADE-managed pull request.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      method: z.enum(["merge", "squash", "rebase"]).optional().default("squash"),
      archiveLane: z.boolean().optional().default(true),
    }),
    execute: async ({ prId, method, archiveLane }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        const result = await deps.prService.land({ prId, method, archiveLane });
        return result;
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.closePullRequest = core({
    description: "Close an ADE-managed pull request without merging.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
    }),
    execute: async ({ prId }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.closePr({ prId });
        return { success: true, prId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.requestPrReviewers = core({
    description: "Request user or team reviewers on an ADE-managed pull request.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      reviewers: z.array(z.string().trim().min(1)).optional(),
      teamReviewers: z.array(z.string().trim().min(1)).optional(),
    }).refine(
      (value) => (value.reviewers?.length ?? 0) + (value.teamReviewers?.length ?? 0) > 0,
      { message: "Provide at least one reviewer or team reviewer." },
    ),
    execute: async ({ prId, reviewers = [], teamReviewers = [] }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.requestReviewers({ prId, reviewers, teamReviewers });
        return { success: true, prId, reviewers, teamReviewers };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getPullRequestDiff = core({
    description:
      "Retrieve the code diff for an ADE-managed pull request. " +
      "Returns per-file patches from GitHub. Use `files` to limit to specific paths. " +
      "Output is truncated to `maxChars` (default 80 000) to stay within context budgets.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      files: z
        .array(z.string().trim().min(1))
        .optional()
        .describe("Optional list of file paths to include. Omit for full diff."),
      maxChars: z
        .number()
        .int()
        .min(1000)
        .max(400_000)
        .optional()
        .default(80_000)
        .describe("Maximum total characters of patch text to return."),
    }),
    execute: async ({ prId, files: filterFiles, maxChars }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        let prFiles = await deps.prService.getFiles(prId);
        if (filterFiles && filterFiles.length > 0) {
          const allowed = new Set(filterFiles);
          prFiles = prFiles.filter((f) => allowed.has(f.filename));
        }
        // Build bounded output
        let totalChars = 0;
        let truncated = false;
        const patches: Array<{
          filename: string;
          status: string;
          additions: number;
          deletions: number;
          patch: string | null;
        }> = [];
        for (const f of prFiles) {
          const patchLen = f.patch?.length ?? 0;
          if (totalChars + patchLen > maxChars && patches.length > 0) {
            truncated = true;
            break;
          }
          patches.push({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
          });
          totalChars += patchLen;
        }
        return {
          success: true,
          prId,
          fileCount: prFiles.length,
          returnedCount: patches.length,
          truncated,
          patches,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.approvePullRequest = core({
    description: "Submit an APPROVE review on an ADE-managed pull request.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      body: z
        .string()
        .optional()
        .default("")
        .describe("Optional approval comment body."),
    }),
    execute: async ({ prId, body }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.submitReview({ prId, event: "APPROVE", body });
        return { success: true, prId, event: "APPROVE" };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.requestPrChanges = core({
    description:
      "Submit a REQUEST_CHANGES review on an ADE-managed pull request with a comment explaining what needs to change.",
    inputSchema: z.object({
      prId: z.string().trim().min(1),
      body: z.string().trim().min(1).describe("Review comment explaining the requested changes."),
    }),
    execute: async ({ prId, body }) => {
      if (!deps.prService) return { success: false, error: "PR service is not available." };
      try {
        await deps.prService.submitReview({ prId, event: "REQUEST_CHANGES", body });
        return { success: true, prId, event: "REQUEST_CHANGES" };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Lane Management
  // ---------------------------------------------------------------------------

  tools.deleteLane = core({
    description: "Delete an ADE lane and its associated worktree. This is destructive — the worktree and branch are removed.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1).describe("ID of the lane to delete."),
    }),
    execute: async ({ laneId }) => {
      try {
        await deps.laneService.delete({ laneId });
        return { success: true, laneId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.renameLane = core({
    description: "Rename a lane's display name. Does not change the git branch name.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1).describe("ID of the lane to rename."),
      name: z.string().trim().min(1).describe("New display name for the lane."),
    }),
    execute: async ({ laneId, name }) => {
      try {
        await deps.laneService.rename({ laneId, name });
        return { success: true, laneId, name };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.archiveLane = core({
    description: "Archive a lane — hides it from the default lane list but preserves all data and the worktree.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1).describe("ID of the lane to archive."),
    }),
    execute: async ({ laneId }) => {
      try {
        await deps.laneService.archive({ laneId });
        return { success: true, laneId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Test Management
  // ---------------------------------------------------------------------------

  tools.listTestSuites = tests({
    description: "List available test suites that can be run in ADE.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!deps.testService) return { success: false, error: "Test service is not available." };
      const suites = deps.testService.listSuites();
      return { success: true, count: suites.length, suites };
    },
  });

  tools.runTests = tests({
    description: "Run a test suite in a specific ADE lane.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1),
      suiteId: z.string().trim().min(1),
    }),
    execute: async ({ laneId, suiteId }) => {
      if (!deps.testService) return { success: false, error: "Test service is not available." };
      try {
        const run = await deps.testService.run({ laneId, suiteId });
        return { success: true, run };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.stopTestRun = tests({
    description: "Stop a running test execution.",
    inputSchema: z.object({
      runId: z.string().trim().min(1),
    }),
    execute: async ({ runId }) => {
      if (!deps.testService) return { success: false, error: "Test service is not available." };
      try {
        deps.testService.stop({ runId });
        return { success: true, runId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listTestRuns = tests({
    description: "List recent test runs, optionally filtered by lane or suite.",
    inputSchema: z.object({
      laneId: z.string().optional(),
      suiteId: z.string().optional(),
      limit: z.number().int().positive().max(100).optional().default(20),
    }),
    execute: async ({ laneId, suiteId, limit }) => {
      if (!deps.testService) return { success: false, error: "Test service is not available." };
      const runs = deps.testService.listRuns({
        ...(laneId?.trim() ? { laneId: laneId.trim() } : {}),
        ...(suiteId?.trim() ? { suiteId: suiteId.trim() } : {}),
        limit,
      });
      return { success: true, count: runs.length, runs };
    },
  });

  tools.getTestLog = tests({
    description: "Read the tail of a test run log.",
    inputSchema: z.object({
      runId: z.string().trim().min(1),
      maxBytes: z.number().int().positive().max(500_000).optional().default(40_000),
    }),
    execute: async ({ runId, maxBytes }) => {
      if (!deps.testService) return { success: false, error: "Test service is not available." };
      try {
        const content = deps.testService.getLogTail({ runId, maxBytes });
        return { success: true, runId, content };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Terminal Management
  // ---------------------------------------------------------------------------

  tools.createTerminal = core({
    description: "Open a shell terminal (PTY) in a lane. Use for raw CLI commands only — for AI-powered work, use spawnChat instead. This does NOT create an AI chat session.",
    inputSchema: z.object({
      laneId: z.string().trim().min(1),
      title: z.string().optional(),
      startupCommand: z.string().optional(),
    }),
    execute: async ({ laneId, title, startupCommand }) => {
      if (!deps.ptyService) return { success: false, error: "Terminal service is not available." };
      try {
        // cols/rows/title are required by the real PtyCreateArgs. They used to
        // be omitted and silently clamped inside the pty service — invisible
        // while these tool bodies were unreachable, live now that they execute.
        const result = await deps.ptyService.create({
          laneId,
          title: title?.trim() || "CTO terminal",
          cols: 100,
          rows: 30,
          ...(startupCommand?.trim() ? { startupCommand: startupCommand.trim() } : {}),
          toolType: "shell",
          tracked: true,
        });
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Linear Issue Discovery
  // ---------------------------------------------------------------------------

  tools.listLinearIssues = linear({
    description: "Search Linear issues by project slug and state.",
    inputSchema: z.object({
      projectSlugs: z.array(z.string()).optional(),
      stateTypes: z.array(z.string()).optional(),
      limit: z.number().int().positive().max(100).optional().default(25),
    }),
    execute: async ({ projectSlugs, stateTypes, limit }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        const issues = await deps.issueTracker.fetchCandidateIssues({
          projectSlugs: projectSlugs ?? [],
          stateTypes: stateTypes ?? ["started", "unstarted"],
        });
        const limited = issues.slice(0, limit);
        return {
          success: true,
          count: limited.length,
          totalAvailable: issues.length,
          issues: limited.map((issue) => ({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            stateName: issue.stateName,
            priorityLabel: issue.priorityLabel,
            assigneeName: issue.assigneeName,
            labels: issue.labels,
            projectSlug: issue.projectSlug,
            url: issue.url,
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getLinearIssue = linear({
    description: "Fetch a single Linear issue by ID or identifier.",
    inputSchema: z.object({
      issueId: z.string().trim().min(1),
    }),
    execute: async ({ issueId }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        const issue = await deps.issueTracker.fetchIssueById(issueId);
        if (!issue) return { success: false, error: `Issue not found: ${issueId}` };
        return { success: true, issue: buildIssueBrief(issue), raw: issue };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.updateLinearIssueAssignee = linear({
    description: "Assign or unassign a Linear issue.",
    inputSchema: z.object({
      issueId: z.string().trim().min(1),
      assigneeId: z.string().nullable(),
    }),
    execute: async ({ issueId, assigneeId }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        await deps.issueTracker.updateIssueAssignee(issueId, assigneeId);
        return { success: true, issueId, assigneeId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.addLinearIssueLabel = linear({
    description: "Add a label to a Linear issue.",
    inputSchema: z.object({
      issueId: z.string().trim().min(1),
      label: z.string().trim().min(1),
    }),
    execute: async ({ issueId, label }) => {
      if (!deps.issueTracker) return { success: false, error: "Linear issue tracker is not available." };
      try {
        await deps.issueTracker.addLabel(issueId, label);
        return { success: true, issueId, label };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Automation Management
  // ---------------------------------------------------------------------------

  tools.listAutomations = core({
    description: "List automation rules configured in ADE.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!deps.automationService) return { success: false, error: "Automation service is not available." };
      const rules = deps.automationService.list();
      return { success: true, count: rules.length, rules };
    },
  });

  tools.triggerAutomation = core({
    description: "Manually trigger an ADE automation rule.",
    inputSchema: z.object({
      automationId: z.string().trim().min(1),
      dryRun: z.boolean().optional().default(false),
    }),
    execute: async ({ automationId, dryRun }) => {
      if (!deps.automationService) return { success: false, error: "Automation service is not available." };
      try {
        const run = await deps.automationService.triggerManually({ id: automationId, dryRun });
        return { success: true, run };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listAutomationRuns = core({
    description: "List recent automation run history.",
    inputSchema: z.object({
      limit: z.number().int().positive().max(100).optional().default(20),
    }),
    execute: async ({ limit }) => {
      if (!deps.automationService) return { success: false, error: "Automation service is not available." };
      const runs = deps.automationService.listRuns({ limit });
      return { success: true, count: runs.length, runs };
    },
  });

  // ---------------------------------------------------------------------------
  // Git Operations
  // ---------------------------------------------------------------------------

  /**
   * Lane for a *read*. Defaulting to the CTO's own session lane is fine here:
   * inspecting the primary lane is normal supervision.
   */
  const resolveReadLaneId = (laneId?: string): string => laneId?.trim() || deps.defaultLaneId;

  /**
   * Lane for a *mutation*. Deliberately has no default.
   *
   * `deps.defaultLaneId` is the CTO session's lane, and the CTO session is
   * pinned to the project's primary lane — so defaulting here would turn an
   * omitted `laneId` into "commit/push/reset the primary worktree", which is
   * exactly what lanes exist to prevent. The capability manifest tells the CTO
   * to name a lane for real work; this enforces it in code instead of trusting
   * the model to have read the prompt. `gitGuard`/`conflictGuard` turn the
   * throw into a `{ success: false, error }` the CTO can recover from by
   * retrying with an explicit lane.
   */
  const requireMutationLaneId = (laneId: string | undefined, operation: string): string => {
    const trimmed = laneId?.trim();
    if (trimmed) return trimmed;
    throw new Error(
      `${operation} needs an explicit laneId. It is a mutating git operation and there is no safe default — `
      + "the CTO's own lane is the project's primary lane. Call listLanes and pass the lane you mean.",
    );
  };

  // The service is handed to the callback rather than re-read inside it: a
  // `deps.gitService` narrowing cannot survive the arrow boundary, and every
  // call site paid for that with a non-null assertion.
  const gitGuard = async <T>(
    fn: (git: NonNullable<CtoOperatorToolDeps["gitService"]>) => Promise<T>,
  ): Promise<{ success: true } & T | { success: false; error: string }> => {
    const git = deps.gitService;
    if (!git) return { success: false, error: "Git service is not available." };
    try {
      return { success: true, ...(await fn(git)) } as { success: true } & T;
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  };

  tools.gitStatus = core({
    description: "Get the git sync status for a lane (branch, ahead/behind, dirty state).",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard((git) => git.getSyncStatus({ laneId: resolveReadLaneId(laneId) })),
  });

  tools.gitCommit = core({
    description: "Create a git commit in a named lane. By default stages all changes (stageAll: true). Use gitStatus first to see what will be committed. Never commits to the CTO's own lane by default — laneId is required.",
    inputSchema: z.object({ laneId: z.string().min(1).describe("Lane to commit in. Required — there is no default."), message: z.string().min(1).describe("Commit message."), stageAll: z.boolean().optional().default(true).describe("Stage all changes before committing.") }),
    execute: ({ laneId, message, stageAll }) => gitGuard((git) => git.commit({ laneId: requireMutationLaneId(laneId, "gitCommit"), message, stageAll })),
  });

  tools.gitPush = core({
    description: "Push commits to the remote for a named lane. laneId is required — there is no default.",
    inputSchema: z.object({ laneId: z.string().min(1).describe("Lane to push. Required — there is no default."), force: z.boolean().optional().default(false) }),
    execute: ({ laneId, force }) => gitGuard((git) => git.push({ laneId: requireMutationLaneId(laneId, "gitPush"), force })),
  });

  tools.gitPull = core({
    description: "Pull from the remote for a lane. Defaults to fast-forward only; use rebase or merge when that is the intended history shape.",
    inputSchema: z.object({
      laneId: z.string().min(1).describe("Lane to pull into. Required — there is no default."),
      mode: z.enum(["ff-only", "rebase", "merge"]).optional().default("ff-only"),
    }),
    execute: ({ laneId, mode }) => gitGuard((git) => git.pull({ laneId: requireMutationLaneId(laneId, "gitPull"), mode })),
  });

  tools.gitUndoLastHeadChange = core({
    description: "Undo the latest successful head-changing git operation recorded by ADE for a named lane. This resets the lane with git reset --hard, so laneId is required — there is no default.",
    inputSchema: z.object({ laneId: z.string().min(1).describe("Lane to undo in. Required — there is no default.") }),
    execute: ({ laneId }) => gitGuard((git) => git.undoLastHeadChange({ laneId: requireMutationLaneId(laneId, "gitUndoLastHeadChange") })),
  });

  tools.gitRedoLastHeadChange = core({
    description: "Redo the latest successful ADE git undo for a named lane. This resets the lane with git reset --hard, so laneId is required — there is no default.",
    inputSchema: z.object({ laneId: z.string().min(1).describe("Lane to redo in. Required — there is no default.") }),
    execute: ({ laneId }) => gitGuard((git) => git.redoLastHeadChange({ laneId: requireMutationLaneId(laneId, "gitRedoLastHeadChange") })),
  });

  tools.gitFetch = core({
    description: "Fetch remote refs for a lane.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard((git) => git.fetch({ laneId: resolveReadLaneId(laneId) })),
  });

  tools.gitListRecentCommits = core({
    description: "List recent commits in a lane.",
    inputSchema: z.object({ laneId: z.string().optional(), limit: z.number().int().positive().max(100).optional().default(20) }),
    execute: ({ laneId, limit }) => gitGuard(async (git) => {
      const commits = await git.listRecentCommits({ laneId: resolveReadLaneId(laneId), limit });
      return { count: commits.length, commits };
    }),
  });

  tools.gitListBranches = core({
    description: "List git branches for a lane.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(async (git) => {
      const branches = await git.listBranches({ laneId: resolveReadLaneId(laneId) });
      return { count: branches.length, branches };
    }),
  });

  tools.gitCheckoutBranch = core({
    description: "Switch to or create a git branch in a lane.",
    inputSchema: z.object({
      laneId: z.string().min(1).describe("Lane to switch branches in. Required — there is no default."),
      branch: z.string().min(1),
      create: z.boolean().optional().default(false),
      startPoint: z.string().optional(),
      baseRef: z.string().optional(),
      acknowledgeActiveWork: z.boolean().optional().default(false),
    }),
    execute: ({ laneId, branch, create, startPoint, baseRef, acknowledgeActiveWork }) => gitGuard((git) => git.checkoutBranch({
      laneId: requireMutationLaneId(laneId, "gitCheckoutBranch"),
      branchName: branch,
      mode: create ? "create" : "existing",
      startPoint,
      baseRef,
      acknowledgeActiveWork,
    })),
  });

  tools.gitStashPush = core({
    description: "Stash working changes for a lane branch.",
    inputSchema: z.object({ laneId: z.string().min(1).describe("Lane to stash in. Required — there is no default."), message: z.string().optional() }),
    execute: ({ laneId, message }) => gitGuard((git) => git.stashPush({ laneId: requireMutationLaneId(laneId, "gitStashPush"), ...(message?.trim() ? { message: message.trim() } : {}) })),
  });

  tools.gitStashPop = core({
    description: "Pop a stash saved for a lane branch. Defaults to the latest branch-matching stash; call gitStashList to inspect refs.",
    inputSchema: z.object({ laneId: z.string().min(1).describe("Lane to pop the stash in. Required — there is no default."), stashRef: z.string().optional() }),
    execute: ({ laneId, stashRef }) => gitGuard(async (git) => {
      const resolvedLaneId = requireMutationLaneId(laneId, "gitStashPop");
      const trimmedRef = stashRef?.trim();
      const stashes = await git.listStashes({ laneId: resolvedLaneId });
      const selectedStash = trimmedRef
        ? stashes.find((stash) => stash.ref === trimmedRef)
        : stashes[0];
      if (trimmedRef && !selectedStash) {
        throw new Error(`Stash ${trimmedRef} is not saved for this lane branch.`);
      }
      const resolvedRef = trimmedRef || selectedStash?.ref;
      if (!resolvedRef) throw new Error("No stashes are saved for this lane branch.");
      return git.stashPop({
        laneId: resolvedLaneId,
        stashRef: resolvedRef,
        ...(selectedStash?.oid ? { stashOid: selectedStash.oid } : {}),
      });
    }),
  });

  tools.gitStashList = core({
    description: "List stashes saved for a lane branch.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard(async (git) => {
      const stashes = await git.listStashes({ laneId: resolveReadLaneId(laneId) });
      return { count: stashes.length, stashes };
    }),
  });

  tools.gitGetConflictState = core({
    description: "Check if a lane has merge or rebase conflicts in progress.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => gitGuard((git) => git.getConflictState({ laneId: resolveReadLaneId(laneId) })),
  });

  tools.gitRebaseContinue = core({
    description: "Continue a rebase after resolving conflicts in a named lane. laneId is required — there is no default.",
    inputSchema: z.object({ laneId: z.string().min(1).describe("Lane to continue the rebase in. Required — there is no default.") }),
    execute: ({ laneId }) => gitGuard((git) => git.rebaseContinue({ laneId: requireMutationLaneId(laneId, "gitRebaseContinue") })),
  });

  tools.gitRebaseAbort = core({
    description: "Abort an in-progress rebase in a named lane. laneId is required — there is no default.",
    inputSchema: z.object({ laneId: z.string().min(1).describe("Lane to abort the rebase in. Required — there is no default.") }),
    execute: ({ laneId }) => gitGuard((git) => git.rebaseAbort({ laneId: requireMutationLaneId(laneId, "gitRebaseAbort") })),
  });

  tools.gitMergeAbort = core({
    description: "Abort an in-progress merge in a named lane. laneId is required — there is no default.",
    inputSchema: z.object({ laneId: z.string().min(1).describe("Lane to abort the merge in. Required — there is no default.") }),
    execute: ({ laneId }) => gitGuard((git) => git.mergeAbort({ laneId: requireMutationLaneId(laneId, "gitMergeAbort") })),
  });

  // ---------------------------------------------------------------------------
  // Conflict Resolution
  // ---------------------------------------------------------------------------

  /** Same shape as `gitGuard`: the narrowed service travels into the callback. */
  const conflictGuard = async <T>(
    fn: (conflicts: NonNullable<CtoOperatorToolDeps["conflictService"]>) => Promise<T>,
  ): Promise<{ success: true } & T | { success: false; error: string }> => {
    const conflicts = deps.conflictService;
    if (!conflicts) return { success: false, error: "Conflict service is not available." };
    try {
      return { success: true, ...(await fn(conflicts)) } as { success: true } & T;
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  };

  tools.getConflictStatus = conflicts({
    description: "Check merge conflict status for a lane.",
    inputSchema: z.object({ laneId: z.string().optional() }),
    execute: ({ laneId }) => conflictGuard((conflicts) => conflicts.getLaneStatus({ laneId: resolveReadLaneId(laneId) })),
  });

  tools.getConflictRiskMatrix = conflicts({
    description: "Get the conflict risk matrix across all lanes.",
    inputSchema: z.object({}),
    execute: () => conflictGuard(async (conflicts) => {
      const matrix = await conflicts.getRiskMatrix();
      return { count: matrix.length, entries: matrix };
    }),
  });

  tools.simulateMerge = conflicts({
    description: "Dry-run merge between two lanes to predict conflicts.",
    inputSchema: z.object({ sourceLaneId: z.string().min(1), targetLaneId: z.string().optional() }),
    execute: ({ sourceLaneId, targetLaneId }) => conflictGuard((conflicts) => conflicts.simulateMerge({ sourceLaneId, targetLaneId: targetLaneId?.trim() || undefined })),
  });

  tools.runConflictPrediction = conflicts({
    description: "Run batch conflict prediction across all lanes.",
    inputSchema: z.object({}),
    execute: () => conflictGuard((conflicts) => conflicts.runPrediction()),
  });

  tools.listConflictProposals = conflicts({
    description: "List stored conflict resolution proposals for a lane.",
    inputSchema: z.object({ laneId: z.string().min(1) }),
    execute: ({ laneId }) => conflictGuard(async (conflicts) => {
      const proposals = await conflicts.listProposals({ laneId });
      return { count: proposals.length, proposals };
    }),
  });

  tools.applyConflictProposal = conflicts({
    description: "Apply an AI-generated conflict resolution proposal.",
    inputSchema: z.object({ laneId: z.string().min(1), proposalId: z.string().min(1) }),
    execute: ({ laneId, proposalId }) => conflictGuard((conflicts) => conflicts.applyProposal({ laneId, proposalId })),
  });

  tools.undoConflictProposal = conflicts({
    description: "Undo an applied conflict resolution proposal.",
    inputSchema: z.object({ laneId: z.string().min(1), proposalId: z.string().min(1) }),
    execute: ({ laneId, proposalId }) => conflictGuard((conflicts) => conflicts.undoProposal({ laneId, proposalId })),
  });

  // ---------------------------------------------------------------------------
  // Agent Chat Steering
  // ---------------------------------------------------------------------------

  tools.steerChat = core({
    description: "Inject a steering instruction into an active chat session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      instruction: z.string().min(1),
    }),
    execute: async ({ sessionId, instruction }) => {
      try {
        await deps.steerChat({ sessionId, instruction });
        return { success: true, sessionId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.cancelSteer = core({
    description: "Cancel a pending steer instruction on a chat session. Pass the steerId returned by steerChat.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      steerId: z.string().min(1).describe("The steerId returned by steerChat."),
    }),
    execute: async ({ sessionId, steerId }) => {
      try {
        await deps.cancelSteer({ sessionId, steerId });
        return { success: true, sessionId };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.listSubagents = core({
    description: "List sub-agents spawned by a chat session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
    }),
    execute: async ({ sessionId }) => {
      try {
        const subagents = await deps.listSubagents({ sessionId });
        return { success: true, count: subagents.length, subagents };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.approveToolUse = core({
    description: "Approve or deny a pending tool use in a chat session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      toolUseId: z.string().min(1),
      decision: z.enum(["accept", "accept_for_session", "decline", "cancel"]),
    }),
    execute: async ({ sessionId, toolUseId, decision }) => {
      try {
        await deps.approveToolUse({ sessionId, toolUseId, decision });
        return { success: true, sessionId, toolUseId, decision };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Unified Event Feed
  // ---------------------------------------------------------------------------

  type RecentEvent = {
    type: string;
    timestamp: string;
    summary: string;
    ids: Record<string, string | null>;
  };

  tools.getRecentEvents = core({
    description:
      "Surface a unified feed of recent project events: CTO session completions, " +
      "test completions/failures, PR review activity, and chat session events. " +
      "Use this to stay aware of what happened while you were idle or to brief the user on recent activity.",
    inputSchema: z.object({
      since: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp. Only events after this time are returned. Defaults to 24 hours ago."),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum number of events to return."),
    }),
    execute: async ({ since, limit }) => {
      const sinceEpoch = since
        ? parseIsoToEpoch(since)
        : Date.now() - 24 * 60 * 60 * 1000;
      const safeLimit = Math.max(1, Math.min(200, limit));
      const events: RecentEvent[] = [];

      const afterCutoff = (ts: string | null | undefined): boolean => {
        if (!ts) return false;
        const epoch = parseIsoToEpoch(ts);
        return Number.isFinite(epoch) && epoch >= sinceEpoch;
      };

      // 1. CTO session logs
      if (deps.ctoStateService) {
        try {
          const logs = deps.ctoStateService.getSessionLogs(200);
          for (const log of logs) {
            if (!afterCutoff(log.createdAt)) continue;
            events.push({
              type: "cto_session",
              timestamp: log.createdAt,
              summary: log.summary,
              ids: { sessionId: log.sessionId, logId: log.id },
            });
          }
        } catch {
          // CTO state service may not be fully initialized
        }
      }

      // 2. Test runs
      if (deps.testService) {
        try {
          const runs = deps.testService.listRuns({ limit: 100 });
          for (const run of runs) {
            const ts = run.endedAt ?? run.startedAt;
            if (!afterCutoff(ts)) continue;
            const duration = run.durationMs != null ? ` (${Math.round(run.durationMs / 1000)}s)` : "";
            events.push({
              type: "test_run",
              timestamp: ts,
              summary: `${run.suiteName}: ${run.status}${duration}`,
              ids: {
                runId: run.id,
                suiteId: run.suiteId,
                laneId: run.laneId,
              },
            });
          }
        } catch {
          // ignore
        }
      }

      // 5. PR review activity (recent events from all tracked PRs)
      if (deps.prService) {
        try {
          const prs = deps.prService.listAll();
          // Fetch activity for the most recently updated PRs to avoid excessive API calls
          const recentPrs = prs
            .filter((pr) => afterCutoff(pr.updatedAt))
            .slice(0, 5);
          for (const pr of recentPrs) {
            try {
              const activity = await deps.prService.getActivity(pr.id);
              for (const ev of activity) {
                if (!afterCutoff(ev.timestamp)) continue;
                events.push({
                  type: `pr_${ev.type}`,
                  timestamp: ev.timestamp,
                  summary: `PR #${pr.githubPrNumber} "${pr.title}": ${ev.body ?? ev.type}${ev.author ? ` (${ev.author})` : ""}`,
                  ids: {
                    prId: pr.id,
                    prNumber: String(pr.githubPrNumber),
                    laneId: pr.laneId,
                  },
                });
              }
            } catch {
              // individual PR activity fetch may fail
            }
          }
        } catch {
          // ignore
        }
      }

      // 7. Chat session events
      try {
        const chats = await deps.listChats(undefined, { includeIdentity: false, includeAutomation: true });
        for (const chat of chats) {
          const ts = chat.endedAt ?? chat.lastActivityAt;
          if (!afterCutoff(ts)) continue;
          events.push({
            type: "chat_session",
            timestamp: ts,
            summary: `Chat "${chat.title ?? chat.sessionId}": ${chat.status}${chat.summary ? ` — ${chat.summary}` : ""}`,
            ids: {
              sessionId: chat.sessionId,
              laneId: chat.laneId,
            },
          });
        }
      } catch {
        // ignore
      }

      // Sort descending by timestamp and apply limit
      events.sort((a, b) => parseIsoToEpoch(b.timestamp) - parseIsoToEpoch(a.timestamp));
      const sliced = events.slice(0, safeLimit);

      return {
        success: true,
        count: sliced.length,
        totalBeforeLimit: events.length,
        since: since ?? new Date(sinceEpoch).toISOString(),
        events: sliced,
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Project Health Dashboard
  // ---------------------------------------------------------------------------

  tools.getProjectHealthSummary = core({
    description:
      "Aggregate project health into a single snapshot: test pass rates, PR status distribution, and active lanes.",
    inputSchema: z.object({
      testRunLimit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .default(50),
    }),
    execute: async ({ testRunLimit }) => {
      let tests: {
        suiteCount: number;
        recentRuns: number;
        byStatus: Record<string, number>;
        passRate: number;
      } | null = null;
      if (deps.testService) {
        const suites = deps.testService.listSuites();
        const runs = deps.testService.listRuns({ limit: testRunLimit });
        const byStatus: Record<string, number> = {};
        for (const r of runs) {
          byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
        }
        const terminal = runs.filter((r) => r.status !== "running");
        const passed = terminal.filter((r) => r.status === "passed").length;
        tests = {
          suiteCount: suites.length,
          recentRuns: runs.length,
          byStatus,
          passRate: terminal.length > 0 ? Math.round((passed / terminal.length) * 10000) / 100 : 0,
        };
      }

      let prs: {
        total: number;
        byState: Record<string, number>;
        byChecksStatus: Record<string, number>;
        byReviewStatus: Record<string, number>;
      } | null = null;
      if (deps.prService) {
        const all = (deps.prService as any).listAll?.() ?? [];
        const byState: Record<string, number> = {};
        const byChecksStatus: Record<string, number> = {};
        const byReviewStatus: Record<string, number> = {};
        for (const pr of all) {
          byState[pr.state] = (byState[pr.state] ?? 0) + 1;
          if (pr.checksStatus) byChecksStatus[pr.checksStatus] = (byChecksStatus[pr.checksStatus] ?? 0) + 1;
          if (pr.reviewStatus) byReviewStatus[pr.reviewStatus] = (byReviewStatus[pr.reviewStatus] ?? 0) + 1;
        }
        prs = { total: all.length, byState, byChecksStatus, byReviewStatus };
      }

      const allLanes = await deps.laneService.list({ includeArchived: false });
      const activeLanes = allLanes.filter((l) => l.laneType !== "primary");
      const lanes = {
        total: allLanes.length,
        active: activeLanes.length,
      };

      return {
        success: true,
        generatedAt: nowIso(),
        tests,
        prs,
        lanes,
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Computer Use Artifact Oversight
  // ---------------------------------------------------------------------------

  tools.listComputerUseArtifacts = proof({
    description:
      "List computer-use artifacts (screenshots, videos, browser traces, console logs) across the project.",
    inputSchema: z.object({
      kind: z
        .enum(["screenshot", "video_recording", "browser_trace", "browser_verification", "console_logs"])
        .optional(),
      ownerKind: z
        .enum(["lane", "chat_session", "automation_run", "github_pr", "linear_issue"])
        .optional(),
      ownerId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().default(50),
    }),
    execute: async ({ kind, ownerKind, ownerId, limit }) => {
      if (!deps.computerUseArtifactBrokerService) {
        return { success: false, error: "Computer-use artifact broker is not available." };
      }
      try {
        const artifacts = deps.computerUseArtifactBrokerService.listArtifacts({
          kind: kind ?? null,
          ownerKind: ownerKind ?? undefined,
          ownerId: ownerId ?? undefined,
          limit,
        });
        return {
          success: true,
          count: artifacts.length,
          artifacts: artifacts.map((a: any) => ({
            id: a.id,
            kind: a.kind,
            title: a.title,
            description: a.description,
            uri: a.uri,
            reviewState: a.reviewState,
            workflowState: a.workflowState,
            reviewNote: a.reviewNote,
            createdAt: a.createdAt,
            owners: (a.links ?? []).map((l: any) => ({ kind: l.ownerKind, id: l.ownerId, relation: l.relation })),
          })),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.getArtifactPreview = proof({
    description: "Get full details for a specific computer-use artifact by ID.",
    inputSchema: z.object({
      artifactId: z.string().min(1),
    }),
    execute: async ({ artifactId }) => {
      if (!deps.computerUseArtifactBrokerService) {
        return { success: false, error: "Computer-use artifact broker is not available." };
      }
      try {
        const results = deps.computerUseArtifactBrokerService.listArtifacts({ artifactId });
        if (results.length === 0) return { success: false, error: `Artifact not found: ${artifactId}` };
        const a = results[0] as any;
        return {
          success: true,
          artifact: {
            id: a.id, kind: a.kind, title: a.title, description: a.description,
            uri: a.uri, mimeType: a.mimeType, reviewState: a.reviewState,
            workflowState: a.workflowState, reviewNote: a.reviewNote,
            metadata: a.metadata, createdAt: a.createdAt,
            links: (a.links ?? []).map((l: any) => ({
              ownerKind: l.ownerKind, ownerId: l.ownerId, relation: l.relation,
            })),
          },
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.reviewArtifact = proof({
    description: "Mark a computer-use artifact as approved, rejected, or needing more evidence.",
    inputSchema: z.object({
      artifactId: z.string().min(1),
      reviewState: z.enum(["pending", "accepted", "needs_more", "dismissed"]),
      workflowState: z.enum(["evidence_only", "promoted", "published", "dismissed"]).optional(),
      reviewNote: z.string().max(2000).optional(),
    }),
    execute: async ({ artifactId, reviewState, workflowState, reviewNote }) => {
      if (!deps.computerUseArtifactBrokerService) {
        return { success: false, error: "Computer-use artifact broker is not available." };
      }
      try {
        const updated = deps.computerUseArtifactBrokerService.updateArtifactReview({
          artifactId,
          reviewState,
          workflowState: workflowState ?? null,
          reviewNote: reviewNote ?? null,
        });
        return {
          success: true,
          artifact: { id: updated.id, kind: updated.kind, reviewState: updated.reviewState, workflowState: updated.workflowState, reviewNote: updated.reviewNote },
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Codebase Self-Search (for when CTO needs to understand ADE internals)
  // ---------------------------------------------------------------------------

  // ADE source search sits with file reads
  tools.searchCodebase = files({
    description:
      "Search the ADE codebase itself for patterns, function names, or implementation details. " +
      "Use this when you need to understand how an ADE feature works internally, find the implementation " +
      "of a specific function, or debug unexpected behavior. This searches the actual ADE source code, " +
      "not the user's project files. Results are scoped and truncated to avoid context bloat.",
    inputSchema: z.object({
      pattern: z.string().trim().min(1).describe("Regex or text pattern to search for (e.g. 'spawnChat', 'createLane', 'modelId')."),
      fileGlob: z.string().optional().describe("Optional file glob to narrow search (e.g. '*.ts', 'services/**/*.ts'). Defaults to all TypeScript files."),
      maxResults: z.number().int().positive().max(30).optional().default(10).describe("Max number of file matches to return."),
      contextLines: z.number().int().nonnegative().max(5).optional().default(2).describe("Lines of context around each match."),
    }),
    execute: async ({ pattern, fileGlob, maxResults, contextLines }) => {
      try {
        const { execFileSync } = await import("node:child_process");
        const adeRoot = typeof __dirname === "string"
          ? path.resolve(__dirname, "../../../../..")
          : path.resolve(process.cwd());
        const searchPattern = pattern.trim().slice(0, 500);
        const globArg = (fileGlob?.trim() || "*.ts").slice(0, 200);
        const args = [
          "--no-heading",
          "--line-number",
          "--max-count=3",
          `--context=${contextLines}`,
          "--glob",
          globArg,
          "--",
          searchPattern,
          ".",
        ];
        const result = execFileSync("rg", args, {
          cwd: adeRoot,
          encoding: "utf8",
          maxBuffer: 512 * 1024,
          timeout: 10_000,
          windowsHide: true,
        }).trim();
        const lines = result ? result.split("\n") : [];
        const outputLines: string[] = [];
        const seenFiles = new Set<string>();
        for (const line of lines) {
          const match = line.match(/^([^:]+):\d+:/);
          if (match && !seenFiles.has(match[1])) {
            if (seenFiles.size >= maxResults) break;
            seenFiles.add(match[1]);
          }
          outputLines.push(line);
          if (outputLines.length >= 200) break;
        }
        const truncated = outputLines.length < lines.length || seenFiles.size >= maxResults;
        return {
          success: true,
          matchCount: outputLines.filter((l) => l.match(/^\S+:\d+:/)).length,
          truncated,
          output: outputLines.join("\n"),
        };
      } catch (error: any) {
        if (error?.status === 1) {
          return { success: true, matchCount: 0, truncated: false, output: "No matches found." };
        }
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Persistent Memory
  // ---------------------------------------------------------------------------

  tools.saveMemory = core({
    description:
      "Save a durable fact to your persistent memory (MEMORY.md). Use for decisions, user preferences, " +
      "conventions, and standing project context you should remember across sessions and model switches. " +
      "Keep each fact to one crisp sentence. Exact duplicates are ignored.",
    inputSchema: z.object({
      fact: z.string().trim().min(1).describe("A single durable fact to remember."),
      tags: memoryTagsSchema.optional().describe(
        "What the fact is about. Tag whenever you can: a tagged fact is the one a worker chat on that lane, "
        + "and the nightly gardener, can actually find later.",
      ),
    }),
    execute: async ({ fact, tags }) => {
      if (!deps.ctoMemoryService) return { success: false, error: "Memory service is not available." };
      try {
        const result = deps.ctoMemoryService.appendMemoryFact(fact, tags ?? null);
        return {
          success: true,
          saved: result.saved,
          fact: result.fact,
          file: "MEMORY.md",
          ...(result.evictedCount
            ? {
                notice: `MEMORY.md hit its size cap: the ${result.evictedCount} oldest fact(s) were moved to memory-archive.md (still searchable via searchMemory). Consider pruning MEMORY.md.`,
              }
            : {}),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.searchMemory = core({
    description:
      "Search your persistent memory (MEMORY.md, thread state, and recent daily logs) for prior context. " +
      "Use this before asking the user to restate something you may already know.",
    inputSchema: z.object({
      query: z.string().trim().min(1),
      limit: z.number().int().positive().max(100).optional().default(20),
      tags: memoryTagsSchema.optional().describe("Restrict the search to facts carrying these tags."),
    }),
    execute: async ({ query, limit, tags }) => {
      if (!deps.ctoMemoryService) return { success: false, error: "Memory service is not available." };
      try {
        const rows = deps.ctoMemoryService.searchMemory(query, { limit, ...(tags ? { tags } : {}) });
        return { success: true, query, count: rows.length, rows };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.readDiscoveries = core({
    description:
      "Drain the worker discovery log: findings agents handed up since you last read it. "
      + "These are unreviewed — decide which ones deserve saveMemory. Reading advances the cursor, so each "
      + "discovery is shown once.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!deps.ctoMemoryService) return { success: false, error: "Memory service is not available." };
      try {
        const fresh = deps.ctoMemoryService.readNewDiscoveries();
        // `text` is the budgeted view; `lines` is raw. The drain deliberately
        // hands out one line even when it alone exceeds the budget, so that a
        // single oversized entry cannot wedge the queue — returning `lines`
        // here would let that one entry carry the whole 64 KB window into a
        // tool result the budget exists to bound.
        return { success: true, count: fresh.lines.length, discoveries: fresh.text };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  tools.readMemory = core({
    description:
      "Read your persistent memory: durable facts (MEMORY.md), the current thread state, and today's daily journal. " +
      "Use to review what you already know before making decisions.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!deps.ctoMemoryService) return { success: false, error: "Memory service is not available." };
      try {
        const snapshot = deps.ctoMemoryService.getSnapshot();
        return {
          success: true,
          memory: snapshot.memory,
          threadState: snapshot.threadState,
          dailyLog: snapshot.dailyLog,
          dailyLogDate: snapshot.dailyLogDate,
          updatedAt: snapshot.updatedAt,
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  // ===========================================================================
  // Full ADE domain coverage, loaded on demand
  //
  // Everything below follows three rules:
  //   1. A missing service yields `{ success: false, error }`, never a throw.
  //   2. Mutating tools that name a lane go through `requireMutationLaneId`.
  //   3. Destructive tools go through `confirmDestructive` first.
  // ===========================================================================

  /** Uniform "the runtime did not wire this" answer. */
  const unavailable = (what: string) => ({
    success: false as const,
    error: `${what} is not available on this runtime.`,
  });

  /** Uniform try/catch so a service throw becomes a recoverable tool result. */
  const attempt = async <T>(fn: () => Promise<T> | T): Promise<{ success: true; result: T } | { success: false; error: string }> => {
    try {
      return { success: true, result: await fn() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  };

  /**
   * The destructive-action gate.
   *
   * Raises the same approval card an agent's tool call raises, and the user
   * answers it through `approveToolUse`. Returns an error result to hand back
   * to the model when the user declines, or `null` to proceed.
   *
   * With no `requestApproval` wired (headless `ade` RPC, tests) it proceeds:
   * there is no one to show a card to, and a tool that blocks forever on an
   * invisible prompt is worse than the write it was guarding.
   */
  const confirmDestructive = async (args: {
    title: string;
    description: string;
    detail?: Record<string, unknown>;
  }): Promise<{ success: false; error: string } | null> => {
    if (!deps.requestApproval) return null;
    try {
      const verdict = await deps.requestApproval(args);
      if (verdict.approved) return null;
      return {
        success: false,
        error: verdict.reason?.trim()
          ? `Declined by the user: ${verdict.reason.trim()}`
          : "Declined by the user.",
      };
    } catch (error) {
      return { success: false, error: `Approval could not be requested: ${getErrorMessage(error)}` };
    }
  };

  // ── Pack loading ───────────────────────────────────────────────────────────

  // `core`, not a pack of its own: the loader is what reveals every other
  // pack, so it can never be one of the things waiting to be revealed.
  tools.loadCtoTools = core({
    description:
      "Load one pack of ADE operator tools. Every ADE domain is reachable from this session, but only the core pack "
      + "(lanes, chats, steering, git, PRs, automations, handoff, memory, events) carries full descriptions from the start. "
      + "Extension packs stay callable at all times — this reveals their full descriptions and input contracts. "
      + "Call it with no pack to see every pack, its scope, and whether it is loaded.",
    inputSchema: z.object({
      pack: z
        .enum(CTO_TOOL_PACK_NAMES)
        .optional()
        .describe("Pack to load. Omit to list every pack without loading one."),
    }),
    execute: async ({ pack }) => {
      const loaded = new Set<CtoToolPack>(deps.loadedToolPacks?.() ?? []);
      loaded.add("core");
      if (!pack) {
        return {
          success: true,
          packs: CTO_TOOL_PACK_NAMES.map((name) => ({
            pack: name,
            scope: CTO_TOOL_PACK_SCOPES[name],
            loaded: loaded.has(name),
            alwaysLoaded: name === "core",
          })),
        };
      }
      deps.onToolPackLoaded?.(pack);
      const members = Object.entries(tools)
        .filter(([, definition]) => definition.pack === pack)
        .map(([name, definition]) => ({ name, description: definition.description }));
      return {
        success: true,
        pack,
        scope: CTO_TOOL_PACK_SCOPES[pack],
        alreadyLoaded: loaded.has(pack),
        count: members.length,
        tools: members,
      };
    },
  });

  // ── Automations (core: authoring is standing CTO work) ─────────────────────

  tools.getAutomation = core({
    description: "Read one automation rule in full, including its triggers, actions, and provenance.",
    inputSchema: z.object({ id: z.string().min(1) }),
    execute: async ({ id }) => {
      const automationRules = deps.automationRuleService;
      if (!automationRules) return unavailable("The automation rule service");
      return attempt(() => automationRules.get({ id }));
    },
  });

  tools.planAutomation = core({
    description:
      "Turn a plain-English automation request into a rule draft, without saving it. "
      + "Returns the draft plus confidence, ambiguities, and issues. Follow with simulateAutomation to see what it would do, "
      + "then saveAutomation to persist it.",
    inputSchema: z.object({
      intent: z.string().trim().min(1).describe("What the automation should do, in plain English."),
      plannerProvider: z
        .enum(["codex", "claude"])
        .optional()
        .default("codex")
        .describe("Which CLI plans the rule. Defaults to codex."),
    }),
    execute: async ({ intent, plannerProvider }) => {
      const automationPlanner = deps.automationPlannerService;
      if (!automationPlanner) return unavailable("The automation planner");
      // A read-only, never-prompting planner config. The planner only writes a
      // draft object; it must not be able to touch the worktree while doing it.
      const planner = plannerProvider === "claude"
        ? {
            provider: "claude" as const,
            claude: {
              permissionMode: "plan" as const,
              dangerouslySkipPermissions: false,
              allowedTools: [] as string[],
              additionalAllowedDirs: [] as string[],
            },
          }
        : {
            provider: "codex" as const,
            codex: {
              sandbox: "read-only" as const,
              askForApproval: "never" as const,
              webSearch: false,
              additionalWritableDirs: [] as string[],
            },
          };
      return attempt(() => automationPlanner.parseNaturalLanguage({ intent, planner }));
    },
  });

  tools.simulateAutomation = core({
    description:
      "Dry-run an automation draft: report the actions it would take, in order, with warnings — and run none of them. "
      + "Always simulate before saving a rule you generated.",
    inputSchema: z.object({
      draft: z.record(z.string(), z.unknown()).describe("An automation rule draft, e.g. the one planAutomation returned."),
    }),
    execute: async ({ draft }) => {
      const automationPlanner = deps.automationPlannerService;
      if (!automationPlanner) return unavailable("The automation planner");
      return attempt(() => automationPlanner.simulate({ draft }));
    },
  });

  tools.saveAutomation = core({
    description:
      "Validate and persist an automation rule draft. A draft with an `id` REPLACES that rule in place and asks the user "
      + "to confirm first; a draft without one creates a new rule. Draft actions may include `handoff` "
      + "(hand a chat to another model on a trigger), `ade-action`, `agent-session`, `run-tests`, `run-command`, "
      + "`create-lane`, `delete-lane`, and `predict-conflicts`.",
    inputSchema: z.object({
      draft: z.record(z.string(), z.unknown()).describe("The rule draft to save."),
      confirmations: z
        .array(z.string())
        .optional()
        .describe("Confirmation keys returned by a previous save attempt whose validation demanded them."),
    }),
    execute: async ({ draft, confirmations }) => {
      const automationPlanner = deps.automationPlannerService;
      if (!automationPlanner) return unavailable("The automation planner");
      const existingId = typeof (draft as { id?: unknown }).id === "string"
        ? (draft as { id: string }).id.trim()
        : "";
      if (existingId) {
        const declined = await confirmDestructive({
          title: "Replace automation rule?",
          description:
            `Replace the existing automation rule '${existingId}' with a new definition. `
            + "The current triggers and actions are overwritten and cannot be restored.",
          detail: { tool: "saveAutomation", ruleId: existingId },
        });
        if (declined) return declined;
      }
      return attempt(() => automationPlanner.saveDraft({
        draft,
        ...(confirmations?.length ? { confirmations } : {}),
      }));
    },
  });

  tools.setAutomationEnabled = core({
    description: "Enable or disable one automation rule. Reversible, and keeps the rule and its history.",
    inputSchema: z.object({ id: z.string().min(1), enabled: z.boolean() }),
    execute: async ({ id, enabled }) => {
      const automationRules = deps.automationRuleService;
      if (!automationRules) return unavailable("The automation rule service");
      return attempt(() => automationRules.toggleRule({ id, enabled }));
    },
  });

  tools.deleteAutomation = core({
    description:
      "Delete one automation rule permanently. Asks the user to confirm first. "
      + "Prefer setAutomationEnabled(false) when the user only wants it to stop firing.",
    inputSchema: z.object({ id: z.string().min(1) }),
    execute: async ({ id }) => {
      const automationRules = deps.automationRuleService;
      if (!automationRules) return unavailable("The automation rule service");
      const declined = await confirmDestructive({
        title: "Delete automation rule?",
        description: `Permanently delete automation rule '${id}'. This cannot be undone.`,
        detail: { tool: "deleteAutomation", ruleId: id },
      });
      if (declined) return declined;
      return attempt(() => automationRules.deleteRule({ id }));
    },
  });

  // ── Handoff (core) ─────────────────────────────────────────────────────────

  tools.handoffChatToModel = core({
    description:
      "Hand a chat to a different model. `brief` writes a summary and starts a fresh thread (any lane in the project); "
      + "`fork` carries the full transcript and must stay in the source lane. "
      + "For a handoff that should fire on its own later — a usage limit, a failed turn — save an automation rule "
      + "with a `handoff` action instead of calling this now.",
    inputSchema: z.object({
      sessionId: z.string().min(1).describe("Chat to hand off."),
      targetModelId: z.string().min(1).describe("Full modelId to hand off to. Resolve the user's model name first."),
      mode: z.enum(["brief", "fork"]).optional().default("brief"),
      targetLaneId: z.string().optional().describe("Lane for the new chat. brief only; fork stays in the source lane."),
      handoffNote: z.string().max(4000).optional().describe("Extra context appended to the handoff prompt."),
      reasoningEffort: z.string().optional(),
    }),
    execute: async ({ sessionId, targetModelId, mode, targetLaneId, handoffNote, reasoningEffort }) => {
      const handoff = deps.handoffSession;
      if (!handoff) return unavailable("Chat handoff");
      const outcome = await attempt(() => handoff({
        sourceSessionId: sessionId,
        targetModelId,
        mode,
        ...(targetLaneId?.trim() ? { targetLaneId: targetLaneId.trim() } : {}),
        ...(handoffNote?.trim() ? { handoffNote: handoffNote.trim() } : {}),
        ...(reasoningEffort?.trim() ? { reasoningEffort: reasoningEffort.trim() } : {}),
      }));
      if (!outcome.success) return outcome;
      const result = outcome.result as { session?: { id?: string; laneId?: string; modelId?: string }; usedFallbackSummary?: boolean };
      return {
        success: true,
        sessionId: result.session?.id ?? null,
        laneId: result.session?.laneId ?? null,
        modelId: result.session?.modelId ?? null,
        usedFallbackSummary: result.usedFallbackSummary ?? false,
      };
    },
  });

  // ── Scheduled work ─────────────────────────────────────────────────────────

  tools.scheduleWork = scheduling({
    description:
      "Schedule durable work on a chat: a one-shot wakeup (delaySeconds or runAt) or a recurring five-field cron in the "
      + "ADE brain machine's local timezone. Survives restarts. Pass exactly one of cron, runAt, or delaySeconds.",
    inputSchema: z.object({
      sessionId: z.string().min(1).describe("Chat to wake."),
      prompt: z.string().trim().min(1).max(4000).describe("What the chat should do when it wakes."),
      cron: z.string().optional().describe("Five-field cron, brain-machine local time."),
      runAt: z.string().optional().describe("ISO 8601 timestamp with offset or Z."),
      delaySeconds: z.number().int().positive().optional(),
      recurring: z.boolean().optional(),
      reason: z.string().max(500).optional(),
    }),
    execute: async ({ sessionId, prompt, cron, runAt, delaySeconds, recurring, reason }) => {
      const scheduledWork = deps.scheduledWorkService;
      if (!scheduledWork) return unavailable("Scheduled work");
      return attempt(() => scheduledWork.create({
        sessionId,
        prompt,
        ...(cron?.trim() ? { cron: cron.trim() } : {}),
        ...(runAt?.trim() ? { runAt: runAt.trim() } : {}),
        ...(delaySeconds != null ? { delaySeconds } : {}),
        ...(recurring != null ? { recurring } : {}),
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
      }));
    },
  });

  tools.listScheduledWork = scheduling({
    description: "List ADE-managed wakeups, cron jobs, and loops — for one chat, or across the project.",
    inputSchema: z.object({
      sessionId: z.string().optional(),
      includeTerminal: z.boolean().optional().default(false),
    }),
    execute: async ({ sessionId, includeTerminal }) => {
      const scheduledWork = deps.scheduledWorkService;
      if (!scheduledWork) return unavailable("Scheduled work");
      return attempt(() => scheduledWork.list({
        ...(sessionId?.trim() ? { sessionId: sessionId.trim() } : {}),
        includeTerminal,
      }));
    },
  });

  tools.getScheduledWorkState = scheduling({
    description: "Read pause state, next wake time, and active jobs for one chat's scheduled work.",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
    execute: async ({ sessionId }) => {
      const scheduledWork = deps.scheduledWorkService;
      if (!scheduledWork) return unavailable("Scheduled work");
      return attempt(() => scheduledWork.getState({ sessionId }));
    },
  });

  tools.cancelScheduledWork = scheduling({
    description:
      "Cancel one scheduled job permanently. Asks the user to confirm first. "
      + "Use setScheduledWorkPaused when the user only wants it held.",
    inputSchema: z.object({ sessionId: z.string().min(1), scheduleId: z.string().min(1) }),
    execute: async ({ sessionId, scheduleId }) => {
      const scheduledWork = deps.scheduledWorkService;
      if (!scheduledWork) return unavailable("Scheduled work");
      const declined = await confirmDestructive({
        title: "Cancel scheduled work?",
        description:
          `Permanently cancel scheduled job '${scheduleId}' on chat '${sessionId}'. `
          + "It cannot be restored; it would have to be scheduled again.",
        detail: { tool: "cancelScheduledWork", sessionId, scheduleId },
      });
      if (declined) return declined;
      return attempt(() => scheduledWork.cancel({ sessionId, scheduleId }));
    },
  });

  tools.setScheduledWorkPaused = scheduling({
    description: "Pause or resume every scheduled job on one chat. Reversible; nothing is lost.",
    inputSchema: z.object({ sessionId: z.string().min(1), paused: z.boolean() }),
    execute: async ({ sessionId, paused }) => {
      const scheduledWork = deps.scheduledWorkService;
      if (!scheduledWork) return unavailable("Scheduled work");
      return attempt(() => scheduledWork.setPaused({ sessionId, paused }));
    },
  });

  // ── Proof capture ──────────────────────────────────────────────────────────

  tools.captureProof = proof({
    description:
      "File an existing on-disk file (screenshot, recording, trace, log) as a project proof artifact and attach it to a "
      + "lane, chat, automation run, PR, or Linear issue. Additive: it never removes or overwrites an artifact. "
      + "Use listComputerUseArtifacts to read them back and reviewArtifact to judge them.",
    inputSchema: z.object({
      sourcePath: z.string().min(1).describe("Absolute path to the file to file as proof."),
      kind: z.enum(["screenshot", "video_recording", "browser_trace", "browser_verification", "console_logs"]),
      title: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      ownerKind: z.enum(["lane", "chat_session", "automation_run", "github_pr", "linear_issue"]),
      ownerId: z.string().min(1),
    }),
    execute: async ({ sourcePath, kind, title, description, ownerKind, ownerId }) => {
      const proofIngest = deps.proofIngestService;
      if (!proofIngest) return unavailable("The proof artifact broker");
      return attempt(() => proofIngest.ingest({
        backend: { name: "cto", style: "manual", toolName: "captureProof" },
        inputs: [{
          kind,
          title,
          path: sourcePath,
          ...(description?.trim() ? { description: description.trim() } : {}),
        }],
        owners: [{ kind: ownerKind, id: ownerId, relation: "attached_to" }],
      }));
    },
  });

  // ── Review ─────────────────────────────────────────────────────────────────

  tools.listReviewLaunchContext = review({
    description: "Read what a review run can target right now: lanes, their recent commits, and open PRs.",
    inputSchema: z.object({}),
    execute: async () => {
      const review = deps.reviewService;
      if (!review) return unavailable("The review service");
      return attempt(() => review.listLaunchContext());
    },
  });

  tools.startReviewRun = review({
    description:
      "Start an ADE code review over a lane's diff, its working tree, a commit range, or a PR. "
      + "laneId is required — reviews read a specific worktree and there is no safe default.",
    inputSchema: z.object({
      laneId: z.string().min(1).describe("Lane to review. Required — there is no default."),
      mode: z.enum(["lane_diff", "working_tree", "commit_range", "pr"]).optional().default("lane_diff"),
      baseCommit: z.string().optional().describe("Required for commit_range."),
      headCommit: z.string().optional().describe("Required for commit_range."),
      prId: z.string().optional().describe("Required for pr."),
    }),
    execute: async ({ laneId, mode, baseCommit, headCommit, prId }) => {
      const review = deps.reviewService;
      if (!review) return unavailable("The review service");
      return attempt(() => {
        const resolvedLaneId = requireMutationLaneId(laneId, "startReviewRun");
        if (mode === "commit_range") {
          if (!baseCommit?.trim() || !headCommit?.trim()) {
            throw new Error("commit_range needs both baseCommit and headCommit.");
          }
          return review.startRun({
            target: { mode, laneId: resolvedLaneId, baseCommit: baseCommit.trim(), headCommit: headCommit.trim() },
          });
        }
        if (mode === "pr") {
          if (!prId?.trim()) throw new Error("pr mode needs a prId.");
          return review.startRun({ target: { mode, laneId: resolvedLaneId, prId: prId.trim() } });
        }
        return review.startRun({ target: { mode, laneId: resolvedLaneId } });
      });
    },
  });

  tools.rerunReview = review({
    description: "Re-run a finished review with the same target and config.",
    inputSchema: z.object({ runId: z.string().min(1) }),
    execute: async ({ runId }) => {
      const review = deps.reviewService;
      if (!review) return unavailable("The review service");
      return attempt(() => review.rerun({ runId }));
    },
  });

  tools.cancelReviewRun = review({
    description: "Cancel an in-flight review run. Reversible with rerunReview.",
    inputSchema: z.object({ runId: z.string().min(1) }),
    execute: async ({ runId }) => {
      const review = deps.reviewService;
      if (!review) return unavailable("The review service");
      return attempt(() => review.cancelRun({ runId }));
    },
  });

  tools.listReviewRuns = review({
    description: "List review runs, newest first, optionally filtered by lane or status.",
    inputSchema: z.object({
      laneId: z.string().optional(),
      status: z.enum(["queued", "running", "completed", "failed", "cancelled", "all"]).optional(),
      limit: z.number().int().min(1).max(200).optional().default(25),
    }),
    execute: async ({ laneId, status, limit }) => {
      const review = deps.reviewService;
      if (!review) return unavailable("The review service");
      return attempt(() => review.listRuns({
        ...(laneId?.trim() ? { laneId: laneId.trim() } : {}),
        ...(status ? { status } : {}),
        limit,
      }));
    },
  });

  tools.getReviewRunDetail = review({
    description: "Read one review run in full: findings, severities, anchors, and evidence.",
    inputSchema: z.object({ runId: z.string().min(1) }),
    execute: async ({ runId }) => {
      const review = deps.reviewService;
      if (!review) return unavailable("The review service");
      return attempt(() => review.getRunDetail({ runId }));
    },
  });

  tools.getReviewQualityReport = review({
    description: "Read aggregate review quality: run counts, finding counts, and accepted/rejected feedback rates.",
    inputSchema: z.object({}),
    execute: async () => {
      const review = deps.reviewService;
      if (!review) return unavailable("The review service");
      return attempt(() => review.qualityReport());
    },
  });

  // ── Universal search ───────────────────────────────────────────────────────

  tools.searchProject = search({
    description:
      "Search ADE's own project index across lanes, chats, PRs, files, and issues — the same index behind ⌘K. "
      + "Use searchCodebase instead when you want raw ADE source text.",
    inputSchema: z.object({
      query: z.string().trim().min(1),
      laneId: z.string().optional().describe("Restrict to one lane. Read-only, so any lane is fine."),
      limit: z.number().int().min(1).max(100).optional().default(25),
    }),
    execute: async ({ query, laneId, limit }) => {
      const universalSearch = deps.searchService;
      if (!universalSearch) return unavailable("Universal search");
      return attempt(() => universalSearch.query({
        query,
        ...(laneId?.trim() ? { laneId: resolveReadLaneId(laneId) } : {}),
        limit,
      }));
    },
  });

  tools.getSearchIndexStatus = search({
    description: "Read the universal search index status: what is indexed and how fresh it is.",
    inputSchema: z.object({}),
    execute: async () => {
      const universalSearch = deps.searchService;
      const indexStatus = universalSearch?.indexStatus;
      if (!indexStatus) return unavailable("Search index status");
      return attempt(() => indexStatus.call(universalSearch));
    },
  });

  // ── Usage, spend, budget ───────────────────────────────────────────────────

  tools.getUsageStats = insights({
    description:
      "Read token, cost, and activity stats. scope picks the reach: account merges every machine on the ADE account, "
      + "machine is this computer only, project is the open project's share.",
    inputSchema: z.object({
      preset: z.enum(["today", "7d", "30d", "year", "all"]).optional().default("7d"),
      scope: z.enum(["account", "machine", "project"]).optional().default("project"),
      force: z.boolean().optional().default(false),
    }),
    execute: async ({ preset, scope, force }) => {
      const usage = deps.usageService;
      if (!usage) return unavailable("Usage tracking");
      return attempt(() => usage.getAdeUsageStats({ preset, scope, force }));
    },
  });

  tools.getUsageSnapshot = insights({
    description: "Read provider rate-limit windows and spend controls for the signed-in account.",
    inputSchema: z.object({}),
    execute: async () => {
      const usage = deps.usageService;
      if (!usage) return unavailable("Usage tracking");
      return attempt(() => usage.getUsageSnapshot());
    },
  });

  tools.getBudgetStatus = insights({
    description: "Read the project's spend caps, cumulative usage against them, and whether the budget currently blocks work.",
    inputSchema: z.object({}),
    execute: async () => {
      const budget = deps.budgetService;
      if (!budget) return unavailable("Budget caps");
      return attempt(() => ({
        config: budget.getConfig(),
        cumulativeUsageThisWeek: budget.getGlobalCumulativeUsage(),
      }));
    },
  });

  // ── Project config and secret NAMES ────────────────────────────────────────

  tools.getProjectConfig = config({
    description:
      "Read the project's effective ADE configuration: shared config, local overrides, and the merged result. "
      + "Read-only, and VALUES of env blocks and credential-shaped fields are replaced with placeholders — "
      + "you see which keys exist, never what they are set to. Use the Settings surface to change any of it.",
    inputSchema: z.object({}),
    execute: async () => {
      const projectConfig = deps.projectConfigService;
      if (!projectConfig) return unavailable("Project config");
      const outcome = await attempt(() => projectConfig.get());
      if (!outcome.success) return outcome;
      return { success: true, result: redactConfigValues(outcome.result) };
    },
  });

  tools.listProjectSecretNames = config({
    description:
      "List the NAMES and metadata of this project's ADE secrets. Values are never returned by any tool you have — "
      + "if the user needs a secret value, they must read it from the Secrets surface themselves.",
    inputSchema: z.object({}),
    execute: async () => {
      const projectSecrets = deps.projectSecretService;
      if (!projectSecrets) return unavailable("Project secrets");
      const outcome = await attempt(() => projectSecrets.list());
      if (!outcome.success) return outcome;
      // Defence in depth: the broker's own shape is names-and-metadata, and this
      // strips anything value-shaped regardless, so no future service change can
      // leak a value through this tool.
      const rows = Array.isArray(outcome.result)
        ? outcome.result
        : Array.isArray((outcome.result as { secrets?: unknown })?.secrets)
          ? (outcome.result as { secrets: unknown[] }).secrets
          : [];
      return {
        success: true,
        count: rows.length,
        secrets: rows.map((row) => {
          const record = (row ?? {}) as Record<string, unknown>;
          return {
            name: typeof record.name === "string" ? record.name : String(record.name ?? ""),
            updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
            scope: typeof record.scope === "string" ? record.scope : null,
          };
        }),
      };
    },
  });

  // ── Devices: iOS simulator, app control, built-in browser (reads) ──────────

  tools.getIosSimulatorStatus = devices({
    description: "Read the iOS simulator session status: which device is claimed, by which chat, and what is running.",
    inputSchema: z.object({}),
    execute: async () => {
      const iosSimulator = deps.iosSimulatorService;
      if (!iosSimulator) return unavailable("The iOS simulator service");
      return attempt(() => iosSimulator.getStatus());
    },
  });

  tools.listIosSimulatorDevices = devices({
    description: "List the iOS simulators available on this machine.",
    inputSchema: z.object({}),
    execute: async () => {
      const iosSimulator = deps.iosSimulatorService;
      if (!iosSimulator) return unavailable("The iOS simulator service");
      return attempt(() => iosSimulator.listDevices());
    },
  });

  tools.listIosLaunchTargets = devices({
    description: "List the app targets ADE can launch on an iOS simulator for a lane.",
    inputSchema: z.object({ laneId: z.string().optional().describe("Lane to scan. Read-only, so any lane is fine.") }),
    execute: async ({ laneId }) => {
      const iosSimulator = deps.iosSimulatorService;
      if (!iosSimulator) return unavailable("The iOS simulator service");
      return attempt(() => iosSimulator.listLaunchTargets({ laneId: resolveReadLaneId(laneId) }));
    },
  });

  tools.getIosScreenSnapshot = devices({
    description: "Read the current iOS simulator screen as a structured snapshot (elements and text, not pixels).",
    inputSchema: z.object({}),
    execute: async () => {
      const iosSimulator = deps.iosSimulatorService;
      const getScreenSnapshot = iosSimulator?.getScreenSnapshot;
      if (!getScreenSnapshot) return unavailable("iOS simulator screen snapshots");
      return attempt(() => getScreenSnapshot.call(iosSimulator, {}));
    },
  });

  tools.getAppControlStatus = devices({
    description: "Read the desktop app-control session status: what is attached and which chat owns it.",
    inputSchema: z.object({}),
    execute: async () => {
      const appControl = deps.appControlService;
      if (!appControl) return unavailable("The app control service");
      return attempt(() => appControl.getStatus());
    },
  });

  tools.listAppControlTargets = devices({
    description: "List the desktop apps and renderer targets ADE can attach to right now.",
    inputSchema: z.object({}),
    execute: async () => {
      const appControl = deps.appControlService;
      if (!appControl) return unavailable("The app control service");
      return attempt(() => appControl.listTargets());
    },
  });

  tools.getAppControlSnapshot = devices({
    description: "Read a structured snapshot of the attached desktop app's UI (elements and text, not pixels).",
    inputSchema: z.object({}),
    execute: async () => {
      const appControl = deps.appControlService;
      const getSnapshot = appControl?.getSnapshot;
      if (!getSnapshot) return unavailable("App control snapshots");
      return attempt(() => getSnapshot.call(appControl, {}));
    },
  });

  tools.getBrowserStatus = devices({
    description: "Read the built-in browser's status: whether it is running, claimed, and by which chat.",
    inputSchema: z.object({}),
    execute: async () => {
      const browser = deps.builtInBrowserService;
      if (!browser) return unavailable("The built-in browser");
      return attempt(() => browser.getStatus());
    },
  });

  tools.listBrowserSessions = devices({
    description: "List the built-in browser's open sessions and their tabs.",
    inputSchema: z.object({}),
    execute: async () => {
      const browser = deps.builtInBrowserService;
      if (!browser) return unavailable("The built-in browser");
      return attempt(() => browser.listSessions());
    },
  });

  tools.getBrowserTrace = devices({
    description: "Read one built-in browser session's recorded trace: navigations, console output, and network summary.",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
    execute: async ({ sessionId }) => {
      const browser = deps.builtInBrowserService;
      const getTrace = browser?.getTrace;
      if (!getTrace) return unavailable("Browser traces");
      return attempt(() => getTrace.call(browser, { sessionId }));
    },
  });

  // ── Orchestration reads ────────────────────────────────────────────────────

  tools.listOrchestrationRuns = orchestration({
    description:
      "List orchestration runs and their status. Read-only — leads and workers drive the runs themselves. "
      + "Omit laneId to list runs across every lane.",
    inputSchema: z.object({
      laneId: z.string().optional().describe("Restrict to one lane. Read-only, so any lane is fine."),
      limit: z.number().int().min(1).max(100).optional().default(25),
    }),
    execute: async ({ laneId, limit }) => {
      const orchestration = deps.orchestrationService;
      if (!orchestration) return unavailable("Orchestration");
      return attempt(() => orchestration.runList(laneId?.trim() || undefined, { limit }));
    },
  });

  tools.readOrchestrationBundle = orchestration({
    description:
      "Read one orchestration run's bundle: its manifest, plan, and registered assets. "
      + "Both ids come from listOrchestrationRuns.",
    inputSchema: z.object({
      runId: z.string().min(1),
      laneId: z.string().min(1).describe("Lane the run belongs to — its bundle lives in that lane's worktree."),
    }),
    execute: async ({ runId, laneId }) => {
      const orchestration = deps.orchestrationService;
      if (!orchestration) return unavailable("Orchestration");
      return attempt(() => orchestration.bundleRead(
        runId,
        orchestration.bundleRootFor(laneId, runId),
      ));
    },
  });

  return tools;
}
