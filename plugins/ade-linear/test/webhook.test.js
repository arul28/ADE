"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  TRIGGER_ASSIGNED,
  TRIGGER_CREATED,
  TRIGGER_ID_REMAP,
  TRIGGER_LABELED,
  TRIGGER_STATUS_CHANGED,
  TRIGGER_UPDATED,
  addedLabelNames,
  createWebhookHandler,
  triggersFor,
} = require("../webhook");
const { createData } = require("../data");
const { createApi, createSdk, issueNode } = require("./support");

/** One Linear webhook body. */
function body(overrides = {}) {
  return {
    action: overrides.action ?? "update",
    type: "Issue",
    data: {
      id: "a",
      identifier: "ENG-1",
      title: "Fix the thing",
      team: { id: "t1", name: "Engineering" },
      project: { id: "p1", name: "Platform" },
      state: { id: "s1", name: "In Progress" },
      assignee: { id: "u1", name: "Ada" },
      labels: [{ id: "l1", name: "bug" }],
      labelIds: ["l1"],
      ...(overrides.data ?? {}),
    },
    ...(overrides.updatedFrom === undefined ? {} : { updatedFrom: overrides.updatedFrom }),
  };
}

/** One `webhook.received` payload as the child sees it. */
function delivery(overrides = {}) {
  return {
    event: "webhook.received",
    id: overrides.id ?? "d1",
    channel: overrides.channel ?? "linear",
    eventType: "Issue",
    receivedAt: "2026-08-31T00:00:00.000Z",
    headers: {},
    body: "bodyText" in overrides ? overrides.bodyText : JSON.stringify(overrides.body ?? body()),
    attempt: overrides.attempt ?? 1,
    ...(overrides.truncated ? { truncated: true } : {}),
  };
}

function build(overrides = {}) {
  const sdk = createSdk(overrides.sdk ?? {});
  const api = createApi({ fetchIssueById: async () => issueNode({ id: "a" }), ...(overrides.api ?? {}) });
  const data = createData({ sdk, api });
  return { sdk, api, data, webhook: createWebhookHandler({ sdk, data }) };
}

describe("which trigger one Linear event implies", () => {
  it("fires created for a create, whatever else the payload says", () => {
    const triggers = triggersFor(body({ action: "create", updatedFrom: { stateName: "Todo" } }));
    assert.deepEqual(triggers.map((t) => t.triggerId), [TRIGGER_CREATED]);
  });

  it("fires assigned when the assignee is NEW", () => {
    const triggers = triggersFor(body({ updatedFrom: { assigneeId: "u0" } }));
    assert.deepEqual(triggers.map((t) => t.triggerId), [TRIGGER_ASSIGNED]);
  });

  it("does not fire assigned for an unassigned issue that changed some other way", () => {
    const triggers = triggersFor(body({ data: { assignee: null }, updatedFrom: { title: "old" } }));
    assert.deepEqual(triggers.map((t) => t.triggerId), [TRIGGER_UPDATED]);
  });

  /**
   * A PORTED DEFECT, asserted so it cannot change by accident.
   *
   * `mapLinearActionToTriggerType` (`linearAutomationDispatch.ts:82`) reads the
   * previous assignee out of `updatedFrom` and treats "absent" as "there was
   * none". Linear's `updatedFrom` carries only the fields that CHANGED, so an
   * edit that did not touch the assignee has no `assigneeId` in it — and any
   * edit to an ALREADY-ASSIGNED issue therefore looks like a new assignment.
   *
   * The consequence is that `issue_status_changed` is close to unreachable for
   * an assigned issue: the assignee branch wins first. This is the built-in's
   * behaviour today, and it is ported unchanged ON PURPOSE — every automation
   * rule a user already has was built against it, and a plugin that quietly
   * fixed it would change what those rules do on the day they migrate. It is
   * reported as a finding rather than repaired here.
   */
  it("fires assigned for ANY edit to an assigned issue — the built-in's own bug", () => {
    assert.deepEqual(
      triggersFor(body({ updatedFrom: { title: "old" } })).map((t) => t.triggerId),
      [TRIGGER_ASSIGNED],
    );
    assert.deepEqual(
      triggersFor(body({ updatedFrom: { state: { name: "Todo" } } })).map((t) => t.triggerId),
      [TRIGGER_ASSIGNED],
    );
  });

  it("fires status_changed and carries the transition when the assignee held still", () => {
    const triggers = triggersFor(body({ updatedFrom: { assigneeId: "u1", state: { name: "Todo" } } }));
    assert.equal(triggers[0].triggerId, TRIGGER_STATUS_CHANGED);
    assert.equal(triggers[0].payload.stateTransition, "Todo->In Progress");
  });

  it("prefers assigned over status_changed when one edit did both", () => {
    // One Linear event can be several things at once, and a rule on "assigned"
    // must fire for the edit that assigned it even though it also moved state.
    const triggers = triggersFor(body({ updatedFrom: { assigneeId: "u0", state: { name: "Todo" } } }));
    assert.deepEqual(triggers.map((t) => t.triggerId), [TRIGGER_ASSIGNED]);
  });

  it("falls through to updated for anything else", () => {
    assert.deepEqual(
      triggersFor(body({ data: { assignee: null }, updatedFrom: {} })).map((t) => t.triggerId),
      [TRIGGER_UPDATED],
    );
  });

  it("reads state off either shape Linear sends", () => {
    const nested = triggersFor(body({ updatedFrom: { assigneeId: "u1", state: { name: "Todo" } } }));
    const flat = triggersFor(body({
      data: { state: undefined, stateName: "In Progress" },
      updatedFrom: { assigneeId: "u1", stateName: "Todo" },
    }));
    assert.equal(nested[0].triggerId, TRIGGER_STATUS_CHANGED);
    assert.equal(flat[0].triggerId, TRIGGER_STATUS_CHANGED);
  });

  it("answers nothing for a payload that names no issue", () => {
    assert.deepEqual(triggersFor({ action: "update", data: {} }), []);
    assert.deepEqual(triggersFor(null), []);
    assert.deepEqual(triggersFor("not an object"), []);
  });
});

