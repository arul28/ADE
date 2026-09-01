// What an AGENT, a RULE, the SEARCH BAR and the CLI can do with Linear.
//
// Four callers, one set of verbs. They differ only in how the arguments arrive
// and what shape the answer has to be, so each verb is written once here and
// the differences live at the edges:
//
//   * an agent tool answers JSON the model reads, so it returns data and lets a
//     failure throw — the host turns a thrown error into a tool error the model
//     can react to;
//   * an automation step answers `{ok, message}`, because a rule reports rather
//     than reasons;
//   * a search provider answers `{results: [{id, title, subtitle, action, args}]}`;
//   * a CLI word answers whatever prints usefully as JSON.
//
// ## Why every verb resolves the issue first
//
// A human types `ADE-14`, Linear sends a UUID, and a rule's template can
// produce either. `resolveIssue` accepts both and answers the STORED row, which
// carries the team key that `list_states` needs and the state id that the
// merge transition compares against. A verb that took the caller's string
// straight to the API would work from the webhook and fail from the CLI.

"use strict";

const { issueBranchName, normalizeIssue } = require("./issueFormat");

/** Agent tools answer at most this many issues, whatever the caller asked for. */
const MAX_TOOL_ISSUES = 100;

/** Search results shown in the palette. The built-in shows the same handful. */
const MAX_SEARCH_RESULTS = 8;

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Read an integer argument that may have arrived as a string.
 *
 * An automation rule's arguments come out of a template and are text; an agent
 * tool's come out of a JSON schema and are numbers. One coercion here beats a
 * `priority` filter that silently does nothing when a rule set it.
 */
function integer(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

/**
 * The tool-facing projection of an issue row.
 *
 * Deliberately smaller than the stored row: a model reading a tool result pays
 * for every field, and `badgeTone`, `stateRank` and the materialized `title2`
 * are things a RENDERER needs. `branchName` stays because an agent asked to
 * open a lane needs the name Linear expects.
 */
function toolIssue(row) {
  if (!row) return null;
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    url: row.url,
    state: row.stateName,
    stateType: row.stateType,
    stateId: row.stateId,
    priority: row.priorityLabel,
    team: row.teamKey,
    project: row.projectName,
    assignee: row.assigneeName,
    labels: row.labels.map((label) => label.name).filter(Boolean),
    dueDate: row.dueDate,
    branchName: row.branchName ?? issueBranchName(row),
    hasLane: row.hasLane === true,
    laneName: row.laneName,
    updatedAt: row.updatedAt,
    subIssues: row.subIssues,
  };
}

/**
 * Build the verbs.
 *
 * `api`, `data` and `flows` are injected. Nothing here reaches the sdk
 * directly — everything that touches ADE goes through `flows`, and everything
 * that touches Linear goes through `api`, which is what makes this module
 * testable with two plain objects.
 */
