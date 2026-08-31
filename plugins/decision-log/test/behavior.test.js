"use strict";

/**
 * What the plugin actually does, against a host that behaves like the host.
 *
 * The value written to a collection IS the rendered row, so the shape
 * assertions here are the difference between a decision and a blank line on
 * four clients.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { makeHost, settle } = require("./host");
const plugin = require(path.join(__dirname, "..", "index.js"));

async function start(options) {
  const harness = makeHost(options);
  await plugin.activate(harness.host);
  await settle();
  harness.calls.published.length = 0;
  harness.calls.panels.length = 0;
  harness.calls.invokes.length = 0;
  return harness;
}

/** Press the button, answer the question. Two invocations, one action. */
async function logVia(context, text, extra = {}) {
  const first = await plugin.actions.logDecision(Object.assign({ context }, extra));
  if (!first.prompt) return { first, second: null };
  const second = await plugin.actions.logDecision(
    Object.assign({ context }, extra, { prompt: { id: first.prompt.id, text, context: first.prompt.context } }),
  );
  return { first, second };
}

const SESSION = { kind: "session", id: "sess-1", title: "Chat", provider: "claude", status: "idle" };
const SURFACE = { kind: "surface", surface: "app" };

// ---------------------------------------------------------------------------

test("the chat button asks for one line before it writes anything", async () => {
  const harness = await start();
  const first = await plugin.actions.logDecision({ context: SESSION });
  assert.ok(first.prompt, "the first press must ask, not write");
  assert.equal(first.prompt.id, "decision");
  assert.equal((await harness.host.collections.list("decisions", { limit: 100 })).length, 0);
});

test("answering the question stores the decision with its lane and its date", async () => {
  const harness = await start();
  const { second } = await logVia(SESSION, "We're going with Postgres");

  const rows = await harness.host.collections.list("decisions", { limit: 100 });
  assert.equal(rows.length, 1);
  const row = rows[0].value;
  assert.equal(row.title, "We're going with Postgres");
  assert.equal(row.laneId, "lane-a");
  assert.equal(row.laneName, "Search rewrite");
  assert.equal(row.status, "active");
  assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/);
  // The subtitle is the lane and the date, because that is what the user asked
  // to have saved alongside the line.
  assert.match(row.subtitle, /^Search rewrite · /);
  assert.match(second.message, /Search rewrite/);
});

test("the lane's real name is resolved per lane, not from the project-scoped list", async () => {
  // Regression. The first build asked `lane.list`, which is project-scoped and
  // answers a plugin with an empty array rather than an error — so every
  // subtitle silently read "Lane 1b4714f3" and nothing anywhere said why.
  const harness = await start();
  await logVia(SESSION, "We're going with Postgres");

  const [row] = await harness.host.collections.list("decisions", { limit: 100 });
  assert.equal(row.value.laneName, "Search rewrite");
  assert.match(row.value.subtitle, /^Search rewrite · /);
  assert.ok(
    harness.calls.invokes.some((call) => call.action === "getSummary" && call.args.laneId === "lane-a"),
    "the name must be resolved by lane id",
  );
});

test("a renamed lane is corrected on the rows already in the log", async () => {
  const harness = await start();
  await logVia(SESSION, "We're going with Postgres");

  // The lane is renamed out from under the log.
  const lane = (await harness.host.actions.invoke("lane", "getSummary", { laneId: "lane-a" }));
  lane.name = "Search rewrite v2";

  await plugin.actions.refreshLog();
  const [row] = await harness.host.collections.list("decisions", { limit: 100 });
  assert.equal(row.value.laneName, "Search rewrite v2");
  assert.match(row.value.subtitle, /^Search rewrite v2 · /);
});

test("a lane whose name cannot be read still logs, with an honest fallback", async () => {
  const harness = await start({ laneSummaryUnavailable: true });
  const { second } = await logVia(SESSION, "We're going with Postgres");
  assert.ok(second.message, "a name we cannot read must not cost the decision");

  const [row] = await harness.host.collections.list("decisions", { limit: 100 });
  assert.equal(row.value.laneId, "lane-a");
  assert.match(row.value.laneName, /^Lane lane-a/);
  assert.ok(harness.calls.logs.some((line) => line.level === "warn"), "and it says so in the log");
});

test("an empty answer is a real answer, and logs nothing", async () => {
  const harness = await start();
  const { second } = await logVia(SESSION, "   ");
  assert.equal(second.ok, false);
  assert.equal((await harness.host.collections.list("decisions", { limit: 100 })).length, 0);
});