describe("the label rule, which is where a naive port double-counts", () => {
  it("fires labeled with ONLY the added label names", () => {
    const triggers = triggersFor(body({
      data: { labelIds: ["l1", "l2"], labels: [{ id: "l1", name: "bug" }, { id: "l2", name: "p1" }] },
      updatedFrom: { labelIds: ["l1"] },
    }));
    assert.equal(triggers[0].triggerId, TRIGGER_LABELED);
    assert.deepEqual(triggers[0].payload.addedLabels, ["p1"]);
    // The matchable set is the ADDED names, so a rule fires once, on add.
    assert.deepEqual(triggers[0].payload.labels, ["p1"]);
  });

  it("SUPPRESSES the updated fallthrough for a pure label add", () => {
    // Firing both would make a rule counting label adds count each one twice.
    // The assignee is held still so the base mapping really is `updated` — see
    // the ported-defect test above for why that matters.
    const triggers = triggersFor(body({
      data: { labelIds: ["l1", "l2"], labels: [{ id: "l1", name: "bug" }, { id: "l2", name: "p1" }] },
      updatedFrom: { assigneeId: "u1", labelIds: ["l1"] },
    }));
    assert.deepEqual(triggers.map((t) => t.triggerId), [TRIGGER_LABELED]);
  });

  it("keeps a concurrent status change beside the labeled event", () => {
    const triggers = triggersFor(body({
      data: { labelIds: ["l1", "l2"], labels: [{ id: "l1", name: "bug" }, { id: "l2", name: "p1" }] },
      updatedFrom: { assigneeId: "u1", labelIds: ["l1"], state: { name: "Todo" } },
    }));
    assert.deepEqual(triggers.map((t) => t.triggerId), [TRIGGER_LABELED, TRIGGER_STATUS_CHANGED]);
  });

  it("never diffs against an ABSENT previous label set", () => {
    // Linear only puts `labelIds` in `updatedFrom` when the label set was part
    // of the change. Diffing against an empty prev set would make every edit
    // look like it added every label.
    assert.deepEqual(addedLabelNames("update", body().data, { title: "old" }), []);
    assert.deepEqual(
      triggersFor(body({ data: { assignee: null }, updatedFrom: { title: "old" } })).map((t) => t.triggerId),
      [TRIGGER_UPDATED],
    );
  });

  it("finds no added labels on a create, which carries no updatedFrom", () => {
    assert.deepEqual(addedLabelNames("create", body().data, null), []);
  });

  it("finds no added labels when a label was REMOVED", () => {
    assert.deepEqual(
      addedLabelNames("update", { labelIds: ["l1"], labels: [{ id: "l1", name: "bug" }] }, { labelIds: ["l1", "l2"] }),
      [],
    );
  });

  it("ignores an added id whose name the payload never gave", () => {
    // A trigger carrying an empty label name matches no rule and reads as a
    // bug in the run log.
    assert.deepEqual(addedLabelNames("update", { labelIds: ["l1", "l9"], labels: [] }, { labelIds: ["l1"] }), []);
  });

  it("reads labels off the nodes shape too", () => {
    assert.deepEqual(
      addedLabelNames(
        "update",
        { labels: { nodes: [{ id: "l1", name: "bug" }, { id: "l2", name: "p1" }] } },
        { labelIds: ["l1"] },
      ),
      ["p1"],
    );
  });
});

