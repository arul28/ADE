import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import artifactSizeBudget from "./artifact-size-budget.cjs";
import runtimeResourceTargets from "./runtime-resource-targets.cjs";

const {
  MAC_UPDATE_ARCHIVE_MAX_BYTES,
  WINDOWS_INSTALLER_MAX_BYTES,
  findArtifactSizeViolations,
} = artifactSizeBudget;
const {
  ALLOW_HOST_ONLY_ENV,
  RUNTIME_TARGET_ENV,
  artifactNamesForTarget,
  diffRuntimeArtifacts,
  hostRuntimeTarget,
  resolveRuntimeTargets,
  runtimeBinaryNameForTarget,
} = runtimeResourceTargets;

const desktopRoot = path.resolve(import.meta.dirname, "..");

async function withRuntimeDir(names, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-runtime-targets-"));
  try {
    for (const name of names) {
      await fs.writeFile(path.join(dir, name), "x");
    }
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("a pinned target resolves to exactly that target and nothing else", () => {
  const resolved = resolveRuntimeTargets({ [RUNTIME_TARGET_ENV]: "darwin-arm64" });
  assert.deepEqual(resolved.targets, ["darwin-arm64"]);
  assert.equal(resolved.mode, "target");
  assert.equal(resolved.exclusive, true);
});

test("a pinned target overrides host-only mode rather than widening it", () => {
  const resolved = resolveRuntimeTargets({
    [RUNTIME_TARGET_ENV]: "win32-x64",
    [ALLOW_HOST_ONLY_ENV]: "1",
  });
  assert.deepEqual(resolved.targets, ["win32-x64"]);
  assert.equal(resolved.exclusive, true);
});

test("local host-only packaging still resolves to just the host target", () => {
  const resolved = resolveRuntimeTargets({ [ALLOW_HOST_ONLY_ENV]: "1" });
  assert.deepEqual(resolved.targets, [hostRuntimeTarget()]);
  assert.equal(resolved.mode, "host-only");
  assert.equal(resolved.exclusive, false);
});

test("an unset target keeps the historical full target set", () => {
  const resolved = resolveRuntimeTargets({});
  assert.equal(resolved.mode, "full");
  assert.equal(resolved.exclusive, false);
  assert.ok(resolved.targets.includes("linux-x64"));
});

test("an unknown pinned target fails loudly instead of silently shipping everything", () => {
  assert.throws(
    () => resolveRuntimeTargets({ [RUNTIME_TARGET_ENV]: "darwin-riscv" }),
    /not a known runtime target/,
  );
});

test("the Windows runtime binary keeps its .exe suffix", () => {
  assert.equal(runtimeBinaryNameForTarget("win32-x64"), "ade-win32-x64.exe");
  assert.deepEqual(artifactNamesForTarget("win32-x64"), [
    "ade-win32-x64.exe",
    "ade-win32-x64.native.tar.gz",
  ]);
  assert.equal(runtimeBinaryNameForTarget("darwin-arm64"), "ade-darwin-arm64");
});

test("a foreign-platform sidecar is reported as unexpected", async () => {
  await withRuntimeDir(
    ["ade-darwin-arm64", "ade-darwin-arm64.native.tar.gz", "ade-win32-x64.exe"],
    (dir) => {
      const diff = diffRuntimeArtifacts(dir, ["darwin-arm64"]);
      assert.deepEqual(diff.missing, []);
      assert.deepEqual(diff.unexpected, ["ade-win32-x64.exe"]);
    },
  );
});

test("a foreign-arch sidecar is reported as unexpected", async () => {
  await withRuntimeDir(
    ["ade-darwin-arm64", "ade-darwin-arm64.native.tar.gz", "ade-darwin-x64.native.tar.gz"],
    (dir) => {
      assert.deepEqual(diffRuntimeArtifacts(dir, ["darwin-arm64"]).unexpected, [
        "ade-darwin-x64.native.tar.gz",
      ]);
    },
  );
});

// The artifact download drops install.ps1 and SHA256SUMS beside the runtime
// files, and materialization leaves .sea/.native staging behind. Neither is a
// runtime sidecar, so neither may trip the gate.
test("non-sidecar files in the runtime directory are ignored", async () => {
  await withRuntimeDir(
    ["ade-win32-x64.exe", "ade-win32-x64.native.tar.gz", "install.ps1", "SHA256SUMS"],
    (dir) => {
      const diff = diffRuntimeArtifacts(dir, ["win32-x64"]);
      assert.deepEqual(diff.missing, []);
      assert.deepEqual(diff.unexpected, []);
    },
  );
});

test("a missing sidecar is reported", async () => {
  await withRuntimeDir(["ade-darwin-x64"], (dir) => {
    assert.deepEqual(diffRuntimeArtifacts(dir, ["darwin-x64"]).missing, [
      "ade-darwin-x64.native.tar.gz",
    ]);
  });
});

test("the macOS zip budget sits below the 1 GiB Squirrel.Mac cliff", () => {
  assert.ok(MAC_UPDATE_ARCHIVE_MAX_BYTES < 1024 * 1024 * 1024);
  // The v1.2.52 arm64 zip that crashed every updating client.
  const violations = findArtifactSizeViolations([
    { name: "ADE-1.2.52-arm64.zip", size: 1054 * 1024 * 1024 },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].budget.id, "mac-update-archive");
});

test("an in-budget macOS zip and Windows installer pass", () => {
  assert.deepEqual(
    findArtifactSizeViolations([
      { name: "ADE-1.2.53-arm64.zip", size: MAC_UPDATE_ARCHIVE_MAX_BYTES },
      { name: "ADE-1.2.53-win-x64.exe", size: WINDOWS_INSTALLER_MAX_BYTES },
    ]),
    [],
  );
});

test("an oversized Windows installer is a violation", () => {
  const violations = findArtifactSizeViolations([
    { name: "ADE-1.2.52-win-x64.exe", size: 1716 * 1024 * 1024 },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].budget.id, "windows-installer");
});

test("the macOS DMG is not size-budgeted; only the updater zip is", () => {
  assert.deepEqual(
    findArtifactSizeViolations([{ name: "ADE-1.2.52-arm64.dmg", size: 2048 * 1024 * 1024 }]),
    [],
  );
});

test("the packaged macOS bundle only ever filters in its own arch's sidecar", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(desktopRoot, "package.json"), "utf8"));
  const runtimeEntries = [
    ...(pkg.build.extraResources ?? []),
    ...(pkg.build.mac.extraResources ?? []),
    ...(pkg.build.win.extraResources ?? []),
  ].filter((entry) => entry?.from === "resources/runtime");

  // A shared top-level entry is what shipped every platform's runtime to every
  // platform; the runtime payload must stay per-platform.
  assert.deepEqual((pkg.build.extraResources ?? []).filter((e) => e?.from === "resources/runtime"), []);
  assert.equal(runtimeEntries.length, 2);
  assert.deepEqual(pkg.build.mac.extraResources[0].filter, [
    "ade-darwin-${arch}",
    "ade-darwin-${arch}.native.tar.gz",
  ]);
  const winRuntime = pkg.build.win.extraResources.find((e) => e.from === "resources/runtime");
  assert.deepEqual(winRuntime.filter, ["ade-win32-x64.exe", "ade-win32-x64.native.tar.gz"]);
});

