import { SESSION_ACTIVITY_VALUES } from "../../../shared/types/sessions";
import {
  ADE_TURN_USAGE_DEFAULT_DAYS,
  ADE_TURN_USAGE_GROUP_BY,
  ADE_TURN_USAGE_MAX_DAYS,
  ADE_TURN_USAGE_MAX_RECENT,
  DEFAULT_ADE_TURN_USAGE_GROUP_BY,
} from "../../../shared/types/turnUsage";
import type { AdeActionDomain } from "./domains";
import { ADE_ACCOUNT_DELETE_MACHINE_CONFIRMATION } from "../../../shared/types/account";

const sessionActivityValueInput = SESSION_ACTIVITY_VALUES.map((value) => `"${value}"`).join(" | ");

/**
 * The documented input shape for every action the CTO's curated tools reach.
 *
 * Pure data: `ade actions list --text`, the RPC server's action catalogue and
 * the CTO domain-coverage test all read it, and none of them needs a runtime.
 * A new CTO-facing action without an entry here fails `ctoDomainCoverage.test`.
 */
export type AdeActionInputContract = {
  description?: string;
  input?: string;
  example?: string;
};

type AdeActionInputContractTable =
  Partial<Record<AdeActionDomain, Partial<Record<string, AdeActionInputContract>>>>;

