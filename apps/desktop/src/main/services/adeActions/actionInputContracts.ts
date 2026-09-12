import type { AdeActionDomain } from "./domains";

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

const ADE_ACTION_INPUT_CONTRACTS: Partial<Record<AdeActionDomain, Partial<Record<string, AdeActionInputContract>>>> = {
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
  },
  attention: {
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
    readTranscript: {
      description: "Read a bounded recent window of user/assistant messages for any project-backed chat on this machine.",
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
  review: {
    listLaunchContext: {
      description: "Read what a review run can target right now: lanes, their recent commits, and open PRs.",
      input: "no input",
      example: "ade actions run review.listLaunchContext --json",
    },
    startRun: {
      description:
        "Start a code-review run over a lane diff, working tree, commit range, or PR. Reads the named lane's worktree, "
        + "so laneId is always required.",
      input: "object { target: { mode: \"lane_diff\" | \"working_tree\", laneId } | { mode: \"commit_range\", laneId, baseCommit, headCommit } | { mode: \"pr\", laneId, prId }, config?: Partial<ReviewRunConfig> }",
      example: "ade actions run review.startRun --input-json '{\"target\":{\"mode\":\"lane_diff\",\"laneId\":\"lane-1\"}}' --json",
    },
    rerun: {
      description: "Re-run a finished review with the same target and config.",
      input: "object { runId: string }",
      example: "ade actions run review.rerun --input-json '{\"runId\":\"review-1\"}' --json",
    },
    cancelRun: {
      description: "Cancel an in-flight review run. Reversible with review.rerun.",
      input: "object { runId: string }",
      example: "ade actions run review.cancelRun --input-json '{\"runId\":\"review-1\"}' --json",
    },
    listRuns: {
      description: "List review runs, newest first, optionally filtered by lane or status.",
      input: "object { laneId?: string, status?: \"queued\" | \"running\" | \"completed\" | \"failed\" | \"cancelled\" | \"all\", limit?: number }",
      example: "ade actions run review.listRuns --input-json '{\"limit\":10}' --json",
    },
    getRunDetail: {
      description: "Read one review run in full: findings, severities, anchors, and evidence.",
      input: "object { runId: string }",
      example: "ade actions run review.getRunDetail --input-json '{\"runId\":\"review-1\"}' --json",
    },
    qualityReport: {
      description: "Read aggregate review quality: run counts, finding counts, and accepted/rejected feedback rates.",
      input: "no input",
      example: "ade actions run review.qualityReport --json",
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
  orchestration: {
    runList: {
      description: "List orchestration runs and their status, optionally for one lane.",
      input: "positional argsList [laneId?, { limit?: number }?]",
      example: "ade actions run orchestration.runList --args-json '[null,{\"limit\":10}]' --json",
    },
    bundleRead: {
      description: "Read one orchestration run's bundle: manifest, plan, and registered assets.",
      input: "positional argsList [runId, bundlePath]",
      example: "ade actions run orchestration.bundleRead --args-json '[\"run-1\",\"/path/to/bundle\"]' --json",
    },
  },
  computer_use_artifacts: {
    listArtifacts: {
      description: "List computer-use proof artifacts (screenshots, recordings, traces, logs) across the project.",
      input: "object { kind?, ownerKind?, ownerId?, artifactId?, limit? }",
      example: "ade actions run computer_use_artifacts.listArtifacts --input-json '{\"kind\":\"screenshot\",\"limit\":20}' --json",
    },
    ingest: {
      description:
        "File existing on-disk captures as proof artifacts and attach them to a lane, chat, automation run, PR, or issue. "
        + "Additive: never removes or overwrites an artifact.",
      input: "object { backend: { name, style?, toolName? }, inputs: Array<{ kind?, title?, description?, path?, uri?, text? }>, owners?: Array<{ kind, id, relation? }>, callerRoot?: string }",
      example: "ade actions run computer_use_artifacts.ingest --input-json '{\"backend\":{\"name\":\"cto\",\"style\":\"manual\"},\"inputs\":[{\"kind\":\"screenshot\",\"title\":\"Lanes tab\",\"path\":\"/tmp/shot.png\"}],\"owners\":[{\"kind\":\"lane\",\"id\":\"lane-1\"}]}' --json",
    },
    readArtifactPreview: {
      description: "Read one artifact's bytes as a bounded preview, for artifacts small enough to inline.",
      input: "object { artifactId: string, maxBytes?: number }",
      example: "ade actions run computer_use_artifacts.readArtifactPreview --input-json '{\"artifactId\":\"artifact-1\"}' --json",
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
};

export function getAdeActionInputContract(
  domain: AdeActionDomain,
  action: string,
): AdeActionInputContract | undefined {
  return ADE_ACTION_INPUT_CONTRACTS[domain]?.[action];
}
