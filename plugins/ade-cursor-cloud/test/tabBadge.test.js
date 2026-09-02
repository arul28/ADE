"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  TAB_ENTITY_ID,
  tabBadgePayload,
  nextUnreadCount,
  applyViewerCount,
} = require("../tabBadge");

describe("tab badge payload", () => {
  it("is null at zero, so a seen count unpublishes rather than drawing 0", () => {
    assert.equal(tabBadgePayload(0), null);
    assert.equal(tabBadgePayload(-3), null);
    assert.equal(tabBadgePayload("nope"), null);
  });

  it("caps the visible text at 9+ and keeps a tooltip with the real count", () => {
    assert.deepEqual(tabBadgePayload(1), {
      id: "tab-badge",
      text: "1",
      tone: "accent",
      tooltip: "1 finished cloud agent you have not opened",
    });
    assert.equal(tabBadgePayload(9).text, "9");
    assert.equal(tabBadgePayload(10).text, "9+");
    assert.match(tabBadgePayload(10).tooltip, /10 finished/);
  });

  it("addresses the plugin's own fleet tab, not an ADE surface id", () => {
    assert.equal(TAB_ENTITY_ID, "ade-cursor-cloud/fleet");
    assert.equal(TAB_ENTITY_ID.split("/").length, 2);
  });
});

describe("unread count", () => {
  it("bumps and floors at zero, and never past 99", () => {
    assert.equal(nextUnreadCount(0, 1), 1);
    assert.equal(nextUnreadCount(8, 1), 9);
    assert.equal(nextUnreadCount(99, 1), 99);
    assert.equal(nextUnreadCount(2, -2), 0);
  });
});

describe("viewer refcount", () => {
  it("increments on viewed and will not go below zero on hide", () => {
    assert.equal(applyViewerCount(0, true), 1);
    assert.equal(applyViewerCount(1, true), 2);
    assert.equal(applyViewerCount(1, false), 0);
    assert.equal(applyViewerCount(0, false), 0);
  });
});
