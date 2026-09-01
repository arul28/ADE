// The row a bound list draws, dressed once on this machine.
//
// A `list` binding reads a stored row and reshapes NOTHING: `readListItem` in
// `shared/plugins/vocabularyNodes.ts` looks for `title`, `key`, `subtitle`,
// `meta`, `tone`, `icon`, `mono`, `badge`, `onPress`, `actions` and `overflow`,
// and every other field on the row is invisible. So a row carrying `badgeText`
// and `badgeTone` draws no badge, and a row carrying no `onPress` cannot be
// pressed — the reader sees a title, a subtitle, and a list that does not
// respond.
//
// That is why this file is in the PANELS half rather than beside the Linear
// client. Which glyph a state gets, which of four tones it takes, whether a
// priority is loud enough to earn a chip, and which three verbs fit on a row are
// all render decisions, and every token they spend already lives in
// `common.js`. `data.js` calls {@link issueListRow} on the way to
// `collections.put` and stores what comes back.
//
// ## The key
//
// A bound row inherits its COLLECTION key when it declares none of its own, and
// this plugin's collection keys encode sort order — `flat:000012:<id>`. A tick
// in a selectable list carries that key, so a batch handler would be handed
// eleven sort-encoded strings and no issue ids. Declaring `key` explicitly is
// what stops that, and `panelActions.js` strips the prefix anyway, because two
// defences against one wrong id is the right number when the wrong id creates a
// lane.

"use strict";

const { COPY, label, priorityEntry, stateIcon, stateTone, value } = require("./common");
const { ACTIONS } = require("./contract");

/**
 * One issue, as the vocabulary's row.
 *
 * The anatomy is the built-in's, on both surfaces at once: the phone leads with
 * a state icon and trails with a priority glyph, the desktop leads with a
 * monospace identifier and trails with a date and a lane badge. A vocabulary row
 * has one slot for each of those, so this is not a compromise between the two —
 * it is both, in the slots each already used.
 *
 * @param {object} issue A materialized issue from `issueFormat.js`.
 * @param {object} [options]
 * @param {boolean} [options.showLaunch] Offer the launch verbs as row actions.
 */
function issueListRow(issue, options = {}) {
  const source = issue && typeof issue === "object" ? issue : {};
  const id = String(source.id ?? "");
  const identifier = String(source.identifier ?? "");
  const stateType = source.stateType ?? null;

  const row = {
    // Declared, never inherited. See the module comment.
    key: id,
    title: label(source.title || identifier || "Untitled issue"),
    // The identifier and the state, which is the phone's second line and the
    // desktop's row minus its columns.
    subtitle: value(source.subtitle || [identifier, source.stateName].filter(Boolean).join(" · ")),
    // Monospace, under the subtitle: the desktop draws the identifier in a
    // 54px mono column and this is the vocabulary's only monospace on a row.
    mono: value(identifier),
    icon: stateIcon(stateType),
    tone: stateTone(stateType),
    onPress: { action: ACTIONS.openIssue, args: { issueId: id } },
  };

  // The state chip. `badge`, not `badgeText` — the reader coerces one and
  // ignores the other, which is the whole reason this function exists.
  const stateName = source.stateName || stateType;
  if (stateName) {
    row.badge = { text: label(stateName), tone: stateTone(stateType), icon: stateIcon(stateType) };
  }

  // `meta` is the row's right-hand line, and it carries whichever of three
  // facts the reader most needs at a glance. A lane wins, because the built-in
  // draws a badge for it and it is the one that changes what pressing the row
  // should do; then the assignee, then the date the desktop puts in its last
  // column.
  // `label`, not `value`: the parser reads `meta` at `maxLabelChars` (200) and
  // `value` clamps to `maxValueChars` (1000), so a heavily labelled issue was
  // cut twice — once here and again by the parser, with its own ellipsis.
  row.meta = label(metaLine(source));

  const actions = [];
  if (options.showLaunch !== false && !source.hasLane) {
    actions.push({
      action: ACTIONS.launchLaneAndAgent,
      args: { issueId: id },
      label: COPY.launchOne,
      kind: "primary",
      icon: "sparkle",
    });
    actions.push({
      action: ACTIONS.launchLaneOnly,
      args: { issueId: id },
      label: COPY.laneOne,
      icon: "git-branch",
    });
  }
  // `{issueId}`, never `{url}` — the DATA half owns `openInLinear` and resolves
  // the URL from this row. See the same note in `issue.js`.
  if (source.url) {
    actions.push({
      action: ACTIONS.openInLinear,
      args: { issueId: id },
      label: COPY.openInLinear,
      kind: "quiet",
      icon: "link",
    });
  }
  // Three is `maxListItemActions`, and a fourth is where a row stops being a
  // row. What does not fit goes behind the overflow control rather than being
  // dropped, because `Assign to me` on a row is the verb a reader reaches for
  // without opening the issue.
  if (actions.length > 0) row.actions = actions.slice(0, 3);
  row.overflow = [
    { action: ACTIONS.assignToMe, args: { issueId: id }, label: COPY.assignToMe, icon: "users" },
    { action: ACTIONS.linkToLane, args: { issueId: id }, label: COPY.linkToLane, icon: "link" },
  ];

  return row;
}

