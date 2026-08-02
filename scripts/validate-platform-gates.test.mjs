import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationFor,
  baselineKey,
  collectGates,
  coverageByPlatform,
  diffAgainstBaseline,
  evaluateGates,
  gatedPlatformLabel,
  isFileCovered,
  parseCiWorkflow,
  platformsMatching,
  runnerPlatform,
  summarizeViolations,
  testTargetsForCommand,
  toFileId,
  VIOLATION_KINDS,
} from "./validate-platform-gates.mjs";

const WIN = "\\";
const POSIX = "/";

// A gate site parsed on Windows must produce the same identifier as the path
// spelled in ci.yml, so the separator is injected rather than read from the host.
test("normalizes native Windows test paths into forward-slash file ids", () => {
  assert.equal(
    toFileId("apps\\ade-cli\\src\\cli.test.ts", WIN),
    "apps/ade-cli/src/cli.test.ts",
  );
  assert.equal(toFileId("apps/ade-cli/src/cli.test.ts", POSIX), "apps/ade-cli/src/cli.test.ts");
  // A backslash is a legal filename character on POSIX and must survive verbatim.
  assert.equal(toFileId("apps/odd\\name.test.ts", POSIX), "apps/odd\\name.test.ts");
});

test("resolves platform conditions to the platforms they select", () => {
  assert.deepEqual(platformsMatching('process.platform === "win32"'), ["win32"]);
  assert.deepEqual(platformsMatching('process.platform !== "win32"'), ["darwin", "linux"]);
  assert.deepEqual(platformsMatching('process.platform === "darwin"'), ["darwin"]);
  assert.deepEqual(platformsMatching('"win32" === process.platform'), ["win32"]);
  assert.deepEqual(
    platformsMatching('process.platform === "darwin" || process.platform === "win32"'),
    ["darwin", "win32"],
  );
  assert.deepEqual(
    platformsMatching('!(process.platform === "linux")'),
    ["darwin", "win32"],
  );
  assert.deepEqual(
    platformsMatching('process.platform !== "linux" && process.platform !== "darwin"'),
    ["win32"],
  );
});

test("reports non-platform conditions as unrecognised instead of guessing", () => {
  assert.equal(platformsMatching("!isCrsqliteAvailable()"), null);
  assert.equal(platformsMatching("!e2eConfig"), null);
  assert.equal(platformsMatching(""), null);
  // References process.platform but through a helper call this parser will not
  // evaluate: better to say nothing than to classify it wrongly.
  assert.equal(platformsMatching('normalize(process.platform).startsWith("win")'), null);
});

test("labels the platforms a gated assertion runs on", () => {
  assert.equal(gatedPlatformLabel(["win32"]), "win32");
  assert.equal(gatedPlatformLabel(["darwin", "linux"]), "darwin|linux");
  assert.equal(gatedPlatformLabel(["darwin", "linux", "win32"]), "all");
  assert.equal(gatedPlatformLabel([]), "none");
});

test("detects it.skipIf / it.runIf / describe.skipIf gates and inverts skipIf", () => {
  const source = [
    'it.skipIf(process.platform !== "win32")("windows only", () => {});',
    'it.skipIf(process.platform === "win32")("everything but windows", () => {});',
    'it.runIf(process.platform === "darwin")("mac only", () => {});',
    'describe.skipIf(process.platform !== "darwin")("mac suite", () => {});',
    'test.runIf(process.platform === "win32")("windows only", () => {});',
    'describe.skipIf(!isCrsqliteAvailable())("not a platform gate", () => {});',
  ].join("\n");

  const gates = collectGates(source, "apps/x/a.test.ts");
  assert.deepEqual(
    gates.map((gate) => [gate.line, gate.form, gate.gatedPlatform]),
    [
      [1, "it.skipIf", "win32"],
      [2, "it.skipIf", "darwin|linux"],
      [3, "it.runIf", "darwin"],
      [4, "describe.skipIf", "darwin"],
      [5, "test.runIf", "win32"],
    ],
  );
});

test("detects the ternary-to-it call form", () => {
  const source = [
    '(process.platform === "win32" ? it : it.skip)(',
    '  "creates the service definition", () => {},',
    ");",
    '(process.platform === "win32" ? it.skip : it)("posix only", () => {});',
  ].join("\n");

  const gates = collectGates(source, "apps/x/b.test.ts");
  assert.deepEqual(
    gates.map((gate) => [gate.line, gate.form, gate.gatedPlatform]),
    [
      [1, "ternary-runner", "win32"],
      [4, "ternary-runner", "darwin|linux"],
    ],
  );
});

