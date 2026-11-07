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
import { PROVIDER_CONTEXT_PROVIDER_IDS } from "../../../shared/types/providerContext";

const sessionActivityValueInput = SESSION_ACTIVITY_VALUES.map((value) => `"${value}"`).join(" | ");
const providerContextProviderInput = PROVIDER_CONTEXT_PROVIDER_IDS.map((value) => `"${value}"`).join(" | ");

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
  integration_connect: {
    request: {
      description: "Ask the person in this chat to connect an integration (github, linear, or jira) through the connect card, and save what they give straight into it on the machine that runs this chat. Returns at once with method \"already\" when it is connected. Otherwise blocks until they connect or decline. Returns {provider, connected: true, method, account} | {provider, connected: false, declined: true}; a key or token is never returned, logged, or written to the transcript. If the person named the integration, ask at once; if it was your own idea, ask in words first and raise the card only after a yes.",
      input: "object { provider: \"github\" | \"linear\" | \"jira\", reason: string, timeoutMs?: number }",
      example: "ade integrations connect linear --reason \"To read and update the issues you mentioned\"",
    },
    status: {
      description: "List every integration ADE can connect (github, linear, jira) with whether it is connected for this project on this machine, and as whom. Never returns a credential.",
      input: "no input",
      example: "ade integrations status --text",
    },
  },
  agent37: {
    ready_status: {
      description: "List the account's Agent 37 ready machines: per project kept ready (its git identity and name), whether a machine is ready (prepared and asleep), being prepared, or failed, with machine names and states. Reads Agent 37 with the account's key; never returns the key.",
      input: "no input",
      example: "ade agent37 ready --text",
    },
    claim_ready: {
      description: "Take this project's ready Agent 37 machine for a new chat: marks it claimed and wakes it (about 1-2 s), then returns {instanceId, machineKey, name, projectPath, laneId, wakeMs, claimToken}. Its ADE comes online a few seconds later; wait for it before sending work there. `ade chat create --machine agent37:ready` does all of this. Throws when there is no ready machine (with whether one is being prepared). A claimed machine bills while awake; give an unused one back with release_ready.",
      input: "object { originUrl: string }",
      example: "ade chat create --machine agent37:ready --prompt \"…\"",
    },
    list: {
      description: "List the account's Agent 37 machines: name, Agent 37 id, ADE machine key, state (running, asleep…), type and size, what an hour costs awake and asleep, spend, what sleeping saved, how it sleeps, plus the wallet and this month against the cap. Reads Agent 37 with the account's key; never returns the key.",
      input: "no input",
      example: "ade agent37 list --text",
    },
    spending: {
      description: "This month's Agent 37 spend against the account's monthly cap, the wallet, and what sleeping saved. Returns {monthlyCapUsd, monthSpentUsd, capReached, capNear, balanceUsd, savedUsd}.",
      input: "no input",
      example: "ade agent37 spending --text",
    },
    create: {
      description: "Make an Agent 37 machine from ADE's template, signed in to the account. With an ADE desktop attached its window approves the sign-in; otherwise the person approves from a link ADE posts in your chat (the command waits up to 10 minutes). Costs money: asks the person in your chat first (a full-auto chat is answered by ADE within the monthly cap). Refused at the cap. Returns the machine {instanceId, machineKey, name, joined}; with background: true, returns {requestId} at once to read with make_status.",
      input: "object { kind?: \"box\" | \"vm\", shape?: \"2x4\" | \"4x8\" | \"4x16\" | \"4x32\", name?: string, background?: boolean }",
      example: "ade agent37 create --kind vm --shape 4x8 --name \"android vm\"",
    },
    limits: {
      description: "What unattended agents (full-auto chats, automation runs) may spend on Agent 37 alone: {unattendedSpend, machinesPerDay, maxShape, preset: ask | balanced | hands_off | custom}. Attended agents always ask in their chat.",
      input: "none",
      example: "ade agent37 limits --text",
    },
    set_limits: {
      description: "Change what unattended agents may spend: a preset, or single limits. Loosening any limit asks the person; an unattended agent is refused.",
      input: "object { preset?: \"ask\" | \"balanced\" | \"hands_off\", unattendedSpend?: boolean, machinesPerDay?: number (0-100), maxShape?: \"2x4\" | \"4x8\" | \"4x16\" | \"4x32\" }",
      example: "ade agent37 limits balanced",
    },
    make_status: {
      description: "A create, copy or move started with background: true: {stage, message, approvalUrl (the sign-in link to open while it waits for the person), done, result, error}.",
      input: "object { requestId: string }",
      example: "ade --role agent actions run agent37.make_status --input-json '{\"requestId\":\"…\"}' --json",
    },
    sleep: {
      description: "Put an Agent 37 machine to sleep now: memory kept, only its disk bills. Free.",
      input: "object { machine: string (name, Agent 37 id or machine key) }",
      example: "ade agent37 sleep \"android vm\"",
    },
    wake: {
      description: "Wake an asleep Agent 37 machine (about a second; ADE on it is online a few seconds later). Bounded by the monthly cap. A --machine call to an asleep machine wakes it on its own.",
      input: "object { machine: string }",
      example: "ade agent37 wake \"android vm\"",
    },
    resize: {
      description: "Change an Agent 37 machine's size (same type). It restarts: files stay, running work stops. Asks the person first.",
      input: "object { machine: string, shape: \"2x4\" | \"4x8\" | \"4x16\" | \"4x32\" }",
      example: "ade agent37 resize \"android vm\" --shape 4x16",
    },
    copy: {
      description: "Copy an Agent 37 machine into a new one with the same files (repos, lanes, installed dependencies), signed in as a new machine: a fresh machine for a lane, from a warm one. A big disk takes minutes. Asks the person first.",
      input: "object { machine: string, name?: string, shape?: string }",
      example: "ade agent37 copy \"supabase-stack 9d77\" --name \"lane copy\"",
    },
    move: {
      description: "Move an Agent 37 machine to the other type (box to VM or back), keeping every repo, lane and chat: makes the new machine, copies the home folder, deletes the old one. Docker data and running processes don't move. Asks the person first. To move one chat and its lane to another computer, use ade chat move.",
      input: "object { machine: string, to: \"box\" | \"vm\", shape?: string }",
      example: "ade agent37 move \"my box\" --to vm",
    },
    delete: {
      description: "Delete an Agent 37 machine and remove it from the account. Its files are gone for good. Asks the person first; a full-auto chat may delete only a machine it made itself.",
      input: "object { machine: string }",
      example: "ade agent37 delete \"lane copy\"",
    },
    set_sleep: {
      description: "How long an Agent 37 machine waits with nothing running before it sleeps (5 to 1440 minutes), or never. Never asks first: it bills around the clock.",
      input: "object { machine: string, minutes: number | \"never\" }",
      example: "ade agent37 sleep-after \"my box\" 30",
    },
    set_cap: {
      description: "Set the account's monthly cap for every Agent 37 machine (dollars), or off. Raising or removing it asks the person first; lowering never does. At the cap ADE makes and wakes nothing.",
      input: "object { monthlyCapUsd: number | \"off\" }",
      example: "ade agent37 cap 50",
    },
    ready_set: {
      description: "Turn on (or change) \"Keep a cloud machine ready\" for this project: a machine kept prepared and asleep for the next chat. Turning it on asks the person first. A desktop on the account prepares it.",
      input: "object { originUrl?: string, kind?: \"box\" | \"vm\", shape?: string, setup?: string, projectName?: string }",
      example: "ade agent37 ready on --kind vm --setup \"npm ci\"",
    },
    ready_off: {
      description: "Turn off \"Keep a cloud machine ready\" for this project; its unclaimed machine is deleted on the next pass.",
      input: "object { originUrl?: string }",
      example: "ade agent37 ready off",
    },
    ready_retry: {
      description: "Prepare this project's ready machine again after a failure.",
      input: "object { originUrl?: string }",
      example: "ade agent37 ready retry",
    },
    release_ready: {
      description: "Give back a ready machine you claimed in the last 30 minutes and no chat used: it is tagged ready again and put back to sleep. Needs the claimToken claim_ready returned, so it never sleeps a machine another caller claimed. Returns {released: boolean}.",
      input: "object { instanceId: string, claimToken: string }",
      example: "ade --role agent actions run agent37.release_ready --input-json '{\"instanceId\":\"o2m461src2\",\"claimToken\":\"<from claim_ready>\"}' --json",
    },
  },
  mcp_registry: {
    list: {
      description: "Read the person's MCP setup on this machine: every server in ADE's MCP registry (name, transport, the command and args or the URL, the env variable and header NAMES, on or off for the account / this machine / this project, and whether each value is set here), plus the servers other tools' configs on this machine have that the registry does not, with the tools they come from. Never returns a value.",
      input: "no input",
      example: "ade mcp servers --text",
    },
    request: {
      description: "Propose adding one MCP server to the person's ADE registry: an MCP server card opens in this chat showing exactly what runs, and the person approves it (always, in every permission mode) and types any env or header values. ADE saves it to their account and the values to the account vault, on the machine that runs this chat. Returns at once with {already: true} when the registry has the same name, URL, or command line. Otherwise blocks until they add or decline. Returns {name, added: true, missing, next} | {name, added: false, already: true, existing, matchedBy, next} | {name, added: false, declined: true}; a value is never returned, logged, or written to the transcript. source \"imported\" takes a server another tool's config has (by its name, see mcp_registry.list); source \"agent\" describes one: command + args (stdio) or url (http/sse), with envNames or headerNames. After it is added, this chat's agent does not have the tools until the person presses Refresh chat. Never guess a URL or command: for a server you do not know, ask the person for its link or offer to search. If the person named the server, raise the card at once; if it was your own idea, ask in words first and raise the card only after a yes.",
      input: "object { name: string, reason: string, source?: \"imported\" | \"agent\", transport?: \"stdio\" | \"http\" | \"sse\", command?: string, args?: string[], url?: string, envNames?: string[], headerNames?: string[], timeoutMs?: number }",
      example: "ade mcp servers add github --reason \"To read your PRs\" --env GITHUB_PERSONAL_ACCESS_TOKEN -- npx -y @modelcontextprotocol/server-github",
    },
    remove: {
      description: "Propose removing one MCP server from the person's ADE registry: a card in this chat asks them, in every permission mode. On yes it leaves their account on every machine, with its saved values and sign-in. Blocks until they answer. Returns {name, removed: true, next} | {name, removed: false, declined: true}. Only when the person asked for it. This chat's agent keeps the server's tools until the person presses Refresh chat. GitHub, Linear and Jira are ADE integrations, not servers: link their settings page (ade://settings/integrations.github, .linear, .jira) instead.",
      input: "object { name: string, reason?: string, timeoutMs?: number }",
      example: "ade mcp servers remove stripe --reason \"You asked to disconnect Stripe\"",
    },
    chatStatus: {
      description: "Name the registry servers that are on for one chat but that its running agent did not start with (missing; it loads them after Refresh chat), and the servers it started with that were since removed or turned off (removed; Refresh chat unloads them). Empty when the chat has no running agent.",
      input: "object { chatSessionId: string }",
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
  ai: {
    getProviderContextInventory: {
      description:
        "List what a provider's agent receives when a lane chat starts on this machine: ADE's own prompt pieces (exact), "
        + "the user's and the project's instruction files, memory, skills, agents, plugins and MCP servers (estimated; no config values), "
        + "and the median first-turn context of the last 30 days' chats. Read-only.",
      input: `object { provider: ${providerContextProviderInput}, laneId?: string (defaults to the primary lane) }`,
      example: "ade actions run ai.getProviderContextInventory --input-json '{\"provider\":\"claude\"}' --json",
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
    getModelCatalog: {
      description:
        "List every model this machine can run with its full model registry profile: Intelligence Index and every per-eval score, domain and personality indices, modalities, license, speed, list prices, Coding Agent Index rows and linked speech leaderboard rows, plus the harness and who bills it (plan, metered, free). Registry data is based on Artificial Analysis (artificialanalysis.ai).",
      input: "object { provider?: \"claude\" | \"codex\" | \"opencode\" | \"cursor\" }",
      example: "ade models catalog --text",
    },
    getModelSheet: {
      description:
        "List every model this machine can run, grouped by model family and organized by the kind of task it suits: a 0-1 score per task kind (question, research, review, small_edit, feature, debugging, refactor, writing, vision) at each measured effort, the best effort per kind, speed and cost tiers, billing and harness, how unmatched names were matched, and plain-English notes (summary, strengths, weaknesses, best for, avoid for). Registry data is based on Artificial Analysis (artificialanalysis.ai).",
      input: "object { provider?: \"claude\" | \"codex\" | \"opencode\" | \"cursor\" }",
      example: "ade models sheet --text",
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
    getUsageLimits: {
      description:
        "Read how much of each subscription window is left on this machine, per account: percent left, reset time, pace, "
        + "how old the reading is, whether the account can take a chat, the account id `ade chat create --instance` takes, "
        + "and which account the asking chat runs on. Reads the cached poll; never refreshes.",
      input: "object { provider?: string, chatSessionId?: string }",
      example: "ade usage limits --text",
    },
    getUsageSnapshot: {
      description:
        "Read provider rate-limit windows and spend controls. Account-tied, so it takes no scope.",
      input: "no input",
      example: "ade actions run usage.getUsageSnapshot --text",
    },
  },
  lane: {
    getDependencyStatus: {
      description:
        "Read the lockfiles in this machine's main checkout (npm, pnpm, yarn, bun, CocoaPods, Bundler, Poetry, uv, Pipenv, Composer, Cargo, Go, SwiftPM), "
        + "whether each one is installed and whether it changed after the last install, the one-line update command for this machine, "
        + "and the project's default lane template. Reads only; never installs.",
      input: "object { refresh?: boolean } (refresh skips the 20 s cache)",
      example: "ade lanes deps --text",
    },
    acknowledgeDependencyStatus: {
      description:
        "Mark the current lockfiles as installed for tools ADE cannot watch (tracksInstall: false: bun, Bundler, Python tools). "
        + "Tools with an install record clear by themselves when the install finishes.",
      input: "object { lockfiles?: string[] } (paths relative to the main checkout; omit for all)",
      example: "ade lanes action acknowledgeDependencyStatus --input-json '{\"lockfiles\":[\"Gemfile.lock\"]}'",
    },
    listTemplates: {
      description: "List this machine's lane templates for the project. Templates live in this machine's .ade/local.yaml and never sync; add --machine to read another machine's.",
      input: "none",
      example: "ade lanes templates list --text",
    },
    getTemplate: {
      description: "Read one lane template.",
      input: "object { templateId: string }",
      example: "ade lanes templates show ade-lane --json",
    },
    getDefaultTemplate: {
      description: "Read the id of the template every new lane on this machine runs, or null.",
      input: "none",
      example: "ade lanes templates default --text",
    },
    setDefaultTemplate: {
      description: "Choose the template every new lane on this machine runs. Pass null to stop running one.",
      input: "object { templateId: string | null }",
      example: "ade lanes templates default ade-lane",
    },
    saveTemplate: {
      description:
        "Create or replace a lane template on this machine. Steps run in this order: envFiles, docker, dependencies (each command runs directly, "
        + "without a shell, in its cwd), mountPoints, copyPaths (from the main checkout), setupScript "
        + "(shell commands; injectPrimaryPath sets $PRIMARY_WORKTREE_PATH). Each command may run 20 minutes.",
      input:
        "object { template: { id: string, name: string, description?, envFiles?: [{ source, dest, vars? }], dependencies?: [{ command: string[], cwd? }], "
        + "copyPaths?: [{ source, dest? }], envVars?: Record<string,string>, portRange?: { start, end }, "
        + "setupScript?: { commands?: string[], unixCommands?: string[], windowsCommands?: string[], scriptPath?, unixScriptPath?, windowsScriptPath?, injectPrimaryPath?: boolean } } }",
      example: "ade lanes templates save --json '{\"id\":\"web\",\"name\":\"Web\",\"dependencies\":[{\"command\":[\"npm\",\"install\"],\"cwd\":\"apps/web\"}]}'",
    },
    applyTemplate: {
      description: "Run a template's setup in an existing lane and wait for it to finish (up to 45 minutes). Returns each step's status and error.",
      input: "object { laneId: string, templateId: string }",
      example: "ade lanes templates apply ade-lane --lane <lane> --text",
    },
    deleteTemplate: {
      description: "Delete a lane template on this machine.",
      input: "object { templateId: string }",
      example: "ade lanes templates delete ade-lane",
    },
    initEnv: {
      description: "Run the project's lane environment setup (no template) in a lane and wait for it to finish.",
      input: "object { laneId: string }",
      example: "ade lanes action initEnv --arg laneId=<lane>",
    },
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
      input: "object { launchId: uuid, prompt: string, kind?: \"chat\" | \"cli\" (default chat), mode?: \"foreground\" | \"background\" (default foreground), laneId?: uuid, laneName?, laneConfig?: { mode: \"new\" | \"existing\", start?: { from: \"default\" | \"primary\" | \"branch\", branch? (from branch), on: \"remote\" | \"local\" | \"uncommitted\" } (new; default: the project's new-lane defaults), branchRef? (existing), templateId?, color?, linearIssue? } (default: a new lane with the project's new-lane defaults), title?, displayPrompt?, attachments?, provider?, modelId?, chat?: { create: <chat.createSession args without laneId>, message: <chat.sendMessage args without sessionId> } (required for kind chat) }",
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
      input: "object { provider?: \"claude\" | \"codex\" | \"cursor\" | \"droid\" | \"copilot\" | \"opencode\" }",
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
    listPendingInputs: {
      description: "List the questions and approvals a chat is blocked on right now, with each item id, kind, questions and options. Empty after a restart: the provider request died with the process.",
      input: "object { sessionId: string }",
      example: "ade chat pending chat-123 --text",
    },
    respondToInput: {
      description: "Answer a chat's pending question or approval (an item from listPendingInputs). Unblocks a chat whose sends are refused with \"Answer or decline the pending request\". Cards only the person may answer (screen-control consent) are refused to agents.",
      input: "object { sessionId: string, itemId: string, decision?: \"accept\" | \"accept_for_session\" | \"decline\" | \"cancel\" (default decline: send accept to answer a question), answers?: { [questionId]: string | string[] } (option values or free text; \"selection\" for a model pick), responseText?: string (free answer, or the reason for a decline) }",
      example: "ade chat respond chat-123 --option 2   (or: ade actions run chat.respondToInput --input-json '{\"sessionId\":\"chat-123\",\"itemId\":\"item-1\",\"decision\":\"accept\",\"answers\":{\"q1\":\"staging\"}}')",
    },
    clearAsk: {
      description: "Take back a \"Needs you\" hand this chat raised with `ade chat ask`. Clears only the agent-raised marker: a hand the user raised, the turn-end inference, and a provider question card are left alone. Use it when you asked and then kept working anyway, so the row stops claiming it is blocked on the user.",
      input: "object { sessionId: string }",
      example: "ade chat ask --clear",
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
    getClaudePluginUi: {
      description: "Read what Claude Code mods draw for a chat right now: status lines, the latest toast, the band above the prompt and open panes. User clients only.",
      input: "object { sessionId: string }",
      example: "ade actions run chat.getClaudePluginUi --input-json '{\"sessionId\":\"chat-123\"}' --json",
    },
    actOnClaudePluginUi: {
      description: "Press a button, submit a field, pick an option or close a pane that a Claude Code mod drew. Names the generation and the control from getClaudePluginUi. User clients only.",
      input: "object { sessionId: string, generation: number, kind: \"press\" | \"input\" | \"select\" | \"closePane\", target?: { plugin, handle }, key?, value?, site?: { component: \"AbovePrompt\" } | { component: \"Pane\", paneId }, paneId? }",
      example: "ade actions run chat.actOnClaudePluginUi --input-json '{\"sessionId\":\"chat-123\",\"generation\":1,\"kind\":\"press\",\"target\":{\"plugin\":\"my-mod\",\"handle\":42}}' --json",
    },
    listThreadComments: {
      description: "List a chat's pending thread comments (the user's unsent notes on parts of agent replies). User clients only.",
      input: "object { sessionId: string }",
      example: "ade actions run chat.listThreadComments --input-json '{\"sessionId\":\"chat-123\"}' --json",
    },
    createThreadComment: {
      description: "Pin a pending comment to part of an agent reply. It goes with the user's next send. User clients only.",
      input: "object { sessionId: string, messageKey: string, messageExcerpt: string, anchor: { kind: \"text\", quote, prefix, suffix } | { kind: \"table_row\", tableIndex, rowIndex, headers, cells } | { kind: \"media\", mediaKind: \"image\" | \"video\", source, label, mediaIndex }, body: string }",
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
    resolveSmartLinkImage: {
      description: "Fetch a link preview's og:image (public hosts only, max 256 KiB, bitmap image types) as a data URL; null when unavailable.",
      input: "object { url: string }",
      example: "ade actions run chat.resolveSmartLinkImage --input-json '{\"url\":\"https://example.com/og.png\"}' --json",
    },
    getMcpApp: {
      description: "Read the MCP App a tool call produced: its HTML page, the network origins it declared, and the tool input and result it replays.",
      input: "object { sessionId: string, itemId: string }",
      example: "ade actions run chat.getMcpApp --input-json '{\"sessionId\":\"<chat>\",\"itemId\":\"<tool call id>\"}' --json",
    },
    mcpAppRequest: {
      description: "User clients only. Pass one request from an MCP App's frame (tools/call or resources/read) to the server the app came from, through the chat's live session. A tool not marked read-only asks the user first.",
      input: "object { sessionId: string, itemId: string, method: \"tools/call\" | \"resources/read\", params: object }",
      example: "ade actions run chat.mcpAppRequest --input-json '{\"sessionId\":\"<chat>\",\"itemId\":\"<tool call id>\",\"method\":\"resources/read\",\"params\":{\"uri\":\"ui://server/page.html\"}}' --json",
    },
    listMcpAppGrants: {
      description: "List the tools the user always allows for the MCP server an app came from, in this project.",
      input: "object { sessionId: string, itemId: string }",
      example: "ade actions run chat.listMcpAppGrants --input-json '{\"sessionId\":\"<chat>\",\"itemId\":\"<tool call id>\"}' --json",
    },
    revokeMcpAppGrant: {
      description: "User clients only. Take back one \"always allow\" answer for a tool of the MCP server an app came from.",
      input: "object { sessionId: string, itemId: string, tool: string }",
      example: "ade actions run chat.revokeMcpAppGrant --input-json '{\"sessionId\":\"<chat>\",\"itemId\":\"<tool call id>\",\"tool\":\"add_item\"}' --json",
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
    startSideChat: {
      description:
        "Open a chat's side chat (a read-only fork shown inside the chat, at most one per chat) with a first message, "
        + "or send the message to the side chat it already has.",
      input: "object { sessionId: string, text: string }",
      example: "ade actions run chat.startSideChat --input-json '{\"sessionId\":\"chat-123\",\"text\":\"Why did we pick Redis?\"}' --json",
    },
    endSideChat: {
      description: "End a side chat for good. Pass the side chat's id or its main chat's id; with expectedSideSessionId, it refuses when the main chat has a different side chat now.",
      input: "object { sessionId: string, expectedSideSessionId?: string }",
      example: "ade actions run chat.endSideChat --input-json '{\"sessionId\":\"chat-123\"}' --json",
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
    setParent: {
      description:
        "Point a chat at a new parent chat, or detach it with parentSessionId null. Use it when a move, a deleted parent, "
        + "or a launch left the link wrong; reports go to the new parent from the next turn. spawnKind defaults to the "
        + "chat's current kind, or subagent when its old parent is gone. A chat-bound agent may change its own chat's "
        + "parent, adopt a chat whose parent is gone (or that has none), or release a chat that reports to it.",
      input: "object { sessionId: string, parentSessionId: string | null, spawnKind?: \"subagent\" | \"peer\" }",
      example: "ade actions run chat.setParent --input-json '{\"sessionId\":\"chat-123\",\"parentSessionId\":\"chat-456\"}' --text",
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
  android_emulator: {
    getSdkSetupPlan: {
      description: "Read what an Android SDK install would add on this machine: each part with its size, the licences, the free disk and acceleration. Reads Google's repository.",
      input: "object { sdkRoot?: string, includeAndroidCli?: boolean }",
      example: "ade android sdk status --json",
    },
    installSdk: {
      description: "Start the guided Android SDK install. User-only: the ADE desktop app sends it (the setup card, or Settings › Android devices); an agent and a terminal are refused. Every licence the install needs must be named in acceptedLicenseIds; surface names where the user accepted them. Progress arrives as android.sdk.install events.",
      input: "object { acceptedLicenseIds: string[], sdkRoot?: string, includeAndroidCli?: boolean, surface?: \"setup-card\" | \"settings\" }",
      example: "Desktop app only: the setup card, or Settings › Android devices. A terminal is refused.",
    },
    cancelSdkInstall: {
      description: "Stop the running Android SDK install. Finished parts stay; the partial download is kept for the next install. User-only: the ADE desktop app sends it.",
      input: "object {}",
      example: "Desktop app only: the setup card's Cancel. A terminal is refused.",
    },
    getSdkInstallState: {
      description: "Read the Android SDK install's state: idle, running (part, step, bytes, time left), done, failed or cancelled.",
      input: "object {}",
      example: "ade actions run android_emulator.getSdkInstallState --json",
    },
    setSdkPath: {
      description: "Use an Android SDK that is already on this machine (\"Use mine…\"), or null to go back to detection. User-only: the ADE desktop app sends it.",
      input: "object { path: string | null }",
      example: "Desktop app only: \"Use mine…\" on the setup card. A terminal is refused.",
    },
    // P3 system images (`androidSystemImages.ts`).
    listSystemImages: {
      description: "List this machine's Android system images: each installed one with its size on disk and the AVDs that boot from it, then the phone images Google publishes for this host ABI with their download size and licence. includeAvailable false skips Google's repository.",
      input: "object { laneId?: string, includeAvailable?: boolean }",
      example: "ade android sdk images --json",
    },
    installSystemImage: {
      description: "Download and install one system image on the guided install's job (one install per machine; progress as android.sdk.install events; cancelSdkInstall stops it). User-only: the ADE desktop app sends it from the device picker's System images; an agent and a terminal are refused. The image's licence must be named in acceptedLicenseIds.",
      input: "object { id: string, acceptedLicenseIds: string[], laneId?: string }",
      example: "Desktop app only: the device picker's System images. A terminal is refused.",
    },
    removeSystemImage: {
      description: "Delete one installed system image folder. Refused while an AVD that boots from it runs; when AVDs use it, confirmedInUse must be true (their files stay, but they cannot start). User-only: the ADE desktop app sends it.",
      input: "object { id: string, confirmedInUse?: boolean, laneId?: string }",
      example: "Desktop app only: the device picker's System images. A terminal is refused.",
    },
    getStatus: {
      description:
        "Read whether this host can run the Android emulator: the SDK and its tools, hardware acceleration, and (with laneId) the lane's emulator and its state.",
      input: "object { laneId?: string }",
      example: "ade android status --json",
    },
    listDevices: {
      description: "List this machine's AVDs (with the lane holding each), the hardware profiles a new AVD can use, and the installed system images.",
      input: "object { laneId?: string }",
      example: "ade android devices --json",
    },
    createDevice: {
      description:
        "Make a new AVD for the lane from a hardware profile and hold it. Boots it unless start is false. systemImage defaults to the newest installed image for the host ABI. "
        + "extra true makes it one of the lane's extra devices beside its own (at most 2 by default, ANDROID_EXTRA_DEVICE_LIMIT past that): the lane keeps its device, and the extra is reached with device on start, stop, releaseDevice, installApp and launchApp.",
      input: "object { laneId: string, profileId: string, catalogId?: string, colorId?: string, systemImage?: string, displayName?: string, start?: boolean, extra?: boolean }",
      example: "ade android device-create --catalog pixel-10 --extra --json",
    },
    attachDevice: {
      description: "Hold an existing AVD (one no other lane holds) for the lane. Boots it unless start is false.",
      input: "object { laneId: string, avdName: string, start?: boolean }",
      example: "ade android device-attach --avd Pixel_9_API_36 --json",
    },
    start: {
      description: "Boot the lane's AVD and wait until Android reports boot completed. No-op when it is already booted. "
        + "Refused with ANDROID_LOW_MEMORY when the machine is under memory pressure, swapping, or its emulators would pass half of its memory; force boots anyway. "
        + "When adb refuses the device (ANDROID_ADB_UNAUTHORIZED), ADE restarts the adb server itself if no other device uses it; restartAdb restarts it even then, "
        + "and only the person may ask for that (an agent's restartAdb is dropped): an agent asks the person to press \"Restart adb and start\" in the Android pane, or to run ade android start --restart-adb in their own terminal. "
        + "device names one of the lane's extra devices to boot beside the lane's device instead (the same memory guard).",
      input: "object { laneId: string, force?: boolean, restartAdb?: boolean, device?: string }",
      example: "ade android start --json",
    },
    stop: {
      description: "Stop the lane's emulator, if ADE started it. The lane keeps its AVD. device names one of the lane's extra devices to stop instead.",
      input: "object { laneId: string, device?: string }",
      example: "ade android stop --json",
    },
    setKeepRunning: {
      description: "Pin the lane's running emulator (\"Keep running\") so ADE does not stop it after 20 minutes unused, or unpin it. Answers the lane's device status.",
      input: "object { laneId: string, keepRunning: boolean }",
      example: "ade android keep-running on --json",
    },
    releaseDevice: {
      description:
        "Stop the lane's emulator and let the AVD go. An AVD ADE made for the lane is deleted unless deleteCreated is false; the user's own AVD is never deleted. "
        + "device names one of the lane's extra devices: that one goes, and the lane keeps its own device. Without device, the extras stay.",
      input: "object { laneId: string, deleteCreated?: boolean, device?: string }",
      example: "ade android device-detach --json",
    },
    devicePromote: {
      description:
        "Make one of the lane's extra devices the lane's own device (the one that streams, records, runs tests and takes installs by default). "
        + "The old device is kept: one ADE made becomes an extra (its emulator keeps running), the user's own AVD is released to them. "
        + "Refused with ANDROID_LANE_DEVICE_BUSY while the old device starts or stops, streams to a viewer, records, runs tests, installs or launches an app, or another holder has the lane's lease.",
      input: "object { laneId: string, device: string }",
      example: "ade android device-promote --device ade_1234abcd_pixel_10 --json",
    },
    getStreamStatus: {
      description: "Read the lane's live-view stream: running, backend and frame rate. The transport (URL and token) is always null here.",
      input: "object { laneId: string }",
      example: "ade actions run android_emulator.getStreamStatus --input-json '{\"laneId\":\"lane-1\"}' --json",
    },
    tap: {
      description: "Tap one point on the lane's emulator, in device pixels (the screenshot's pixels). An agent's input starts an automatic recording when none runs (noRecord: true for this call only; so do every input action's).",
      input: "object { laneId: string, x: number, y: number, noRecord?: boolean }",
      example: "ade android tap 540 1200 --json",
    },
    swipe: {
      description: "Swipe from one point to another on the lane's emulator, in device pixels.",
      input: "object { laneId: string, fromX: number, fromY: number, toX: number, toY: number, durationMs?: number, noRecord?: boolean }",
      example: "ade android swipe 540 1800 540 600 --duration-ms 300 --json",
    },
    sendKey: {
      description: "Press a hardware or navigation key on the lane's emulator.",
      input: "object { laneId: string, key: \"back\" | \"home\" | \"recents\" | \"power\" | \"volume_up\" | \"volume_down\" }",
      example: "ade android button back --json",
    },
    rotate: {
      description: "Lock the lane's emulator screen to an orientation, with ade apple rotate's names (landscape is landscape-right: the device turned a quarter to the left). Apps that fix their orientation, such as the home screen, keep it.",
      input: "object { laneId: string, orientation: \"portrait\" | \"portrait-upside-down\" | \"landscape-left\" | \"landscape-right\" | \"landscape\" }",
      example: "ade android rotate portrait-upside-down --json",
    },
    sendText: {
      description: "Type text into the focused field on the lane's emulator. submit true presses Enter after it (with no text, Enter alone), as ade apple type --submit.",
      input: "object { laneId: string, text: string, submit?: boolean, noRecord?: boolean }",
      example: "ade android type \"hello\" --submit --json",
    },
    // Parity (`androidEmulatorControl.ts`).
    pressKey: {
      description: "Press one real key on the lane's emulator, with modifiers held around it: Enter, Tab, Delete, Escape, arrows, Home/End (line start and end), Page up/down, Space, F1-F12, or one letter or digit. key may be a combo (ctrl+a). Goes through the live view when one runs, else adb (a combo over adb needs Android 12 or later).",
      input: "object { laneId: string, key: string, modifiers?: Array<\"shift\" | \"ctrl\" | \"alt\" | \"meta\" | \"cmd\">, noRecord?: boolean }",
      example: "ade android key a --ctrl --json",
    },
    relaunchApp: {
      description: "Force-stop an app and start it again (its launcher activity, or the named one), with new launch arguments and intent extras when given.",
      input: "object { laneId: string, packageName: string, activity?: string, arguments?: string[], extras?: Array<{ key: string, type: \"string\" | \"int\" | \"long\" | \"float\" | \"bool\", value: string }> }",
      example: "ade android relaunch --package com.example.app --extra debug=true --json",
    },
    getAppState: {
      description: "Read an app's state on the lane's emulator: installed, running, in front, its pid and version.",
      input: "object { laneId: string, packageName: string }",
      example: "ade android app-state --package com.android.settings --json",
    },
    getForegroundApp: {
      description: "Read the app in front of the lane's emulator (null on the home screen). waitMs (up to 30000) keeps asking until an app is in front; with packageName, until that app is, and a wait that runs out refuses with ANDROID_WAIT_TIMEOUT.",
      input: "object { laneId: string, waitMs?: number, packageName?: string }",
      example: "ade android foreground --package com.android.chrome --wait 10 --json",
    },
    frame: {
      description: "Write one PNG of the lane's emulator screen now, on the machine that runs it. Never filed as proof (screenshot files proof). outPath must be inside the lane's worktree; omitted = a file under the ADE data folder.",
      input: "object { laneId: string, outPath?: string }",
      example: "ade android frame --json",
    },
    inspectPoint: {
      description: "Read the element under a point (device pixels) as the chat composer's context packet: resource id, class, text, bounds, nearby elements, and the source file and line when ADE finds the element's id, testTag or text in the lane's worktree. includeScreenshot adds a PNG crop of the element. ref aims at one element instead.",
      input: "object { laneId: string, x: number, y: number, ref?: string, includeScreenshot?: boolean }",
      example: "ade android inspect 540 1200 --json",
    },
    selectPoint: {
      description: "Pick the element under a point, as the person's Inspect does: the same packet as inspectPoint, always with the crop; with no element under it, the point itself.",
      input: "object { laneId: string, x: number, y: number, ref?: string, noRecord?: boolean }",
      example: "ade android select 540 1200 --json",
    },
    deviceCleanup: {
      description: "Run the Android device cleanup pass now: release the devices of lanes that ended, stop emulators ADE started that no lane holds, forget lane rows whose AVD is gone, and list ADE AVDs no lane holds (never deleted). powerOffIdle also stops idle ADE emulators now (an agent: its own lane's only). dryRun reports and changes nothing.",
      input: "object { laneId?: string, powerOffIdle?: boolean, dryRun?: boolean }",
      example: "ade android device-cleanup --dry-run --json",
    },
    screenshot: {
      description: "Write a PNG of the lane's emulator screen, on the machine that runs it, and file it in the calling chat's proof drawer (proof false skips that). outPath defaults to a file under the ADE data folder.",
      input: "object { laneId: string, outPath?: string, caption?: string, proof?: boolean }",
      example: "ade android screenshot --out /tmp/screen.png --json",
    },
    // P1 agent suite (`androidAgentSuite.ts`).
    listApps: {
      description: "List the apps installed on the lane's emulator (not the system ones), with each launcher activity and whether ADE installed it.",
      input: "object { laneId: string }",
      example: "ade android apps --json",
    },
    installApp: {
      description: "Install an app on the lane's emulator: an APK inside the lane's folder, or the project's Gradle build (gradlew :<module>:install<Variant>, module app and variant debug by default). ADE remembers the package, so a lane release can remove it. device names one of the lane's extra devices to install on instead (booted first when off).",
      input: "object { laneId: string, apkPath?: string, gradle?: { module?: string, variant?: string }, device?: string }",
      example: "ade android install --gradle --module app --variant debug --json",
    },
    runInstrumentationTests: {
      description: "Run the lane app's instrumentation tests on the lane's emulator (gradlew :<module>:connected<Variant>AndroidTest, module app and variant debug by default), one class or one method when asked. Answers with the counts and each failure, from the JUnit XML (or Gradle's output). Refused when the emulator is not booted.",
      input: "object { laneId: string, gradle?: { module?: string, variant?: string }, className?: string, method?: string }",
      example: "ade android test --class com.example.LoginTest --json",
    },
    launchApp: {
      description: "Start an app's launcher activity (or the named one) and wait for it to draw. With apkPath or gradle it installs first. device names one of the lane's extra devices to install and start on (booted first when off, through the RAM guard).",
      input: "object { laneId: string, packageName?: string, activity?: string, apkPath?: string, gradle?: { module?, variant? }, device?: string, arguments?: string[], extras?: Array<{ key, type: \"string\" | \"int\" | \"long\" | \"float\" | \"bool\", value }> }",
      example: "ade android launch --package com.example.app --json",
    },
    terminateApp: {
      description: "Force-stop an app on the lane's emulator.",
      input: "object { laneId: string, packageName: string }",
      example: "ade android terminate --package com.example.app --json",
    },
    uninstallApp: {
      description: "Remove an app from the lane's emulator. On an AVD the lane attached (the user's own), only a package ADE installed there.",
      input: "object { laneId: string, packageName: string }",
      example: "ade android uninstall --package com.example.app --json",
    },
    openUrl: {
      description: "Open a URL (https or an app's own scheme) on the lane's emulator.",
      input: "object { laneId: string, url: string }",
      example: "ade android open-url https://example.com --json",
    },
    longPress: {
      description: "Hold one point on the lane's emulator (context menus), in device pixels. durationMs is 100 to 5000, 1000 by default.",
      input: "object { laneId: string, x: number, y: number, durationMs?: number }",
      example: "ade android long-press 540 1200 --duration-ms 1000 --json",
    },
    drag: {
      description: "Hold a point, then move to another (a list reorder, a slider). swipe is the quick stroke.",
      input: "object { laneId: string, fromX: number, fromY: number, toX: number, toY: number, durationMs?: number }",
      example: "ade android drag 540 1800 540 600 --json",
    },
    scroll: {
      description: "Scroll the lane's emulator: down shows what is below. amount is in device pixels (60% of the screen by default); the anchor is the screen centre unless given.",
      input: "object { laneId: string, direction: \"up\" | \"down\" | \"left\" | \"right\", amount?: number, anchorX?: number, anchorY?: number }",
      example: "ade android scroll --direction down --json",
    },
    getScreenSnapshot: {
      description: "Read the lane's emulator screen as named elements (ref, id, label, text, role, bounds, centre). Kept for a few seconds while nothing changes; fresh reads it again.",
      input: "object { laneId: string, fresh?: boolean }",
      example: "ade android snapshot --json",
    },
    findElement: {
      description: "Find one element on the lane's emulator screen.",
      input: "object { laneId: string, query: { ref?, identifier?, label?, text?, role?, index? } }",
      example: "ade android find-element --label \"Sign in\" --json",
    },
    tapElement: {
      description: "Find one element and tap its centre. holdMs makes it a long press.",
      input: "object { laneId: string, query: { ref?, identifier?, label?, text?, role?, index? }, holdMs?: number }",
      example: "ade android tap-element --text Continue --json",
    },
    fillElement: {
      description: "Find a text field, tap it, replace its text, and read it back (typed: verified, not-seen or unknown).",
      input: "object { laneId: string, query: { ref?, identifier?, label?, text?, role?, index? }, text: string, focusFirst?: boolean }",
      example: "ade android fill-element --identifier email --value me@example.com --json",
    },
    waitForElement: {
      description: "Wait until an element is on screen (or gone). timeoutMs is up to 120000, 10000 by default.",
      input: "object { laneId: string, query: { ref?, identifier?, label?, text?, role?, index? }, timeoutMs?: number, state?: \"visible\" | \"gone\" }",
      example: "ade android wait-for-element --text Welcome --timeout-ms 20000 --json",
    },
    assertVisible: {
      description: "Refuse (ANDROID_ELEMENT_NOT_FOUND) unless the element is on screen now.",
      input: "object { laneId: string, query: { ref?, identifier?, label?, text?, role?, index? } }",
      example: "ade android assert-visible --text \"Hello\" --json",
    },
    readLog: {
      description: "Read the lane's emulator log (logcat) once: an app's lines (its processes, or its uid when it died), at a level and up, after a cursor. Answers a cursor for the next read.",
      input: "object { laneId: string, packageName?: string, level?: \"verbose\" | \"debug\" | \"info\" | \"warn\" | \"error\" | \"fatal\", since?: string, lines?: number }",
      example: "ade android log --package com.example.app --level warn --lines 100 --json",
    },
    recordStart: {
      description: "Record the lane's emulator screen from its live stream, up to maxSeconds (300 at most). At the stop it becomes a demo (still time cut, tap rings, typed-text badges, step captions, under 10 MB); plain keeps it as recorded; zoom zooms in on each tap. A start while an automatic recording runs converts it to manual.",
      input: "object { laneId: string, chatSessionId?: string, label?: string, maxSeconds?: number, plain?: boolean, zoom?: boolean }",
      example: "ade android record-start --label \"Sign-in flow\" --json",
    },
    recordStop: {
      description: "Stop the lane's recording, make its demo, and file the one video in the calling chat's proof drawer (proof false keeps it a file; discard drops it; keep wins over discard).",
      input: "object { laneId: string, chatSessionId?: string, discard?: boolean, keep?: boolean, proof?: boolean }",
      example: "ade android record-stop --json",
    },
    getAutoRecord: {
      description: "Read whether an agent's input on this lane starts an automatic recording: the lane's switch, the machine's \"Record agent input\" preference, and both together.",
      input: "object { laneId: string }",
      example: "ade android auto-record status --json",
    },
    setAutoRecord: {
      description: "Turn this lane's auto-record on or off (kept in the project). Off: an agent's input starts no recording; one already running still runs.",
      input: "object { laneId: string, enabled: boolean }",
      example: "ade android auto-record off --json",
    },
    getMachinePreferences: {
      description: "Read this machine's Android preferences (tapRings, keyBadges, autoRecordAgentInput, recordingsWarnBytes, remoteBitrateKbpsCap) and the bytes of this project's Android recordings here.",
      input: "object {}",
      example: "ade actions run android_emulator.getMachinePreferences --json",
    },
    setMachinePreferences: {
      description: "Change some of this machine's Android preferences; the others stay. Numbers are clamped (bitrate 100-20000 kbit/s, warning 1-100 GiB). User-only: Settings › Android devices sends it. Emits android.preferences.changed.",
      input: "object { tapRings?: boolean, keyBadges?: boolean, autoRecordAgentInput?: boolean, recordingsWarnBytes?: number, remoteBitrateKbpsCap?: number }",
      example: "Desktop app only: Settings › Android devices. A terminal is refused.",
    },
    recordList: {
      description: "List the lane's recordings, the running one first.",
      input: "object { laneId: string }",
      example: "ade android record-list --json",
    },
    recordDelete: {
      description: "Delete one of the lane's finished recordings (its files; proof already filed stays).",
      input: "object { laneId: string, id: string }",
      example: "ade android record-delete --id <id> --json",
    },
    deviceLease: {
      description: "Take turns on the lane's emulator with the other agents of the lane (advisory). Waits up to waitMs; a token renews or releases the turn.",
      input: "object { laneId: string, holder?: string, ttlMs?: number, waitMs?: number, token?: string, distinct?: boolean }",
      example: "ade android lease --wait 60000 --json",
    },
    deviceLeaseRelease: {
      description: "Give the lane's emulator to the next in line.",
      input: "object { laneId: string, token: string }",
      example: "ade android lease release --token <t> --json",
    },
    deviceLeaseStatus: {
      description: "Read who has the lane's emulator and how many wait.",
      input: "object { laneId: string }",
      example: "ade android lease status --json",
    },
    setLocation: {
      description: "Set the emulator's GPS position.",
      input: "object { laneId: string, latitude: number, longitude: number }",
      example: "ade android location 51.5072 -0.1276 --json",
    },
    setAppearance: {
      description: "Turn the emulator's dark theme on or off.",
      input: "object { laneId: string, appearance: \"light\" | \"dark\" }",
      example: "ade android appearance dark --json",
    },
    getPosture: {
      description: "Read the hinge of a foldable emulator: the angle, the fold state (closed, half-open, open) and the size of the screen in front. supported is false on a device with no hinge.",
      input: "object { laneId: string }",
      example: "ade android posture --json",
    },
    setPosture: {
      description: "Fold a foldable emulator: move its hinge to an angle (0 shut to 180 flat) or a pose, and wait until Android shows the screen that goes with it (the cover screen when shut).",
      input: "object { laneId: string, angle?: number, pose?: \"open\" | \"half\" | \"closed\" }",
      example: "ade android fold half --json",
    },
    listComposePreviews: {
      description: "List the Jetpack Compose @Preview functions of a Gradle module in the lane (module app by default), through Google's Android CLI. Needs no emulator. all adds the previews of the modules it depends on.",
      input: "object { laneId: string, module?: string, all?: boolean }",
      example: "ade android preview list --module app --json",
    },
    renderComposePreviews: {
      description: "Render Jetpack Compose @Preview functions of a Gradle module in the lane to PNG, with no emulator (Google's Android CLI and layoutlib). Every preview of the module (up to 24) when fqns is empty. Each image is filed as proof in the calling chat unless proof is false; inline adds each PNG as a data: URL.",
      input: "object { laneId: string, module?: string, fqns?: string[], chatSessionId?: string, proof?: boolean, inline?: boolean }",
      example: "ade android preview --module app --fqn com.example.ui.GreetingKt.GreetingPreview --json",
    },
    setPermission: {
      description: "Grant or revoke a runtime permission of an app (camera, or android.permission.CAMERA).",
      input: "object { laneId: string, action: \"grant\" | \"revoke\", packageName: string, permission: string }",
      example: "ade android permission grant camera --package com.example.app --json",
    },
    getDeviceSettings: {
      description: "Read the emulator's text and display size, developer switches, accessibility switches, status bar override, battery, radios, the last location ADE set, the display's orientation and the app in front. fields foreground reads only the app in front; orientation only the display's turn.",
      input: "object { laneId: string, fields?: \"all\" | \"foreground\" | \"orientation\" }",
      example: "ade actions run android_emulator.getDeviceSettings --input-json '{\"laneId\":\"<lane>\"}'",
    },
    setDeviceSetting: {
      description: "Change one emulator setting (text or display size, animations, show taps, layout bounds, battery, Wi-Fi, mobile data, airplane mode, or an accessibility switch) and read the settings back.",
      input: "object { laneId: string, setting: { kind: \"text-size\", value: \"small\" | \"default\" | \"large\" | \"largest\" } | { kind: \"display-size\", value: \"small\" | \"default\" | \"large\" | \"larger\" } | { kind: \"animations\", off: boolean } | { kind: \"show-taps\" | \"layout-bounds\" | \"wifi\" | \"mobile-data\" | \"airplane\", on: boolean } | { kind: \"battery\", level?: 0-100, charging?: boolean } | { kind: \"accessibility\", option: \"increase-contrast\" | \"bold-text\" | \"invert-colors\" | \"grayscale\" | \"color-correction\" | \"talkback\", on: boolean } }",
      example: "ade actions run android_emulator.setDeviceSetting --input-json '{\"laneId\":\"<lane>\",\"setting\":{\"kind\":\"airplane\",\"on\":true}}'",
    },
    setStatusBar: {
      description: "Override the emulator's status bar for screenshots (SystemUI demo mode): the time (9:41 by default), Wi-Fi or a mobile network with its bars, the battery, no notification icons. Read back as statusBarOverridden in getDeviceSettings.",
      input: "object { laneId: string, time?: \"H:MM\", dataNetwork?: \"wifi\" | \"5g\" | \"lte\" | \"4g\" | \"3g\" | \"e\" | \"g\", wifiBars?: 0-4, cellularBars?: 0-4, batteryLevel?: 0-100, batteryState?: \"charging\" | \"charged\" | \"discharging\" }",
      example: "ade android status-bar --time 9:41 --json",
    },
    clearStatusBar: {
      description: "End the emulator's status bar override (SystemUI demo mode off).",
      input: "object { laneId: string }",
      example: "ade android status-bar --clear --json",
    },
    clearLocation: {
      description: "Clear the location ADE set: the emulator has no 'no location', so its GPS goes back to the point a cold boot uses (37.4219983, -122.084).",
      input: "object { laneId: string }",
      example: "ade android location --clear --json",
    },
    storeScreenshots: {
      description: "Google Play screenshots of the lane's emulator, filed as proof: on a foldable, the cover screen shut (phone slot) and the inner screen open (large-screen slot), with the hinge put back after; on any other device, its one screen. Each PNG is 9:16 or 16:9 with no alpha, short side 1080 px or more, long side 3840 px or less, the screen centred on black.",
      input: "object { laneId: string, chatSessionId?: string, proof?: boolean }",
      example: "ade android play-store-shots --json",
    },
    windowLayout: {
      description: "Lay out the windows of a large emulator screen (a tablet, or a foldable open), as ade apple window: status lists the app windows; split puts packageName beside withPackage (or the app in front); left, right, top, bottom put an app on that side of a split screen; swap changes the sides over; freeform opens an app in a free window; size and move change a free window; fill makes it full screen; close removes it. applied is false, with a reason, when the window did not end where asked.",
      input: "object { laneId: string, action?: \"status\" | \"split\" | \"left\" | \"right\" | \"top\" | \"bottom\" | \"swap\" | \"freeform\" | \"size\" | \"move\" | \"fill\" | \"close\", packageName?: string, withPackage?: string, width?: number, height?: number, x?: number, y?: number }",
      example: "ade android window split --package com.android.settings --with com.android.chrome --json",
    },
    requestRender: {
      description: "Ask a desktop window that shows the lane's Android device in 3D to draw stills (and, when asked, a turntable video and a contact sheet), and file them as proof in the calling chat's drawer. Fails when no window shows the device.",
      input: "object { laneId: string, request: { angles: (\"front\" | \"three-quarter-left\" | \"three-quarter-right\" | \"back\" | \"current\")[], background: \"transparent\" | \"studio\" | \"dusk\", shadow: boolean, video: boolean, contactSheet?: boolean }, proof?: boolean }",
      example: "ade android render --angles front,back --lighting studio --sheet --json",
    },
    captureProofBundle: {
      description: "Write a proof bundle (screen.png, elements.json, logcat.txt, meta.json) and file the screenshot in the calling chat's proof drawer.",
      input: "object { laneId: string, outDir?: string, caption?: string, includeElements?: boolean, logLines?: number, packageName?: string, proof?: boolean }",
      example: "ade android proof-bundle --caption \"After sign-in\" --json",
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
        "List this machine's provider accounts (Claude and Codex only). Each entry is an id plus the config directory "
        + "that holds that login, never a credential; `label` is the signed-in email, else the id.",
      input: "object { provider?: \"claude\" | \"codex\" }",
      example: "ade actions run provider_instances.list --input-json '{\"provider\":\"claude\"}' --text",
    },
    create: {
      description:
        "Create an empty provider account: a new config directory with the next free id (`claude-2`, …). Accounts have no "
        + "names; one shows as its email once signed in. Returns the account and the exact login command (argv + env var) "
        + "a terminal must run so the provider CLI signs in to THIS directory. A `label` from an older client only shapes the id.",
      input: "object { provider: \"claude\" | \"codex\", label?: string, accentColor?: string }",
      example: "ade actions run provider_instances.create --input-json '{\"provider\":\"claude\"}' --text",
    },
    remove: {
      description:
        "Forget a provider account, signing it out first (the provider CLI's own logout) so adding it again starts "
        + "from a fresh sign-in. The config home directory is never deleted and is returned; `signOutError` says when "
        + "the sign-out failed and the login is still there. The machine's own login and the current default cannot be removed.",
      input: "object { id: string }",
      example: "ade actions run provider_instances.remove --input-json '{\"id\":\"work\"}' --text",
    },
    signOut: {
      description:
        "Sign one provider account out with the provider CLI's own logout in its config home, keeping the account. "
        + "Refused for the current default. On the machine's own login this also signs out the terminal's CLI.",
      input: "object { id: string }",
      example: "ade actions run provider_instances.signOut --input-json '{\"id\":\"work\"}' --text",
    },
    rename: {
      description: "Kept for older phones only. Accounts have no names: the stored label is not shown anywhere.",
      input: "object { id: string, label: string }",
      example: "ade actions run provider_instances.rename --input-json '{\"id\":\"claude-2\",\"label\":\"x\"}' --text",
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
      description:
        "Patch the per-provider account settings. Omitted fields keep their current value. compaction, "
        + "mainPromptCacheTtl, subagentPromptCacheTtl and onExtraUsage belong to one account and need instanceId; "
        + "null clears them. mainPromptCacheTtl, subagentPromptCacheTtl and onExtraUsage are Claude only.",
      input: "object { provider: \"claude\" | \"codex\", instanceId?: string, settings: { smartBalance?: boolean, "
        + "autoStartWindows?: boolean, compaction?: object | null, mainPromptCacheTtl?: \"5m\" | \"1h\" | null, "
        + "subagentPromptCacheTtl?: \"1h\" | null, "
        + "onExtraUsage?: \"stop\" | null } }",
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