test("every release packaging job pins its runtime target and gates before and after the build", async () => {
  const workflow = await fs.readFile(
    path.resolve(desktopRoot, "../../.github/workflows/release-core.yml"),
    "utf8",
  );

  assert.match(workflow, /ADE_RUNTIME_TARGET: darwin-\$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /ADE_RUNTIME_TARGET: win32-x64/);

  // Only the job's own runtime artifact reaches resources/runtime.
  assert.match(workflow, /name: ade-runtime-darwin-\$\{\{ matrix\.arch \}\}\n\s+path: apps\/desktop\/resources\/runtime/);
  assert.match(workflow, /name: ade-runtime-win32-x64\n\s+path: apps\/desktop\/resources\/runtime/);
  assert.doesNotMatch(workflow, /pattern: ade-runtime-\*\n\s+path: apps\/desktop\/resources\/runtime/);

  for (const gate of [
    /Gate runtime resources to darwin-\$\{\{ matrix\.arch \}\}[\s\S]*?npm run assert:runtime-target/,
    /Gate runtime resources to win32-x64[\s\S]*?npm run assert:runtime-target/,
    /Enforce macOS update artifact size budget[\s\S]*?npm run assert:artifact-size/,
    /Enforce Windows installer size budget[\s\S]*?npm run assert:artifact-size/,
  ]) {
    assert.match(workflow, gate);
  }

  // Both size gates must precede their job's upload step.
  for (const [gate, upload] of [
    ["Enforce macOS update artifact size budget", "Upload ${{ matrix.arch }} artifacts"],
    ["Enforce Windows installer size budget", "Upload validated Windows release artifacts"],
  ]) {
    assert.ok(workflow.indexOf(gate) > 0 && workflow.indexOf(gate) < workflow.indexOf(upload));
  }
});

test("the standalone runtime proof bundle still stages all five targets, outside the desktop bundle", async () => {
  const workflow = await fs.readFile(
    path.resolve(desktopRoot, "../../.github/workflows/release-core.yml"),
    "utf8",
  );
  assert.match(workflow, /pattern: ade-runtime-\*\n\s+path: \$\{\{ runner\.temp \}\}\/ade-runtime-all/);
  assert.match(workflow, /ADE_RUNTIME_PROOF_DIR: \$\{\{ runner\.temp \}\}\/ade-runtime-all/);
  for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]) {
    assert.ok(workflow.includes(`"ade-${target}`));
  }
});
