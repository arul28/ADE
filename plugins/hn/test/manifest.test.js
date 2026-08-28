"use strict";

/**
 * The manifest and the panel, against the code that has to agree with them.
 *
 * `apps/desktop/src/shared/plugins/manifest.ts` already decides whether this
 * file is a legal manifest, and it is TypeScript this suite cannot import. What
 * it cannot decide is the half that spans two files: a socket naming an action
 * nobody exported, a panel binding a collection the manifest never declared, a
 * declared network host that is not the host the code actually calls. Every one
 * of those parses perfectly and contributes nothing at runtime, which is the
 * failure this file exists to catch.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
const staticPanel = JSON.parse(fs.readFileSync(path.join(root, "panels/stories.json"), "utf8"));
const index = require("../index");
const hn = require("../hn");

/** The icon tokens this manifest uses, as `pluginIcons.tsx` spells them. */
const ICONS = ["trend", "clock", "chat"];

describe("identity", () => {
  it("is a lowercase-kebab id at a three-part version", () => {
    assert.match(manifest.name, /^[a-z][a-z0-9-]{0,63}$/);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.vocabVersion, 1);
    assert.equal(manifest.official, false);
  });

  it("points `entry` at a file that is really there", () => {
    assert.ok(fs.existsSync(path.join(root, manifest.entry)));
    assert.doesNotMatch(manifest.entry, /(^\/|\.\.)/);
  });
});

