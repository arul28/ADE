import { describe, expect, it } from "vitest";
import { getAdeActionInputContract } from "./actionInputContracts";
import {
  ADE_ACTION_ALLOWLIST,
  ADE_ACTION_CTO_ONLY,
  isAllowedAdeAction,
  isAutomationAllowedAdeAction,
  isCtoOnlyAdeAction,
  listAllowedAdeActionNames,
} from "./actionPolicy";
import type { AdeActionDomain } from "./domains";

/**
 * The gate, tested over the tables alone.
 *
 * Deliberately loads nothing but `actionPolicy` and its two pure siblings: a
 * question about who may call what is answered by two tables and four
 * predicates, and a test that has to stand up the registry's whole service
 * graph to ask it would be measuring the wiring instead of the policy.
 */

describe("isAllowedAdeAction", () => {
  it("accepts a canonical action from the allowlist", () => {
    expect(isAllowedAdeAction("git", "commit")).toBe(true);
    expect(isAllowedAdeAction("lane", "create")).toBe(true);
    expect(isAllowedAdeAction("automations", "triggerManually")).toBe(true);
    expect(isAllowedAdeAction("issue", "addComment")).toBe(true);
  });

  it("exposes the session-scoped Linear link lane actions for CLI/automation reach", () => {
    expect(isAllowedAdeAction("lane", "attachLinearIssueToSession")).toBe(true);
    expect(isAllowedAdeAction("lane", "detachLinearIssueFromSession")).toBe(true);
    expect(isAllowedAdeAction("lane", "listLinearIssuesForSession")).toBe(true);
    expect(isAllowedAdeAction("lane", "listLinearIssuesForLaneSessions")).toBe(true);
    expect(isAllowedAdeAction("lane", "unlinkLinearIssues")).toBe(true);
  });

  it("exposes the Linear issue tracker write actions for the CLI daemon bridge", () => {
    // CLI agents have no Linear creds; they write back through the daemon
    // bridge, so these must be agent-reachable (not CTO-gated).
    expect(isAllowedAdeAction("linear_issue_tracker", "updateIssueState")).toBe(true);
    expect(isAllowedAdeAction("linear_issue_tracker", "createComment")).toBe(true);
    expect(isAllowedAdeAction("linear_issue_tracker", "updateIssueAssignee")).toBe(true);
    expect(isAllowedAdeAction("linear_issue_tracker", "addLabel")).toBe(true);
    expect(isCtoOnlyAdeAction("linear_issue_tracker", "updateIssueState")).toBe(false);
    expect(isCtoOnlyAdeAction("linear_issue_tracker", "addLabel")).toBe(false);
  });

  it("exposes CLI agent launch through the chat runtime action surface", () => {
    expect(isAllowedAdeAction("chat", "launchCli")).toBe(true);
    expect(isCtoOnlyAdeAction("chat", "launchCli")).toBe(false);
  });

  it("exposes caller lifecycle writes through the runtime session surface", () => {
    expect(isAllowedAdeAction("session", "requestSessionAttention")).toBe(true);
    expect(isAllowedAdeAction("session", "setSessionStatusNote")).toBe(true);
    expect(isAllowedAdeAction("session", "settleSession")).toBe(true);
    // The residue read path. It was added to the CTO-only list but NOT to the
    // allowlist, which silently refused every call — and left the settle design
    // claiming a user-visible guarantee ("settled never quietly means something
    // is still running") that nothing could actually reach.
    expect(isAllowedAdeAction("session", "getSettleResidue")).toBe(true);
    expect(isAllowedAdeAction("session", "unsettleSession")).toBe(true);
    expect(isCtoOnlyAdeAction("session", "settleSession")).toBe(true);
    expect(isCtoOnlyAdeAction("session", "unsettleSession")).toBe(true);
    expect(isCtoOnlyAdeAction("session", "settleSessions")).toBe(true);
    expect(isCtoOnlyAdeAction("session", "unsettleSessions")).toBe(true);
    expect(isCtoOnlyAdeAction("session", "updateLifecycleSettings")).toBe(true);
    expect(isAutomationAllowedAdeAction("session", "settleSession")).toBe(false);
    expect(isAutomationAllowedAdeAction("session", "updateLifecycleSettings")).toBe(false);
  });

  // Regression guard for the 2026-07 removal of agent self-settlement: "is this
  // work done" is a subjective call agents are unreliable at, so no settle
  // writer may be reachable by a session-bound agent (role `agent`) or an
  // automation. Only cto-role human surfaces and the deterministic PR-merge
  // policy settle rows.
  it("gives agents no way to settle or unsettle a session", () => {
    expect(isAllowedAdeAction("session", "settleSelfSession")).toBe(false);
    expect(isAllowedAdeAction("session", "unsettleSelfSession")).toBe(false);
    for (const action of [
      "settleSession",
      "unsettleSession",
      "settleSessions",
      "unsettleSessions",
      "setSettleOverride",
    ]) {
      expect(isCtoOnlyAdeAction("session", action)).toBe(true);
      expect(isAutomationAllowedAdeAction("session", action)).toBe(false);
    }
  });

  it("exposes snooze/wake/settle-override and lane branch drift to generic actions", () => {
    expect(isAllowedAdeAction("session", "snoozeSession")).toBe(true);
    expect(isAllowedAdeAction("session", "snoozeSessions")).toBe(true);
    expect(isAllowedAdeAction("session", "wakeSession")).toBe(true);
    expect(isAllowedAdeAction("session", "wakeSessions")).toBe(true);
    expect(isAllowedAdeAction("session", "setSettleOverride")).toBe(true);
    expect(isAllowedAdeAction("session", "clearWokeMarker")).toBe(true);
    expect(isAllowedAdeAction("lane", "getBranchDrift")).toBe(true);
    expect(isAllowedAdeAction("lane", "resolveBranchDrift")).toBe(true);
    expect(isCtoOnlyAdeAction("session", "snoozeSession")).toBe(false);
    expect(isCtoOnlyAdeAction("lane", "resolveBranchDrift")).toBe(false);
  });

  it("exposes iOS Preview Lab matching and workspace readiness to generic actions", () => {
    expect(isAllowedAdeAction("ios_simulator", "resolvePreviewMatch")).toBe(true);
    expect(isAllowedAdeAction("ios_simulator", "ensurePreviewWorkspace")).toBe(true);
    expect(isAllowedAdeAction("ios_simulator", "renderCurrentPreview")).toBe(true);
    expect(isCtoOnlyAdeAction("ios_simulator", "resolvePreviewMatch")).toBe(false);
    expect(isCtoOnlyAdeAction("ios_simulator", "ensurePreviewWorkspace")).toBe(false);
    expect(isCtoOnlyAdeAction("ios_simulator", "renderCurrentPreview")).toBe(false);
  });

  it("exposes subagent transcript reads through the chat runtime action surface", () => {
    expect(isAllowedAdeAction("chat", "getMainTranscript")).toBe(true);
    expect(isAllowedAdeAction("chat", "getSubagentTranscript")).toBe(true);
    expect(isAllowedAdeAction("chat", "readTranscript")).toBe(true);
    expect(isAllowedAdeAction("chat", "readTranscriptPage")).toBe(true);
    expect(isAllowedAdeAction("chat", "sendMessage")).toBe(true);
    expect(isAllowedAdeAction("chat", "messageSession")).toBe(true);
    expect(isCtoOnlyAdeAction("chat", "getMainTranscript")).toBe(false);
    expect(isCtoOnlyAdeAction("chat", "getSubagentTranscript")).toBe(false);
    expect(isCtoOnlyAdeAction("chat", "readTranscript")).toBe(false);
    expect(isCtoOnlyAdeAction("chat", "readTranscriptPage")).toBe(false);
    expect(isCtoOnlyAdeAction("chat", "sendMessage")).toBe(false);
    expect(isCtoOnlyAdeAction("chat", "messageSession")).toBe(false);
  });

  it("exposes Codex goal actions and getCommit through the runtime action surface", () => {
    expect(isAllowedAdeAction("chat", "setCodexGoal")).toBe(true);
    expect(isAllowedAdeAction("chat", "setCodexGoalStatus")).toBe(true);
    expect(isAllowedAdeAction("chat", "clearCodexGoal")).toBe(true);
    expect(isAllowedAdeAction("chat", "getCodexGoal")).toBe(true);
    expect(isAllowedAdeAction("chat", "resetCodexMemory")).toBe(true);
    expect(isAllowedAdeAction("chat", "terminateCodexBackgroundTerminal")).toBe(true);
    expect(isAllowedAdeAction("chat", "stopTask")).toBe(true);
    expect(isAllowedAdeAction("git", "getCommit")).toBe(true);
  });

  it("rejects an unknown action on a known domain", () => {
    expect(isAllowedAdeAction("git", "rmRf")).toBe(false);
    expect(isAllowedAdeAction("issue", "deleteAllIssues")).toBe(false);
    expect(isAllowedAdeAction("automations", "__proto__")).toBe(false);
  });

  it("rejects an unknown domain outright", () => {
    expect(isAllowedAdeAction("not-a-domain" as AdeActionDomain, "anything")).toBe(false);
  });

  it("is case-sensitive on the action name", () => {
    // The allowlist is authored in the exact camelCase the service exposes.
    // Case-insensitive matching would mask typos/mistakes in rules.
    expect(isAllowedAdeAction("git", "Commit")).toBe(false);
    expect(isAllowedAdeAction("git", "COMMIT")).toBe(false);
  });

  it("allowlists every chat action a caller invokes by string", () => {
    // The inverse direction of the allowlist: not "is each entry valid" but
    // "does each name someone actually calls have an entry". A name called by
    // string with no entry fails at `run_ade_action` with "is not exposed
    // through ADE actions", which no compiler or type sees.
    //
    // Two callers reach the chat domain by string, and BOTH have to be in this
    // list — `chat.createAttachmentUpload` shipped unallowlisted precisely
    // because it is called only from the second one, so a preload-only sweep
    // would have passed:
    //
    //   perl -0777 -ne 'while(/"chat",\s*\n?\s*"([A-Za-z][A-Za-z0-9]*)"/g)
    //     {print "$1\n"}' src/preload/preload.ts | sort -u
    //   perl -0777 -ne 'while(/domain:\s*"chat",\s*\n?\s*action:\s*"([A-Za-z]
    //     [A-Za-z0-9]*)"/g){print "$1\n"}' \
    //     src/main/services/remoteRuntime/remoteConnectionService.ts | sort -u
    //
    // Re-run both when adding a chat action to either caller.
    const CALLED_BY_STRING = [
      // src/preload/preload.ts
      "approveToolUse", "archiveSession", "cancelDispatchedSteer", "cancelScheduledWork",
      "cancelSteer", "clearCodexGoal", "copyTempAttachment", "createPromptStash",
      "createScheduledWork", "createSession", "deletePromptStash", "deleteSession",
      "dispatchSteer", "editSteer", "ensureCtoSession", "fileSearch",
      "generateAutoLaneIdentity", "getAvailableModels", "getChatEventHistory",
      "getChatEventHistoryPage", "getClaudeSessionInfo", "getClaudeSessionMessages",
      "getCodexGoal", "getContextUsage", "getImageDataUrl", "getMainTranscript",
      "getParallelLaunchState", "getSessionCapabilities", "getSessionSummary",
      "getSlashCommands", "getSubagentTranscript", "getTurnFileDiff", "handoffSession",
      "interrupt", "killDroidWorker", "launchCli", "launchHeadless",
      "listClaudeOutputStyles", "listClaudePlugins", "listCodexPlugins", "listClaudeSessions",
      "listMentionSuggestions", "listPromptStashes", "listScheduledWork", "listSessions",
      "listSubagents", "markCrossMachineHandoff", "modelCatalog", "resumeUsageLimitNow",
      "prepareCrossMachineHandoff", "recoverCodexTurn", "recoverContinuity", "recoverTurn",
      "regenerateSessionMetadata", "reloadClaudePlugins", "resetCodexMemory",
      "resolveSmartLinkPreview", "resolveUnprocessedMessage", "respondToInput",
      "restoreCancelledQueue", "rewindFiles", "saveTempAttachment", "sendMessage",
      "setClaudeOutputStyle", "setCodexGoal", "setCodexGoalStatus", "setParallelLaunchState",
      "setScheduledWorkPaused", "steer", "stopTask", "suggestLaneNameFromPrompt",
      "terminateCodexBackgroundTerminal", "unarchiveSession", "updateSession",
      "validateCrossMachineSource", "warmupModel",
      // src/main/services/remoteRuntime/remoteConnectionService.ts
      "createAttachmentUpload",
    ];

    // A silently emptied list would make every assertion below vacuous.
    expect(CALLED_BY_STRING.length).toBeGreaterThan(50);
    for (const action of CALLED_BY_STRING) {
      expect(ADE_ACTION_ALLOWLIST.chat, `chat.${action} is called by string but not allowlisted`)
        .toContain(action);
    }
  });

  it("keeps copyTempAttachment's remote reach tied to authority a paired peer already holds", () => {
    // `chat.copyTempAttachment` takes an unconstrained absolute source path and
    // is NOT local-only: `run_ade_action` is reachable over the sync runtime RPC
    // channel, whose JSON-RPC handler is the same origin-blind factory the local
    // unix socket gets, so a paired peer can read any file on this disk with it.
    //
    // That is acceptable only while the same peer already holds strictly greater
    // authority through the same door. `chat.launchCli` runs arbitrary processes
    // and is allowlisted and un-gated, which is the comparison the registry's
    // comment makes. If that ever stops being true, the comparison is void and
    // copyTempAttachment needs a real gate rather than a reassuring comment.
    expect(ADE_ACTION_ALLOWLIST.chat).toContain("copyTempAttachment");
    expect(isAllowedAdeAction("chat", "launchCli")).toBe(true);
    expect(isCtoOnlyAdeAction("chat", "launchCli")).toBe(false);
  });

  it("each allowlist entry is marked allowed by the predicate", () => {
    // Round-trip: whatever is in the data drives the predicate, so this
    // guards against accidental mutations (e.g. a trailing space in a name).
    for (const [domain, actions] of Object.entries(ADE_ACTION_ALLOWLIST) as Array<
      [AdeActionDomain, readonly string[] | undefined]
    >) {
      for (const action of actions ?? []) {
        expect(isAllowedAdeAction(domain, action)).toBe(true);
      }
    }
  });
});

