// The four acts that turn an issue into work, and one that closes it.
//
// Everything here reaches ADE rather than Linear: a lane is `lane.create`, an
// agent is `chat.createSession` or `chat.launchCli`, and the link between the
// issue and the lane is `ade.lanes.linkIssue`. Linear is touched only at the
// end, when the merged pull request moves the issue to Done.
//
// ## Why `lanes.linkIssue` and not `lane.create({linearIssue})`
//
// `CreateLaneArgs` has a `linearIssue` field and the built-in fills it. A
// plugin must not: that field is the COMPILED integration's, the host stamps
// no plugin id on it, and `unlinkIssue` would then refuse to remove a link this
// plugin made. Creating the lane and linking the issue as two steps is what
// makes the link this plugin's own — removable by it, attributed to it, and
// carrying the full {@link IssueRef} that the branch namer and the PR body
// writer read.
//
// ## The branch name is the contract
//
// Linear matches a branch to an issue BY NAME. So the lane is created with an
// explicit `branchName` from `issueFormat.issueBranchName`, which is a
// byte-for-byte port of `shared/linearIssueBranch.ts`. A lane whose branch ADE
// named its own way would silently break Linear's own branch linking and
// "Open in coding tool", and nothing would report it.

"use strict";

const { issueBranchName, issueLaneName, issueRefFromRow } = require("./issueFormat");

/**
 * Every launch argument that can carry a permission choice, in the order a
 * caller's own value wins.
 *
 * The unified `permissionMode` is FIRST because it is the one field every
 * launch accepts and the one a caller that could not name a provider falls back
 * to. The four native fields follow: `chat.createSession` and `chat.launchCli`
 * read whichever is present, so exactly one is ever sent.
 *
 * Named here rather than derived, because this list is a fact about the LAUNCH
 * ACTION's arguments, not about which providers exist — which is the thing the
 * capabilities read owns and this file deliberately does not.
 */
const PERMISSION_FIELDS = Object.freeze([
  "permissionMode",
  "claudePermissionMode",
  "droidPermissionMode",
  "opencodePermissionMode",
  "cursorModeId",
]);

/**
 * The kickoff prompt, ported from `LinearLaunchModel.swift:223`.
 *
 * Kept identical rather than improved. A user who has launched agents from
 * issues on the phone knows what the agent was told; a plugin that reworded it
 * would change the behaviour of every launch without saying so.
 */
function defaultKickoff(row) {
  const title = String(row?.title ?? "").trim();
  return `Pick up ${row?.identifier ?? ""}: ${title}.\n\nRead the attached Linear issue for full context, plan the change, then implement it.`;
}

/**
 * The context file the launched agent reads.
 *
 * The same JSON `writeSessionLinearIssueContextFile` writes
 * (`agentChatService.ts:6297`), so an agent — and the `ade linear` skill that
 * tells it to look — finds the shape it already expects. The host writes the
 * file and hands the child its path in `ADE_PLUGIN_CONTEXT_FILE`; the plugin
 * supplies only the name and the content.
 */
