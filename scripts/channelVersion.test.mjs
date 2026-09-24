import assert from "node:assert/strict";
import test from "node:test";

import {
  computeChannelVersion,
  formatChannelVersionStamp,
  parseTaggedBaseVersion,
  resolveChannelBaseVersion,
} from "./channelVersion.mjs";

test("formats a channel version stamp as UTC yyyymmddHHMM", () => {
  // 2026-09-21T10:35:00Z -> the example in the build contract.
  assert.equal(formatChannelVersionStamp(new Date("2026-09-21T10:35:00.000Z")), "202609211035");
  // Single-digit month, day, hour and minute stay padded to two digits.
  assert.equal(formatChannelVersionStamp(new Date("2026-01-02T03:04:00.000Z")), "202601020304");
  // A time that would shift a day under a local-time format stays on its UTC day.
  assert.equal(formatChannelVersionStamp(new Date("2026-12-31T23:59:00.000Z")), "202612312359");
});

test("rejects an invalid clock", () => {
  assert.throws(() => formatChannelVersionStamp(new Date("not a date")), /valid Date/);
});

test("computes <base>-<channel>.<stamp>", () => {
  assert.equal(
    computeChannelVersion({
      baseVersion: "1.2.75",
      channel: "alpha",
      now: new Date("2026-09-21T10:35:00.000Z"),
    }),
    "1.2.75-alpha.202609211035",
  );
  assert.equal(
    computeChannelVersion({
      baseVersion: " 1.2.75 ",
      channel: "Beta",
      now: new Date("2026-09-21T10:35:00.000Z"),
    }),
    "1.2.75-beta.202609211035",
  );
});

test("rejects a missing base version or a bad channel name", () => {
  assert.throws(() => computeChannelVersion({ baseVersion: "", channel: "alpha" }), /base version/);
  assert.throws(() => computeChannelVersion({ baseVersion: "1.2.75", channel: "../evil" }), /channel name/);
});

test("reads a base version from a v* tag and strips the v", () => {
  assert.equal(parseTaggedBaseVersion("v1.2.75"), "1.2.75");
  assert.equal(parseTaggedBaseVersion(" V1.2.75\n"), "1.2.75");
  assert.equal(parseTaggedBaseVersion("release-1.2.75"), null);
  assert.equal(parseTaggedBaseVersion(""), null);
  assert.equal(parseTaggedBaseVersion(undefined), null);
});

test("prefers the reachable tag over the package.json fallback", () => {
  assert.equal(
    resolveChannelBaseVersion({ taggedVersion: "v1.2.75", fallbackVersion: "1.0.0-beta.1" }),
    "1.2.75",
  );
});

test("falls back to the package.json version when no tag is reachable", () => {
  assert.equal(
    resolveChannelBaseVersion({ taggedVersion: "", fallbackVersion: "1.0.0-beta.1" }),
    "1.0.0-beta.1",
  );
  assert.equal(
    resolveChannelBaseVersion({ taggedVersion: "not-a-version", fallbackVersion: "1.0.0-beta.1" }),
    "1.0.0-beta.1",
  );
});

test("throws when neither a tag nor a fallback version exists", () => {
  assert.throws(
    () => resolveChannelBaseVersion({ taggedVersion: "", fallbackVersion: "  " }),
    /Unable to resolve a channel base version/,
  );
});
