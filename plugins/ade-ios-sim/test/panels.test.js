"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { NEEDS_A_MAC, buildMainPanel } = require("../panels");

describe("iOS Sim Control panels", () => {
  it("binds the status row every client can list, and says where to drive it", () => {
    // The panel is the FALLBACK tier now: desktop and web draw the plugin's own
    // page. So it binds the row a phone or a terminal can list, and states the
    // one thing they cannot do — rather than mounting a host canvas that only
    // one client ever had.
    const panel = buildMainPanel({ status: { supported: true, platform: "darwin" } });
    assert.equal(panel.title, "iOS Sim Control");
    const list = panel.body.find((node) => node.component === "list");
    assert.equal(list.bind.collection, "status");
    assert.equal(list.emptyText, NEEDS_A_MAC);
    assert.ok(panel.body.some((node) => node.component === "text" && node.text === NEEDS_A_MAC));
    assert.match(NEEDS_A_MAC, /needs a Mac/i);
    // No canvas: the compiled pane it mounted is what the page replaced.
    assert.ok(!panel.body.some((node) => node.component === "canvas"));
  });

  it("keeps the plugin's own name on the error card and its fallback", () => {
    const panel = buildMainPanel({ state: "error", error: "simctl went away." });
    assert.equal(panel.title, "iOS Sim Control");
    assert.equal(panel.fallback.title, "iOS Sim Control");
    assert.equal(panel.fallback.text, "simctl went away.");
    assert.equal(panel.fallback.deeplink, "ade://plugin/ade-ios-sim/main");
  });
});
