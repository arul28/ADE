// One Linear webhook: parse it, refetch what it named, fire the triggers, ack.
//
// The order matters and is not the obvious one. The ack comes LAST, after the
// refetch and after the triggers, because an unacked delivery is redelivered on
// the next drain tick and that is exactly the behaviour a handler that died
// halfway wants. Acking on receipt would turn every crash into a lost event.
//
// ## Why the payload is a hint and never the data
//
// Linear's webhook body carries the issue as it was at the moment of the
// change, and this plugin's collections carry the issue as every client draws
// it. Writing the webhook's version into the rows would mean the row shape
// depends on which of the two paths last touched it — a webhook body has no
// `children`, no `labels.nodes` colour, and no `creator`, so half the fields
// would blank out on every update and come back on the next manual refresh.
//
// So the body is read for two things only: WHICH issue changed, and WHAT KIND
// of change it was. The row itself is refetched over GraphQL, where the field
// set is the one `ISSUE_FIELDS` names.
//
// ## The triggers are a port, not a redesign
//
// `linearAutomationDispatch.ts:82` decides which of the five trigger types one
// Linear event implies, including the rule that a pure label add fires
// `issue_labeled` and SUPPRESSES the `issue_updated` it would otherwise fall
// through to. That rule is ported here exactly: a user whose automation counted
// once per label add must keep counting once.

"use strict";

/** The plugin's five triggers. The manifest declares these ids. */
/**
 * How many delivery ids this plugin keeps, and the slack it lists over.
 *
 * The ids exist to make a REDELIVERY idempotent, and a relay redelivers within
 * minutes — so a few hundred is generous and the row budget is 4,000 for the
 * whole plugin. The slack is what makes the prune see that it is over.
 */
const DELIVERY_MEMORY = 500;
const DELIVERY_SLACK = 64;

const TRIGGER_CREATED = "issue_created";
const TRIGGER_UPDATED = "issue_updated";
const TRIGGER_ASSIGNED = "issue_assigned";
const TRIGGER_STATUS_CHANGED = "issue_status_changed";
const TRIGGER_LABELED = "issue_labeled";

/**
 * The remap every automation rule built against the built-in has to survive.
 *
 * The built-in's trigger types are `linear.issue_created` and friends, chosen
 * by `triggerCatalog.ts:82`. A plugin's are namespaced by the host from
 * `plugin:<pluginId>/<triggerId>`, so the same trigger has a different name
 * under the plugin and every existing rule points at the old one.
 *
 * This table is the migration, and it is exported rather than inlined so the
 * core-removal change can read it instead of re-deriving it. Nothing here
 * performs the remap — a rule belongs to the user and rewriting one silently
 * is not a thing a plugin may do.
 */
const TRIGGER_ID_REMAP = Object.freeze({
  "linear.issue_created": "plugin:ade-linear/issue_created",
  "linear.issue_updated": "plugin:ade-linear/issue_updated",
  "linear.issue_assigned": "plugin:ade-linear/issue_assigned",
  "linear.issue_status_changed": "plugin:ade-linear/issue_status_changed",
  "linear.issue_labeled": "plugin:ade-linear/issue_labeled",
});

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** `data.state.name` or `data.stateName`, the two shapes Linear sends. */
function nestedName(source, key) {
  const nested = record(source?.[key]);
  return text(nested?.name) ?? text(source?.[`${key}Name`]);
}

function nestedId(source, key) {
  const nested = record(source?.[key]);
  return text(nested?.id) ?? text(source?.[`${key}Id`]);
}

/** Label ids off either `labelIds: []` or `labels: {nodes: [{id}]}`. */
function labelIds(source) {
  if (Array.isArray(source?.labelIds)) return source.labelIds.filter((id) => typeof id === "string");
  const raw = source?.labels;
  const nodes = Array.isArray(raw) ? raw : Array.isArray(record(raw)?.nodes) ? record(raw).nodes : [];
  return nodes.map((node) => text(record(node)?.id)).filter(Boolean);
}

/** `{id: name}` for every label the payload names, so an added id becomes a word. */
function labelNamesById(source) {
  const raw = source?.labels;
  const nodes = Array.isArray(raw) ? raw : Array.isArray(record(raw)?.nodes) ? record(raw).nodes : [];
  const map = new Map();
  for (const node of nodes) {
    const entry = record(node);
    const id = text(entry?.id);
    const name = text(entry?.name);
    if (id && name) map.set(id, name);
  }
  return map;
}

