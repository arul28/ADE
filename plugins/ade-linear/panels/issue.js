// One issue, in full — the built-in's right-hand column as a panel of its own.
//
// The reader arrives here by pressing a row, which is a `{navigate}`, which
// PUSHES: every client gives them the way back out of its own furniture (a
// chevron and a left-edge swipe on the phone, the browser's Back on desktop and
// the web), and restores the filter strip, the ticks, the folded sections and
// the scroll they left behind. So this panel spends no nodes on a Back button
// of its own and no state on remembering where the reader came from.
//
// ## Three things it does that the built-in does not
//
// - **The state and the priority are editable in place.** The built-in browser
//   is read-only on both surfaces: you look at an issue in ADE and you change it
//   in Linear. A `segmented` with `onChange` is one tap.
// - **A comment can be written.** `{prompt}` asks for a line and re-invokes the
//   same action with the answer. The built-in has no composer anywhere, on
//   either surface.
// - **The description and every comment are real prose.** `markdown` renders the
//   same closed subset on four clients — where the built-in's phone renderer and
//   its desktop renderer are two different parsers that agree by coincidence.
//
// ## The one thing it must be careful about
//
// This is ONE panel drawing every issue, and panel state survives a re-publish
// of the same controls. A shared `stateKey` on the state control would carry the
// value the reader picked on ADE-122 onto ADE-140 the moment they navigated. So
// both editable controls key on the issue's identifier — a different key is a
// different signature, and a changed signature is exactly the case the state
// lifecycle resets on.

"use strict";

const {
  ACTIONS,
  COLLECTION_STATES,
  issuePriorityKey,
  issueStateKey,
  statesKeyPrefix,
} = require("./contract");

const {
  COPY,
  DEEPLINK_ISSUE,
  LIMITS,
  PRIORITIES,
  SOFT_SCHEMA_BYTES,
  clamp,
  fallback,
  label,
  priorityLabel,
  prose,
  schemaBytes,
  stateIcon,
  stateTone,
  value,
} = require("./common");

/**
 * How many comments the panel will draw, before the byte budget has its say.
 *
 * Each comment is two nodes — a `divider` naming its author and a `markdown` of
 * their words — so twenty of them is forty nodes of a two-hundred-node budget,
 * which leaves the rest of the issue room to exist. The reader asks for more
 * with the button below them, and the plugin republishes with a wider window.
 */
/** How many sub-issue rows this card draws. The heading says so when it cuts. */
const MAX_SUB_ISSUES = 50;

const COMMENT_WINDOW = 20;

/**
 * The header: what the issue is, and what is true about it right now.
 *
 * The phone's built-in draws exactly these three chips — a status chip, a
 * priority glyph with its label, and a lane marker — so this is that row, in
 * `badge` nodes.
 */
function issueHeader(issue) {
  const chips = [
    {
      component: "badge",
      text: label(issue.stateName || issue.stateType || "—"),
      tone: stateTone(issue.stateType),
      icon: stateIcon(issue.stateType),
    },
  ];

  const priority = PRIORITIES.find((entry) => entry.value === String(issue.priority ?? ""));
  if (priority && priority.value !== "0") {
    chips.push({
      component: "badge",
      text: priority.label,
      tone: priority.tone,
      ...(priority.icon ? { icon: priority.icon } : {}),
    });
  }

  if (issue.hasLane) {
    chips.push({ component: "badge", text: COPY.hasLane, tone: "accent", icon: "git-branch" });
  }

  return [
    { component: "text", variant: "title", text: prose(issue.title) },
    { component: "stack", direction: "horizontal", gap: "sm", wrap: true, align: "center", children: chips },
  ];
}

/**
 * The two controls that write back to Linear.
 *
 * The state control's LITERAL option is the issue's current state, and the rest
 * come from the team's workflow states through `optionsFrom`. That ordering is
 * doing real work: a bound control whose rows have not arrived yet still draws
 * one true option instead of an empty menu, and the declared `default` is
 * guaranteed to be among the options, so the control opens on the state the
 * issue is actually in rather than falling back to unset.
 *
 * Both are told on change and both republish afterwards, so a failed write ends
 * with the control back on the truth rather than on the reader's intention.
 */