describe("listAllowedAdeActionNames", () => {
  it("returns only allowlisted names that the service actually implements as functions", () => {
    const service = {
      commit: () => undefined,
      pull: () => undefined,
      push: () => undefined,
      stash: () => undefined,
      // Extras that are NOT in the allowlist — must not leak through.
      rmRf: () => undefined,
      internalHelper: () => undefined,
      // Key present but not callable — must be filtered out.
      fetch: "not-a-function",
    } as Record<string, unknown>;

    const names = listAllowedAdeActionNames("git", service);

    expect(names).toContain("commit");
    expect(names).toContain("pull");
    expect(names).toContain("push");
    expect(names).toContain("stash");
    expect(names).not.toContain("rmRf");
    expect(names).not.toContain("internalHelper");
    // Present in allowlist but not a function on the service → drop.
    expect(names).not.toContain("fetch");
  });

  it("returns names sorted alphabetically for a stable UI ordering", () => {
    const service: Record<string, unknown> = {};
    for (const name of ADE_ACTION_ALLOWLIST.git ?? []) {
      service[name] = () => undefined;
    }

    const names = listAllowedAdeActionNames("git", service);
    const sortedCopy = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sortedCopy);
  });

  it("returns an empty array when the domain has no allowlist entry", () => {
    // A fabricated domain name hits the `?? []` fallback; the service is
    // irrelevant because nothing is allowed.
    const names = listAllowedAdeActionNames(
      "made-up-domain" as AdeActionDomain,
      { foo: () => undefined } as Record<string, unknown>,
    );
    expect(names).toEqual([]);
  });

  it("returns an empty array when the service implements none of the allowlisted names", () => {
    const service = { someUnrelated: () => undefined } as Record<string, unknown>;
    const names = listAllowedAdeActionNames("git", service);
    expect(names).toEqual([]);
  });
});