test("the confirmation card names this decision, not the newest one", async () => {
  const harness = await start();
  await logVia(SESSION, "We're going with Postgres");

  const emitted = harness.calls.invokes.find((call) => call.action === "emitAdeCard");
  assert.ok(emitted, "a card must be placed in the transcript");
  const card = emitted.args.card;
  assert.equal(emitted.args.sessionId, "sess-1");
  assert.equal(card.state, "terminal");
  // Required, and it is what a client that has never heard of this variant
  // draws — so it has to be a whole sentence, not a label.
  assert.match(card.fallbackText, /We're going with Postgres/);
  assert.match(card.fallbackText, /Search rewrite/);
  // Regression: `rows` and the panel's `$context` were both observed NOT
  // rendering for a plugin's own (unknown) variant on a real device, while the
  // subtitle drew fine. So the lane and the date have to be in the subtitle,
  // not only in the fields that are meant to carry them.
  assert.match(card.subtitle, /We're going with Postgres/);
  assert.match(card.subtitle, /Search rewrite/);
  // The panel must name a panel a `chat-card` socket declares, or the card
  // draws without it.
  assert.equal(card.panel.panelId, "card");
  assert.equal(card.panel.context.Decision, "We're going with Postgres");
  assert.equal(card.panel.context.Lane, "Search rewrite");
  // Re-emitting the same id merges; minting one per press would stack rows.
  assert.match(card.cardId, /^decision-dec:/);
});

test("the palette entry reads the chat the reader was looking at", async () => {
  const harness = await start();
  const first = await plugin.actions.logDecision({ context: SURFACE, subject: SESSION });
  assert.ok(first.prompt);
  assert.equal(first.prompt.context.sessionId, "sess-1");
  assert.equal(first.prompt.context.laneId, "lane-a");

  await plugin.actions.logDecision({
    context: SURFACE,
    subject: SESSION,
    prompt: { id: "decision", text: "Ship on Friday", context: first.prompt.context },
  });
  const rows = await harness.host.collections.list("decisions", { limit: 100 });
  assert.equal(rows[0].value.laneId, "lane-a");
});

test("the palette says so when there is nothing to log against, rather than guessing", async () => {
  const harness = await start();
  const result = await plugin.actions.logDecision({ context: SURFACE, subject: { kind: "none" } });
  assert.equal(result.ok, false);
  assert.match(result.message, /Open a chat or select a lane/);
  assert.equal(result.prompt, undefined);
  assert.equal((await harness.host.collections.list("decisions", { limit: 100 })).length, 0);
});

test("a lane selected in the palette is logged against without a chat", async () => {
  const harness = await start();
  const subject = { kind: "lane", id: "lane-b", name: "Billing", branch: "b", machineKey: "m", dirty: false };
  const first = await plugin.actions.logDecision({ context: SURFACE, subject });
  await plugin.actions.logDecision({
    context: SURFACE,
    subject,
    prompt: { id: "decision", text: "Stripe, not Adyen", context: first.prompt.context },
  });
  const rows = await harness.host.collections.list("decisions", { limit: 100 });
  assert.equal(rows[0].value.laneName, "Billing");
  // No chat, so no card — a card has to go somewhere.
  assert.equal(harness.calls.invokes.filter((call) => call.action === "emitAdeCard").length, 0);
});

test("decisions read newest-first, because the key carries the order", async () => {
  const harness = await start();
  await logVia(SESSION, "first");
  await new Promise((resolve) => setTimeout(resolve, 2));
  await logVia(SESSION, "second");

  const rows = await harness.host.collections.list("decisions", { limit: 100 });
  assert.equal(rows.length, 2);
  // `list` and a panel binding both read in KEY order, so this ordering is the
  // one four clients will draw.
  assert.equal(rows[0].value.title, "second");
  assert.equal(rows[1].value.title, "first");
});

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

test("a row carries its own reverse verb, behind a confirm", async () => {
  const harness = await start();
  await logVia(SESSION, "We're going with Postgres");
  const [row] = await harness.host.collections.list("decisions", { limit: 100 });

  assert.equal(row.value.overflow.length, 1);
  assert.equal(row.value.overflow[0].action, "reverseDecision");
  assert.equal(row.value.overflow[0].label, "Mark as reversed");
  assert.ok(row.value.overflow[0].confirm, "reversing must ask first");
});

test("reversing marks the decision without removing it from the log", async () => {
  const harness = await start();
  await logVia(SESSION, "We're going with Postgres");
  const [before] = await harness.host.collections.list("decisions", { limit: 100 });

  const result = await plugin.actions.reverseDecision({ key: before.key });
  assert.match(result.message, /reversed/i);

  const [after] = await harness.host.collections.list("decisions", { limit: 100 });
  assert.equal(after.value.status, "reversed");
  assert.deepEqual(after.value.badge, { text: "Reversed", tone: "warning" });
  assert.equal(after.value.tone, "warning");
  assert.equal(after.value.text, "We're going with Postgres", "the decision itself is kept");
  // And it offers the way back, so a mis-tap on a confirm is not permanent.
  assert.equal(after.value.overflow[0].action, "unreverseDecision");

  await plugin.actions.unreverseDecision({ key: before.key });
  const [restored] = await harness.host.collections.list("decisions", { limit: 100 });
  assert.equal(restored.value.status, "active");
  assert.equal(restored.value.badge, undefined);
});

test("reversing a decision that is gone says so instead of writing a new one", async () => {
  const harness = await start();
  const result = await plugin.actions.reverseDecision({ key: "dec:0000000000000:zzzzzz" });
  assert.equal(result.ok, false);
  assert.equal((await harness.host.collections.list("decisions", { limit: 100 })).length, 0);
});

// ---------------------------------------------------------------------------
// Lane badges
// ---------------------------------------------------------------------------

test("a lane with decisions gets a count, and a lane with none gets nothing", async () => {
  const harness = await start();
  await logVia(SESSION, "one");

  const badges = harness.calls.published.filter((call) => call.socket === "row-badge");
  assert.equal(badges.length, 1, "only the lane that has a decision is published for");
  assert.equal(badges[0].entityKind, "lane");
  assert.equal(badges[0].entityId, "lane-a");
  assert.equal(badges[0].payload.text, "1");
  assert.equal(badges[0].payload.id, "count");
  // lane-b has no decisions, so nothing was published for it at all — a
  // declared badge draws no row until something fills it.
  assert.equal(badges.some((call) => call.entityId === "lane-b"), false);
});

test("a badge is republished only when the count actually changed", async () => {
  const harness = await start();
  await logVia(SESSION, "one");
  const afterFirst = harness.calls.published.filter((call) => call.socket === "row-badge").length;

  await plugin.actions.refreshLog();
  const afterRefresh = harness.calls.published.filter((call) => call.socket === "row-badge").length;
  // Rewriting the same badge every tick spends the user's relay allowance on
  // data nobody read.
  assert.equal(afterRefresh, afterFirst);
});

test("reversing the last decision on a lane clears its badge rather than leaving a stale one", async () => {
  const harness = await start();
  await logVia(SESSION, "one");
  const [row] = await harness.host.collections.list("decisions", { limit: 100 });
  harness.calls.published.length = 0;

  await plugin.actions.reverseDecision({ key: row.key });
  const cleared = harness.calls.published.find((call) => call.entityId === "lane-a");
  assert.ok(cleared, "the badge must be revisited");
  assert.equal(cleared.payload, null, "publish null, do not leave a wrong count on screen");
});

// ---------------------------------------------------------------------------
// The Decisions page
// ---------------------------------------------------------------------------

test("the page filters by a relative range and by lane, from state the client owns", async () => {
  const harness = await start();
  await logVia(SESSION, "one");

  const published = harness.calls.panels.filter((call) => call.panelId === "log").pop();
  const [filters, list] = published.schema.body[0].children;

  const range = filters.children.find((node) => node.stateKey === "range");
  assert.deepEqual(range.options.map((option) => option.value), ["", "-7d", "-30d"]);

  assert.deepEqual(list.bind.where, [
    { field: "at", since: { $state: "range" } },
    { field: "laneId", equals: { $state: "lane" } },
  ]);
  // `limit` caps what a node DRAWS, and `maxListItems` is 100.
  assert.equal(list.bind.limit, 100);
});

test("the lane filter appears once there is a lane to filter to, with All first", async () => {
  const harness = await start();
  await logVia(SESSION, "one");

  const published = harness.calls.panels.filter((call) => call.panelId === "log").pop();
  const lane = published.schema.body[0].children[0].children.find((node) => node.stateKey === "lane");
  assert.ok(lane, "a lane filter must be offered");
  assert.equal(lane.options[0].value, "", "an empty value is how a filter says All");
  assert.equal(lane.options[1].label, "Search rewrite");
});

test("past the control's ceiling the page says what it left out", async () => {
  const lanes = Array.from({ length: 9 }, (_, index) => ({ id: `lane-${index}`, name: `Lane ${index}` }));
  const sessions = {};
  for (const lane of lanes) sessions[`sess-${lane.id}`] = { sessionId: `sess-${lane.id}`, laneId: lane.id };
  const harness = await start({ lanes, sessions });

  for (const lane of lanes) {
    await logVia({ kind: "session", id: `sess-${lane.id}` }, `decision in ${lane.name}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  const published = harness.calls.panels.filter((call) => call.panelId === "log").pop();
  const children = published.schema.body[0].children;
  const lane = children[0].children.find((node) => node.stateKey === "lane");
  // 2-8 options per control, and one of them is "All lanes".
  assert.equal(lane.options.length, 8);
  const caption = children.find((node) => node.component === "text");
  assert.ok(caption, "a silent cap reads as 'covered everything' when it did not");
  assert.match(caption.text, /2 older lanes are not in this filter/);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("saving the digest writes the config AND the schedule, in the same press", async () => {
  const harness = await start();
  const result = await plugin.actions.applyDigestSettings({ digestEnabled: true, digestDay: "3" });

  assert.equal(harness.config.digestEnabled, true);
  assert.equal(harness.config.digestDay, "3");
  assert.equal(harness.schedules.length, 1);
  assert.equal(harness.schedules[0].cron, "13 9 * * 3");
  assert.equal(harness.schedules[0].action, "weeklyDigest");
  // This is the whole "takes effect right away without a restart" claim.
  assert.match(result.message, /no restart/i);
});

test("changing the day replaces the schedule rather than stacking a second one", async () => {
  // Regression. The first build deleted `row.scheduleId`, but a schedule row's
  // id field is `id` — so every save left the previous schedule alive and
  // walked toward the 8-live ceiling one day change at a time.
  const harness = await start();
  await plugin.actions.applyDigestSettings({ digestEnabled: true, digestDay: "1" });
  const result = await plugin.actions.applyDigestSettings({ digestEnabled: true, digestDay: "5" });

  assert.match(result.message, /Friday/, "the save must succeed, not refuse on a bad id");
  assert.equal(harness.schedules.length, 1, "8 live schedules is the ceiling; do not leak them");
  assert.equal(harness.schedules[0].cron, "13 9 * * 5");
  assert.deepEqual(harness.calls.schedulesDeleted, ["sched-1"]);
});

test("eight saves in a row still leave exactly one schedule", async () => {
  const harness = await start();
  for (const day of ["1", "2", "3", "4", "5", "6", "0", "1"]) {
    await plugin.actions.applyDigestSettings({ digestEnabled: true, digestDay: day });
  }
  assert.equal(harness.schedules.length, 1);
});

test("turning the digest off removes the standing claim on the clock", async () => {
  const harness = await start();
  await plugin.actions.applyDigestSettings({ digestEnabled: true, digestDay: "1" });
  await plugin.actions.applyDigestSettings({ digestEnabled: false });
  assert.equal(harness.schedules.length, 0);
});

test("the settings section is a form that applies on change, with no Apply button", async () => {
  const harness = await start();
  await plugin.actions.applyDigestSettings({ digestEnabled: true, digestDay: "4" });

  const published = harness.calls.panels.filter((call) => call.panelId === "settings").pop();
  const children = published.schema.body[0].children;
  const form = children.find((node) => node.component === "form");

  // The checklist item is "no restart AND no Apply button", and a `form` is what
  // should express it: labels, help text and a real boolean, none of which the
  // two `segmented` controls this section used to be could carry.
  assert.ok(form, "the settings section is a form");
  assert.equal(form.applyOnChange.action, "applyDigestSettings");
  assert.equal(form.submit, undefined, "a form that applies on change draws no button");
  assert.equal(
    children.some((node) => node.component === "button"),
    false,
    "a settings section that applies on change must have no button to press",
  );

  const toggle = form.fields.find((field) => field.id === "digestEnabled");
  assert.equal(toggle.kind, "toggle");
  assert.equal(toggle.value, true, "it reopens on the value it just wrote");
  assert.ok(toggle.help, "the help text a form gives for free");
  const day = form.fields.find((field) => field.id === "digestDay");
  assert.equal(day.kind, "select");
  assert.equal(day.value, "4");
  assert.equal(day.options.find((option) => option.value === "4").label, "Thursday");
});

test("the day picker is hidden while the digest is off", async () => {
  const harness = await start();
  await plugin.actions.applyDigestSettings({ digestEnabled: false });
  const published = harness.calls.panels.filter((call) => call.panelId === "settings").pop();
  const form = published.schema.body[0].children.find((node) => node.component === "form");
  assert.equal(form.fields.some((field) => field.id === "digestDay"), false);
});

test("turning the digest back on keeps the day it was last set to", async () => {
  const harness = await start();
  await plugin.actions.applyDigestSettings({ digestEnabled: true, digestDay: "6" });
  await plugin.actions.applyDigestSettings({ digestEnabled: false });
  // The day field is not on screen while off, so the change carries no
  // `digestDay` — the stored value has to survive that.
  const result = await plugin.actions.applyDigestSettings({ digestEnabled: true });
  assert.match(result.message, /Saturday/);
  assert.equal(harness.config.digestDay, "6");
});

test("a panel published before the form still applies, reading `state`", async () => {
  // A reader can be looking at a `segmented`-built settings panel published by
  // an older copy of this plugin when the code reloads under them. Their next
  // tap arrives as `state: {digestEnabled: "on"}` and must not read as Off.
  const harness = await start();
  const result = await plugin.actions.applyDigestSettings({ state: { digestEnabled: "on", digestDay: "2" } });
  assert.equal(harness.config.digestEnabled, true);
  assert.equal(harness.config.digestDay, "2");
  assert.match(result.message, /Tuesday/);
});

// ---------------------------------------------------------------------------
// The digest itself
// ---------------------------------------------------------------------------

test("the digest sends one notification inside its ceilings", async () => {
  const harness = await start();
  await logVia(SESSION, "We're going with Postgres");

  const result = await plugin.actions.weeklyDigest();
  assert.equal(harness.calls.notifications.length, 1);
  const sent = harness.calls.notifications[0];
  assert.ok(sent.title.length <= 80, "the title ceiling is 80 characters");
  assert.ok(sent.body.length <= 240, "the body ceiling is 240 characters");
  // A tap has to land somewhere, and only this plugin's own panels are legal.
  assert.equal(sent.deeplink, "ade://plugin/decision-log/log");
  assert.equal(result.count, 1);
});

test("a quiet week sends nothing at all", async () => {
  const harness = await start();
  const result = await plugin.actions.weeklyDigest();
  assert.equal(harness.calls.notifications.length, 0);
  assert.match(result.message, /nothing to send/i);
});

test("a host that cannot notify is a refusal to retry, not a crash", async () => {
  const harness = await start({ notificationsUnavailable: true });
  await logVia(SESSION, "one");
  const result = await plugin.actions.weeklyDigest();
  assert.equal(result.ok, false);
  assert.match(result.message, /could not send/i);
});

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

test("a full store costs the newest decision and nothing else", async () => {
  const harness = await start({ putAlwaysRefuses: true });
  const { second } = await logVia(SESSION, "We're going with Postgres");
  assert.equal(second.ok, false);
  assert.match(second.message, /full/i);
  // The plugin is still alive and still answering.
  assert.deepEqual(await plugin.actions.openLog(), { navigate: { panelId: "log" } });
  assert.ok(harness.calls.logs.some((line) => line.level === "warn"));
});

test("the store is a bounded window, so history does not append forever", async () => {
  const harness = await start();
  // Write past the plugin's own window without going through the prompt each
  // time — this is about retention, not about the button.
  // Seeded in the PAST, so the decision logged below is genuinely the newest
  // and the assertion measures retention rather than the fixture's clock.
  const base = Date.now() - 60_000;
  for (let index = 0; index < 405; index += 1) {
    const stamp = base - index;
    const inverted = String(9999999999999 - stamp).padStart(13, "0");
    await harness.host.collections.put("decisions", `dec:${inverted}:seed${index}`, {
      title: `d${index}`,
      at: new Date(stamp).toISOString(),
      laneId: "",
      status: "active",
      text: `d${index}`,
    });
  }
  await logVia(SESSION, "the newest one");

  const rows = await harness.host.collections.list("decisions", { limit: 1000 });
  assert.equal(rows.length, 400, "the window is held at 400");
  assert.equal(rows[0].value.title, "the newest one", "and it keeps the newest, not the oldest");
});

test("a very long line is truncated for the row but kept whole for the card", async () => {
  const harness = await start();
  const long = `Postgres ${"x".repeat(400)}`;
  await logVia(SESSION, long);

  const [row] = await harness.host.collections.list("decisions", { limit: 100 });
  assert.ok(row.value.title.length <= 200, "a list title has a 200-character ceiling");
  assert.ok(row.value.title.endsWith("…"));
  assert.equal(row.value.text, long, "the decision itself is not lost");
});
