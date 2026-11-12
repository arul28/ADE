import assert from "node:assert/strict";
import test from "node:test";

import { pickRunner, READINESS_WINDOW_SECONDS } from "./ios-runner.mjs";

// A fixed clock keeps the window assertions exact.
const NOW = 1_800_000_000;
const FRESH = String(NOW - 30);

test("keeps the cheap Ubuntu runner when the gate skipped iOS", () => {
  const { runner } = pickRunner({
    runIos: "false",
    event: "push",
    readyAt: FRESH,
    now: NOW,
  });

  assert.equal(runner, "ubuntu-latest");
});

test("never routes a pull request from a fork to the self-hosted runner", () => {
  // A self-hosted runner executes whatever workflow the commit it checks out
  // contains, so any of these reaching the Mac is remote code execution on a
  // developer machine. They must all fall back to the hosted image.
  const cases = [
    { name: "fork head", event: "pull_request", headRepo: "someone/ADE", baseRepo: "arul28/ADE" },
    { name: "missing head repo", event: "pull_request", headRepo: "", baseRepo: "arul28/ADE" },
    { name: "undefined head repo", event: "pull_request", headRepo: undefined, baseRepo: "arul28/ADE" },
    { name: "pull_request_target", event: "pull_request_target", headRepo: "arul28/ADE", baseRepo: "arul28/ADE" },
  ];

  for (const { name, ...inputs } of cases) {
    const { runner } = pickRunner({ runIos: "true", readyAt: FRESH, now: NOW, ...inputs });
    assert.equal(runner, "xcode-27", `${name} must fall back to the hosted runner`);
  }
});

test("only a fresh, trusted readiness stamp selects the Mac Studio", () => {
  const cases = [
    { name: "same-repo PR", event: "pull_request", headRepo: "arul28/ADE", baseRepo: "arul28/ADE", readyAt: FRESH, want: "self" },
    { name: "push", event: "push", readyAt: FRESH, want: "self" },
    { name: "dispatch", event: "workflow_dispatch", readyAt: FRESH, want: "self" },
    { name: "window edge", event: "push", readyAt: String(NOW - READINESS_WINDOW_SECONDS), want: "self" },
    { name: "one second past the window", event: "push", readyAt: String(NOW - READINESS_WINDOW_SECONDS - 1), want: "hosted" },
    { name: "never stamped", event: "push", readyAt: "", want: "hosted" },
    { name: "stamped zero", event: "push", readyAt: "0", want: "hosted" },
    { name: "garbage stamp", event: "push", readyAt: "yes", want: "hosted" },
    { name: "future stamp (clock skew)", event: "push", readyAt: String(NOW + 60), want: "hosted" },
  ];

  for (const { name, want, ...inputs } of cases) {
    const { runner } = pickRunner({ runIos: "true", now: NOW, ...inputs });
    if (want === "self") {
      assert.deepEqual(runner, ["self-hosted", "mac-studio", "ios"], name);
    } else {
      assert.equal(runner, "xcode-27", name);
    }
  }
});