describe("isCtoOnlyAdeAction", () => {
  it("keeps AI credential mutations CTO-only", () => {
    expect(isCtoOnlyAdeAction("ai", "storeApiKey")).toBe(true);
    expect(isCtoOnlyAdeAction("ai", "deleteApiKey")).toBe(true);
    expect(isCtoOnlyAdeAction("ai", "cursorAuthLogin")).toBe(true);
    expect(isCtoOnlyAdeAction("ai", "cursorAuthLogout")).toBe(true);
    expect(isCtoOnlyAdeAction("ai", "cursorAuthCancel")).toBe(true);
    expect(isCtoOnlyAdeAction("ai", "cursorAuthStatus")).toBe(false);
    expect(isCtoOnlyAdeAction("ai", "listApiKeys")).toBe(false);
  });

  it("keeps plaintext project secret export CTO-only", () => {
    expect(isCtoOnlyAdeAction("project_secret", "exportEnv")).toBe(true);
    expect(isCtoOnlyAdeAction("project_secret", "list")).toBe(false);
  });

});

describe("ADE_ACTION_ALLOWLIST shape", () => {
  it("has no duplicate action names within any domain", () => {
    // A duplicate would be a silent footgun: the sort would keep both,
    // and the predicate would be correct but the UI would render the name twice.
    for (const [domain, actions] of Object.entries(ADE_ACTION_ALLOWLIST)) {
      if (!actions) continue;
      const unique = new Set(actions);
      expect(unique.size, `domain "${domain}" has duplicate action names`).toBe(actions.length);
    }
  });

  it("exposes the automations domain with the full CRUD + trigger surface", () => {
    // Automations self-management via ADE action is load-bearing — the /automations
    // IPC handlers and the CLI both depend on these exact names.
    const actions = ADE_ACTION_ALLOWLIST.automations ?? [];
    for (const name of [
      "list",
      "get",
      "saveRule",
      "deleteRule",
      "toggleRule",
      "triggerManually",
      "listRuns",
      "getRunDetail",
      "getIngressStatus",
      "startIngress",
      "refreshWebhookGatewayStatus",
      "setWebhookGatewayPublicUrl",
    ]) {
      expect(actions).toContain(name);
    }
    expect(isCtoOnlyAdeAction("automations", "setWebhookGatewayPublicUrl")).toBe(true);
    expect(isCtoOnlyAdeAction("automations", "refreshWebhookGatewayStatus")).toBe(false);
  });

  it("exposes the issue domain with GitHub issue mutation helpers", () => {
    const actions = ADE_ACTION_ALLOWLIST.issue ?? [];
    for (const name of ["addComment", "setLabels", "close", "reopen", "assign", "setTitle"]) {
      expect(actions).toContain(name);
    }
  });

  it("exposes lane.listSnapshots for runtime-backed lane snapshot parity", () => {
    const actions = ADE_ACTION_ALLOWLIST.lane ?? [];
    expect(actions).toContain("listSnapshots");
  });

  it("exposes lane.listDeleteProgress for runtime-backed lane delete progress recovery", () => {
    const actions = ADE_ACTION_ALLOWLIST.lane ?? [];
    expect(actions).toContain("listDeleteProgress");
  });

  it("exposes runtime-backed PR reads", () => {
    const actions = ADE_ACTION_ALLOWLIST.pr ?? [];
    expect(actions).toContain("listPrsByLane");
    expect(actions).toContain("getMobileGithubDetail");
  });

  it("exposes reconcileOnFocus + syncLanePr so the reconcile safety net works in the runtime-backed build", () => {
    // Regression: in production a project is runtime-backed (local daemon RPC),
    // so the desktop context's prService is null and these actions are dispatched
    // to the daemon. If they are not allowlisted, the daemon rejects them —
    // reconcile-on-focus becomes a no-op and the manual ⟳ sync silently fails.
    const actions = ADE_ACTION_ALLOWLIST.pr ?? [];
    expect(actions).toContain("reconcileOnFocus");
    expect(actions).toContain("syncLanePr");
  });

  it("exposes ade_project.clearLocalData for runtime-backed cleanup", () => {
    const actions = ADE_ACTION_ALLOWLIST.ade_project ?? [];
    expect(actions).toContain("clearLocalData");
  });

  it("exposes session.getDelta for runtime-backed session delta reads", () => {
    const actions = ADE_ACTION_ALLOWLIST.session ?? [];
    expect(actions).toContain("getDelta");
  });

  it("exposes computer-use backend status and artifact preview reads for runtime-backed proof flows", () => {
    const actions = ADE_ACTION_ALLOWLIST.computer_use_artifacts ?? [];
    expect(actions).toContain("getBackendStatus");
    expect(actions).toContain("readArtifactPreview");
    for (const action of [
      "deleteArtifacts",
      "listArtifacts",
      "listBrokenArtifacts",
      "pruneBrokenArtifacts",
      "recoverArtifact",
    ]) {
      expect(isCtoOnlyAdeAction("computer_use_artifacts", action)).toBe(true);
    }
  });

  // The gate is evaluated per action, so a domain that is CTO-only "as a
  // domain" is only actually closed if every one of its methods is listed.
  // `cto_memory` states the restriction as a domain rule with named
  // exceptions, which is what makes the structure fail-closed.
  it("keeps cto_memory writes CTO-only and its reads open", () => {
    const actions = ADE_ACTION_ALLOWLIST.cto_memory ?? [];
    expect(actions).toContain("recordDiscovery");

    // A worker agent can hand a finding up...
    expect(isCtoOnlyAdeAction("cto_memory", "recordDiscovery")).toBe(false);

    // ...and can still READ, exactly as it could before this domain was
    // inverted. These two are deliberately open and must stay open: CTO memory
    // is plain markdown under `<adeDir>/cto/` that every coding agent can
    // already open with a file read, so closing the action gate protects
    // nothing — it only breaks existing automation `ade-action` steps, silently.
    expect(isCtoOnlyAdeAction("cto_memory", "getSnapshot")).toBe(false);
    expect(isCtoOnlyAdeAction("cto_memory", "searchMemory")).toBe(false);

    // The REWRITE path is the one that is actually operator state.
    expect(isCtoOnlyAdeAction("cto_memory", "updateMemory")).toBe(true);

    // Fail-closed: a method added to the domain later is CTO-only by default
    // rather than open by omission.
    expect(isCtoOnlyAdeAction("cto_memory", "someMethodAddedLater")).toBe(true);
  });

  it("gives recordDiscovery an input contract so any provider can call it", () => {
    const contract = getAdeActionInputContract("cto_memory", "recordDiscovery");
    expect(contract?.description).toContain("CTO");
    expect(contract?.input).toContain("fact: string");
    expect(contract?.input).toContain("tags");
    expect(contract?.example).toContain("cto_memory.recordDiscovery");
  });

  it("exposes prompt stashes through the project runtime for connected desktops", () => {
    const actions = ADE_ACTION_ALLOWLIST.chat ?? [];
    expect(actions).toEqual(expect.arrayContaining([
      "listPromptStashes",
      "createPromptStash",
      "deletePromptStash",
    ]));
    expect(isCtoOnlyAdeAction("chat", "listPromptStashes")).toBe(true);
    expect(isCtoOnlyAdeAction("chat", "createPromptStash")).toBe(true);
    expect(isCtoOnlyAdeAction("chat", "deletePromptStash")).toBe(true);
  });
});