/**
 * The row's right-hand line.
 *
 * Pre-formatted here because rule 3 forbids a schema from joining two fields,
 * and because the priority is the one fact with no slot left: the icon is the
 * state's, the badge is the state's name, and a second badge would be a row
 * that no longer reads at a glance. So a loud priority rides in words.
 */
function metaLine(issue) {
  const parts = [];

  if (issue.hasLane) {
    // The built-in's own tooltip, which says more than its badge does.
    parts.push(issue.laneName ? `Lane: ${issue.laneName}` : COPY.hasLane);
  }

  const priority = priorityEntry(issue.priority);
  if (priority && priority.value !== "0") parts.push(priority.label);

  if (issue.assigneeName) parts.push(issue.assigneeName);

  if (issue.labelNames) parts.push(issue.labelNames);

  return parts.join(" · ");
}

/**
 * One comment, as a row — for a client that binds the thread rather than
 * drawing it as prose.
 *
 * The detail panel draws comments as `markdown` nodes, which is what keeps a
 * code fence in a comment readable. This exists for the same thread read as a
 * bound list, which is what `data.js` stores, and it is the honest fallback: a
 * body flattened to one subtitle line is worse prose and better paging.
 */
function commentListRow(comment) {
  const source = comment && typeof comment === "object" ? comment : {};
  const author = source.userDisplayName || source.userName || COPY.someone;
  const when = source.createdAt ? ` · ${source.createdAt}` : "";
  return {
    key: String(source.id ?? ""),
    title: label(`${author}${when}`),
    subtitle: value(flatten(source.body)),
    icon: "chat",
  };
}

/**
 * Markdown as one line, for a slot that has no room for two.
 *
 * Deliberately crude: it collapses whitespace and nothing else. Stripping
 * markdown properly would be a second parser with its own bugs, and the
 * vocabulary already has the real one — this is the summary line, not the body.
 */
function flatten(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

/**
 * The bare issue id inside a collection key.
 *
 * `flat:000012:<id>` and `group:<stateId>:000003:<id>` both end in the id, and a
 * Linear id holds no colon — so the last segment is the id, and a bare id is
 * already its own last segment. Idempotent on purpose: it runs over keys that
 * may or may not have been dressed, and must not corrupt the ones that were.
 */
function issueIdFromRowKey(key) {
  const text = typeof key === "string" ? key.trim() : "";
  if (!text) return null;
  const index = text.lastIndexOf(":");
  const id = index === -1 ? text : text.slice(index + 1);
  return id || null;
}

module.exports = { commentListRow, flatten, issueIdFromRowKey, issueListRow, metaLine };