const ADE_ACTION_INPUT_CONTRACTS: AdeActionInputContractTable = {
  cto_state: {
    getThreadHealth: {
      description:
        "Report whether the CTO thread can take a turn: the session id, the last turn failure, context occupancy, "
        + "and whether a rotation is advised. Open to every role; never changes state.",
      input: "none",
      example: "ade actions run cto_state.getThreadHealth --json",
    },
    startFreshSession: {
      description:
        "Retire the CTO's live conversation into History and start a fresh one on the primary lane. "
        + "Identity, memory and the daily log carry over; a hand-off note is written first. CTO-only.",
      input: "none",
      example: "ade --role cto actions run cto_state.startFreshSession --json",
    },
  },
  cto_memory: {
    recordDiscovery: {
      description:
        "Hand one durable finding up to the project's CTO — a convention, a trap, a decision the next agent should not have to rediscover. "
        + "Append-only and unreviewed: the CTO reads new discoveries as they arrive and decides what becomes durable memory. "
        + "Tag it so it can be found later.",
      input: "object { fact: string, tags?: { lane?: string, pr?: string | number, path?: string, topic?: string } }",
      example: "ade actions run cto_memory.recordDiscovery --input-json '{\"fact\":\"Vitest localStorage suites need Node 22\",\"tags\":{\"topic\":\"testing\",\"path\":\"apps/desktop\"}}'",
    },
  },
  account: {
    startLogin: {
      description: "Start the machine-owned ADE account OAuth PKCE login flow.",
      input: "no input",
      example: "ade login",
    },
    pollLogin: {
      description: "Poll an in-memory ADE account login session.",
      input: "object { sessionId: string }",
      example: "ade actions run account.pollLogin --input-json '{\"sessionId\":\"...\"}'",
    },
    startDeviceLogin: {
      description: "Start the machine-owned ADE account device authorization flow for headless sign-in.",
      input: "no input",
      example: "ade login --headless",
    },
    pollDeviceLogin: {
      description: "Poll an in-memory ADE account device authorization session.",
      input: "object { sessionId: string }",
      example: "ade actions run account.pollDeviceLogin --input-json '{\"sessionId\":\"...\"}'",
    },
    status: {
      description: "Read the machine-owned ADE account sign-in status without exposing tokens.",
      input: "no input",
      example: "ade auth status --text",
    },
    cancelLogin: {
      description: "Cancel a pending in-memory ADE account login session so a late browser callback cannot sign in.",
      input: "object { sessionId: string }",
      example: "ade actions run account.cancelLogin --input-json '{\"sessionId\":\"...\"}'",
    },
    signOut: {
      description: "Clear the machine-owned ADE account session.",
      input: "no input",
      example: "ade logout",
    },
    getToken: {
      description: "Internal bearer-token accessor for ADE remote services; refreshes near expiry.",
      input: "no input",
    },
    createToken: {
      description: "Return a self-contained durable account token once for ADE_ACCOUNT_TOKEN provisioning.",
      input: "no input",
      example: "ade account token create",
    },
    deleteMachine: {
      description:
        "Remove a machine from the ADE account. Destructive: the directory revokes it and clears its Activity, and it can only rejoin when someone confirms it on that computer. "
        + `People only: agents are refused, so ask the user to do it. Refused without confirmation: "${ADE_ACCOUNT_DELETE_MACHINE_CONFIRMATION}".`,
      input: `object { machine: string (machine key), confirmation: "${ADE_ACCOUNT_DELETE_MACHINE_CONFIRMATION}" }`,
      example: `ade machines remove <machine-key> --confirm ${ADE_ACCOUNT_DELETE_MACHINE_CONFIRMATION} --text`,
    },
  },
  proxy: {
    status: {
      description: "Read the local subscription proxy and its signed-in provider subscriptions without exposing credentials.",
      input: "no input",
      example: "ade proxy status --text",
    },
    ensureRunning: {
      description: "Install and start the local subscription proxy when a harness needs a borrowed subscription.",
      input: "no input",
      example: "ade proxy start --text",
    },
    stop: {
      description: "Stop the local subscription proxy without removing its installed binary or signed-in subscriptions.",
      input: "no input",
      example: "ade proxy stop --text",
    },
    signIn: {
      description: "Sign in one Claude or Codex subscription for use by harness presets; ADE opens the provider's sign-in page and waits for completion.",
      input: "object { provider: \"claude\" | \"codex\" }",
      example: "ade actions run proxy.signIn --input-json '{\"provider\":\"claude\"}'",
    },
    signOut: {
      description: "Remove one subscription sign-in from this machine.",
      input: "object { loginId: string }",
      example: "ade actions run proxy.signOut --input-json '{\"loginId\":\"...\"}'",
    },
    setDisabled: {
      description: "Temporarily enable or disable one subscription sign-in without removing it.",
      input: "object { loginId: string, disabled: boolean }",
      example: "ade actions run proxy.setDisabled --input-json '{\"loginId\":\"...\",\"disabled\":true}'",
    },
  },
  attention: {
    sendNotification: {
      description:
        "Send a push you write to every phone on the ADE account: title up to 64 characters, optional body up to 160, "
        + "optional ade:// link a tap opens. Respects notifications off, quiet hours and a muted machine. "
        + "At most 60 per account per hour. Open to agents and automations.",
      input: "object { title: string, body?: string, open?: string }",
      example: "ade notify --title \"Deploy finished\" --body \"ADE 1.4.2 is live\" --open \"ade://pr/1514\"",
    },
    getSnapshot: {
      description: "Read the account-wide Activity stream across every connected machine and project.",
      input: "object { since?: non-negative integer, streamId?: string | null }",
      example: "ade --role cto actions run attention.getSnapshot --input-json '{\"since\":0}' --json",
    },
    acknowledge: {
      description: "Mark up to 64 Activity items as seen or dismissed across account surfaces.",
      input: "object { itemIds: string[], seenAt?: ISO timestamp, dismissedAt?: ISO timestamp | null }",
      example: "ade --role cto actions run attention.acknowledge --input-json '{\"itemIds\":[\"attention-item-1\"],\"seenAt\":\"2026-07-28T12:00:00.000Z\"}' --json",
    },
    reportPresence: {
      description: "Report one device's foreground and ambient-surface presence for desktop-first notification delivery.",
      input: "AttentionPresence object { deviceId, deviceName, platform, appForeground, ambientSurfaceVisible, visibleItemIds, observedAt }",
      example: "ade --role cto actions run attention.reportPresence --input-json '{\"deviceId\":\"mac-1\",\"deviceName\":\"MacBook Pro\",\"platform\":\"macOS\",\"appForeground\":true,\"ambientSurfaceVisible\":true,\"visibleItemIds\":[],\"observedAt\":\"2026-07-28T12:00:00.000Z\"}' --json",
    },
    getPreferences: {
      description: "Read account, device, project, and muted-session Activity preferences for the signed-in owner.",
      input: "object { accountOwnerId: string }",
      example: "ade --role cto actions run attention.getPreferences --input-json '{\"accountOwnerId\":\"user_123\"}' --json",
    },
    putPreferences: {
      description: "Replace Activity preferences for the signed-in account owner.",
      input: "object { accountOwnerId: string, preferences: AttentionPreferences }",
      example: "ade --role cto actions run attention.putPreferences --input-json '{\"accountOwnerId\":\"user_123\",\"preferences\":{\"account\":{},\"devices\":{},\"projects\":{},\"mutedSessionIds\":[]}}' --json",
    },
    putMachinePreferences: {
      description: "Patch Activity preferences for one machine (e.g. mute its notifications) without replacing the whole document.",
      input: "object { accountOwnerId: string, machineKey: string, preferences: Partial<AttentionPreferenceScope> }",
      example: "ade --role cto actions run attention.putMachinePreferences --input-json '{\"accountOwnerId\":\"user_123\",\"machineKey\":\"machine:abc\",\"preferences\":{\"notificationsEnabled\":false}}' --json",
    },
  },
  project_secret: {
    request: {
      description: "Ask the person in this chat for a project secret through the private secret card, and save their answer to this project's encrypted secrets. Blocks until they save, keep the existing value, or decline. Returns {name, saved: true, replaced} | {name, saved: false, kept: true} | {name, saved: false, declined: true}; the value is never returned, logged, or written to the transcript. Use this instead of asking a person to paste a secret into chat.",
      input: "object { name: string, reason: string, generate?: boolean, timeoutMs?: number }",
      example: "ade secrets request GITHUB_WEBHOOK_SECRET --reason \"Signs GitHub deliveries to your triage webhook\" --generate",
    },
    list: {
      description: "List ADE project secret names and metadata without revealing values.",
      input: "no input",
      example: "ade secrets list --text",
    },
    get: {
      description: "Read one ADE project secret value when the user explicitly asked for that secret.",
      input: "object { name: string }",
      example: "ade secrets get STRIPE_API_KEY --text",
    },
    set: {
      description: "Create or replace one ADE project secret.",
      input: "object { name: string, value: string }",
      example: "ade secrets set STRIPE_API_KEY --value sk_test_...",
    },
    pullFromAccount: {
      description: "Take every account-stored secret this repository has in the account vault onto this machine, and drop the account-scoped copies the account reports deleted. Returns {state: \"pulled\", added, updated, removed}, or {state: \"unavailable\"} when the vault could not be read at all; values are never returned. A secret kept for this device only is never replaced or removed.",
      input: "no input",
      example: "ade secrets pull --text",
    },
    delete: {
      description: "Delete one ADE project secret.",
      input: "object { name: string, confirmName: string }",
      example: "ade secrets delete STRIPE_API_KEY",
    },
    previewEnvImport: {
      description: "Parse bounded .env file content and mark variables that will replace existing ADE secrets.",
      input: "object { fileName: string, content: string }",
    },
    importEnv: {
      description: "Atomically create or replace selected ADE secrets parsed from a .env file.",
      input: "object { secrets: Array<{ name: string, value: string }> }",
    },
    exportEnv: {
      description: "Export every ADE project secret to a new ade-secrets.env file in this machine's Downloads folder.",
      input: "no input",
    },
  },
  analytics: {
    capture: {
      description: "Capture one privacy-bounded ADE product event. Event names and properties are strictly allowlisted and quota limited.",
      input: "object { event, surface, properties?, projectId?, sessionId?, clientEventId?, occurredAt?, dedupeKey?, minimumIntervalMs? }",
      example: "ade actions run analytics.capture --input-json '{\"event\":\"ade_screen_viewed\",\"surface\":\"tui\",\"properties\":{\"screen\":\"details_help\"}}'",
    },
    getStatus: {
      description: "Read anonymous product analytics configuration and local daily budget counters.",
      input: "no input",
      example: "ade actions run analytics.getStatus --text",
    },
  },
  usage: {
    getAdeUsageStats: {
      description:
        "Read token, cost, and activity stats. `scope` picks the reach: \"account\" merges every machine on the ADE account, \"machine\" is this computer only, \"project\" is the open project's share of it.",
      input:
        "object { preset?: \"today\" | \"7d\" | \"30d\" | \"year\" | \"all\", since?: ISO string, until?: ISO string, scope?: \"account\" | \"machine\" | \"project\", force?: boolean }",
      example: "ade usage stats --preset 30d --scope account --text",
    },
    getCostBreakdown: {
      description:
        "Rank ADE chat spend by chat, lane, or account from the per-turn ledger: API-equivalent value, dollars billed to API keys, and plan value covered by subscriptions. Chats and lanes are the open project's; accounts are the machine's. The ledger keeps three months.",
      input:
        "object { by: \"chat\" | \"lane\" | \"account\", preset?: \"today\" | \"7d\" | \"30d\" | \"year\" | \"all\", since?: ISO string, until?: ISO string, laneId?: string (with by: chat, one lane's chats), limit?: number (max 200) }",
      example: "ade usage stats --by lane --preset 30d --text",
    },
    getModelDetail: {
      description:
        "One model's cost, tokens, cost per million tokens, cache hit rate, daily trend, cost split by token type and speed, and the price ADE bills it at (custom, list, or fallback).",
      input:
        "object { provider: string, model: string (as the stats name it), preset?: \"today\" | \"7d\" | \"30d\" | \"year\" | \"all\", since?: ISO string, until?: ISO string, scope?: \"account\" | \"machine\" | \"project\" }",
      example: "ade usage stats --model claude-opus-5-5 --text",
    },
    getModelPriceOverrides: {
      description: "The token prices and \"Map to\" model mappings set on this machine.",
      input: "object {}",
      example: "ade usage prices --text",
    },
    setModelPriceOverride: {
      description:
        "Set or clear this machine's price for a model (USD per million tokens), or map a model id onto another model so its usage counts and prices as that model. Re-prices history in the background.",
      input:
        "object { model: string, price?: { input: number, output: number, cacheRead?: number, cacheWrite?: number } | null (null = automatic), mapTo?: string | null (null = no mapping) }",
      example: "ade usage prices set my-preview-model --map-to claude-opus-5-5",
    },
    getTurnUsageSummary: {
      description:
        "Read this machine's per-turn usage ledger: tokens, cache hit ratio, provider cost, and API-list-price cost by provider, account, and model, plus what one percent of each subscription window has cost in ADE turns.",
      input:
        `object { days?: number (1-${ADE_TURN_USAGE_MAX_DAYS}, default ${ADE_TURN_USAGE_DEFAULT_DAYS}), groupBy?: ${ADE_TURN_USAGE_GROUP_BY.map((value) => JSON.stringify(value)).join(" | ")} (default ${JSON.stringify(DEFAULT_ADE_TURN_USAGE_GROUP_BY)}), recent?: number (newest rows of the calling project to include, max ${ADE_TURN_USAGE_MAX_RECENT}) }`,
      example: "ade usage turns --days 14 --text",
    },
    getModelRoutes: {
      description:
        "List every route (harness × model × effort) this machine can run, rated from the model registry: expected coding-agent score, cost and time per task, speed, and who bills it. Registry data is based on Artificial Analysis (artificialanalysis.ai).",
      input: "object { provider?: \"claude\" | \"codex\" | \"opencode\" | \"cursor\", limit?: number }",
      example: "ade router routes --provider claude --text",
    },
    previewModelRoute: {
      description:
        "Show which route the model router would pick for one task, given the model that would run it, without running anything. Uses live plan windows and burn rates.",
      input:
        "object { description: string, provider: string, model: string, reasoningEffort?: string, agentType?: string, kind?: \"read_only\" | \"review\" | \"test_run\" | \"light_edit\" | \"heavy_edit\" | \"lead\" | \"unknown\" }",
      example: "ade router pick \"summarize how sync works\" --provider claude --model opus --text",
    },
    getRouterShadowSummary: {
      description:
        "Summarize the shadow router: for each subagent that started, the route it would have picked instead, the estimated saving, and why it kept the original.",
      input: "object { days?: number (1-90, default 7) }",
      example: "ade router shadow --days 7 --text",
    },
    getRouterEfficiency: {
      description:
        "Report what the router would have saved: it replays every chat thread from the turn ledger at its free switch points and prices the router's pick against what really ran, then summarizes the shadow-logged subagents. Dollars are list prices and the saving is an estimate.",
      input: "object { days?: number (1-90, default 7) }",
      example: "ade router efficiency --days 7 --text",
    },
    refreshModelRegistry: {
      description: "Fetch the newest model registry from the ADE account directory (signed-in accounts only).",
      input: "object { force?: boolean }",
      example: "ade router refresh --text",
    },
    getUsageSnapshot: {
      description:
        "Read provider rate-limit windows and spend controls. Account-tied, so it takes no scope.",
      input: "no input",
      example: "ade actions run usage.getUsageSnapshot --text",
    },
  },
  lane: {
    getReclaimRisk: {
      description: "Preview what ADE can safely remove for one lane, including estimated bytes and any blocked reasons.",
      input: "object { laneId: string }",
      example: "ade lanes reclaim-preview lane-123 --text",
    },
    archiveAndReclaim: {
      description: "Archive a lane and remove only its ADE-managed local worktree and generated data. The lane, branch, chat, and metadata remain.",
      input: "object { laneId: string, confirmation: \"RECLAIM\", forceDirty?: boolean }",
      example: "ade lanes archive-and-reclaim lane-123 --confirm RECLAIM --text",
    },
    unarchive: {
      description: "Restore an archived lane and safely recreate its managed worktree when it was reclaimed.",
      input: "object { laneId: string }",
      example: "ade lanes unarchive lane-123 --text",
    },
  },
  chat: {
    startLaunch: {
      description: "Launch a chat (or prepare a CLI lane) in a brand-new lane: reserves the chat and lane ids, returns at once, then fetches the base, checks out the worktree, applies the default lane template, creates the chat and sends the opening message. Progress streams as chat_launch_event.",
      input: "object { launchId: uuid, prompt: string, kind?: \"chat\" | \"cli\" (default chat), mode?: \"foreground\" | \"background\" (default foreground), laneId?: uuid, laneName?, baseBranch? (default: the project's new-lane base), laneConfig?: { mode: \"root\" | \"child\" | \"import\" (default root), parentLaneId? (child), branchRef? (import), templateId?, color?, linearIssue? }, title?, displayPrompt?, attachments?, provider?, modelId?, chat?: { create: <chat.createSession args without laneId>, message: <chat.sendMessage args without sessionId> } (required for kind chat) }",
      example: "ade actions run chat.startLaunch --input-json '{\"kind\":\"chat\",\"mode\":\"background\",\"launchId\":\"6f1c…\",\"prompt\":\"fix the flaky test\",\"chat\":{\"create\":{\"provider\":\"codex\",\"model\":\"openai/gpt-5.6-sol\"},\"message\":{\"text\":\"fix the flaky test\"}}}'",
    },
    listLaunches: {
      description: "List new-lane launches this brain is running or recently finished.",
      input: "none",
      example: "ade actions run chat.listLaunches --json",
    },
    cancelLaunch: {
      description: "Cancel a new-lane launch and fully delete what it created: the chat, the lane's worktree, and its local and remote branch. A lane imported from an existing branch keeps that branch.",
      input: "object { launchId: uuid }",
      example: "ade actions run chat.cancelLaunch --input-json '{\"launchId\":\"6f1c…\"}'",
    },
    getLaunch: {
      description: "Read one new-lane launch's current snapshot (stages, phase, lane, chat).",
      input: "object { launchId: uuid }",
      example: "ade actions run chat.getLaunch --input-json '{\"launchId\":\"6f1c…\"}' --json",
    },
    retryLaunch: {
      description: "Retry a failed new-lane launch from its first unfinished stage.",
      input: "object { launchId: uuid }",
      example: "ade actions run chat.retryLaunch --input-json '{\"launchId\":\"6f1c…\"}'",
    },
    startLaunchNow: {
      description: "Start a new-lane launch's agent without waiting for the rest of its lane environment setup (also 'Start anyway' after an environment failure).",
      input: "object { launchId: uuid }",
      example: "ade actions run chat.startLaunchNow --input-json '{\"launchId\":\"6f1c…\"}'",
    },
    queueLaunchMessage: {
      description: "Queue a message for a new-lane launch whose chat is still being set up; it is sent in order once the agent starts.",
      input: "object { launchId: uuid, text: string, displayText?, attachments? }",
      example: "ade actions run chat.queueLaunchMessage --input-json '{\"launchId\":\"6f1c…\",\"text\":\"also check CI\"}'",
    },
    completeLaunchClient: {
      description: "Report the CLI session a client started for a CLI new-lane launch (or the error that stopped it).",
      input: "object { launchId: uuid, sessionId?: string, error?: string }",
      example: "ade actions run chat.completeLaunchClient --input-json '{\"launchId\":\"6f1c…\",\"sessionId\":\"pty-1\"}'",
    },
    createSession: {
      description: "Create a persistent ADE Work chat session.",
      input: "object { laneId?, provider?, model?/modelId?, reasoningEffort?, permissionMode?, fastMode?, title?, surface? }",
      example: "ade actions run chat.createSession --input-json '{\"laneId\":\"lane-1\",\"provider\":\"codex\",\"model\":\"openai/gpt-5.6-sol\",\"reasoningEffort\":\"xhigh\",\"permissionMode\":\"full-auto\",\"fastMode\":false}'",
    },
    getAvailableModels: {
      description: "List available chat models, optionally filtered by provider.",
      input: "object { provider?: \"claude\" | \"codex\" | \"cursor\" | \"droid\" | \"opencode\" }",
      example: "ade actions run chat.getAvailableModels --input-json '{\"provider\":\"codex\"}'",
    },
    getSessionSummary: {
      description: "Read one chat session summary, plus the IANA timeZone of the ADE brain that produced its timestamps.",
      input: "scalar sessionId string, positional argsList [sessionId], or object { sessionId }",
      example: "ade actions run chat.getSessionSummary --scalar chat-123",
    },
    getTurnStatus: {
      description: "Read live turn status for one chat: RUNNING, BLOCKED, or IDLE.",
      input: "scalar sessionId string, positional argsList [sessionId], or object { sessionId }",
      example: "ade actions run chat.getTurnStatus --scalar chat-123",
    },
    createScheduledWork: {
      description: "Create durable scheduled work for an eligible chat or tracked provider CLI session. Use delaySeconds or runAt for one-shot wakeups; five-field cron uses the ADE brain machine's local timezone.",
      input: "object { sessionId?: string, prompt: string, exactly one of cron?: string | runAt?: ISO 8601 string with offset/Z | delaySeconds?: positive integer, recurring?: boolean, reason?: string }",
      example: "ade actions run chat.createScheduledWork --input-json '{\"delaySeconds\":720,\"prompt\":\"Check CI and report\"}' --text",
    },
    listScheduledWork: {
      description: "List ADE-managed durable wakeups, cron jobs, and loops, optionally for one chat.",
      input: "object { sessionId?: string, includeTerminal?: boolean }",
      example: "ade actions run chat.listScheduledWork --input-json '{\"sessionId\":\"chat-123\"}' --text",
    },
    getScheduledWorkState: {
      description: "Read pause state, next wake time, and active durable jobs for an eligible chat or tracked provider CLI session.",
      input: "object { sessionId: string }",
      example: "ade actions run chat.getScheduledWorkState --input-json '{\"sessionId\":\"chat-123\"}' --text",
    },
    cancelScheduledWork: {
      description: "Cancel one ADE-managed scheduled job. Claude cron cancellation is also requested through CronDelete.",
      input: "object { sessionId: string, scheduleId: string }",
      example: "ade actions run chat.cancelScheduledWork --input-json '{\"sessionId\":\"chat-123\",\"scheduleId\":\"cron-abc\"}' --text",
    },
    resumeUsageLimitNow: {
      description: "Send the usage-limit continue prompt now instead of waiting for the published reset. Cancels the armed auto-resume row and clears the paused streak.",
      input: "object { sessionId: string }",
      example: "ade actions run chat.resumeUsageLimitNow --input-json '{\"sessionId\":\"chat-123\"}' --text",
    },
    continueUsageLimitOnAlternate: {
      description: "Continue a usage-limited chat on another signed-in account that still has room. Starts a new chat; the original thread stays parked.",
      input: "object { sessionId: string }",
      example: "ade actions run chat.continueUsageLimitOnAlternate --input-json '{\"sessionId\":\"chat-123\"}' --text",
    },
    switchAccount: {
      description: "Move a Claude or Codex chat to another signed-in account of the same provider. Same chat and thread; the next turn runs on that account. Refused while a turn runs. Account ids come from `ade providers accounts list`.",
      input: "object { sessionId: string, instanceId: string }",
      example: "ade actions run chat.switchAccount --input-json '{\"sessionId\":\"chat-123\",\"instanceId\":\"claude-2\"}' --text",
    },
    listCliChildSessions: {
      description: "List tracked CLI sessions spawned with a parent chat (`ade new chat --mode cli --parent …`), with status, exit code, lane, and parent. `chat.getTurnStatus` and `chat.readTranscript` also answer for these ids.",
      input: "object { laneId?: string, parentSessionId?: string, includeArchived?: boolean }  (archived hidden by default)",
      example: "ade actions run chat.listCliChildSessions --input-json '{\"parentSessionId\":\"chat-123\"}' --json",
    },
    readTranscript: {
      description: "Read a bounded recent window of user/assistant messages for any project-backed chat on this machine. For a tracked CLI session id it returns the CLI's last message and terminal tail instead.",
      input: "object { sessionId: string, limit?: number, maxChars?: number, since?: ISO timestamp }",
      example: "ade actions run chat.readTranscript --input-json '{\"sessionId\":\"chat-123\",\"limit\":20,\"maxChars\":8000}'",
    },
    readTranscriptPage: {
      description: "Read a bounded page of recent or older user/assistant messages for any project-backed chat on this machine.",
      input: "object { sessionId: string, beforeOffset?: number, limit?: number, maxChars?: number }",
      example: "ade actions run chat.readTranscriptPage --input-json '{\"sessionId\":\"chat-123\",\"beforeOffset\":4096,\"limit\":20,\"maxChars\":8000}'",
    },
    getChatEventHistory: {
      description: "Read the recent raw chat event stream, including scheduled work, transcript retractions, tool calls, and metadata events.",
      input: "object { sessionId: string, maxEvents?: number, maxBytes?: number } or argsList [sessionId, options?]",
      example: "ade actions run chat.getChatEventHistory --input-json '{\"sessionId\":\"chat-123\",\"maxEvents\":128}' --json",
    },
    getChatEventHistoryPage: {
      description: "Page older raw chat events before an event-history byte offset.",
      input: "object { sessionId: string, beforeOffset: number, maxBytes?: number } or argsList [sessionId, options]",
      example: "ade actions run chat.getChatEventHistoryPage --input-json '{\"sessionId\":\"chat-123\",\"beforeOffset\":4096,\"maxBytes\":65536}' --json",
    },
    sendMessage: {
      description: "Send a user message to a chat session; provider dispatch continues asynchronously.",
      input: "object { sessionId: string, text: string, attachments? }",
      example: "ade actions run chat.sendMessage --input-json '{\"sessionId\":\"chat-123\",\"text\":\"next step\"}'",
    },
    listThreadComments: {
      description: "List a chat's pending thread comments (the user's unsent notes on parts of agent replies). User clients only.",
      input: "object { sessionId: string }",
      example: "ade actions run chat.listThreadComments --input-json '{\"sessionId\":\"chat-123\"}' --json",
    },
    createThreadComment: {
      description: "Pin a pending comment to part of an agent reply. It goes with the user's next send. User clients only.",
      input: "object { sessionId: string, messageKey: string, messageExcerpt: string, anchor: { kind: \"text\", quote, prefix, suffix } | { kind: \"table_row\", tableIndex, rowIndex, headers, cells }, body: string }",
      example: "ade actions run chat.createThreadComment --input-json '{\"sessionId\":\"chat-123\",\"messageKey\":\"message:m1\",\"messageExcerpt\":\"Here is the plan\",\"anchor\":{\"kind\":\"text\",\"quote\":\"step two\",\"prefix\":\"\",\"suffix\":\"\"},\"body\":\"skip this\"}'",
    },
    updateThreadComment: {
      description: "Edit a pending thread comment, or hold it back from the next send. User clients only.",
      input: "object { sessionId: string, commentId: string, body?: string, includeInNextSend?: boolean }",
      example: "ade actions run chat.updateThreadComment --input-json '{\"sessionId\":\"chat-123\",\"commentId\":\"c-1\",\"includeInNextSend\":false}'",
    },
    deleteThreadComment: {
      description: "Delete a pending thread comment. User clients only.",
      input: "object { sessionId: string, commentId: string }",
      example: "ade actions run chat.deleteThreadComment --input-json '{\"sessionId\":\"chat-123\",\"commentId\":\"c-1\"}'",
    },
    messageSession: {
      description: "Deliver a message to a chat using ADE-normalized routing: auto steers active turns, wakes idle chats, queues non-urgent context, or interrupts and replaces.",
      input: "object { sessionId: string, text: string, kind?: \"auto\" | \"queue\" | \"wake\" | \"interrupt-replace\", attachments?, contextAttachments?, metadata? }",
      example: "ade actions run chat.messageSession --input-json '{\"sessionId\":\"chat-123\",\"kind\":\"auto\",\"text\":\"use this context\"}'",
    },
    modelCatalog: {
      description: "Read the provider/model catalog, including reasoning tiers and fast service tiers.",
      input: "object { mode?: \"cached\" | \"refresh-stale\" | \"force\", refreshProvider?: string, cursorSource?: string }",
      example: "ade actions run chat.modelCatalog --input-json '{\"mode\":\"cached\"}' --json",
    },
    resolveSmartLinkPreview: {
      description: "Resolve a safe, bounded title and favicon preview for a pasted chat URL.",
      input: "object { url: string }",
      example: "ade actions run chat.resolveSmartLinkPreview --input-json '{\"url\":\"https://github.com/owner/repo/pull/123\"}' --json",
    },
    resolveSourceFavicons: {
      description: "Fetch the favicons of Sources domains from the sites themselves (HTTPS, public hosts only, cached 7 days) as data URLs; null when a site has none.",
      input: "object { domains?: string[] (max 48), domain?: string, url?: string }",
      example: "ade actions run chat.resolveSourceFavicons --input-json '{\"domains\":[\"github.com\",\"zed.dev\"]}' --json",
    },
    recoverCodexTurn: {
      description: "Recover a stalled Codex turn by waiting, nudging it, retrying on the same thread, or restarting and resuming the thread.",
      input: "object { sessionId: string, turnId: string, action: \"wait\" | \"steer\" | \"interrupt_retry_same_thread\" | \"restart_resume_thread\" }",
      example: "ade actions run chat.recoverCodexTurn --input-json '{\"sessionId\":\"chat-123\",\"turnId\":\"turn-456\",\"action\":\"wait\"}'",
    },
    recoverTurn: {
      description: "Recover a stalled provider turn using ADE's provider-neutral wait, nudge, same-runtime retry, or restart-and-resume actions.",
      input: "object { sessionId: string, turnId: string, action: \"wait\" | \"nudge\" | \"retry_same_runtime\" | \"restart_resume\" }",
      example: "ade actions run chat.recoverTurn --input-json '{\"sessionId\":\"chat-123\",\"turnId\":\"turn-456\",\"action\":\"restart_resume\"}'",
    },
    resolveUnprocessedMessage: {
      description: "Idempotently run an accepted-but-unprocessed follow-up as the next turn, or dismiss it.",
      input: "object { sessionId: string, steerId: string, action: \"run_next\" | \"dismiss\" }",
      example: "ade actions run chat.resolveUnprocessedMessage --input-json '{\"sessionId\":\"chat-123\",\"steerId\":\"steer-456\",\"action\":\"run_next\"}'",
    },
    recoverContinuity: {
      description: "Explicitly reconnect, reconstruct, or supersede a chat whose provider thread could not be resumed.",
      input: "object { sessionId: string, mode: \"retry_original\" | \"recover_from_history\" | \"start_new_chat\" }",
      example: "ade actions run chat.recoverContinuity --input-json '{\"sessionId\":\"chat-123\",\"mode\":\"retry_original\"}'",
    },
    startCodexRealtime: {
      description:
        "Start a Codex realtime voice conversation on a chat from a renderer WebRTC offer. "
        + "The session uses the signed-in ChatGPT account and is CTO-only.",
      input: "object { sessionId: string, sdp: string, preferences?: CodexVoicePreferences | null }",
    },
    stopCodexRealtime: {
      description: "Stop the current Codex realtime voice conversation for a chat. CTO-only.",
      input: "object { sessionId: string, token?: string }",
    },
    getCodexRealtimeState: {
      description:
        "Read the current Codex voice state and live captions for the renderer. "
        + "Captions contain spoken words, so this read is CTO-only.",
      input: "object { sessionId: string, token: string }",
    },
    handoffSession: {
      description:
        "Hand a chat to a different model. \"brief\" writes a summary and starts a fresh thread (any lane in the project); "
        + "\"fork\" carries the full transcript and must stay in the source lane.",
      input: "object { sourceSessionId: string, targetModelId: string, mode?: \"brief\" | \"fork\", targetLaneId?: string | null, handoffNote?: string | null, reasoningEffort?: string | null }",
      example: "ade actions run chat.handoffSession --input-json '{\"sourceSessionId\":\"chat-123\",\"targetModelId\":\"openai/gpt-5.6-sol\",\"mode\":\"brief\"}' --json",
    },
    setScheduledWorkPaused: {
      description: "Pause or resume every scheduled job on one chat. Reversible; nothing is cancelled.",
      input: "object { sessionId: string, paused: boolean }",
      example: "ade actions run chat.setScheduledWorkPaused --input-json '{\"sessionId\":\"chat-123\",\"paused\":true}' --text",
    },
    setSpawnKind: {
      description: "Demote a subagent chat to a peer (reports stop) or promote a peer back to a subagent (reports resume). Taking over posts a quiet note on the parent.",
      input: "object { sessionId: string, spawnKind: \"subagent\" | \"peer\" }",
      example: "ade actions run chat.setSpawnKind --input-json '{\"sessionId\":\"chat-123\",\"spawnKind\":\"peer\"}' --text",
    },
    dismissSubagentTakeoverPrompt: {
      description: "Record that the subagent takeover banner was shown and answered or dismissed, so it does not reappear.",
      input: "object { sessionId: string }",
      example: "ade actions run chat.dismissSubagentTakeoverPrompt --input-json '{\"sessionId\":\"chat-123\"}' --text",
    },
  },
  session: {
    setSessionActivity: {
      description:
        "Agent callers must use an ADE-bound tracked session. The target may be the caller's chat or a tracked terminal owned by that chat; "
        + "`--session` cannot target another session. Report one fixed activity label for the current turn. This is a detail inside the existing parent phase, "
        + "not a board-state change; ADE stamps the source and update time, and null clears the report.",
      input: `object { sessionId: string, value: ${sessionActivityValueInput} | null }`,
      example: "ade actions run session.setSessionActivity --input-json '{\"sessionId\":\"chat-123\",\"value\":\"testing\"}' --text",
    },
    moveOnBoard: {
      description:
        "Move one chat between Work-board columns. Applies the lifecycle write and stages a host-authored message the agent reacts to; "
        + "both are reversible together with session.undoBoardMove for 5 seconds. Waiting is derived and is not a target.",
      input: "object { sessionId: string, to: \"needs_you\" | \"working\" | \"done\" }",
      example: "ade session move chat-123 --to working --text",
    },
    undoBoardMove: {
      description:
        "Reverse a still-staged board move: restores the lifecycle columns and cancels the message before it is dispatched. "
        + "Refuses once the message has gone out.",
      input: "object { sessionId: string, moveId: string }",
      example: "ade actions run session.undoBoardMove --input-json '{\"sessionId\":\"chat-123\",\"moveId\":\"...\"}'",
    },
  },
  automations: {
    webhookCreateAutomation: {
      description:
        "One step: make a private webhook URL and the automation that runs on it. Returns { rule, hookId, setup } where setup has the URL, "
        + "numbered paste steps for the service, the signature/secret state, and the filters in words. Defaults come from the preset "
        + "(GitHub/Stripe/Linear/Sentry signature format, suggested filters and prompt). chatSessionId \"this\" sends every delivery to the "
        + "calling chat as a new turn; an agent may bind only its own chat. Failures leave no URL behind.",
      input:
        "object { preset?: \"github\" | \"stripe\" | \"linear\" | \"sentry\" | \"generic\", name?: string, prompt?: string (use {{trigger.body.<path>}}), "
        + "filters?: Array<string like \"body.action=opened\" | \"headers.x-github-event=issues\" | \"body.ref~main\" | \"body.draft!=true\" | \"body.issue\"> ([] = every request), "
        + "requireSignature?: boolean, secretName?: string, modelId?: string, reasoningEffort?: string, chatSessionId?: string | \"this\", enabled?: boolean, confirmations?: string[] }",
      example: "ade automations webhook create --preset github --filter body.action=opened --in-this-chat --text",
    },
    webhookList: {
      description: "Every webhook automation in this project: its URL and route (relay / gateway / this computer), signature and secret state, filters, bound chat, and last delivery.",
      input: "no input",
      example: "ade automations webhook list --text",
    },
    webhookCreateEndpoint: {
      description: "Make a bare private webhook URL (no rule). Prefer webhookCreateAutomation, which makes the URL and the rule together.",
      input: "object { label?: string }",
      example: "ade automations webhook new --label \"Deploy failures\" --text",
    },
    webhookGetEndpoint: {
      description: "Read one webhook URL: url, route, whether its token lives on this machine, and the last delivery time. Registers it with ADE's relay if that has not happened yet.",
      input: "object { hookId: string }",
      example: "ade automations webhook url wh-0123456789abcdef --text",
    },
    webhookRotateEndpoint: {
      description: "Replace a webhook URL's secret token. The old URL stops working at once; the person must paste the new one into the service.",
      input: "object { hookId: string }",
      example: "ade automations webhook rotate wh-0123456789abcdef --text",
    },
    webhookRetire: {
      description: "Stop a webhook URL that no automation uses any more (deleting an automation already does this). Refuses while a rule still names it.",
      input: "object { hookId: string }",
      example: "ade automations webhook retire wh-0123456789abcdef --text",
    },
    webhookListDeliveries: {
      description: "The newest deliveries to one webhook URL with their outcome (ran, filtered, bad_signature, missing_signature, duplicate, expired, no_rule, disabled, rate_limited, too_large, error) and a one-sentence reason.",
      input: "object { hookId: string, limit?: number (max 50) }",
      example: "ade automations webhook deliveries wh-0123456789abcdef --text",
    },
    webhookGetDelivery: {
      description: "One delivery in full: outcome and reason, signature state, the exact prompt the agent got, headers (authorization/cookies hidden), body, and the run's id and chat.",
      input: "object { id: string }",
      example: "ade automations webhook delivery whd_0123456789abcdef01 --text",
    },
    webhookReplayDelivery: {
      description: "Run a logged delivery again against the automation as it is now (no signature or duplicate check). Returns the new delivery.",
      input: "object { id: string }",
      example: "ade automations webhook replay whd_0123456789abcdef01 --text",
    },
    webhookSendTest: {
      description: "Ring a webhook URL with a sample request signed the way the configured service signs it, through the real route (relay when public). Then read webhookListDeliveries to see the outcome.",
      input: "object { hookId: string, body?: string (JSON), headers?: Record<string,string> }",
      example: "ade automations webhook test wh-0123456789abcdef --text",
    },
    list: {
      description: "List this project's automation rules with their last/next run state.",
      input: "no input",
      example: "ade actions run automations.list --text",
    },
    get: {
      description: "Read one automation rule, including its provenance (origin, scope, originRequest, oneShot).",
      input: "object { id: string }",
      example: "ade actions run automations.get --input-json '{\"id\":\"nightly-review\"}' --text",
    },
    saveRule: {
      description: "Create or update one automation rule from a draft. An existing id updates in place; provenance fields travel with the draft and default to origin \"user\".",
      input: "object { draft: AutomationRuleDraft (id?, name, enabled, mode, triggers, execution, prompt?, origin?: \"user\" | \"cto\" | \"chat-menu\", scope?: { sessionId, sessionTitle }, originRequest?, oneShot?, maxRuns?), confirmations?: string[] }",
      example: "ade actions run automations.saveRule --input-json '{\"draft\":{\"name\":\"Hand off on limit\",\"enabled\":true,\"mode\":\"monitor\",\"triggers\":[{\"type\":\"session.limit_reached\",\"sessionId\":\"chat-123\"}],\"origin\":\"chat-menu\",\"oneShot\":true,\"maxRuns\":3,\"execution\":{\"kind\":\"built-in\",\"builtIn\":{\"actions\":[{\"type\":\"handoff\",\"targetModelId\":\"openai/gpt-5.6-sol\",\"targetLaneMode\":\"same\"}]}}}}' --text",
    },
    listRuns: {
      description: "List recent automation runs across every rule, newest first.",
      input: "object { ruleId?: string, laneId?: string, limit?: number }",
      example: "ade actions run automations.listRuns --input-json '{\"limit\":20}' --json",
    },
    deleteRule: {
      description: "Delete one local automation rule. Shared rules must be removed from the shared project config.",
      input: "object { id: string }",
      example: "ade actions run automations.deleteRule --input-json '{\"id\":\"nightly-review\"}' --text",
    },
    toggleRule: {
      description: "Enable or disable one automation rule. Reversible, and keeps the rule and its run history.",
      input: "object { id: string, enabled: boolean }",
      example: "ade actions run automations.toggleRule --input-json '{\"id\":\"nightly-review\",\"enabled\":false}' --text",
    },
    triggerManually: {
      description: "Fire one automation rule now, optionally against a lane or as a dry run.",
      input: "object { id: string, laneId?: string, dryRun?: boolean, verboseTrace?: boolean }",
      example: "ade actions run automations.triggerManually --input-json '{\"id\":\"nightly-review\",\"dryRun\":true}' --text",
    },
    planTest: {
      description: "Show what a safe or live test of one automation will do with an event, step by step. Changes nothing.",
      input: "object { id: string, mode: \"safe\" | \"live\", event?: { triggerType?, laneId?, sessionId?, pr?: { number, title?, url?, repo?, headBranch?, baseBranch? }, issue?: { number, title? }, linearIssue?: { id, title? }, webhookBody?, label? } }",
      example: "ade actions run automations.planTest --input-json '{\"id\":\"nightly-review\",\"mode\":\"safe\",\"event\":{\"pr\":{\"number\":12,\"title\":\"Bump deps\"}}}' --text",
    },
    runTest: {
      description: "Start a test run of one automation. A safe test works in a throwaway lane and only reports steps that post, push, or call outside ADE. A live test runs for real. Both mark notifications [Test] and use no run budget.",
      input: "object { id: string, mode: \"safe\" | \"live\", event?: same as planTest }",
      example: "ade actions run automations.runTest --input-json '{\"id\":\"nightly-review\",\"mode\":\"safe\"}' --text",
    },
    cleanUpTestRun: {
      description: "Delete the lanes a finished test run made, with their local branches.",
      input: "object { runId: string }",
      example: "ade actions run automations.cleanUpTestRun --input-json '{\"runId\":\"run-123\"}' --text",
    },
  },
  automation_planner: {
    parseNaturalLanguage: {
      description:
        "Turn a plain-English automation request into a rule draft. Writes nothing: the draft is returned for review, "
        + "then simulated, then saved.",
      input: "object { intent: string, planner: { provider: \"codex\", codex: {...} } | { provider: \"claude\", claude: {...} } }",
      example: "ade actions run automation_planner.parseNaturalLanguage --input-json '{\"intent\":\"hand this chat to Sol when it hits a usage limit\",\"planner\":{\"provider\":\"codex\",\"codex\":{\"sandbox\":\"read-only\",\"askForApproval\":\"never\",\"webSearch\":false,\"additionalWritableDirs\":[]}}}' --json",
    },
    validateDraft: {
      description: "Validate an automation draft and return the confirmation keys a save would demand.",
      input: "object { draft: AutomationRuleDraft, confirmations?: string[] }",
      example: "ade actions run automation_planner.validateDraft --input-json '{\"draft\":{\"name\":\"Nightly review\",\"enabled\":true,\"mode\":\"monitor\",\"triggers\":[],\"execution\":{\"kind\":\"built-in\"}}}' --json",
    },
    simulate: {
      description:
        "Dry-run an automation draft: report the actions it would take, in order, with warnings. Executes none of them.",
      input: "object { draft: AutomationRuleDraft }",
      example: "ade actions run automation_planner.simulate --input-json '{\"draft\":{\"name\":\"Nightly review\",\"enabled\":true,\"mode\":\"monitor\",\"triggers\":[],\"execution\":{\"kind\":\"built-in\"}}}' --json",
    },
    saveDraft: {
      description:
        "Validate and persist an automation draft. A draft carrying an `id` REPLACES that rule in place; without one a new "
        + "rule is created.",
      input: "object { draft: AutomationRuleDraft, confirmations?: string[] }",
      example: "ade actions run automation_planner.saveDraft --input-json '{\"draft\":{\"name\":\"Nightly review\",\"enabled\":true,\"mode\":\"monitor\",\"triggers\":[],\"execution\":{\"kind\":\"built-in\"}}}' --json",
    },
  },
  search: {
    query: {
      description: "Search ADE's own project index across lanes, chats, PRs, files, and issues — the index behind the command palette.",
      input: "object { query: string, laneId?: string, limit?: number }",
      example: "ade actions run search.query --input-json '{\"query\":\"sync cursor\",\"limit\":20}' --json",
    },
    indexStatus: {
      description: "Read what the universal search index covers and how fresh it is.",
      input: "no input",
      example: "ade actions run search.indexStatus --json",
    },
  },
  budget: {
    getConfig: {
      description: "Read the project's spend caps and alert thresholds.",
      input: "no input",
      example: "ade actions run budget.getConfig --json",
    },
    getCumulativeUsage: {
      description: "Read cumulative token and cost usage against the caps for the current week, for one scope.",
      input: "positional argsList [scope, scopeId, provider?]",
      example: "ade actions run budget.getCumulativeUsage --args-json '[\"project\",\"my-project\",\"any\"]' --json",
    },
    checkBudget: {
      description: "Ask whether a scope is inside its budget right now, and collect any soft-threshold warnings.",
      input: "positional argsList [scope, scopeId, provider, context?]",
      example: "ade actions run budget.checkBudget --args-json '[\"project\",\"my-project\",\"any\"]' --json",
    },
  },
  project_config: {
    get: {
      description: "Read the project's ADE configuration: shared config, local overrides, and the merged effective result.",
      input: "no input",
      example: "ade actions run project_config.get --json",
    },
  },
  ios_simulator: {
    getStatus: {
      description: "Read the iOS simulator session status: which device is claimed, by which chat, and what is running.",
      input: "no input",
      example: "ade actions run ios_simulator.getStatus --json",
    },
    listDevices: {
      description: "List the iOS simulators available on this machine.",
      input: "no input",
      example: "ade actions run ios_simulator.listDevices --json",
    },
    listLaunchTargets: {
      description: "List the app targets ADE can launch on an iOS simulator for one lane.",
      input: "object { laneId: string }",
      example: "ade actions run ios_simulator.listLaunchTargets --input-json '{\"laneId\":\"lane-1\"}' --json",
    },
    getScreenSnapshot: {
      description: "Read the current simulator screen as a structured element/text snapshot rather than pixels.",
      input: "object { }",
      example: "ade actions run ios_simulator.getScreenSnapshot --input-json '{}' --json",
    },
  },
  mac_desktop: {
    getStatus: {
      description:
        "Read the lane's Mac Desktop: whether this host can run one, the display, its parked windows, the input lease, and every lane holding a display. Stream fields are redacted.",
      input: "object { laneId?: string }",
      example: "ade actions run mac_desktop.getStatus --input-json '{\"laneId\":\"lane-1\"}' --json",
    },
    listWindows: {
      description: "List the windows parked on a lane's Mac Desktop display (omit laneId for every window this host can see).",
      input: "object { laneId?: string }",
      example: "ade actions run mac_desktop.listWindows --input-json '{\"laneId\":\"lane-1\"}' --json",
    },
    observe: {
      description:
        "Capture the lane's desktop as a screenshot plus a numbered accessibility element list. Act on the handles it returns; they are valid only for this observation.",
      input: "object { laneId: string, windowId?: number, map?: boolean, limit?: number }",
      example: "ade actions run mac_desktop.observe --input-json '{\"laneId\":\"lane-1\",\"map\":true}' --json",
    },
    getStreamStatus: {
      description: "Read the lane's live-view stream shape: running, frame rate, and client count. The URL and token are always null here.",
      input: "object { laneId: string }",
      example: "ade actions run mac_desktop.getStreamStatus --input-json '{\"laneId\":\"lane-1\"}' --json",
    },
  },
  app_control: {
    getStatus: {
      description: "Read the desktop app-control session status: what is attached and which chat owns it.",
      input: "no input",
      example: "ade actions run app_control.getStatus --json",
    },
    listTargets: {
      description: "List the desktop apps and renderer targets ADE can attach to right now.",
      input: "no input",
      example: "ade actions run app_control.listTargets --json",
    },
    getSnapshot: {
      description: "Read a structured element/text snapshot of the attached desktop app.",
      input: "object { }",
      example: "ade actions run app_control.getSnapshot --input-json '{}' --json",
    },
  },
  built_in_browser: {
    getStatus: {
      description: "Read the built-in browser's status: running, claimed, and by which chat.",
      input: "no input",
      example: "ade actions run built_in_browser.getStatus --json",
    },
    listSessions: {
      description: "List the built-in browser's open sessions and their tabs.",
      input: "no input",
      example: "ade actions run built_in_browser.listSessions --json",
    },
    getTrace: {
      description: "Read one browser session's recorded trace: navigations, console output, and network summary.",
      input: "object { sessionId: string }",
      example: "ade actions run built_in_browser.getTrace --input-json '{\"sessionId\":\"browser-1\"}' --json",
    },
  },
  computer_use_artifacts: {
    listArtifacts: {
      description: "List computer-use proof artifacts (screenshots, recordings, traces, logs) across the project.",
      input: "object { kind?, ownerKind?, ownerId?, artifactId?, metadataKind?, excludeMetadataKind?, limit? }",
      example: "ade actions run computer_use_artifacts.listArtifacts --input-json '{\"kind\":\"screenshot\",\"limit\":20}' --json",
    },
    ingest: {
      description:
        "File existing on-disk captures as proof artifacts and attach them to a lane, chat, automation run, PR, or issue. "
        + "Additive: never removes or overwrites an artifact.",
      input: "object { backend: { name, style?, toolName? }, inputs: Array<{ kind?, title?, description?, path?, uri?, text? }>, owners?: Array<{ kind, id, relation? }>, callerRoot?: string }",
      example: "ade actions run computer_use_artifacts.ingest --input-json '{\"backend\":{\"name\":\"cto\",\"style\":\"manual\"},\"inputs\":[{\"kind\":\"screenshot\",\"title\":\"Lanes tab\",\"path\":\"/tmp/shot.png\"}],\"owners\":[{\"kind\":\"lane\",\"id\":\"lane-1\"}]}' --json",
    },
    ingestSceneSnapshot: {
      description:
        "File a scene snapshot the desktop already wrote into this project's artifact store as proof. "
        + "CTO-only, and the path must already be inside `.ade/artifacts/computer-use`.",
      input: "object { path: string, title?: string, sessionId?: string | null, sceneScopeKey?: string }",
      example: "ade --role cto actions run computer_use_artifacts.ingestSceneSnapshot --input-json '{\"path\":\"/repo/.ade/artifacts/computer-use/scene.png\",\"title\":\"Merged pull requests\"}' --json",
    },
    readArtifactPreview: {
      description: "Read one artifact's bytes as a bounded preview, for artifacts small enough to inline.",
      input: "object { artifactId: string, maxBytes?: number }",
      example: "ade actions run computer_use_artifacts.readArtifactPreview --input-json '{\"artifactId\":\"artifact-1\"}' --json",
    },
    readArtifactRange: {
      description: "Read one bounded slice of a stored proof inside .ade/artifacts, base64-encoded, so a paired desktop can stream a video.",
      input: "object { uri: string, offset?: number, length?: number }",
      example: "ade --role cto actions run computer_use_artifacts.readArtifactRange --input-json '{\"uri\":\".ade/artifacts/apple-recordings/lane-1/rec.mp4\",\"offset\":0,\"length\":1048576}' --json",
    },
    updateArtifactReview: {
      description: "Mark a proof artifact approved, rejected, or needing more evidence, with an optional note.",
      input: "object { artifactId: string, reviewState: \"pending\" | \"accepted\" | \"needs_more\" | \"dismissed\", workflowState?: string | null, reviewNote?: string | null }",
      example: "ade actions run computer_use_artifacts.updateArtifactReview --input-json '{\"artifactId\":\"artifact-1\",\"reviewState\":\"accepted\"}' --json",
    },
  },
  "external-sessions": {
    list: {
      description: "List provider-native CLI sessions found outside ADE.",
      input: "object { providers?, laneId?, cwd?, scope?: \"project\" | \"all\", limit? }",
      example: "ade actions run external-sessions.list --input-json '{\"scope\":\"project\",\"limit\":20}' --text",
    },
    import: {
      description: "Import an outside provider CLI session into an ADE lane as a CLI terminal or chat.",
      input: "object { provider, sessionId, laneId, target: \"cli\" | \"chat\", mode: \"resume\" | \"fork\", model?, permissionMode? }",
      example: "ade actions run external-sessions.import --input-json '{\"provider\":\"codex\",\"sessionId\":\"thread-id\",\"laneId\":\"lane-1\",\"target\":\"cli\",\"mode\":\"resume\"}' --text",
    },
    getDetail: {
      description: "Re-parse one outside session file and return a generous transcript tail.",
      input: "object { provider, sessionId }",
      example: "ade actions run external-sessions.getDetail --input-json '{\"provider\":\"claude\",\"sessionId\":\"session-id\"}' --text",
    },
  },
  archive: {
    list: {
      description:
        "List archived lanes, chats, and shells, newest first. Archived items are hidden from every other list "
        + "unless it is asked to include them.",
      input: "object { kinds?: Array<\"lane\" | \"chat\" | \"shell\">, olderThanDays?: number }",
      example: "ade actions run archive.list --input-json '{\"kinds\":[\"chat\"]}' --text",
    },
    summary: {
      description: "Count archived items per kind, and how many (and how many bytes) were archived at least N days ago.",
      input: "object { olderThanDays?: number }  (default 14)",
      example: "ade actions run archive.summary --input-json '{\"olderThanDays\":30}' --text",
    },
    restore: {
      description: "Unarchive lanes, chats, or shells (CTO only for agents). Each item reports done or failed on its own.",
      input: "object { items: Array<{ kind: \"lane\" | \"chat\" | \"shell\", id: string }> }",
      example: "ade actions run archive.restore --input-json '{\"items\":[{\"kind\":\"chat\",\"id\":\"session-id\"}]}' --text",
    },
    delete: {
      description:
        "Permanently delete archived items. The user's action only: agents and automations are refused. Refuses "
        + "anything not archived. A lane delete removes the lane and its worktree but keeps its git branch; `force` "
        + "also removes a worktree with uncommitted changes.",
      input: "object { items: Array<{ kind, id }>, force?: boolean }",
      example: "ade actions run archive.delete --input-json '{\"items\":[{\"kind\":\"shell\",\"id\":\"session-id\"}]}' --text",
    },
  },
  provider_instances: {
    list: {
      description:
        "List this machine's provider accounts (Claude and Codex only). Each entry is a label plus the config directory "
        + "that holds that login, never a credential.",
      input: "object { provider?: \"claude\" | \"codex\" }",
      example: "ade actions run provider_instances.list --input-json '{\"provider\":\"claude\"}' --text",
    },
    create: {
      description:
        "Create an empty provider account: a new config directory plus a label. Returns the account and the exact login "
        + "command (argv + env var) a terminal must run so the provider CLI signs in to THIS directory.",
      input: "object { provider: \"claude\" | \"codex\", label: string, accentColor?: string }",
      example: "ade actions run provider_instances.create --input-json '{\"provider\":\"claude\",\"label\":\"Work\"}' --text",
    },
    remove: {
      description:
        "Forget a provider account. Nothing on disk is deleted — the config home is returned so the caller can say what is "
        + "still there. The machine's own login and the current default cannot be removed.",
      input: "object { id: string }",
      example: "ade actions run provider_instances.remove --input-json '{\"id\":\"work\"}' --text",
    },
    rename: {
      description: "Rename one provider account. Labels are at most 60 characters.",
      input: "object { id: string, label: string }",
      example: "ade actions run provider_instances.rename --input-json '{\"id\":\"work\",\"label\":\"Work (EU)\"}' --text",
    },
    setDefault: {
      description:
        "Make one account the provider's default, so sessions that name no instance land there. Exactly one default per provider.",
      input: "object { id: string }",
      example: "ade actions run provider_instances.setDefault --input-json '{\"id\":\"work\"}' --text",
    },
    setAccent: {
      description: "Set or clear one account's accent colour. `#rrggbb`, or null to clear it.",
      input: "object { id: string, accentColor: string | null }",
      example: "ade actions run provider_instances.setAccent --input-json '{\"id\":\"work\",\"accentColor\":\"#3b82f6\"}' --text",
    },
    getSettings: {
      description:
        "Read the per-provider account settings: whether new chats spread across signed-in accounts, and whether the "
        + "provider's accounts start with the machine on Windows.",
      input: "object { provider: \"claude\" | \"codex\" }",
      example: "ade actions run provider_instances.getSettings --input-json '{\"provider\":\"codex\"}' --text",
    },
    setSettings: {
      description: "Patch the per-provider account settings. Omitted fields keep their current value.",
      input: "object { provider: \"claude\" | \"codex\", settings: { smartBalance?: boolean, autoStartWindows?: boolean } }",
      example: "ade actions run provider_instances.setSettings --input-json '{\"provider\":\"codex\",\"settings\":{\"smartBalance\":true}}' --text",
    },
    loginCommand: {
      description:
        "The exact command that signs one account in: the provider binary, its argv, and the single env var that points it at "
        + "this account's config home. ADE never drives the OAuth flow itself.",
      input: "object { id: string }",
      example: "ade actions run provider_instances.loginCommand --input-json '{\"id\":\"work\"}' --text",
    },
    refresh: {
      description:
        "Re-read every account's config home and record who is signed in there. Writes only when something changed, so it is "
        + "safe to call on a cadence.",
      input: "object { provider?: \"claude\" | \"codex\" }",
      example: "ade actions run provider_instances.refresh --input-json '{\"provider\":\"claude\"}' --text",
    },
  },
};

export function getAdeActionInputContract(
  domain: AdeActionDomain,
  action: string,
): AdeActionInputContract | undefined {
  return ADE_ACTION_INPUT_CONTRACTS[domain]?.[action];
}