/**
 * Every ADE domain the CTO's curated tools cover, and the exact actions the
 * action bus must expose for that coverage to be real.
 *
 * This table is the gate. A future tool over a new action has to add a row
 * here, and the row fails until the action has BOTH an allowlist entry and an
 * input contract — which is what stops someone shipping a tool the bus refuses,
 * or an action with no documented shape.
 */
const CTO_DOMAIN_COVERAGE: ReadonlyArray<{
  domain: AdeActionDomain;
  actions: readonly string[];
  /** Why the CTO reaches this domain at all. */
  why: string;
}> = [
  { domain: "automation_planner", why: "plan / simulate / save automations from plain English", actions: ["parseNaturalLanguage", "validateDraft", "simulate", "saveDraft"] },
  { domain: "automations", why: "read, fire, enable, and delete rules", actions: ["list", "get", "saveRule", "deleteRule", "toggleRule", "triggerManually", "listRuns"] },
  { domain: "chat", why: "handoff and scheduled work", actions: ["handoffSession", "createScheduledWork", "listScheduledWork", "getScheduledWorkState", "cancelScheduledWork", "setScheduledWorkPaused"] },
  // `ingest` is deliberately absent: it is not on the action bus at all.
  // The CTO's `captureProof` tool reaches the broker in-process, and the only
  // other writer is the `ingest_computer_use_artifacts` RPC tool, which owns
  // the owner-claim and caller-root validation. See `registry.test.ts`.
  { domain: "computer_use_artifacts", why: "proof list and review", actions: ["listArtifacts", "readArtifactPreview", "updateArtifactReview"] },
  { domain: "review", why: "launch and read code-review runs", actions: ["listLaunchContext", "startRun", "rerun", "cancelRun", "listRuns", "getRunDetail", "qualityReport"] },
  { domain: "search", why: "project-wide universal search", actions: ["query", "indexStatus"] },
  { domain: "usage", why: "token, cost, and rate-limit reads", actions: ["getAdeUsageStats", "getUsageSnapshot"] },
  { domain: "budget", why: "spend caps and cumulative usage reads", actions: ["getConfig", "getCumulativeUsage", "checkBudget"] },
  { domain: "project_config", why: "read the project's effective ADE config", actions: ["get"] },
  { domain: "project_secret", why: "secret NAMES only", actions: ["list"] },
  { domain: "ios_simulator", why: "simulator reads", actions: ["getStatus", "listDevices", "listLaunchTargets", "getScreenSnapshot"] },
  { domain: "app_control", why: "desktop app-control reads", actions: ["getStatus", "listTargets", "getSnapshot"] },
  { domain: "built_in_browser", why: "browser reads", actions: ["getStatus", "listSessions", "getTrace"] },
  { domain: "orchestration", why: "orchestration run and bundle reads", actions: ["runList", "bundleRead"] },
];