/**
 * Which of the five triggers one event implies, before the label rule.
 *
 * A direct port of `mapLinearActionToTriggerType`
 * (`linearAutomationDispatch.ts:82`), including the precedence: a create wins
 * over everything, then a NEW assignee, then a state change, then the generic
 * update. The precedence is not arbitrary — one Linear event can be all three
 * at once, and a rule on "assigned" must fire for the edit that assigned it
 * even though the same edit also changed the state.
 */
function baseTrigger(action, data, previous) {
  if (action === "create") {
    return { triggerId: TRIGGER_CREATED, stateTransition: null, previousState: null };
  }
  const currentState = nestedName(data, "state");
  const previousState = nestedName(previous, "state");
  const previousAssignee = nestedId(previous, "assignee");
  const currentAssignee = nestedId(data, "assignee");
  if (currentAssignee && currentAssignee !== previousAssignee) {
    return { triggerId: TRIGGER_ASSIGNED, stateTransition: null, previousState };
  }
  if (currentState && previousState && currentState !== previousState) {
    return {
      triggerId: TRIGGER_STATUS_CHANGED,
      stateTransition: `${previousState}->${currentState}`,
      previousState,
    };
  }
  return { triggerId: TRIGGER_UPDATED, stateTransition: null, previousState };
}

/**
 * Labels this event ADDED, by id.
 *
 * Only meaningful on an update, and only when Linear put `labelIds` in
 * `updatedFrom` — its absence means the label set was not part of this change.
 * Diffing against an absent previous set would make every edit look like it
 * added every label, which is the bug the built-in's comment warns about.
 *
 * By ID rather than by name, because the ids are what the label FILTER needs:
 * the tile's option value is `label:<rank>:<labelId>`, and a name cannot be
 * turned back into one. The names are still what a rule's prompt prints, which
 * is {@link addedLabelNames} below.
 */
function addedLabelIds(action, data, previous) {
  if (action === "create" || !previous) return [];
  if (!Array.isArray(previous.labelIds)) return [];
  const before = new Set(labelIds(previous));
  return labelIds(data).filter((id) => !before.has(id));
}

/** The same labels, as words. Kept as its own export: it is what a reader reads. */
function addedLabelNames(action, data, previous) {
  const names = labelNamesById(data);
  return addedLabelIds(action, data, previous).map((id) => names.get(id)).filter(Boolean);
}

/**
 * The values one declarative filter will match, for one fact.
 *
 * ## The bug this exists for
 *
 * Every one of the tile's five filters is a `select` bound to one of this
 * plugin's collections. The HOST builds each option's value from the collection
 * ROW KEY (`PluginAutomationTriggerTiles.tsx`), and `automationService` matches
 * a rule's saved filter against `payload[key]` by string equality. The payload
 * carried DISPLAY NAMES — "Engineering", "In Progress" — while the rule carried
 * `team:9f3…` or `team:ENG:000002:s-doing`. Nothing could ever be equal, and
 * the matcher fails CLOSED, so every rule anyone built on this tile silently
 * never fired.
 *
 * ## Why a list rather than one value
 *
 * The matcher takes membership when the payload sends an array, and a filter
 * can arrive spelled three ways: the row key (a reader who picked from the
 * menu), the bare id, or the display name (a reader who typed into the text box
 * the tile degrades to when a collection is empty or unreadable — which is
 * every hosted-web reader, because a trigger grid opens no panel). All three
 * name the same thing, so all three belong in the answer. Duplicates and blanks
 * are dropped, and an empty list means the event carried no such fact.
 */