function contextFileContent(rows, nowIso) {
  const payload = {
    sessionId: null,
    updatedAt: nowIso,
    issues: rows.map((row) => ({
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      url: row.url,
      stateName: row.stateName,
      role: "primary",
      teamKey: row.teamKey,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * The session setup one launch hands the host.
 *
 * `ADE_PLUGIN_LINEAR_ISSUE_IDS` rather than `ADE_LINEAR_ISSUE_IDS`: every key a
 * plugin may set must match `PLUGIN_SESSION_ENV_KEY_PATTERN`
 * (`^ADE_PLUGIN_[A-Z0-9_]{1,64}$`), and the fixed prefix is what makes
 * shadowing a host variable impossible by construction. The built-in's own
 * name stays the built-in's — see the gap list, because an agent skill written
 * against `ADE_LINEAR_ISSUE_IDS` reads nothing under the plugin.
 */
function sessionSetupFor(rows, nowIso) {
  const identifiers = rows.map((row) => row.identifier).filter(Boolean).join(",");
  const ids = rows.map((row) => row.id).filter(Boolean).join(",");
  return {
    env: {
      ADE_PLUGIN_LINEAR_ISSUE_IDS: identifiers,
      ADE_PLUGIN_LINEAR_ISSUE_UUIDS: ids,
    },
    contextFile: {
      name: "linear-issues.json",
      content: contextFileContent(rows, nowIso),
    },
  };
}

/**
 * Which workflow state a merged issue moves to.
 *
 * `pickStateId(states, "completed")` in `linearLiveStatusService.ts:64` —
 * the FIRST state of the completed type, not the one called "Done". A team
 * that renamed Done still works, and a team with two completed states gets
 * Linear's own ordering rather than a name match this plugin invented.
 */
function pickCompletedStateId(states) {
  const match = states.find((state) => state?.type === "completed");
  return match?.id ?? null;
}

/** The `started` state, for the launch transition. Same rule as above. */
function pickStartedStateId(states) {
  const match = states.find((state) => state?.type === "started");
  return match?.id ?? null;
}

function failure(error, fallback) {
  return { ok: false, message: error?.message ?? fallback, code: error?.code ?? null };
}

/**
 * `{owner, name}` out of a git remote, for the two forms git actually stores.
 *
 * SSH (`git@github.com:owner/repo.git`) and HTTPS
 * (`https://github.com/owner/repo`), with the `.git` suffix optional on both.
 * Anything else — a GitLab remote, a local path, a fork of the URL shape — is
 * `null`, which the caller reports as "no GitHub origin" rather than sending
 * to GitHub to be refused.
 */
function parseGithubRemote(remote) {
  const value = String(remote ?? "").trim();
  if (!value) return null;
  const match = /^(?:git@github\.com:|(?:ssh:\/\/)?git@github\.com\/|https?:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/(.+?)(?:\.git)?\/?$/i
    .exec(value);
  if (!match) return null;
  const owner = match[1].trim();
  const name = match[2].trim();
  return owner && name ? { owner, name } : null;
}

/**
 * Build the flows.
 *
 * `sdk`, `api` and `data` are injected, so every act below is testable against
 * a fake action bridge with no ADE and no Linear.
 */
function createFlows(options = {}) {
  const { sdk, api, data, log = () => {}, now = () => Date.now() } = options;
  if (!sdk || !api || !data) throw new TypeError("createFlows needs sdk, api and data");

  /**
   * Issues already moved to Done, so a redelivered merge does not move twice.
   *
   * In memory rather than in a collection, matching `movedDone` in the
   * built-in. A moved issue that gets moved again is a no-op at Linear (the
   * state is already the target and the call is skipped on `stateId`), so this
   * is a round-trip saver rather than a correctness guard.
   */
  const movedDone = new Set();

  /** This plugin's settings, defaults applied. */
  async function config() {
    return await sdk.config.get().catch(() => ({}));
  }

  /**
   * Create a lane for one issue and link the issue to it.
   *
   * The two halves are one act, and the SECOND half is allowed to fail without
   * failing the first: a lane that exists with no link is a lane the user can
   * work in and link by hand, whereas reporting failure would send them looking
   * for a lane that is already there. Both outcomes are named in the result.
   */
  async function createLaneFromIssue(input = {}) {
    const row = input.issue ?? (await data.findIssueRow(input.issueId));
    if (!row) return { ok: false, message: "That issue is not in this project's Linear view.", code: "not_found" };

    let lane;
    try {
      lane = await sdk.actions.invoke("lane", "create", {
        name: issueLaneName(row),
        branchName: issueBranchName(row),
        ...(input.baseRef ? { baseBranch: input.baseRef } : {}),
        ...(input.description ? { description: input.description } : {}),
      });
    } catch (error) {
      return failure(error, `Could not create a lane for ${row.identifier}.`);
    }

    const laneId = lane?.id ?? lane?.laneId ?? null;
    if (!laneId) return { ok: false, message: "ADE created the lane but named no id.", code: "internal" };

    let linked = false;
    try {
      await sdk.lanes.linkIssue({
        laneId,
        issue: issueRefFromRow(row),
        role: "primary",
        includeInPr: true,
        // Closing on merge is what the `moveToDoneOnMerge` setting then acts
        // on. Recorded on the LINK rather than read from the setting at merge
        // time, so a link made while the setting was on stays honoured.
        closeOnMerge: true,
      });
      linked = true;
    } catch (error) {
      log("warn", `Created lane ${laneId} but could not link ${row.identifier}: ${error?.message ?? error}`);
    }

    // The row's `hasLane` badge is now wrong on every stored copy of it.
    await data.refreshIssue(row.id, { comments: false }).catch(() => {});

    return {
      ok: true,
      laneId,
      laneName: lane?.name ?? issueLaneName(row),
      branchName: lane?.branchRef ?? issueBranchName(row),
      linked,
      message: linked
        ? `Opened a lane on ${row.identifier}.`
        : `Opened a lane on ${row.identifier}, but could not link the issue to it.`,
    };
  }

  /**
   * Link an existing lane to an issue, without creating anything.
   *
   * The gesture behind the lane row's "attach this issue" and the CLI's
   * `attach`. Separate from the create path because attaching to a lane that
   * already exists must never make a second one.
   */
  async function linkIssueToLane(input = {}) {
    const row = input.issue ?? (await data.findIssueRow(input.issueId));
    if (!row) return { ok: false, message: "That issue is not in this project's Linear view.", code: "not_found" };
    if (!input.laneId) return { ok: false, message: "Name the lane to attach the issue to.", code: "invalid_args" };
    try {
      await sdk.lanes.linkIssue({
        laneId: input.laneId,
        issue: issueRefFromRow(row),
        role: input.role ?? "referenced",
        includeInPr: input.includeInPr !== false,
        closeOnMerge: input.closeOnMerge === true,
      });
    } catch (error) {
      return failure(error, `Could not attach ${row.identifier} to that lane.`);
    }
    await data.refreshIssue(row.id, { comments: false }).catch(() => {});
    return { ok: true, message: `Attached ${row.identifier}.`, laneId: input.laneId };
  }

  /**
   * Start an agent on an issue, in a lane.
   *
   * `chat` opens an ADE Work chat; `cli` starts a tracked provider CLI in a
   * terminal. Both carry the same `sessionSetup`, because the whole point of
   * the seam is that the agent reads its issue the same way whichever one the
   * user picked.
   *
   * The lane comes first and is not created here: an agent with no lane has no
   * branch to work on, and a flow that quietly created one would make "start an
   * agent" a two-lane gesture the second time somebody pressed it.
   */
  /**
   * The permission field this launch carries, or nothing.
   *
   * A caller passes exactly one — `permissionMode` for Codex and for anything
   * the capabilities read could not name, or the provider's own field. Copied
   * through by name so this flow never has to know which providers exist.
   */
  function permissionFields(input) {
    for (const field of PERMISSION_FIELDS) {
      const value = typeof input[field] === "string" ? input[field].trim() : "";
      if (value) return { [field]: value };
    }
    return {};
  }

  async function spawnAgentOnIssue(input = {}) {
    const row = input.issue ?? (await data.findIssueRow(input.issueId));
    if (!row) return { ok: false, message: "That issue is not in this project's Linear view.", code: "not_found" };
    if (!input.laneId) return { ok: false, message: "Open a lane on the issue first.", code: "invalid_args" };

    const nowIso = new Date(now()).toISOString();
    const setup = sessionSetupFor([row], nowIso);
    const prompt = typeof input.prompt === "string" && input.prompt.trim()
      ? input.prompt.trim()
      : defaultKickoff(row);

    const base = {
      laneId: input.laneId,
      sessionSetup: setup,
      title: issueLaneName(row),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(typeof input.fastMode === "boolean" ? { fastMode: input.fastMode } : {}),
      // The permission argument, whichever one it is.
      //
      // `permissionMode` is ADE's UNIFIED vocabulary and a provider's own
      // choices are its NATIVE one, so which FIELD carries the reader's answer
      // depends on the provider: `claudePermissionMode`, `droidPermissionMode`,
      // `cursorModeId`, `opencodePermissionMode`, or the unified name for
      // Codex. `pageActions.js:permissionArgument` reads the field off ADE's
      // own capabilities answer and hands it over already named, so this flow
      // copies it rather than keeping a provider table of its own — the table
      // that goes stale the day a sixth provider ships.
      ...permissionFields(input),
    };

    let session;
    try {
      session = input.sessionType === "cli"
        ? await sdk.actions.invoke("chat", "launchCli", { ...base, initialInput: prompt })
        : await sdk.actions.invoke("chat", "createSession", { ...base, initialMessage: prompt });
    } catch (error) {
      return failure(error, `Could not start an agent on ${row.identifier}.`);
    }

    const sessionId = session?.sessionId ?? session?.id ?? null;

    // Link the issue to the SESSION as well as the lane. That second link is
    // what makes the chat header's issue affordances and the PR body's
    // reference find the issue for a chat opened in a lane that carries
    // several.
    if (sessionId) {
      try {
        await sdk.lanes.linkIssue({
          sessionId,
          issue: issueRefFromRow(row),
          role: "primary",
          includeInPr: true,
          closeOnMerge: true,
        });
      } catch (error) {
        log("warn", `Started a session on ${row.identifier} but could not link it: ${error?.message ?? error}`);
      }
    }

    // The launch transition, ported from `linearLiveStatusService.onAgentLaunched`
    // but gated on this plugin's own setting rather than an env flag.
    await moveToStarted(row).catch(() => {});

    return {
      ok: true,
      sessionId,
      message: `Started an agent on ${row.identifier}.`,
    };
  }

  /**
   * Move an issue to the team's first `started` state on launch.
   *
   * Only when the user asked for it. The built-in hides this behind an
   * environment variable nobody sets (`linearLiveStatusService.ts:28`); the
   * setting is the same behaviour with a switch a person can find.
   */
  async function moveToStarted(row) {
    const settings = await config();
    if (settings.moveToStartedOnLaunch !== true) return { ok: true, skipped: "setting" };
    const states = await data.states(row.teamKey ?? null);
    const startedId = pickStartedStateId(states);
    if (!startedId || startedId === row.stateId) return { ok: true, skipped: "already" };
    try {
      await api.updateIssueState(row.id, startedId);
    } catch (error) {
      log("warn", `Could not move ${row.identifier} to In Progress: ${error?.message ?? error}`);
      return { ok: false, error: error?.message ?? String(error) };
    }
    await data.refreshIssue(row.id, { comments: false }).catch(() => {});
    return { ok: true, stateId: startedId };
  }

  /**
   * A merged pull request moves its lane's issues to Done.
   *
   * Ported from `main.ts:3838`. It now reads the same three sources core does:
   * the lane's primary issue, the lane's own links that asked to close, and
   * every SESSION-scoped link inside the lane that asked to close — the last
   * through `ade.lanes.listSessionIssues`, which is the generic twin of core's
   * `laneService.listLinearIssuesForLaneSessions`. An issue attached only to a
   * chat inside the lane is therefore moved here exactly as core moves it.
   *
   * One difference remains, and it is the gate: core is gated on an env flag
   * and this is gated on the `moveToDoneOnMerge` setting.
   */
  async function closeIssueOnMerge(input = {}) {
    const settings = await config();
    if (settings.moveToDoneOnMerge !== true) return { ok: true, moved: 0, skipped: "setting" };

    const laneIds = Array.isArray(input.laneIds) ? input.laneIds.filter(Boolean) : [];
    if (laneIds.length === 0) return { ok: true, moved: 0, skipped: "no-lanes" };

    let moved = 0;
    for (const laneId of laneIds) {
      let lane;
      try {
        lane = await sdk.lanes.get(laneId);
      } catch (error) {
        log("warn", `Could not read lane ${laneId}: ${error?.message ?? error}`);
        continue;
      }
      if (!lane) continue;

      // The same three sources core reads, in the same order: the lane's
      // primary issue always, every other LANE link only when it asked to
      // close, and every SESSION link in the lane only when it asked to close.
      const wanted = new Map();
      const add = (issue) => {
        if (issue?.provider === "linear" && issue?.issueId) wanted.set(issue.issueId, issue);
      };
      add(lane.primaryIssue ?? null);
      for (const link of Array.isArray(lane.issueLinks) ? lane.issueLinks : []) {
        if (link?.closeOnMerge) add(link.issue);
      }
      // The third source is a separate read because it is a separate table.
      // Through `sessionIssues` rather than the SDK verb directly: it holds the
      // downlevel guard AND the catch, so a host whose SDK predates the verb
      // answers `[]` instead of throwing a TypeError this loop would have to
      // know about. A failure here must not take the lane-level half down with
      // it — those issues are still correct to move.
      const sessionGroups = await sessionIssues(laneId);
      for (const group of Array.isArray(sessionGroups) ? sessionGroups : []) {
        for (const link of Array.isArray(group?.issueLinks) ? group.issueLinks : []) {
          if (link?.closeOnMerge) add(link.issue);
        }
      }
      if (wanted.size === 0) continue;

      for (const issue of wanted.values()) {
        if (movedDone.has(issue.issueId)) continue;
        movedDone.add(issue.issueId);
        try {
          // The team, from the link if it carries one and from the stored row
          // if it does not. `IssueRefContainer.key` is optional and this path
          // consumes links from any producer, including core's.
          //
          // `data.states(null)` returns EVERY team's states ordered by key, and
          // `pickCompletedStateId` takes the first `completed` it finds — the
          // alphabetically first team's Done. Moving an issue to another team's
          // state is a move Linear refuses, caught and warned two lines below,
          // so the issue never moved and nothing said why. An unknown team is
          // refused here instead, in the same words as a team with no Done.
          const teamKey = issue.container?.key
            ?? (await data.issueRow(issue.issueId).catch(() => null))?.teamKey
            ?? null;
          const doneId = teamKey ? pickCompletedStateId(await data.states(teamKey)) : null;
          if (!doneId) {
            log("warn", `No completed state for ${issue.key ?? issue.issueId}; leaving it where it is.`);
            movedDone.delete(issue.issueId);
            continue;
          }
          if (doneId === issue.state?.id) continue;
          await api.updateIssueState(issue.issueId, doneId);
          moved += 1;
          await data.refreshIssue(issue.issueId, { comments: false }).catch(() => {});
        } catch (error) {
          // Un-latch so a later merge event retries. A permanent failure then
          // costs one call per merge rather than being silently never retried.
          movedDone.delete(issue.issueId);
          log("warn", `Could not move ${issue.key ?? issue.issueId} to Done: ${error?.message ?? error}`);
        }
      }
    }
    return { ok: true, moved };
  }

  /**
   * The issues linked to the SESSIONS inside one lane.
   *
   * Answers `[]` rather than throwing on a host whose SDK predates the verb —
   * `unsupported_method` there means "this build cannot tell you", which is not
   * the same as "there are none" but leads to the same, smaller, correct
   * action: the lane's own links still close.
   */
  async function sessionIssues(laneId) {
    if (typeof sdk.lanes?.listSessionIssues !== "function") return [];
    try {
      const rows = await sdk.lanes.listSessionIssues(laneId);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      log("debug", `Could not read the session issues for ${laneId}: ${error?.message ?? error}`);
      return [];
    }
  }

  /**
   * Which lanes just had a pull request merge.
   *
   * Two paths, and the first is the honest one.
   *
   * 1. **`transitions`.** When the host's producer knew where each PR moved
   *    from, it says so, and a merge is `from.merged === false && to.merged`.
   *    That is the same test core makes inside `onPullRequestsChanged`, made
   *    against the same previous state, so this path agrees with core exactly.
   * 2. **The re-read.** For an event with no transitions — an older host, a
   *    delivery whose ids overflowed the cap, a PR the poller saw for the first
   *    time — each id is read back and counted as merged if it is merged NOW.
   *    Weaker on purpose: it cannot tell "just merged" from "was already
   *    merged", so the caller's `movedDone` latch is what stops it acting twice.
   *
   * Mixed events take both paths: the ids a transition covers are decided by
   * the transition, and only the rest are re-read. A transition therefore never
   * costs a round trip, and never hides an id the producer did not describe.
   */
  async function mergedLanesFromPrIds(input) {
    const payload = Array.isArray(input) ? { ids: input } : (input ?? {});
    const prIds = Array.isArray(payload.ids) ? payload.ids.filter(Boolean) : [];
    const transitions = Array.isArray(payload.transitions) ? payload.transitions : [];

    const laneIds = new Set();
    const decided = new Set();

    for (const transition of transitions) {
      const prId = transition?.id;
      if (!prId) continue;
      decided.add(prId);
      // Merged BEFORE this window is not a merge to act on. Core makes the same
      // distinction with `previousState !== "merged"`, and it is what keeps a
      // re-poll of an already-merged PR from reopening the whole rule.
      if (transition.from?.merged === true) continue;
      if (transition.to?.merged !== true) continue;
      // The transition carries lifecycle position and no lane, by design — the
      // change event says what moved and never what it is about. One read per
      // genuinely-merged PR is the floor, and it is far below the one read per
      // NAMED PR the fallback pays.
      const laneId = await laneIdForPr(prId);
      if (laneId) laneIds.add(laneId);
    }

    // Capped on the ids the transitions did not already answer, so a full event
    // of transitions is never truncated by a budget meant for the re-read path.
    const toRead = prIds.filter((prId) => !decided.has(prId)).slice(0, 25);
    for (const prId of toRead) {
      const laneId = await laneIdForPr(prId, { onlyWhenMerged: true });
      if (laneId) laneIds.add(laneId);
    }
    return [...laneIds];
  }

  /**
   * The lane one pull request belongs to.
   *
   * `onlyWhenMerged` is the fallback path's extra condition: with no transition
   * to trust, "is it merged now" is the only merge test there is.
   */
  async function laneIdForPr(prId, options = {}) {
    try {
      const detail = await sdk.actions.invoke("pr", "getDetail", { prId });
      const pr = detail?.pr ?? detail ?? null;
      if (!pr?.laneId) return null;
      if (options.onlyWhenMerged && pr.state !== "merged") return null;
      return pr.laneId;
    } catch (error) {
      log("debug", `Could not read PR ${prId}: ${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * Create one GitHub autolink for a team key.
   *
   * Ported from `LinearSection.tsx:748`. It is a `github` action rather than a
   * Linear one: the autolink lives on the repository, and this plugin is only
   * the thing that knows the key prefix and the workspace URL.
   *
   * `github.createRepoAutolink` wants `owner` and `name`, and no action hands a
   * plugin the current repository — so the origin remote is read and parsed
   * here. A remote that is not a GitHub one is refused by name rather than sent
   * and refused by GitHub, because "could not create the autolink" for a GitLab
   * project is an answer that sends the reader looking for a permissions
   * problem they do not have.
   */
  async function createAutolink(input = {}) {
    const teamKey = String(input.teamKey ?? "").trim().toUpperCase();
    if (!teamKey) return { ok: false, message: "Name the team key, e.g. ENG.", code: "invalid_args" };
    const connection = await data.connection();
    const urlKey = connection?.organizationUrlKey ?? null;
    if (!urlKey) {
      return { ok: false, message: "Connect Linear first — the workspace URL is part of the autolink.", code: "no_token" };
    }

    const repo = await githubRepo();
    if (!repo) {
      return { ok: false, message: "This project has no GitHub origin, so there is nothing to autolink.", code: "no_repo" };
    }

    try {
      await sdk.actions.invoke("github", "createRepoAutolink", {
        owner: repo.owner,
        name: repo.name,
        keyPrefix: `${teamKey}-`,
        urlTemplate: `https://linear.app/${urlKey}/issue/${teamKey}-<num>`,
        isAlphanumeric: false,
      });
    } catch (error) {
      return failure(error, `Could not create the ${teamKey} autolink.`);
    }
    return { ok: true, message: `GitHub now links ${teamKey}-123 to Linear.` };
  }

  /** `{owner, name}` for this project's GitHub origin, or `null`. */
  async function githubRepo() {
    let remote = null;
    try {
      const result = await sdk.actions.invoke("git", "getOriginRemote", {});
      remote = typeof result === "string" ? result : result?.url ?? result?.remote ?? result?.originRemote ?? null;
    } catch {
      return null;
    }
    return parseGithubRemote(remote);
  }

  return {
    closeIssueOnMerge,
    contextFileContent,
    createAutolink,
    createLaneFromIssue,
    defaultKickoff,
    githubRepo,
    linkIssueToLane,
    mergedLanesFromPrIds,
    moveToStarted,
    sessionIssues,
    sessionSetupFor,
    spawnAgentOnIssue,
  };
}

module.exports = {
  contextFileContent,
  createFlows,
  defaultKickoff,
  parseGithubRemote,
  pickCompletedStateId,
  pickStartedStateId,
  sessionSetupFor,
};
