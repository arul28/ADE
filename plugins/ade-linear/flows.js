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
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(typeof input.fastMode === "boolean" ? { fastMode: input.fastMode } : {}),
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
   * Ported from `main.ts:3838`, with three differences, all forced:
   *
   * 1. **The trigger.** Core sits inside `onPullRequestsChanged` and sees
   *    `previousState !== "merged" && pr.state === "merged"`. A plugin gets
   *    `pr.changed` — a debounced, coalesced hint with ids and no previous
   *    state — so the transition is derived by reading the PR back
   *    (`pr.getDetail`) and comparing against what this plugin last saw. A
   *    change that coalesced away is therefore a merge this plugin can still
   *    see, because the READ says merged even if the event did not.
   * 2. **Session-level links are invisible.** Core also collects
   *    `laneService.listLinearIssuesForLaneSessions({laneId})`. The plugin's
   *    `PluginLaneSummary` projection carries `primaryIssue` and `issueLinks`
   *    and nothing per-session, so an issue linked ONLY to a chat inside the
   *    lane is not moved. This is in the gap list.
   * 3. **The gate.** Core is gated on an env flag; this is gated on the
   *    `moveToDoneOnMerge` setting.
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

      // The same two sources core reads, in the same order: the lane's primary
      // issue always, and every other link only when it asked to close.
      const wanted = new Map();
      const add = (issue) => {
        if (issue?.provider === "linear" && issue?.issueId) wanted.set(issue.issueId, issue);
      };
      add(lane.primaryIssue ?? null);
      for (const link of Array.isArray(lane.issueLinks) ? lane.issueLinks : []) {
        if (link?.closeOnMerge) add(link.issue);
      }
      if (wanted.size === 0) continue;

      for (const issue of wanted.values()) {
        if (movedDone.has(issue.issueId)) continue;
        movedDone.add(issue.issueId);
        try {
          const teamKey = issue.container?.key ?? null;
          const states = await data.states(teamKey);
          const doneId = pickCompletedStateId(states);
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
   * Which lanes just had a pull request merge.
   *
   * `pr.changed` names PR ids and says nothing about what changed, so this
   * reads each one back and answers the lanes whose PR is now merged. The
   * caller de-duplicates against what it already acted on.
   */
  async function mergedLanesFromPrIds(prIds) {
    const laneIds = new Set();
    for (const prId of Array.isArray(prIds) ? prIds.slice(0, 25) : []) {
      try {
        const detail = await sdk.actions.invoke("pr", "getDetail", { prId });
        const pr = detail?.pr ?? detail ?? null;
        if (pr?.state === "merged" && pr?.laneId) laneIds.add(pr.laneId);
      } catch (error) {
        log("debug", `Could not read PR ${prId}: ${error?.message ?? error}`);
      }
    }
    return [...laneIds];
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
    linkIssueToLane,
    mergedLanesFromPrIds,
    moveToStarted,
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