describe("the trigger payload a rule matches on", () => {
  it("carries the fields the built-in's rules read", () => {
    const payload = triggersFor(body({ updatedFrom: { assigneeId: "u1", title: "old" } }))[0].payload;
    assert.equal(payload.issueId, "a");
    assert.equal(payload.identifier, "ENG-1");
    assert.equal(payload.title, "Fix the thing");
    assert.equal(payload.team, "Engineering");
    assert.equal(payload.project, "Platform");
    assert.equal(payload.assignee, "Ada");
    assert.equal(payload.state, "In Progress");
    assert.deepEqual(payload.changedFields, ["assigneeId", "title"]);
  });

  it("names the previous state on a status change", () => {
    assert.equal(
      triggersFor(body({ updatedFrom: { assigneeId: "u1", state: { name: "Todo" } } }))[0].payload.previousState,
      "Todo",
    );
  });
});

describe("the remap every existing rule has to survive", () => {
  it("maps each built-in trigger type onto this plugin's namespaced id", () => {
    assert.deepEqual(TRIGGER_ID_REMAP, {
      "linear.issue_created": "plugin:ade-linear/issue_created",
      "linear.issue_updated": "plugin:ade-linear/issue_updated",
      "linear.issue_assigned": "plugin:ade-linear/issue_assigned",
      "linear.issue_status_changed": "plugin:ade-linear/issue_status_changed",
      "linear.issue_labeled": "plugin:ade-linear/issue_labeled",
    });
  });

  it("covers every trigger this plugin can emit", () => {
    const emitted = new Set([
      TRIGGER_CREATED, TRIGGER_UPDATED, TRIGGER_ASSIGNED, TRIGGER_STATUS_CHANGED, TRIGGER_LABELED,
    ]);
    const mapped = new Set(Object.values(TRIGGER_ID_REMAP).map((id) => id.split("/")[1]));
    assert.deepEqual([...emitted].sort(), [...mapped].sort());
  });

  it("is frozen, so a caller cannot rewrite the migration table", () => {
    assert.equal(Object.isFrozen(TRIGGER_ID_REMAP), true);
  });
});