describe("the accent and the button tint", () => {
  it("are the darkened orange, not HN's own #FF6600", () => {
    // `sanitizePluginActionColor` refuses anything under 3:1 against BOTH the
    // light and the dark app background, and #FF6600 fails on light. A refused
    // colour is dropped silently, so the button would wear ADE's tone and the
    // author would have no error to read. Pinning the value here is what makes
    // a well-meant "restore the real HN orange" edit fail loudly instead.
    assert.equal(manifest.accent, "#E65C00");
    assert.equal(manifest.sockets[0].color, "#E65C00");
    assert.match(manifest.accent, /^#[0-9A-Fa-f]{6}$/);
  });
});

describe("the chat-header socket", () => {
  const socket = manifest.sockets.find((entry) => entry.socket === "chat-header-action");

  it("is one chat-header-action on the work surface", () => {
    assert.ok(socket, "no chat-header-action declared");
    assert.equal(
      manifest.sockets.filter((entry) => entry.socket === "chat-header-action").length,
      1,
    );
    assert.equal(socket.surface, "work");
    assert.ok(socket.label.length > 0 && socket.label.length <= 24);
  });

  it("names only actions the plugin actually exports", () => {
    const exported = Object.keys(index.actions);
    assert.ok(exported.includes(socket.actionId), `${socket.actionId} is not exported`);
    for (const entry of socket.menu) {
      assert.ok(exported.includes(entry.actionId), `${entry.actionId} is not exported`);
      assert.ok(entry.label.length > 0);
    }
  });

  it("offers the three feeds the code knows how to fetch", () => {
    assert.deepEqual(socket.menu.map((entry) => entry.label), ["Top", "New", "Ask"]);
    assert.deepEqual(hn.FEEDS, ["top", "new", "ask"]);
  });

  it("uses icon tokens from the shared list", () => {
    const used = [manifest.icon, socket.icon, ...socket.menu.map((entry) => entry.icon)];
    for (const icon of used) assert.ok(ICONS.includes(icon), `${icon} is not a token this plugin declares`);
  });
});

/**
 * The two places the panel can be, and why the button names neither.
 *
 * The header button returns `{navigate: {panelId: "stories"}}` with no `target`,
 * which is a request to open the panel wherever THIS client puts a panel. That
 * only reads as "beside the conversation" on desktop because of the
 * `work-rail-pane` below: the placement rule prefers a plugin's Work pane for a
 * press that came from inside a chat, and falls back to the tab route when the
 * plugin declares no pane for that panel.
 *
 * So the pane is not decoration. Delete it and the same button starts taking the
 * whole tab away from the chat it sits above, with nothing in the plugin's own
 * code changing.
 */
describe("where the panel opens", () => {
  const rail = manifest.sockets.find((entry) => entry.socket === "work-rail-pane");
  const tab = manifest.surfaces.find((entry) => entry.kind === "tab");

  it("declares a Work tools pane drawing the same panel the button navigates to", () => {
    assert.ok(rail, "no work-rail-pane declared");
    assert.equal(rail.surface, "work");
    assert.equal(rail.panelId, "stories");
    assert.ok(rail.label.length > 0 && rail.label.length <= 24);
  });

  it("also declares a sidebar tab, which is the fallback everywhere else", () => {
    assert.ok(tab, "no tab surface declared");
    assert.equal(tab.panelId, "stories");
    assert.equal(tab.title, "Hacker News");
  });

  it("sends no `target`, so each client places the panel its own way", () => {
    const source = fs.readFileSync(path.join(root, "index.js"), "utf8");
    assert.ok(source.includes('navigate: { panelId: "stories" }'));
    assert.ok(!source.includes("target:"), "index.js pins a placement the clients should choose");
  });
});

describe("the panel", () => {
  const panel = manifest.panels[0];

  it("declares one panel whose schema file exists", () => {
    assert.equal(manifest.panels.length, 1);
    assert.equal(panel.id, "stories");
    assert.ok(fs.existsSync(path.join(root, panel.schemaFile)));
  });

  it("names a refresh action the plugin exports", () => {
    // Declared, so desktop grows a Refresh button, iOS gets pull-to-refresh and
    // the TUI's `r` dispatches it. An id nothing exports costs the gesture.
    assert.equal(panel.refreshAction, "refreshStories");
    assert.ok(typeof index.actions[panel.refreshAction] === "function");
  });

  it("ships a static schema with the mandatory fallback", () => {
    // The schema file is what every client renders until the child's first
    // `panels.update` lands — which, since `activate` no longer blocks on the
    // network, is the loading state a reader actually sees.
    assert.equal(staticPanel.v, 1);
    assert.ok(staticPanel.fallback.title);
    assert.ok(staticPanel.fallback.text);
    assert.equal(staticPanel.fallback.deeplink, `ade://plugin/${manifest.name}/${panel.id}`);
    assert.equal(staticPanel.body[0].component, "emptyState");
  });
});

describe("collections", () => {
  it("declares exactly the three the code writes, and syncs the read set", () => {
    assert.deepEqual(Object.keys(manifest.collections).sort(), ["prefs", "read", "stories"]);
    // The user asked for read state to reach their phone. `sync: true` is what
    // the install sheet discloses for it.
    assert.equal(manifest.collections.read.sync, true);
  });

  it("names every collection the entry module touches", () => {
    const source = fs.readFileSync(path.join(root, "index.js"), "utf8");
    for (const name of source.matchAll(/collections\.(?:get|put|list|delete)\(\s*"([a-z]+)"/g)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(manifest.collections, name[1]),
        `index.js touches undeclared collection "${name[1]}"`,
      );
    }
  });
});

describe("the network declaration", () => {
  it("declares the one host the code fetches, and nothing more", () => {
    assert.deepEqual(manifest.network.hosts, ["hacker-news.firebaseio.com"]);
  });

  it("does not need news.ycombinator.com, which is only ever opened in a browser", () => {
    // `{openUrl}` hands a link to the system browser; it never travels through
    // the child's `fetch`, so the host guard has nothing to say about it.
    // Declaring it would widen the plugin's reach for no reason.
    const source = fs.readFileSync(path.join(root, "hn.js"), "utf8");
    assert.ok(source.includes("https://news.ycombinator.com/item?id="));
    assert.ok(!manifest.network.hosts.includes("news.ycombinator.com"));
    assert.ok(hn.commentsUrl(1).startsWith("https://news.ycombinator.com/"));
  });
});

describe("the CLI word", () => {
  it("is backed by an exported action", () => {
    assert.deepEqual(manifest.cli, ["stories"]);
    assert.ok(typeof index.actions.stories === "function");
  });
});