// The alias form is the one that hides best in review: the call site reads as a
// plain `it(...)` and the gate lives a few hundred lines away.
test("resolves alias constants and attributes every use of them", () => {
  const source = [
    'const itUnix = process.platform === "win32" ? it.skip : it;',
    'const crdtHostIt = process.platform === "darwin" ? it : it.skip;',
    "",
    'describe("suite", () => {',
    '  itUnix("keeps the runtime alive", async () => {});',
    '  crdtHostIt("hosts crdt sync", async () => {});',
    '  itUnix("restarts a stale daemon", async () => {});',
    '  it("ungated", () => {});',
    "});",
  ].join("\n");

  const gates = collectGates(source, "apps/x/c.test.ts");
  assert.deepEqual(
    gates.map((gate) => [gate.line, gate.form, gate.alias ?? null, gate.gatedPlatform]),
    [
      [1, "alias-declaration", "itUnix", "darwin|linux"],
      [2, "alias-declaration", "crdtHostIt", "darwin"],
      [5, "alias-use", "itUnix", "darwin|linux"],
      [6, "alias-use", "crdtHostIt", "darwin"],
      [7, "alias-use", "itUnix", "darwin|linux"],
    ],
  );
});

test("does not mistake a same-named property access for an alias use", () => {
  const source = [
    'const posixIt = process.platform === "win32" ? it.skip : it;',
    "helpers.posixIt(1);",
    '  posixIt("real use", () => {});',
  ].join("\n");

  const gates = collectGates(source, "apps/x/d.test.ts");
  assert.deepEqual(
    gates.filter((gate) => gate.form === "alias-use").map((gate) => gate.line),
    [3],
  );
});

// This form reports as a GREEN PASS on the gated platform while asserting
// nothing, which is why it is banned outright rather than merely registered.
test("detects the vacuous early-return form, inline and as a block", () => {
  const source = [
    'it("bounds doctor when a dead socket never responds", async () => {',
    '  if (process.platform === "win32") return;',
    "  expect(1).toBe(1);",
    "});",
    'it("block form", async () => {',
    '  if (process.platform !== "linux") {',
    "    return;",
    "  }",
    "  expect(1).toBe(1);",
    "});",
    'it("branching assertion, not a gate", () => {',
    '  if (process.platform === "win32") {',
    '    expect(command).toContain("ade-tool-gate.cjs");',
    "  }",
    "});",
  ].join("\n");

  const gates = collectGates(source, "apps/x/e.test.ts");
  assert.deepEqual(
    gates.map((gate) => [gate.line, gate.form, gate.gatedPlatform]),
    [
      [2, "vacuous-return", "darwin|linux"],
      [6, "vacuous-return", "linux"],
    ],
  );
});

test("reads the WINDOWS-GATE / DARWIN-GATE escape hatch on and above the gate line", () => {
  const lines = [
    "// WINDOWS-GATE: no ConPTY on the hosted runner",
    'it.runIf(process.platform === "win32")("a", () => {});',
    "",
    'it.runIf(process.platform === "darwin")("b", () => {}); // DARWIN-GATE: needs a signed bundle',
    "",
    "",
    "",
    'it.runIf(process.platform === "win32")("c", () => {});',
  ];
  assert.deepEqual(annotationFor(lines, 2), {
    platform: "win32",
    reason: "no ConPTY on the hosted runner",
  });
  assert.deepEqual(annotationFor(lines, 4), {
    platform: "darwin",
    reason: "needs a signed bundle",
  });
  // Four lines above is out of the lookback window.
  assert.equal(annotationFor(lines, 8), null);
});

test("parses ci.yml jobs, runs-on, block scalars, and a matrix os fan-out", () => {
  const workflow = [
    "name: CI",
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  test-desktop:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: cd apps/desktop && npx vitest run --shard=1/8",
    "  windows-foundation:",
    "    runs-on: windows-latest",
    "    steps:",
    "      - name: Test Windows contracts",
    "        run: >-",
    "          cd apps/ade-cli && npx vitest run",
    "          src/bootstrap.test.ts",
    "          src/serviceManager/common.test.ts",
    "      - run: cd apps/desktop && npx vitest run src/renderer/lib/platform.test.ts",
    "  build-runtime-binaries:",
    "    runs-on: ${{ matrix.os }}",
    "    strategy:",
    "      matrix:",
    "        include:",
    "          - target: darwin-arm64",
    "            os: macos-15",
    "          - target: linux-x64",
    "            os: ubuntu-latest",
    "    steps:",
    "      - run: |",
    "          cd apps/ade-cli && npm ci",
    "          cd apps/ade-cli && npm run build:static",
  ].join("\n");

  const jobs = parseCiWorkflow(workflow);
  assert.deepEqual(
    jobs.map((job) => job.name),
    ["test-desktop", "windows-foundation", "build-runtime-binaries"],
  );
  assert.deepEqual(jobs[1].runsOn, ["windows-latest"]);
  assert.equal(
    jobs[1].runCommands[0],
    "cd apps/ade-cli && npx vitest run src/bootstrap.test.ts src/serviceManager/common.test.ts",
  );
  assert.deepEqual(jobs[2].runsOn, ["macos-15", "ubuntu-latest"]);
  assert.equal(jobs[2].runCommands[0].split("\n").length, 2);
});