describe("handling one delivery", () => {
  it("refetches the issue, emits the triggers, and acks — in that order", async () => {
    const { sdk, webhook } = build();
    await webhook.handle(delivery({ body: body({ updatedFrom: { assigneeId: "u1", state: { name: "Todo" } } }) }));
    const order = sdk.calls
      .map(([name]) => name)
      .filter((name) => name === "automations.emitTrigger" || name === "webhooks.ack");
    // The ack is LAST: an unacked delivery is redelivered on the next drain
    // tick, which is what a handler that died halfway wants.
    assert.deepEqual(order, ["automations.emitTrigger", "webhooks.ack"]);
  });

  it("refetches over GraphQL rather than writing the webhook's own version", async () => {
    // A webhook body has no children, no label colours and no creator, so half
    // the row's fields would blank out on every update.
    let fetched = null;
    const { sdk, webhook } = build({ api: { fetchIssueById: async (id) => { fetched = id; return issueNode({ id }); } } });
    await webhook.handle(delivery());
    assert.equal(fetched, "a");
    assert.equal(sdk.collections.value("issues", "issue:a").creatorName, "Grace H");
  });

  it("acts once on a redelivery, but acks again", async () => {
    const { sdk, webhook } = build();
    await webhook.handle(delivery({ id: "d1" }));
    const result = await webhook.handle(delivery({ id: "d1", attempt: 2 }));
    assert.equal(result.duplicate, true);
    // Arriving twice means the previous ack was lost; not re-acking would
    // leave it arriving forever.
    assert.equal(sdk.calls.filter(([name]) => name === "webhooks.ack").length, 2);
    assert.equal(sdk.calls.filter(([name]) => name === "automations.emitTrigger").length, 1);
  });

  it("records the delivery id in a collection, so a restart does not re-fire", async () => {
    const { sdk, webhook } = build();
    await webhook.handle(delivery({ id: "d1" }));
    assert.ok(sdk.collections.value("deliveries", "id:d1"));
    assert.equal(await webhook.seen("d1"), true);
  });

  it("acks and drops a body it cannot parse", async () => {
    // An unparseable body will not parse on the redelivery either, and leaving
    // it unacked makes it arrive on every drain tick.
    const { sdk, webhook } = build();
    const result = await webhook.handle(delivery({ bodyText: "not json {{{" }));
    assert.equal(result.unreadable, true);
    assert.equal(sdk.calls.filter(([name]) => name === "webhooks.ack").length, 1);
    assert.equal(sdk.calls.filter(([name]) => name === "automations.emitTrigger").length, 0);
  });

  it("still refetches an issue whose body the host clipped past parsing", async () => {
    // The host clamps a body at 64 KiB by code unit, so a big delivery arrives
    // cut mid-JSON: it cannot parse, and the whole delivery used to end here —
    // no refetch, no triggers — while the comment beside it promised the row
    // would be right either way. Linear puts `data.id` ahead of the fields long
    // enough to reach the cap, so the id survives the clip and the ROW can
    // still be made right. Only the triggers are lost.
    const { sdk, webhook } = build();
    const clipped = JSON.stringify(body({ data: { id: "issue-77" } })).slice(0, 60);
    const result = await webhook.handle(delivery({ bodyText: clipped, truncated: true }));

    assert.equal(result.clipped, true);
    assert.equal(result.issueId, "issue-77");
    assert.ok(sdk.collections.value("issues", "issue:a"), "the issue was never refetched");
    assert.equal(sdk.calls.filter(([name]) => name === "webhooks.ack").length, 1);
    // The triggers are what the clip actually destroyed, so none are invented.
    assert.equal(sdk.calls.filter(([name]) => name === "automations.emitTrigger").length, 0);
  });

  it("drops a clipped body that lost its issue id too", async () => {
    const { sdk, webhook } = build();
    const result = await webhook.handle(delivery({ bodyText: '{"action":"upd', truncated: true }));
    assert.equal(result.unreadable, true);
    assert.equal(sdk.calls.filter(([name]) => name === "webhooks.ack").length, 1);
  });

  it("keeps only the newest delivery ids, against a budget the whole plugin shares", async () => {
    // `evictOldest` evicts inside THIS collection but against the plugin's
    // whole row budget, so an ingress that ran for a year did not push out old
    // delivery ids — it exhausted the budget, and then every issue write could
    // only make room by evicting ISSUE rows. The list quietly emptied.
    const { sdk, webhook } = build();
    for (let index = 0; index < 540; index += 1) {
      await webhook.remember(`d${String(index).padStart(4, "0")}`, {
        at: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      });
    }
    const kept = sdk.collections.keys("deliveries");
    assert.equal(kept.length, 500);
    // The oldest went and the newest stayed, by recorded time — a delivery id
    // is a random string and sorts in no useful order at all.
    assert.ok(!kept.includes("id:d0000"), "the oldest id was kept");
    assert.ok(kept.includes("id:d0539"), "the newest id was dropped");
  });

  it("ignores a delivery on somebody else's channel", async () => {
    const { sdk, webhook } = build();
    assert.equal((await webhook.handle(delivery({ channel: "stripe" }))).ignored, "channel");
    assert.equal(sdk.calls.filter(([name]) => name === "webhooks.ack").length, 0);
  });

  it("ignores a delivery with no id, which there is nothing to ack", async () => {
    const { webhook } = build();
    assert.equal((await webhook.handle({ channel: "linear", body: "{}" })).ignored, "no-id");
  });

  it("still refetches and acks a body the relay clipped", async () => {
    // The ROW is right either way; only the trigger may be coarser.
    const { sdk, webhook } = build();
    const result = await webhook.handle(delivery({ truncated: true }));
    assert.equal(result.issueId, "a");
    assert.equal(sdk.calls.filter(([name]) => name === "webhooks.ack").length, 1);
  });

  it("acks even when the refetch failed, because the redelivery would too", async () => {
    const { sdk, webhook } = build({ api: { fetchIssueById: async () => { throw new Error("Linear is down"); } } });
    await webhook.handle(delivery());
    assert.equal(sdk.calls.filter(([name]) => name === "webhooks.ack").length, 1);
  });

  it("does not let one refused trigger cost the others or the ack", async () => {
    const { sdk, webhook } = build({ sdk: { emitTriggerThrows: true } });
    const result = await webhook.handle(delivery({
      body: body({
        data: { labelIds: ["l1", "l2"], labels: [{ id: "l1", name: "bug" }, { id: "l2", name: "p1" }] },
        updatedFrom: { assigneeId: "u1", labelIds: ["l1"], state: { name: "Todo" } },
      }),
    }));
    assert.deepEqual(result.triggers, ["issue_labeled", "issue_status_changed"]);
    assert.equal(sdk.calls.filter(([name]) => name === "automations.emitTrigger").length, 2);
    assert.equal(sdk.calls.filter(([name]) => name === "webhooks.ack").length, 1);
  });

  it("emits under the plugin's own trigger ids, unnamespaced — the host namespaces them", async () => {
    const { sdk, webhook } = build();
    await webhook.handle(delivery({ body: body({ action: "create" }) }));
    const emitted = sdk.calls.filter(([name]) => name === "automations.emitTrigger").map(([, id]) => id);
    assert.deepEqual(emitted, ["issue_created"]);
  });

  it("never throws, whatever arrives", async () => {
    const { webhook } = build();
    for (const payload of [{}, null, { channel: "linear" }, delivery({ bodyText: "" })]) {
      await assert.doesNotReject(() => webhook.handle(payload));
    }
  });
});
