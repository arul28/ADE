"use strict";

/**
 * The cross-file agreements the manifest parser cannot check.
 *
 * Each of these parses clean and contributes nothing at runtime: a socket
 * naming an action nobody exported is a button that does nothing, a
 * `refreshAction` the host does not recognise costs the refresh gesture
 * silently, and a collection the code writes but the manifest never declared
 * is refused rather than created.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
const plugin = require(path.join(root, "index.js"));
const source = fs.readFileSync(path.join(root, "index.js"), "utf8");

const actionNames = Object.keys(plugin.actions);

test("the entry module exports the lifecycle the child bootstrap requires", () => {
  assert.equal(typeof plugin.activate, "function");
  assert.equal(typeof plugin.deactivate, "function");
  assert.equal(typeof plugin.actions, "object");
});

test("every socket actionId is really an exported action", () => {
  for (const socket of manifest.sockets) {
    if (!socket.actionId) continue;
    assert.ok(
      actionNames.includes(socket.actionId),
      `socket ${socket.id} names action ${socket.actionId}, which is not exported`,
    );
  }
});

test("every split-button menu entry names an exported action", () => {
  for (const socket of manifest.sockets) {
    for (const entry of socket.menu ?? []) {
      assert.ok(
        actionNames.includes(entry.actionId),
        `menu entry "${entry.label}" names ${entry.actionId}, which is not exported`,
      );
    }
  }
});

test("every panel refreshAction is an exported action, and every schemaFile exists", () => {
  for (const panel of manifest.panels) {
    if (panel.refreshAction) {
      assert.ok(
        actionNames.includes(panel.refreshAction),
        `panel ${panel.id} names refreshAction ${panel.refreshAction}, which is not exported`,
      );
    }
    if (panel.schemaFile) {
      assert.ok(fs.existsSync(path.join(root, panel.schemaFile)), `${panel.schemaFile} is missing`);
    }
  }
});

test("every panelId a socket or surface names is a declared panel", () => {
  const panelIds = new Set(manifest.panels.map((panel) => panel.id));
  for (const socket of manifest.sockets) {
    if (!socket.panelId) continue;
    assert.ok(panelIds.has(socket.panelId), `socket ${socket.id} names unknown panel ${socket.panelId}`);
  }
  for (const surface of manifest.surfaces) {
    assert.ok(panelIds.has(surface.panelId), `surface ${surface.id} names unknown panel ${surface.panelId}`);
  }
});

test("every CLI word is an exported action", () => {
  for (const word of manifest.cli) {
    assert.ok(actionNames.includes(word), `cli word ${word} has no action`);
  }
});

test("every collection the code touches is declared in the manifest", () => {
  const declared = new Set(Object.keys(manifest.collections));
  // `$context` and `$state` are reserved bindings, never real collections.
  const used = new Set(
    [...source.matchAll(/collections\.(?:get|put|delete|list)\(\s*"([^"]+)"/g)].map((match) => match[1]),
  );
  for (const name of used) {
    assert.ok(declared.has(name), `code uses collection "${name}", which the manifest does not declare`);
  }
});

test("the log panel binds only actions it allows", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "panels/log.json"), "utf8"));
  const list = schema.body[0].children[1];
  assert.equal(list.component, "list");
  for (const action of list.bind.allowActions) {
    assert.ok(actionNames.includes(action), `allowActions names ${action}, which is not exported`);
  }
  // The row's own overflow is built in code; keep the two lists in agreement.
  assert.ok(list.bind.allowActions.includes("reverseDecision"));
  assert.ok(list.bind.allowActions.includes("unreverseDecision"));
});

test("every panel schema declares the required fallback", () => {
  for (const panel of manifest.panels) {
    const schema = JSON.parse(fs.readFileSync(path.join(root, panel.schemaFile), "utf8"));
    assert.equal(schema.v, 1);
    assert.ok(schema.fallback && schema.fallback.title, `${panel.id} has no fallback title`);
    assert.ok(schema.fallback.text, `${panel.id} has no fallback text`);
    // A surface that cannot draw the body still has to get the reader somewhere.
    assert.match(schema.fallback.deeplink, /^ade:\/\/plugin\/decision-log\//);
  }
});

test("the chat button's colour is the one that clears the 3:1 contrast gate", () => {
  // `sanitizePluginActionColor` refuses a colour that is not legible on BOTH
  // ADE backgrounds, and it refuses SILENTLY — the manifest still parses and
  // the button simply is not your colour. This value was checked against that
  // gate; pin it so a later "restore the real brand colour" cannot land a
  // failing hex without a test going red.
  const button = manifest.sockets.find((socket) => socket.socket === "chat-header-action");
  assert.equal(button.color, "#7C6FF0");
});

test("every icon is a token from the shared list, not a raw glyph name", () => {
  // An unrecognised token draws the puzzle piece identically on every client,
  // which is what a plugin looks like when it looks unfinished.
  const known = new Set(["note", "list", "chat", "clock", "tag", "bookmark", "gear"]);
  const icons = [
    manifest.icon,
    ...manifest.surfaces.map((surface) => surface.icon),
    ...manifest.panels.map((panel) => panel.icon),
    ...manifest.sockets.map((socket) => socket.icon),
    ...manifest.sockets.flatMap((socket) => (socket.menu ?? []).map((entry) => entry.icon)),
  ].filter(Boolean);
  for (const icon of icons) {
    assert.ok(known.has(icon), `icon "${icon}" is not one of the tokens this plugin uses`);
  }
});