function inlineEditors(issue) {
  const children = [];

  // BOTH, not just the state id. A `segmented` needs two distinct options, and
  // a BOUND one is exempt only because its second option is rows that have not
  // arrived — so a control with one literal option and no `optionsFrom` is
  // refused by the parser and the whole editor vanishes with a warning nobody
  // reads. An issue whose team Linear did not return (`issueFormat.js` leaves
  // `teamKey` undefined) therefore gets no state control at all, and its status
  // is still on the properties card below, which is where the built-in has it.
  if (issue.stateId && issue.teamKey) {
    children.push({
      component: "segmented",
      stateKey: issueStateKey(issue.identifier),
      label: COPY.propStatus,
      default: String(issue.stateId),
      options: [{ value: String(issue.stateId), label: label(issue.stateName || issue.stateType || "—") }],
      optionsFrom: {
        collection: COLLECTION_STATES,
        keyPrefix: statesKeyPrefix(issue.teamKey),
        valueField: "id",
        labelField: "name",
      },
      onChange: { action: ACTIONS.setIssueState, args: { issueId: String(issue.id) } },
    });
  }

  children.push({
    component: "segmented",
    stateKey: issuePriorityKey(issue.identifier),
    label: COPY.propPriority,
    default: String(issue.priority ?? "0"),
    options: PRIORITIES.map((entry) => ({ value: entry.value, label: entry.label })),
    onChange: { action: ACTIONS.setIssuePriority, args: { issueId: String(issue.id) } },
  });

  return { component: "stack", direction: "horizontal", gap: "sm", wrap: true, align: "center", children };
}

/**
 * The properties block, in the built-in's order and with its labels.
 *
 * `keyValue` holds sixty rows and this spends at most sixteen of them, so the
 * whole of `IssueProperties` fits in one node. Branch is the exception and is
 * drawn below rather than here: a `keyValue` row carries no variant, and the
 * branch name is the one value on this screen a reader compares character by
 * character — `text` with `variant: "code"` is the vocabulary's only monospace
 * and it is worth the two extra nodes.
 */
function issueProperties(issue) {
  const rows = [
    { key: COPY.propStatus, value: value(issue.stateName || issue.stateType || "—"), tone: stateTone(issue.stateType) },
    { key: COPY.propPriority, value: priorityLabel(issue.priority) },
    { key: COPY.propAssignee, value: value(issue.assigneeName || COPY.unassigned) },
  ];

  const optional = [
    [COPY.propProject, issue.projectName],
    [COPY.propTeam, issue.teamName || issue.teamKey],
    [COPY.propCycle, issue.cycleName],
    [COPY.propCreator, issue.creatorName || COPY.unknownCreator],
    [COPY.propEstimate, issue.estimate == null ? null : String(issue.estimate)],
    [COPY.propDue, issue.dueDate],
    [COPY.propCreated, issue.createdAt],
    [COPY.propUpdated, issue.updatedAt],
    [COPY.propStarted, issue.startedAt],
    [COPY.propCompleted, issue.completedAt],
    [COPY.propCanceled, issue.canceledAt],
  ];
  for (const [key, text] of optional) {
    if (text) rows.push({ key, value: value(String(text)) });
  }

  // No blocker row. Counting what blocks an issue needs `relations` and
  // `inverseRelations` on every issue in the workspace, which is a second
  // fetch this plugin does not make — and a row drawn from a field nothing
  // produces is a row that never appears. See the gap list.

  return { component: "keyValue", rows: rows.slice(0, LIMITS.maxKeyValueRows) };
}

/** The branch a lane created from this issue would take. */
function branchBlock(branchName) {
  if (!branchName) return [];
  return [
    { component: "text", variant: "caption", text: COPY.branch },
    { component: "text", variant: "code", text: value(branchName) },
  ];
}

/** Labels, wrapped rather than scrolled — the vocabulary has no scroll strip. */
function labelChips(labels) {
  const names = (Array.isArray(labels) ? labels : []).filter((name) => typeof name === "string" && name.trim());
  if (names.length === 0) return [];
  return [
    {
      component: "stack",
      direction: "horizontal",
      gap: "sm",
      wrap: true,
      children: names.slice(0, 12).map((name) => ({ component: "badge", text: label(name), icon: "tag" })),
    },
  ];
}

/**
 * Everything the reader can do to this issue from here.
 *
 * The two launch verbs are the built-in's `SINGLE_LAUNCH_ACTIONS`, with its
 * words. `Open in Linear` answers `{openUrl}`, which is `https:`-only on every
 * client and goes out through the opener that logs this plugin's id.
 */