test("maps runs-on labels onto the platform they report", () => {
  assert.equal(runnerPlatform("windows-latest"), "win32");
  assert.equal(runnerPlatform("macos-15-intel"), "darwin");
  assert.equal(runnerPlatform("ubuntu-24.04-arm"), "linux");
  assert.equal(runnerPlatform("self-hosted"), null);
});

test("resolves vitest targets through cd, &&, --prefix, and whole-suite runs", () => {
  const explicit = testTargetsForCommand(
    "cd apps/ade-cli && npx vitest run src/bootstrap.test.ts src/serviceManager/common.test.ts",
  );
  assert.deepEqual([...explicit.files], [
    "apps/ade-cli/src/bootstrap.test.ts",
    "apps/ade-cli/src/serviceManager/common.test.ts",
  ]);
  assert.equal(explicit.wholeSuiteDirs.size, 0);

  const sharded = testTargetsForCommand("cd apps/desktop && npx vitest run --shard=1/8");
  assert.deepEqual([...sharded.wholeSuiteDirs], ["apps/desktop"]);

  const npmTest = testTargetsForCommand("cd apps/ade-cli && npm test");
  assert.deepEqual([...npmTest.wholeSuiteDirs], ["apps/ade-cli"]);

  const prefixed = testTargetsForCommand(
    "npm --prefix apps/desktop run test -- src/main/windowAppearance.test.ts",
  );
  assert.deepEqual([...prefixed.files], ["apps/desktop/src/main/windowAppearance.test.ts"]);

  // Typechecks and installs are not test runs and must not imply coverage.
  const notTests = testTargetsForCommand(
    "npm --prefix apps/ade-cli ci\nnpm --prefix apps/desktop run typecheck",
  );
  assert.equal(notTests.files.size, 0);
  assert.equal(notTests.wholeSuiteDirs.size, 0);
});

function fixtureCoverage({ macos = false } = {}) {
  const jobs = [
    { name: "test-ade-cli", runsOn: ["ubuntu-latest"], runCommands: ["cd apps/ade-cli && npm test"] },
    { name: "test-desktop", runsOn: ["ubuntu-latest"], runCommands: ["cd apps/desktop && npx vitest run --shard=1/8"] },
    {
      name: "windows-foundation",
      runsOn: ["windows-latest"],
      runCommands: ["cd apps/ade-cli && npx vitest run src/serviceManager/installWindows.test.ts"],
    },
  ];
  if (macos) {
    jobs.push({
      name: "macos-foundation",
      runsOn: ["macos-15"],
      runCommands: ["cd apps/ade-cli && npx vitest run src/services/sync/syncLoopbackCollision.test.ts"],
    });
  }
  return coverageByPlatform(jobs);
}

test("treats a whole-suite job as covering every test file beneath its directory", () => {
  const coverage = fixtureCoverage();
  assert.equal(isFileCovered(coverage, "linux", "apps/ade-cli/src/anything.test.ts"), true);
  assert.equal(isFileCovered(coverage, "linux", "apps/desktop/src/main/a.test.ts"), true);
  assert.equal(isFileCovered(coverage, "win32", "apps/ade-cli/src/serviceManager/installWindows.test.ts"), true);
  assert.equal(isFileCovered(coverage, "win32", "apps/ade-cli/src/anything.test.ts"), false);
  assert.equal(isFileCovered(coverage, "darwin", "apps/ade-cli/src/anything.test.ts"), false);
});

test("a win32 gate in a file no windows job runs is a violation", () => {
  const gates = collectGates(
    '(process.platform === "win32" ? it : it.skip)("windows only", () => {});',
    "apps/ade-cli/src/lib/trustedWindowsTools.test.ts",
  );
  const violations = evaluateGates(gates, fixtureCoverage());
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, VIOLATION_KINDS.uncoveredGate);
  assert.equal(violations[0].requires, "win32");

  // The same gate in a file the windows job does run is fine.
  const covered = evaluateGates(
    collectGates(
      '(process.platform === "win32" ? it : it.skip)("windows only", () => {});',
      "apps/ade-cli/src/serviceManager/installWindows.test.ts",
    ),
    fixtureCoverage(),
  );
  assert.deepEqual(covered, []);
});