function filterValues(...values) {
  const out = [];
  for (const value of values) {
    const trimmed = text(value);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * The stored collection key for a state id or a label id.
 *
 * These two key spaces carry a RANK — `team:<teamKey>:000002:<stateId>` and
 * `label:000007:<labelId>` — because `collections.list` orders by key and
 * nothing else, so the rank IS the order a bound picker draws. A webhook body
 * cannot know it. The rank cannot move into the row value either: the tile's
 * option value is the key, and the picker's order is the key.
 *
 * So the keys are looked up rather than derived, from the plugin's own stored
 * rows. Two small local reads per delivery, on a path that already spends a
 * round trip refetching the issue over GraphQL.
 */
async function collectionKeysById(sdk, collection, keyPrefix) {
  const rows = await sdk.collections
    .list(collection, { keyPrefix, limit: 500 })
    .catch(() => []);
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = text(record(row?.value)?.id);
    const key = text(row?.key);
    if (id && key && !byId.has(id)) byId.set(id, key);
  }
  return byId;
}

/**
 * Every trigger one Linear delivery implies.
 *
 * Returns a list because one event genuinely is two: an edit that adds a label
 * AND reassigns the issue fires both `issue_labeled` and `issue_assigned`. The
 * one case that is NOT two is a pure label add — its base mapping falls
 * through to `issue_updated`, and firing both would make a rule counting label
 * adds count each one twice.
 *
 * `keys` carries the two key spaces a body cannot derive (see
 * {@link collectionKeysById}). It is optional so this stays a pure function of
 * the body: without it the state and label filters still match an id or a name,
 * which is what a reader typing into the degraded text box wrote.
 */
function triggersFor(payload, keys = {}) {
  const body = record(payload);
  if (!body) return [];
  const data = record(body.data);
  const previous = record(body.updatedFrom);
  const action = text(body.action);
  const issueId = text(data?.id) ?? text(body.issueId);
  if (!issueId) return [];

  const identifier = text(data?.identifier);
  const base = baseTrigger(action, data, previous);
  const addedIds = addedLabelIds(action, data, previous);
  const labelNames = labelNamesById(data);
  const added = addedIds.map((id) => labelNames.get(id)).filter(Boolean);

  const stateKeys = keys.states instanceof Map ? keys.states : new Map();
  const labelKeys = keys.labels instanceof Map ? keys.labels : new Map();

  const teamId = nestedId(data, "team");
  const teamKey = text(record(data?.team)?.key);
  const projectId = nestedId(data, "project");
  const assigneeId = nestedId(data, "assignee");
  const stateId = nestedId(data, "state");

  const labelFilter = (ids) => {
    const out = [];
    for (const id of ids) {
      for (const value of filterValues(labelKeys.get(id), id, labelNames.get(id))) {
        if (!out.includes(value)) out.push(value);
      }
    }
    return out;
  };

  const context = {
    issueId,
    identifier,
    title: text(data?.title),

    // ── The five declarative filters ──────────────────────────────────────
    //
    // Named exactly as `plugin.json`'s `filters[].key` names them, because the
    // host looks each rule's saved value up under that name and nothing else.
    // The KEY-shaped spelling comes first in each list: it is what the tile's
    // menu writes, and it is the one this used to get wrong.
    project: filterValues(projectId ? `project:${projectId}` : null, projectId, nestedName(data, "project")),
    team: filterValues(teamId ? `team:${teamId}` : null, teamId, teamKey, nestedName(data, "team")),
    assignee: filterValues(assigneeId ? `user:${assigneeId}` : null, assigneeId, nestedName(data, "assignee")),
    state: filterValues(stateKeys.get(stateId), stateId, nestedName(data, "state")),
    label: labelFilter([...labelNames.keys()]),

    // ── What a prompt and a ledger read ───────────────────────────────────
    //
    // The display names, kept beside the filters rather than instead of them.
    // A rule's prompt interpolates these; a filter never should, because a
    // workspace can rename a team without meaning to switch a rule off.
    teamName: nestedName(data, "team"),
    projectName: nestedName(data, "project"),
    assigneeName: nestedName(data, "assignee"),
    stateName: nestedName(data, "state"),
    previousState: base.previousState,
    labels: [...labelNames.values()],
    changedFields: previous ? Object.keys(previous) : [],
    action,
  };

  const triggers = [];
  if (added.length > 0) {
    triggers.push({
      triggerId: TRIGGER_LABELED,
      payload: {
        ...context,
        addedLabels: added,
        labels: added,
        // A labeled rule filters on the label that was just ADDED, not on the
        // issue's whole set — the same one-shot rule `automationService` states
        // for `linear.issue_labeled`.
        label: labelFilter(addedIds),
        stateTransition: null,
      },
    });
  }
  const suppressBase = added.length > 0 && base.triggerId === TRIGGER_UPDATED;
  if (!suppressBase) {
    triggers.push({
      triggerId: base.triggerId,
      payload: { ...context, stateTransition: base.stateTransition },
    });
  }
  return triggers;
}

/**
 * Build the webhook handler.
 *
 * `sdk`, `data` and `log` are injected, so the whole path — parse, dedupe,
 * refetch, emit, ack — is testable with no relay, no Linear and no host.
 */
/**
 * The issue id out of a body that was clipped past parsing.
 *
 * Linear puts `data.id` at the front of the object, ahead of `description` and
 * `updatedFrom` — the two fields long enough to reach a 64 KiB cap — so the id
 * is in the surviving prefix even when the closing brace is not. Read with a
 * pattern rather than a parser because there is nothing here a parser can read;
 * anchored on `"data"` so it cannot pick up the actor's id instead.
 */
function issueIdFromClippedBody(raw) {
  if (typeof raw !== "string") return null;
  const scoped = /"data"\s*:\s*\{\s*"id"\s*:\s*"([^"]{1,128})"/.exec(raw);
  if (scoped) return scoped[1];
  const top = /"issueId"\s*:\s*"([^"]{1,128})"/.exec(raw);
  return top ? top[1] : null;
}