function issueActions(issue) {
  // Both launch verbs open the CONFIGURATION panel rather than launching with
  // the plugin's defaults, which is the phone's own flow: `LinearLaunchScreen`
  // is one screen serving both, and `laneOnly` hides the agent half of it and
  // shows the note instead. Launching straight from here would silently pick a
  // model, a permission mode and a kickoff prompt on the reader's behalf.
  //
  // `openLaunch` falls back to launching directly when the host offers no
  // `flows.openLaunch`, so a build whose manifest has no `launch` panel still
  // does the thing the button says.
  const buttons = [
    {
      component: "button",
      label: COPY.launchOne,
      kind: "primary",
      icon: "sparkle",
      onPress: { action: ACTIONS.openLaunch, args: { issueId: String(issue.id), laneOnly: false } },
    },
    {
      component: "button",
      label: COPY.laneOne,
      icon: "git-branch",
      onPress: { action: ACTIONS.openLaunch, args: { issueId: String(issue.id), laneOnly: true } },
    },
    {
      component: "button",
      label: COPY.assignToMe,
      kind: "quiet",
      icon: "users",
      onPress: { action: ACTIONS.assignToMe, args: { issueId: String(issue.id) } },
    },
    {
      component: "button",
      label: COPY.comment,
      kind: "quiet",
      icon: "chat",
      onPress: { action: ACTIONS.commentOnIssue, args: { issueId: String(issue.id) } },
    },
  ];

  // `{issueId}`, never `{url}`. `openInLinear` is the DATA half's handler — it
  // wins the merge and resolves the URL from the stored row, so a button that
  // passed a `url` would be answered with "That issue has no Linear link." The
  // stored row is also the fresher source: an issue that moved workspace has a
  // new URL there and an old one baked into a published schema.
  if (issue.url) {
    buttons.push({
      component: "button",
      label: COPY.openInLinear,
      kind: "quiet",
      icon: "link",
      onPress: { action: ACTIONS.openInLinear, args: { issueId: String(issue.id) } },
    });
  }

  return { component: "stack", direction: "horizontal", gap: "sm", wrap: true, children: buttons };
}

/**
 * Sub-issues, as one list rather than as a stack of hand-built rows.
 *
 * A row is one node's worth of budget however dressed, so each child carries its
 * identifier as `mono`, its state as a `badge`, and a press that navigates to
 * its own detail — which the built-in's sub-issue rows do not offer on either
 * surface.
 */
function subIssuesBlock(children) {
  const rows = Array.isArray(children) ? children : [];
  if (rows.length === 0) return [];
  // The heading counts what is DRAWN, not what arrived. An issue with sixty
  // children used to say "Sub-issues (60)" over fifty rows, with nothing to
  // tell the reader that ten were missing rather than deleted.
  const drawn = rows.slice(0, MAX_SUB_ISSUES);
  const heading = drawn.length === rows.length
    ? `${COPY.subIssues} (${rows.length})`
    : `${COPY.subIssues} (${drawn.length} of ${rows.length})`;
  return [
    { component: "divider", label: heading },
    {
      component: "list",
      items: drawn.map((child) => ({
        key: String(child.id),
        title: prose(child.title),
        mono: value(child.identifier),
        icon: stateIcon(child.stateType),
        tone: stateTone(child.stateType),
        ...(child.stateName
          ? { badge: { text: label(child.stateName), tone: stateTone(child.stateType) } }
          : {}),
        // `openIssue`, not a second id of its own: the data half owns issue
        // navigation, and `openSubIssue` was an alias whose only handler
        // delegated to a handler the merge order made unreachable.
        onPress: { action: ACTIONS.openIssue, args: { issueId: String(child.id) } },
      })),
    },
  ];
}

/**
 * One comment: who said it and when, then what they said.
 *
 * The author line is a `divider` label rather than a `text` node because a
 * divider IS the separator between two comments and drawing both would spend a
 * node on a rule nobody asked for. The body is `markdown`, which is the whole
 * reason this panel can show a comment thread at all — and the body is somebody
 * else's text, so it may hold HTML, a `javascript:` link or forty kilobytes of
 * prose. None of that needs cleaning here: the subset cannot express the first
 * two and the clamp below handles the third.
 */
function commentNodes(comment) {
  const who = comment.author || COPY.someone;
  const when = comment.at ? ` · ${comment.at}` : "";
  return [
    { component: "divider", label: label(`${who}${when}`) },
    { component: "markdown", text: clamp(comment.body ?? "", LIMITS.maxMarkdownChars) },
  ];
}

/**
 * Append as much of the comment thread as the panel can afford.
 *
 * Two ceilings, and the byte one is the one that actually bites: a panel over
 * `maxSchemaBytes` is refused WHOLE, so an issue that lost its description
 * because its eleventh comment was long is a blank screen where there was a
 * working issue. Adding one comment at a time and measuring is the only honest
 * way to stay under it, and what did not fit is said out loud rather than
 * silently missing — a thread that stops without saying so reads as a plugin
 * that stopped writing.
 */