// This is the condition that hid three of the five bugs: the darwin gate is not
// merely in the wrong job, there is no macOS unit job at all.
test("a darwin gate is a violation when no macOS job exists, and passes once one does", () => {
  const source = 'it.runIf(process.platform === "darwin")("mac only", () => {});';
  const file = "apps/ade-cli/src/services/sync/syncLoopbackCollision.test.ts";

  const withoutMac = evaluateGates(collectGates(source, file), fixtureCoverage());
  assert.equal(withoutMac.length, 1);
  assert.equal(withoutMac[0].requires, "darwin");

  const withMac = evaluateGates(collectGates(source, file), fixtureCoverage({ macos: true }));
  assert.deepEqual(withMac, []);
});

test("a gate that still runs on linux needs no dedicated runner", () => {
  const gates = collectGates(
    'const posixIt = process.platform === "win32" ? it.skip : it;\nposixIt("a", () => {});',
    "apps/ade-cli/src/cli.test.ts",
  );
  assert.deepEqual(evaluateGates(gates, fixtureCoverage()), []);
});

test("an unsatisfiable gate is reported even though nothing skips visibly", () => {
  const gates = collectGates(
    'it.skipIf(process.platform === "win32" || process.platform !== "win32")("never", () => {});',
    "apps/ade-cli/src/cli.test.ts",
  );
  const violations = evaluateGates(gates, fixtureCoverage());
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, VIOLATION_KINDS.unsatisfiableGate);
});

test("the vacuous return is banned even in a file the matching job runs", () => {
  const gates = collectGates(
    'it("a", () => {\n  if (process.platform === "win32") return;\n});',
    "apps/ade-cli/src/serviceManager/installWindows.test.ts",
  );
  const violations = evaluateGates(gates, fixtureCoverage());
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, VIOLATION_KINDS.vacuousReturn);
  assert.equal(violations[0].line, 2);
});

test("the inline annotation suppresses the coverage requirement, matched by platform", () => {
  const accepted = evaluateGates(
    collectGates(
      '// WINDOWS-GATE: needs a real ConPTY host\nit.runIf(process.platform === "win32")("a", () => {});',
      "apps/desktop/src/main/services/pty/ptyService.test.ts",
    ),
    fixtureCoverage(),
  );
  assert.deepEqual(accepted, []);

  // A DARWIN-GATE annotation does not excuse a win32 gate.
  const mismatched = evaluateGates(
    collectGates(
      '// DARWIN-GATE: wrong platform\nit.runIf(process.platform === "win32")("a", () => {});',
      "apps/desktop/src/main/services/pty/ptyService.test.ts",
    ),
    fixtureCoverage(),
  );
  assert.equal(mismatched.length, 1);
});

test("summarizes violations on a line-number-independent key", () => {
  const violations = [
    { file: "a.test.ts", kind: "uncovered-gate", form: "alias-use", requires: "darwin", line: 10 },
    { file: "a.test.ts", kind: "uncovered-gate", form: "alias-use", requires: "darwin", line: 42 },
    { file: "a.test.ts", kind: "vacuous-return", form: "vacuous-return", requires: "n/a", line: 7 },
  ];
  const summary = summarizeViolations(violations);
  assert.equal(summary.length, 2);
  assert.equal(summary.find((entry) => entry.form === "alias-use").count, 2);
  assert.deepEqual(summary.find((entry) => entry.form === "alias-use").lines, [10, 42]);
  assert.equal(
    baselineKey(summary[0]),
    `${summary[0].file}|${summary[0].kind}|${summary[0].form}|${summary[0].requires}`,
  );
});

test("the baseline tolerates known violations, fails on growth, and fails when stale", () => {
  const known = {
    violations: [
      { file: "a.test.ts", kind: "uncovered-gate", form: "alias-use", requires: "darwin", count: 2 },
    ],
  };
  const at = (line) => ({
    file: "a.test.ts",
    kind: "uncovered-gate",
    form: "alias-use",
    requires: "darwin",
    line,
  });

  const unchanged = diffAgainstBaseline([at(10), at(42)], known);
  assert.deepEqual(unchanged.newViolations, []);
  assert.deepEqual(unchanged.staleEntries, []);

  const grown = diffAgainstBaseline([at(10), at(42), at(99)], known);
  assert.equal(grown.newViolations.length, 1);
  assert.equal(grown.newViolations[0].excess, 1);

  const shrunk = diffAgainstBaseline([at(10)], known);
  assert.equal(shrunk.newViolations.length, 0);
  assert.equal(shrunk.staleEntries.length, 1);
  assert.equal(shrunk.staleEntries[0].actual, 1);

  // A violation in a brand-new file fails immediately, whatever the backlog holds.
  const fresh = diffAgainstBaseline(
    [at(10), at(42), { ...at(1), file: "b.test.ts" }],
    known,
  );
  assert.equal(fresh.newViolations.length, 1);
  assert.equal(fresh.newViolations[0].file, "b.test.ts");
});