function createAutomation(options = {}) {
  const { api, data, flows, log = () => {} } = options;
  if (!api || !data || !flows) throw new TypeError("createAutomation needs api, data and flows");

  /**
   * The stored row for whatever the caller named.
   *
   * Falls back to Linear when the issue is not in the current view: an agent
   * asked about `ENG-9` that the reader's filter excludes must still get an
   * answer, and a rule firing on an issue outside the filter is the normal
   * case rather than the odd one.
   */
  async function resolveIssue(idOrIdentifier) {
    const wanted = text(idOrIdentifier);
    if (!wanted) throw new Error("Name the issue, by id or by identifier (e.g. ENG-42).");
    const stored = await data.findIssueRow(wanted);
    if (stored) return stored;
    const result = await data.refreshIssue(wanted, { comments: false });
    if (!result.ok) throw new Error(result.error ?? `Linear has no issue called ${wanted}.`);
    return result.issue;
  }

  /* ── Agent tools ─────────────────────────────────────────────────────── */

  async function getIssue(args = {}) {
    const row = await resolveIssue(args.issueId);
    return { issue: toolIssue(row) };
  }

  /**
   * Search, straight at Linear rather than at the stored rows.
   *
   * The collections hold the READER's current filter, and an agent asking
   * "what is assigned to me in ENG" must not be answered out of a view somebody
   * else's filter shaped. The cost is one round trip, which is the right price
   * for an answer that is about the workspace rather than about the screen.
   */
  async function searchIssues(args = {}) {
    const limit = Math.min(MAX_TOOL_ISSUES, Math.max(1, integer(args.limit) ?? 50));
    const stateTypes = Array.isArray(args.stateTypes)
      ? args.stateTypes.filter((entry) => typeof entry === "string")
      : null;
    const nodes = await api.searchAllIssues(
      {
        ...(text(args.query) ? { query: text(args.query) } : {}),
        ...(text(args.teamKey) ? { teamKey: text(args.teamKey).toUpperCase() } : {}),
        ...(text(args.projectId) ? { projectId: text(args.projectId) } : {}),
        ...(text(args.assigneeId) ? { assigneeId: text(args.assigneeId) } : {}),
        ...(integer(args.priority) !== null ? { priority: integer(args.priority) } : {}),
        ...(stateTypes && stateTypes.length ? { stateTypes } : {}),
      },
      limit,
    );
    const issues = nodes.map((node) => toolIssue(normalizeIssue(node)));
    return { issues, count: issues.length };
  }

  async function addComment(args = {}) {
    const row = await resolveIssue(args.issueId);
    const body = text(args.body);
    if (!body) throw new Error("A comment needs a body.");
    const commentId = await api.createComment(row.id, body);
    // The thread the reader is looking at is now one comment short.
    await data.refreshComments(row.id).catch(() => {});
    return { ok: true, commentId, issue: row.identifier };
  }

  /**
   * Move an issue to a state.
   *
   * Takes a state ID, not a name, and says so in the tool description — Linear
   * workflow states are per team and two teams can both have a "Done" whose
   * ids differ, so a name would be ambiguous exactly where it mattered. A
   * caller that has only a name calls `list_states` first, which is why that
   * tool exists.
   */
  async function updateIssueState(args = {}) {
    const row = await resolveIssue(args.issueId);
    const stateId = text(args.stateId);
    if (!stateId) throw new Error("Name the target state id. Call list_states to find it.");
    await api.updateIssueState(row.id, stateId);
    const refreshed = await data.refreshIssue(row.id, { comments: false });
    return { ok: true, issue: toolIssue(refreshed.ok ? refreshed.issue : row) };
  }

  async function listStates(args = {}) {
    const teamKey = text(args.teamKey);
    // Fetched rather than read from the collections when a team is named the
    // reader has never browsed: the states are near-static and a caller asking
    // for a team's states is a caller about to move an issue in it.
    let states = await data.states(teamKey ? teamKey.toUpperCase() : null);
    if (states.length === 0) {
      await data.refreshCatalog(teamKey ? teamKey.toUpperCase() : null).catch(() => {});
      states = await data.states(teamKey ? teamKey.toUpperCase() : null);
    }
    return {
      states: states.map((state) => ({
        id: state.id,
        name: state.name,
        type: state.type,
        team: state.teamKey,
      })),
    };
  }

  async function assignIssue(args = {}) {
    const row = await resolveIssue(args.issueId);
    const assigneeId = text(args.assigneeId);
    await api.updateIssueAssignee(row.id, assigneeId);
    const refreshed = await data.refreshIssue(row.id, { comments: false });
    return {
      ok: true,
      issue: toolIssue(refreshed.ok ? refreshed.issue : row),
      cleared: assigneeId === null,
    };
  }

  async function addLabel(args = {}) {
    const row = await resolveIssue(args.issueId);
    const labelName = text(args.labelName);
    if (!labelName) throw new Error("Name the label.");
    const labelId = await api.addLabel(row.id, labelName, row.teamKey ?? null);
    const refreshed = await data.refreshIssue(row.id, { comments: false });
    return { ok: true, labelId, issue: toolIssue(refreshed.ok ? refreshed.issue : row) };
  }

  async function createLaneForIssue(args = {}) {
    const row = await resolveIssue(args.issueId);
    const result = await flows.createLaneFromIssue({
      issue: row,
      ...(text(args.baseRef) ? { baseRef: text(args.baseRef) } : {}),
    });
    if (!result.ok) throw new Error(result.message);
    return {
      ok: true,
      laneId: result.laneId,
      laneName: result.laneName,
      branchName: result.branchName,
      linked: result.linked,
    };
  }

  /**
   * The escape hatch: any GraphQL operation, over the plugin's own credential.
   *
   * The built-in ships the same tool (`linearTools.ts:231`) for the same
   * reason — Linear's API is far larger than nine verbs and an agent that
   * needs a tenth should not need a plugin release. It carries the same risk
   * the built-in's does: a mutation the other tools would have refused is
   * reachable here, which is why the tool exists at the agent's permission and
   * not below it.
   */
  async function graphql(args = {}) {
    const query = text(args.query);
    if (!query) throw new Error("A GraphQL operation is required.");
    const variables = args.variables && typeof args.variables === "object" ? args.variables : null;
    const result = await api.request(query, variables, { maxRetries: 1 });
    return { data: result };
  }

  /* ── Automation steps ────────────────────────────────────────────────── */

  /**
   * A rule reports; it does not reason.
   *
   * So each step wraps the verb above and turns a throw into `{ok:false,
   * message}`. A rule whose step failed must say what failed in a sentence the
   * user reads in the run log — an exception would be a stack trace in a place
   * nobody debugs.
   */
  function asStep(verb, describe) {
    return async (args) => {
      try {
        const result = await verb(args ?? {});
        return { ok: true, message: describe(result, args ?? {}) };
      } catch (error) {
        log("warn", `Linear step failed: ${error?.message ?? error}`);
        return { ok: false, message: error?.message ?? String(error) };
      }
    };
  }

  const steps = {
    setIssueState: asStep(updateIssueState, (result) => `Moved ${result.issue?.identifier} to ${result.issue?.state}.`),
    commentOnIssue: asStep(addComment, (result) => `Commented on ${result.issue}.`),
    assignIssue: asStep(
      assignIssue,
      (result) => (result.cleared
        ? `Cleared the assignee on ${result.issue?.identifier}.`
        : `Assigned ${result.issue?.identifier} to ${result.issue?.assignee ?? "someone"}.`),
    ),
    /**
     * The merged-PR transition, as a step a rule can place.
     *
     * The same act `flows.closeIssueOnMerge` performs on the `pr.changed`
     * event, offered as a step so a user who wants it on THEIR conditions —
     * only this label, only this team — writes the rule instead of taking the
     * blanket setting.
     */
    closeIssueOnMerge: async (args) => {
      const laneIds = Array.isArray(args?.laneIds)
        ? args.laneIds
        : text(args?.laneId) ? [text(args.laneId)] : [];
      const result = await flows.closeIssueOnMerge({ laneIds });
      return {
        ok: result.ok !== false,
        message: result.skipped === "setting"
          ? "Turn on \"Move the issue to Done when its pull request merges\" in the Linear settings first."
          : `Moved ${result.moved ?? 0} ${result.moved === 1 ? "issue" : "issues"} to Done.`,
      };
    },
  };

  /* ── Search provider ─────────────────────────────────────────────────── */

  /**
   * Universal search, answered from the STORED rows.
   *
   * The opposite choice to the agent tool above, and for the opposite reason:
   * the palette is a keystroke-latency surface and a round trip per keystroke
   * would make it feel broken. The built-in's own provider
   * (`searchService.ts:1356`) hits Linear live and is kept off the default
   * path for exactly that cost; answering from rows the plugin already
   * materialized is the same result with none of it.
   */
  async function searchProvider(args = {}) {
    const query = String(args?.query ?? "").trim().toLowerCase();
    if (!query) return { results: [] };
    const rows = await data.issueRows();
    const results = rows
      .filter((row) => String(row.identifier ?? "").toLowerCase().includes(query)
        || String(row.title ?? "").toLowerCase().includes(query))
      .slice(0, MAX_SEARCH_RESULTS)
      .map((row) => ({
        id: row.id,
        title: `${row.identifier} ${row.title}`,
        subtitle: `${row.stateName}${row.assigneeName ? ` · ${row.assigneeName}` : ""}`,
        action: "openIssue",
        args: { issueId: row.id },
      }));
    return { results };
  }

  return {
    MAX_SEARCH_RESULTS,
    MAX_TOOL_ISSUES,
    addComment,
    addLabel,
    assignIssue,
    createLaneForIssue,
    getIssue,
    graphql,
    listStates,
    resolveIssue,
    searchIssues,
    searchProvider,
    steps,
    toolIssue,
    updateIssueState,
  };
}

module.exports = {
  MAX_SEARCH_RESULTS,
  MAX_TOOL_ISSUES,
  createAutomation,
  integer,
  toolIssue,
};
