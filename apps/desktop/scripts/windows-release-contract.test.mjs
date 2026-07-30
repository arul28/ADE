import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const releaseWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release-core.yml"), "utf8").replace(/\r\n/g, "\n");
const ciWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
const appUpdate = parseYaml(fs.readFileSync(path.join(desktopRoot, "resources", "app-update.yml"), "utf8"));
const downloadPage = fs.readFileSync(path.join(repoRoot, "apps", "web", "src", "app", "pages", "DownloadPage.tsx"), "utf8");
const winArtifactValidator = fs.readFileSync(
  path.join(desktopRoot, "scripts", "validate-win-artifacts.mjs"),
  "utf8",
);

const remoteTargets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

function jobBlock(workflow, jobName, nextJobName) {
  const start = workflow.indexOf(`\n  ${jobName}:\n`);
  assert.notEqual(start, -1, `Expected active ${jobName} workflow job`);
  const end = nextJobName ? workflow.indexOf(`\n  ${nextJobName}:\n`, start + 1) : workflow.length;
  assert.notEqual(end, -1, `Expected ${nextJobName} after ${jobName}`);
  return workflow.slice(start, end);
}

test("Windows package carries every remote runtime sidecar its validator requires", () => {
  const runtimeResources = [...pkg.build.extraResources, ...pkg.build.win.extraResources]
    .filter((entry) => entry.to === "runtime");
  const runtimeFilter = runtimeResources.flatMap((entry) => entry.filter);
  for (const target of remoteTargets) {
    assert.ok(runtimeFilter.includes(`ade-${target}`), target);
    assert.ok(runtimeFilter.includes(`ade-${target}.native.tar.gz`), `${target} native archive`);
  }
  const commonRuntimeFilter = pkg.build.extraResources.find((entry) => entry.to === "runtime").filter;
  assert.equal(commonRuntimeFilter.some((entry) => entry.startsWith("ade-linux-")), false);
});

test("electron-builder owns packaged update metadata and defaults to this fork", () => {
  assert.equal(pkg.build.publish.owner, "nsxdavid");
  assert.equal(pkg.build.publish.repo, "ADE");
  assert.deepEqual(appUpdate, { provider: "github", owner: "nsxdavid", repo: "ADE" });
  assert.equal(pkg.build.extraResources.some((entry) => entry.to === "app-update.yml"), false);
  assert.match(pkg.scripts["package:win"], /run-electron-builder\.mjs/);
});

test("public Windows packaging fails closed on Authenticode signing", () => {
  assert.match(pkg.scripts["dist:win:signed"], /package:win:signed/);
  assert.match(pkg.scripts["dist:win:signed"], /validate:win:release:signed/);
  assert.match(pkg.scripts["package:win:signed"], /--require-signing/);

  const windowsRelease = jobBlock(releaseWorkflow, "build-win-release", "build-runtime-binaries");
  assert.match(windowsRelease, /ADE_WINDOWS_SIGNED_BUILD_ENABLED == '1'/);
  assert.match(windowsRelease, /npm run dist:win:signed/);
  assert.match(windowsRelease, /ADE_RELEASE_REPOSITORY:\s*\$\{\{ github\.repository \}\}/);
  assert.match(windowsRelease, /WINDOWS_CSC_LINK/);
  assert.match(windowsRelease, /WINDOWS_SIGNING_EXPECTED_SUBJECT/);
  assert.match(windowsRelease, /WINDOWS_SIGNING_EXPECTED_THUMBPRINT/);
  assert.match(
    fs.readFileSync(path.join(desktopRoot, "scripts", "validate-win-artifacts.mjs"), "utf8"),
    /installerIdentity\.thumbprint !== appIdentity\.thumbprint/,
  );
});

test("signed packaging stops before electron-builder when credentials are absent", () => {
  const wrapper = path.join(desktopRoot, "scripts", "run-electron-builder.mjs");
  const env = { ...process.env };
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
  const result = spawnSync(process.execPath, [wrapper, "--require-signing", "--win", "--x64"], {
    cwd: desktopRoot,
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Signed Windows packaging requires CSC_LINK and CSC_KEY_PASSWORD/);
});

test("Windows release assets are validated and published as one release set", () => {
  const publish = jobBlock(releaseWorkflow, "publish-release", null);
  assert.match(publish, /- build-win-release/);
  assert.match(publish, /name: ade-win-release-/);
  assert.match(publish, /needs\.build-win-release\.result == 'success' \|\| needs\.build-win-release\.result == 'skipped'/);
  assert.match(publish, /ADE_WINDOWS_SIGNED_BUILD_ENABLED == '1' && vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED == '1'/);
  assert.match(publish, /BUILD_WINDOWS: \$\{\{ vars\.ADE_WINDOWS_SIGNED_BUILD_ENABLED \}\}/);
  assert.match(publish, /PUBLISH_WINDOWS: \$\{\{ vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED \}\}/);
  assert.match(publish, /if \[ "\$BUILD_WINDOWS" = "1" \] && \[ "\$PUBLISH_WINDOWS" = "1" \]; then/);
  assert.match(publish, /release-assets\/win\/\*\.exe/);
  assert.match(publish, /release-assets\/win\/\*\.exe\.blockmap/);
  assert.match(publish, /release-assets\/win\/latest\.yml/);
});

test("pull requests build and smoke an unsigned Windows installer", () => {
  const packageJob = jobBlock(ciWorkflow, "package-win", "validate-docs");
  assert.match(packageJob, /runs-on: windows-latest/);
  assert.match(packageJob, /npm run dist:win/);
  assert.doesNotMatch(packageJob, /dist:win:signed/);
  const ciPass = jobBlock(ciWorkflow, "ci-pass", null);
  assert.match(ciPass, /- package-win/);
});

test("Windows package smoke requires every bundled provider runtime", () => {
  assert.ok(
    pkg.build.asarUnpack.includes("node_modules/@cursor/sdk-win32-x64/**"),
    "Cursor's Windows native helpers must be unpacked so Electron can execute them",
  );
  assert.match(winArtifactValidator, /Claude executable source.*bundled/i);
  assert.doesNotMatch(winArtifactValidator, /Claude CLI is not installed.*skipping live Claude startup/i);
  assert.match(winArtifactValidator, /Codex executable source.*bundled/i);
  assert.match(winArtifactValidator, /OpenCode.*--version/i);
  assert.match(winArtifactValidator, /cursorSdkCreateAgentPlatform/);
  assert.match(winArtifactValidator, /cursorNativeRgPath/);
  assert.match(winArtifactValidator, /droidSdkCreateSession/);
});

test("download page gates the Windows release and enables dedicated analytics after proof", () => {
  assert.match(downloadPage, /VITE_ADE_WINDOWS_DOWNLOAD_ENABLED/);
  assert.match(downloadPage, /signed N → N\+1 installed-update test passes/);
  assert.match(downloadPage, /MARKETING_FEATURES\.DOWNLOAD_WINDOWS/);
  assert.match(downloadPage, /WINDOWS_DOWNLOAD_ENABLED \? LINKS\.releasesLatest : LINKS\.releases/);
});
