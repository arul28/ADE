"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildFleetPanel, formatWebhookLastEvent } = require("../panels");

describe("fleet empty states", () => {
  it("offers Open Cursor settings when there is no API key", () => {
    const panel = buildFleetPanel({ state: "no-key" });
    const empty = panel.body.find((node) => node.component === "emptyState");
    assert.equal(empty?.action?.onPress?.action, "openCursorSettings");
    assert.equal(empty?.action?.label, "Open Cursor settings");
  });

  it("formats a webhook last-event as a UTC line a row can print", () => {
    assert.equal(formatWebhookLastEvent(null), null);
    assert.equal(formatWebhookLastEvent(""), null);
    assert.match(formatWebhookLastEvent("2026-09-02T07:04:00.000Z"), /2026-09-02 07:04 UTC/);
  });
});