function createWebhookHandler(options = {}) {
  const { sdk, data, log = () => {} } = options;
  if (!sdk || !data) throw new TypeError("createWebhookHandler needs sdk and data");

  /**
   * Deliveries already acted on.
   *
   * A collection rather than a Set, because the child restarts and a redelivery
   * after a restart would otherwise fire every automation a second time.
   *
   * ## Why this prunes itself
   *
   * `evictOldest` is NOT the bound this once claimed. The host evicts within
   * the collection it was asked to write, but the budget it evicts against is
   * the whole plugin's (`PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN`), so a year of
   * deliveries does not push out old delivery ids — it exhausts the budget and
   * then every issue write can only make room by evicting ISSUE rows. The
   * symptom is a warn line per row and an issue list that quietly empties.
   *
   * So the cap is the plugin's own. `DELIVERY_MEMORY` ids is far more than a
   * redelivery window needs and a small fraction of the row budget.
   */
  async function seen(deliveryId) {
    return Boolean(await sdk.collections.get("deliveries", `id:${deliveryId}`).catch(() => null));
  }

  /** Drop the oldest ids once there are more than the plugin keeps. */
  async function pruneDeliveries() {
    const rows = await sdk.collections
      .list("deliveries", { keyPrefix: "id:", limit: DELIVERY_MEMORY + DELIVERY_SLACK })
      .catch(() => []);
    if (rows.length <= DELIVERY_MEMORY) return;
    // By the recorded time, not by key: a delivery id is a random string and
    // sorts in no useful order at all.
    const oldest = [...rows]
      .sort((a, b) => String(a.value?.at ?? "").localeCompare(String(b.value?.at ?? "")))
      .slice(0, rows.length - DELIVERY_MEMORY);
    for (const row of oldest) {
      await sdk.collections.delete("deliveries", row.key).catch(() => {});
    }
  }

  async function remember(deliveryId, value) {
    await sdk.collections
      .put("deliveries", `id:${deliveryId}`, value, { ifFull: "evictOldest" })
      .catch((error) => {
        // A delivery id that could not be recorded is one automation that may
        // fire twice if the ack is also lost. Worth a line, never worth failing
        // the delivery — the refetch already landed.
        log("warn", `Could not record delivery ${deliveryId}: ${error?.message ?? error}`);
      });
    await pruneDeliveries();
  }

  /**
   * Handle one `webhook.received`.
   *
   * Never throws. A delivery this plugin cannot make sense of is acked and
   * dropped, because an unparseable body will not parse on the redelivery
   * either and leaving it unacked would make it arrive on every drain tick for
   * as long as the ledger keeps it.
   */
  async function handle(payload) {
    if (payload?.channel !== "linear") return { ignored: "channel" };
    const deliveryId = text(payload?.id);
    if (!deliveryId) return { ignored: "no-id" };

    if (await seen(deliveryId)) {
      // Already acted on. Ack again anyway: arriving twice means the previous
      // ack was lost, and not re-acking would leave it arriving forever.
      await sdk.webhooks.ack(deliveryId).catch(() => {});
      return { duplicate: true, deliveryId };
    }

    let body = null;
    try {
      body = payload?.body ? JSON.parse(payload.body) : null;
    } catch {
      body = null;
    }
    if (!record(body)) {
      // A body clipped at the host's 64 KiB cap is cut mid-JSON, so it cannot
      // parse and lands HERE rather than in the `truncated` branch below. That
      // used to end the delivery: no refetch, no triggers, acked and gone —
      // while the comment beside it promised the row would be right either way.
      //
      // It can still be made right. The issue id sits at the front of Linear's
      // body, before any field long enough to reach the cap, so the id survives
      // the clip even when the JSON does not. The row is refetched from Linear
      // and is therefore CORRECT; only the triggers are lost, because what
      // changed is exactly the part that was cut off.
      const clippedIssueId = payload.truncated ? issueIdFromClippedBody(payload.body) : null;
      if (clippedIssueId) {
        log("warn", `Linear delivery ${deliveryId} was clipped past parsing; refetching ${clippedIssueId} without its triggers.`);
        const result = await data.refreshIssue(clippedIssueId, { comments: false }).catch((error) => ({
          ok: false,
          error: error?.message ?? String(error),
        }));
        if (!result?.ok) {
          log("warn", `Could not refetch ${clippedIssueId} after a clipped webhook: ${result?.error ?? "unknown"}`);
        }
        await remember(deliveryId, { at: new Date().toISOString(), issueId: clippedIssueId, clipped: true });
        await sdk.webhooks.ack(deliveryId).catch(() => {});
        return { clipped: true, issueId: clippedIssueId, deliveryId };
      }
      log("warn", `Linear delivery ${deliveryId} had a body this plugin could not read.`);
      await remember(deliveryId, { at: new Date().toISOString(), unreadable: true });
      await sdk.webhooks.ack(deliveryId).catch(() => {});
      return { unreadable: true, deliveryId };
    }

    // A body the relay clipped at the cap but that still parsed is one whose
    // `updatedFrom` may be missing, which would turn a label add into a plain
    // update. The issue is still refetched — the ROW is right either way — and
    // the triggers are emitted from what did arrive, which is the honest
    // smaller version.
    if (payload.truncated) {
      log("warn", `Linear delivery ${deliveryId} was clipped at the size cap; its triggers may be coarser.`);
    }

    // The two key spaces the tile's state and label filters are written in.
    // Read BEFORE the triggers are built, because the trigger payload carries
    // them: a rule whose filter came out of the menu is matched on the row key,
    // and a body cannot derive one. Both degrade to an empty map, which leaves
    // those two filters matching an id or a name rather than nothing.
    const [stateKeys, labelKeys] = await Promise.all([
      collectionKeysById(sdk, "states", "team:"),
      collectionKeysById(sdk, "labels", "label:"),
    ]);
    const triggers = triggersFor(body, { states: stateKeys, labels: labelKeys });
    const issueId = text(record(body.data)?.id) ?? text(body.issueId);

    // The refetch FIRST, so a rule that reads the plugin's collections sees the
    // issue as it now is rather than as it was one event ago.
    if (issueId) {
      const result = await data.refreshIssue(issueId, { comments: false }).catch((error) => ({
        ok: false,
        error: error?.message ?? String(error),
      }));
      if (!result?.ok) {
        log("warn", `Could not refetch ${issueId} after a webhook: ${result?.error ?? "unknown"}`);
      }
    }

    for (const trigger of triggers) {
      try {
        await sdk.automations.emitTrigger({ triggerId: trigger.triggerId, payload: trigger.payload });
      } catch (error) {
        // One trigger the host refused must not cost the others, and must not
        // cost the ack: the issue row is already updated and a redelivery would
        // only re-emit the triggers that DID work.
        log("warn", `Could not emit ${trigger.triggerId}: ${error?.message ?? error}`);
      }
    }

    await remember(deliveryId, {
      at: new Date().toISOString(),
      issueId,
      triggers: triggers.map((trigger) => trigger.triggerId),
    });
    await sdk.webhooks.ack(deliveryId).catch((error) => {
      // An ack that failed means one redelivery, which the `deliveries` row
      // above now makes a no-op. Not worth failing anything.
      log("debug", `Could not ack ${deliveryId}: ${error?.message ?? error}`);
    });

    return { deliveryId, issueId, triggers: triggers.map((trigger) => trigger.triggerId) };
  }

  return { handle, remember, seen, triggersFor };
}

module.exports = {
  TRIGGER_ASSIGNED,
  TRIGGER_CREATED,
  TRIGGER_ID_REMAP,
  TRIGGER_LABELED,
  TRIGGER_STATUS_CHANGED,
  TRIGGER_UPDATED,
  addedLabelIds,
  addedLabelNames,
  baseTrigger,
  createWebhookHandler,
  triggersFor,
};
