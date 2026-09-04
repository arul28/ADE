"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const { buildLaunchPanel, buildRunPanel, buildRunsPanel } = require("../panels");
const { sampleRun } = require("./support");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "plugin.json"), "utf8"));
const surfaceById = new Map(manifest.surfaces.map((surface) => [surface.id, surface]));
const socketById = new Map(manifest.sockets.map((socket) => [socket.id, socket]));

describe("review panels", () => {
  it("puts Launch and Learnings on the runs chrome", () => {
    const panel = buildRunsPanel({ hasRuns: true, counts: { active: 1 } });
    assert.equal(panel.chrome.navActions[0].action, "openLaunch");
    assert.equal(panel.chrome.navActions[1].action, "openLearnings");
    const list = panel.body.find((node) => node.component === "list");
    assert.equal(list.bind.collection, "runs");
  });

  it("draws an empty-state when a run is missing", () => {
    const panel = buildRunPanel({});
    const empty = panel.body.find((node) => node.component === "emptyState");
    assert.equal(empty.action.onPress.action, "openRuns");
  });

  it("binds findings to the selected run's key prefix", () => {
    const panel = buildRunPanel({ run: sampleRun() });
    const list = panel.body.find((node) => node.component === "list");
    assert.equal(list.bind.keyPrefix, "finding:run-1:");
  });

  it("locks a PR launch onto auto_publish and pr mode", () => {
    const panel = buildLaunchPanel({
      lanes: [{ id: "lane-1", name: "fix-login" }],
      form: { targetMode: "pr", laneId: "lane-1", prId: "pr-9", publishBehavior: "auto_publish" },
    });
    const form = panel.body.find((node) => node.component === "form");
    assert.equal(form.submit.onPress.action, "startRun");
    assert.ok(form.fields.some((field) => field.id === "prId"));
    assert.ok(form.fields.every((field) => field.id !== "targetMode"));
  });
});

/**
 * The manifest, as the page tier left it.
 *
 * `apps/desktop/src/shared/plugins/pilotPackages.test.ts` already proves it
 * PARSES with no errors and no warnings. What that gate cannot say is whether
 * the shapes still mean what this package intends, and three of them are easy
 * to get wrong in a way nothing else catches: a `webview` surface with no built
 * page loads a blank frame, `mobile: true` on one is silently narrowed to false
 * (so the phone quietly loses the surface the author thought they declared), and
 * `webviewSurfaceId` on a `row-menu-item` is dropped by `sockets.ts` — which is
 * exactly the kind of ignored field the zero-warnings gate exists to forbid.
 */
describe("the review manifest", () => {
  it("declares two webview surfaces, both built and both desktop-only", () => {
    assert.equal(manifest.version, "2.0.2");
    assert.deepEqual([...surfaceById.keys()], ["runs", "launch"]);
    for (const surface of manifest.surfaces) {
      assert.equal(surface.kind, "webview");
      assert.equal(surface.entryHtml, "dist/index.html");
      // `parseSurfaces` forbids `mobile: true` on a webview — the phone renders
      // the `panelId` panel instead — so the manifest says so itself rather than
      // being narrowed with a warning.
      assert.equal(surface.mobile, false);
      // Every surface names a panel that exists, because that panel IS what the
      // phone and the terminal draw in the page's place.
      assert.ok(
        manifest.panels.some((panel) => panel.id === surface.panelId),
        `${surface.id} names a panel that does not exist`,
      );
      const built = path.join(__dirname, "..", surface.entryHtml);
      assert.ok(fs.existsSync(built), `${surface.entryHtml} is not committed — run npm run build in page/`);
    }
    // The rail tab keeps its order and its id: a tab badge is addressed by
    // `"<pluginId>/<surfaceId>"`, so renaming `runs` would orphan every badge.
    assert.equal(surfaceById.get("runs").order, 45);
    assert.deepEqual(surfaceById.get("launch").popover, { width: 560, height: 640 });
  });

  it("declares no Work-rail pane, because the compiled Review had none", () => {
    // The compiled product put Review on the rail and in the palette and on a
    // PR — never in the Work rail. A `work-rail-pane` socket here would be a
    // placement the page invented, and a reader would find a Review pane in
    // Work that ADE itself never drew.
    assert.equal(socketById.has("runs-pane"), false);
    assert.ok(manifest.sockets.every((socket) => socket.socket !== "work-rail-pane"));
    assert.deepEqual(
      manifest.sockets.map((socket) => socket.id),
      ["request-review", "request-review-row", "palette-runs", "palette-launch"],
    );
  });

  it("points the PR button and both palette entries at a page", () => {
    assert.equal(socketById.get("request-review").actionId, "openLaunchFromPr");
    assert.equal(socketById.get("request-review").webviewSurfaceId, "launch");
    assert.equal(socketById.get("palette-runs").webviewSurfaceId, "runs");
    assert.equal(socketById.get("palette-launch").webviewSurfaceId, "launch");
    for (const socket of manifest.sockets) {
      if (!socket.webviewSurfaceId) continue;
      assert.ok(
        surfaceById.has(socket.webviewSurfaceId),
        `${socket.id} names a webview surface that does not exist`,
      );
    }
  });

  it("keeps webviewSurfaceId off the row menu item, which cannot carry one", () => {
    // `parsePluginContributionPayload`'s `row-menu-item` arm reads only `label`,
    // `actionId`, `icon` and `danger`. A `webviewSurfaceId` here would be a
    // field the author wrote and the platform ignored.
    const row = socketById.get("request-review-row");
    assert.equal(row.actionId, "openLaunchFromPr");
    assert.equal(row.webviewSurfaceId, undefined);
  });

  it("keeps every panel, tool, collection and CLI word the 1.x package had", () => {
    assert.deepEqual(manifest.panels.map((panel) => panel.id), ["runs", "run", "launch", "learnings"]);
    assert.deepEqual(manifest.tools.map((tool) => tool.name), ["list_runs", "start_run", "get_run", "record_feedback"]);
    assert.deepEqual(manifest.cli, ["runs", "launch", "learnings"]);
    // `ui-state` is the one addition: the page's selected run and sidebar width,
    // which the compiled page kept in `localStorage` — dead in a guest, whose
    // storage partition is destroyed with the placement.
    assert.deepEqual(Object.keys(manifest.collections), ["runs", "findings", "suppressions", "ui-state"]);
    assert.equal(manifest.collections["ui-state"].sync, false);
  });
});