function appendComments(body, input) {
  const {
    comments = [],
    commentsState = "loaded",
    hasEarlierComments = false,
    issue,
  } = input;

  body.push({ component: "divider", label: COPY.comments });

  if (commentsState === "loading") {
    body.push({ component: "text", variant: "caption", text: COPY.commentsLoading });
    return { drawn: 0, dropped: 0 };
  }
  if (commentsState === "failed") {
    body.push({ component: "text", variant: "caption", tone: "warning", text: COPY.commentsFailed });
    return { drawn: 0, dropped: 0 };
  }

  if (hasEarlierComments) {
    body.push({
      component: "button",
      label: COPY.earlierComments,
      kind: "quiet",
      icon: "clock-counter-clockwise",
      onPress: { action: ACTIONS.loadComments, args: { issueId: String(issue.id) } },
    });
  }

  const window = comments.slice(-COMMENT_WINDOW);
  let drawn = 0;
  for (const comment of window) {
    const nodes = commentNodes(comment);
    const projected = schemaBytes(body) + schemaBytes(nodes);
    if (projected > SOFT_SCHEMA_BYTES) break;
    body.push(...nodes);
    drawn += 1;
  }

  const dropped = comments.length - drawn;
  if (drawn === 0 && dropped === 0) {
    body.push({ component: "text", variant: "caption", text: COPY.noComments });
  } else if (dropped > 0) {
    body.push({
      component: "text",
      variant: "caption",
      text: `${dropped} earlier comment${dropped === 1 ? "" : "s"} not shown here — open the issue in Linear to read the whole thread.`,
    });
  }

  return { drawn, dropped };
}

function issueFallback(text) {
  return fallback(text ?? "Open ADE on the computer that holds this plugin to read this issue.", DEEPLINK_ISSUE);
}

/**
 * The issue detail panel.
 *
 * `title` is the identifier rather than the issue's title, because the panel
 * title is what a client puts in its chrome — the phone's nav bar, the
 * overlay's back chevron — and `ADE-122` fits there where a sentence does not.
 */
function buildIssuePanel(input = {}) {
  const { state = "detail", issue = null, error = null } = input;

  // The same card the list draws, for the same reason: a reader with no
  // credential cannot be told an issue is missing, because nothing on this
  // machine has ever been able to look for it.
  if (state === "disconnected") {
    return {
      v: 1,
      title: "Issue",
      fallback: issueFallback("Connect Linear in ADE to read this issue."),
      body: [
        {
          component: "emptyState",
          title: COPY.connectTitle,
          description: COPY.connectBody,
          icon: "plug",
          action: { label: COPY.connectAction, onPress: { action: ACTIONS.connectOAuth } },
        },
        {
          component: "button",
          label: COPY.openSettings,
          kind: "quiet",
          icon: "gear",
          onPress: { action: ACTIONS.openSettings },
        },
      ],
    };
  }

  if (state === "loading") {
    return {
      v: 1,
      title: "Issue",
      fallback: issueFallback(),
      body: [
        {
          component: "emptyState",
          title: "Loading this issue…",
          description: "Reading it from Linear.",
          icon: "kanban",
        },
      ],
    };
  }

  if (!issue) {
    return {
      v: 1,
      title: "Issue",
      fallback: issueFallback(),
      body: [
        {
          component: "emptyState",
          title: "That issue could not be found.",
          description: prose(error ?? "It may have been deleted, or it may belong to a workspace this connection cannot see."),
          icon: "kanban",
          action: { label: "Back to issues", onPress: { action: ACTIONS.backToIssues } },
        },
      ],
    };
  }

  const body = [...issueHeader(issue), inlineEditors(issue)];

  const description = typeof issue.description === "string" ? issue.description.trim() : "";
  if (description) {
    body.push({ component: "markdown", text: clamp(description, LIMITS.maxMarkdownChars) });
  } else {
    body.push({ component: "text", variant: "caption", text: COPY.noDescription });
  }

  body.push(...labelChips(issue.labels));
  body.push(issueProperties(issue));
  body.push(...branchBlock(issue.branchName));
  body.push({ component: "divider" });
  body.push(issueActions(issue));
  body.push(...subIssuesBlock(input.subIssues));
  appendComments(body, input);

  return {
    v: 1,
    title: value(issue.identifier || "Issue"),
    fallback: fallback(
      `${issue.identifier} · ${clamp(issue.title ?? "", 120)}`,
      DEEPLINK_ISSUE,
    ),
    body,
  };
}

module.exports = {
  COMMENT_WINDOW,
  appendComments,
  branchBlock,
  buildIssuePanel,
  commentNodes,
  inlineEditors,
  issueActions,
  issueHeader,
  issueProperties,
  labelChips,
  subIssuesBlock,
};