const ROWS = CTO_DOMAIN_COVERAGE.flatMap(({ domain, actions, why }) =>
  actions.map((action) => ({ domain, action, why })));

describe("CTO domain coverage over the ADE action bus", () => {
  it.each(ROWS)("$domain.$action is allowlisted ($why)", ({ domain, action }) => {
    expect(isAllowedAdeAction(domain, action)).toBe(true);
  });

  it.each(ROWS)("$domain.$action has an input contract ($why)", ({ domain, action }) => {
    const contract = getAdeActionInputContract(domain, action);
    expect(contract, `${domain}.${action} needs an entry in ADE_ACTION_INPUT_CONTRACTS`).toBeDefined();
    expect(contract?.description?.length ?? 0).toBeGreaterThan(10);
    expect(contract?.input?.length ?? 0).toBeGreaterThan(0);
  });

  it("covers every domain the coverage table claims exactly once", () => {
    const domains = CTO_DOMAIN_COVERAGE.map((entry) => entry.domain);
    expect(new Set(domains).size).toBe(domains.length);
    for (const domain of domains) {
      expect(ADE_ACTION_ALLOWLIST[domain], `${domain} must exist in the allowlist`).toBeDefined();
    }
  });

  // ── CTO-only decisions ────────────────────────────────────────────────────

  it("keeps the new read surfaces open to agents, as decided", () => {
    // Recorded decisions, not accidents — see the comment block above
    // ADE_ACTION_CTO_ONLY. If one of these ever needs to become CTO-only, the
    // reason has to beat "automations.saveRule already carries the same power".
    for (const [domain, action] of [
      ["automation_planner", "saveDraft"],
      ["review", "startRun"],
      ["search", "query"],
      ["ios_simulator", "listDevices"],
      ["app_control", "listTargets"],
      ["built_in_browser", "getStatus"],
      ["orchestration", "runList"],
      ["project_config", "get"],
      ["project_secret", "list"],
    ] as Array<[AdeActionDomain, string]>) {
      expect(isCtoOnlyAdeAction(domain, action), `${domain}.${action}`).toBe(false);
    }
  });

  it("leaves the privileged neighbours of those surfaces CTO-only", () => {
    for (const [domain, action] of [
      ["search", "rebuildIndex"],
      ["project_secret", "exportEnv"],
      ["budget", "updateConfig"],
      ["usage", "forceRefresh"],
      ["computer_use_artifacts", "deleteArtifacts"],
    ] as Array<[AdeActionDomain, string]>) {
      expect(isCtoOnlyAdeAction(domain, action), `${domain}.${action}`).toBe(true);
    }
  });

  it("does not widen or re-tighten the cto_memory inversion", () => {
    // The inversion is fail-closed: everything CTO-only EXCEPT these three,
    // and the polarity is carried by the rule itself rather than by which of
    // two tables the domain happened to be listed in.
    expect(ADE_ACTION_CTO_ONLY.cto_memory)
      .toEqual({ allExcept: ["recordDiscovery", "getSnapshot", "searchMemory"] });
    expect(isCtoOnlyAdeAction("cto_memory", "updateMemory")).toBe(true);
    expect(isCtoOnlyAdeAction("cto_memory", "recordDiscovery")).toBe(false);
  });

  it("reads both polarities from the one table", () => {
    // `only` domains gate exactly what they name...
    expect(ADE_ACTION_CTO_ONLY.search).toEqual({ only: ["rebuildIndex"] });
    expect(isCtoOnlyAdeAction("search", "rebuildIndex")).toBe(true);
    expect(isCtoOnlyAdeAction("search", "query")).toBe(false);
    // ...and a domain with no rule at all gates nothing.
    expect(ADE_ACTION_CTO_ONLY.git).toBeUndefined();
    expect(isCtoOnlyAdeAction("git", "commit")).toBe(false);
  });

  it("keeps a cto_memory method added later CTO-only by omission", () => {
    // The whole point of `allExcept`: no edit to this file is needed for a new
    // method to be closed, and no edit to another one can silently open it.
    expect(isCtoOnlyAdeAction("cto_memory", "someMethodAddedLater")).toBe(true);
  });
});
