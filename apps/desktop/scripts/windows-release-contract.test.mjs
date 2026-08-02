import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  resolveWindowsPackageIdentity,
  windowsInstallerPattern,
} from "./windows-package-identity.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const releaseWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release-core.yml"), "utf8").replace(/\r\n/g, "\n");
const releaseTriggerWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8").replace(/\r\n/g, "\n");
const prepareWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "prepare-release.yml"), "utf8").replace(/\r\n/g, "\n");
const ciWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
const appUpdate = parseYaml(fs.readFileSync(path.join(desktopRoot, "resources", "app-update.yml"), "utf8"));
const downloadPage = fs.readFileSync(path.join(repoRoot, "apps", "web", "src", "app", "pages", "DownloadPage.tsx"), "utf8");
const winArtifactValidator = fs.readFileSync(
  path.join(desktopRoot, "scripts", "validate-win-artifacts.mjs"),
  "utf8",
);
const electronBuilderWrapper = fs.readFileSync(
  path.join(desktopRoot, "scripts", "run-electron-builder.mjs"),
  "utf8",
);
const windowsTestBuild = fs.readFileSync(
  path.join(desktopRoot, "scripts", "run-windows-test-build.mjs"),
  "utf8",
);
const runtimeValidator = fs.readFileSync(
  path.join(desktopRoot, "scripts", "validate-runtime-resources.mjs"),
  "utf8",
);
const whisperValidator = fs.readFileSync(
  path.join(desktopRoot, "scripts", "validate-whisper-resources.mjs"),
  "utf8",
);
const afterPackScript = fs.readFileSync(
  path.join(desktopRoot, "scripts", "after-pack-runtime-fixes.cjs"),
  "utf8",
);
const windowsServiceManager = fs.readFileSync(
  path.join(repoRoot, "apps", "ade-cli", "src", "serviceManager", "installWindows.ts"),
  "utf8",
);
const windowsRuntimeSigner = fs.readFileSync(
  path.join(repoRoot, "apps", "ade-cli", "scripts", "sign-windows-runtime.ps1"),
  "utf8",
);
const desktopMain = fs.readFileSync(path.join(desktopRoot, "src", "main", "main.ts"), "utf8");
const registerIpc = fs.readFileSync(
  path.join(desktopRoot, "src", "main", "services", "ipc", "registerIpc.ts"),
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

test("electron-builder owns packaged update metadata and preserves the upstream default", () => {
  assert.equal(pkg.build.publish.owner, "arul28");
  assert.equal(pkg.build.publish.repo, "ADE");
  assert.deepEqual(appUpdate, { provider: "github", owner: "arul28", repo: "ADE" });
  assert.equal(pkg.build.extraResources.some((entry) => entry.to === "app-update.yml"), false);
  assert.match(pkg.scripts["package:win"], /run-electron-builder\.mjs/);
  assert.match(
    electronBuilderWrapper,
    /--config\.extraMetadata\.adeReleaseRepository=\$\{configuredRepository\}/,
  );
  assert.match(desktopMain, /packageJson\.adeReleaseRepository/);
  assert.ok(
    (desktopMain.match(/releaseRepository: packagedReleaseRepository/g) ?? []).length >= 2,
    "packaged repository must reach both updater state and release-link IPC",
  );
  assert.match(registerIpc, /buildGithubReleaseUrl\(version, releaseRepository\)/);
});

test("local Windows test builds omit only cross-platform runtime sidecars", () => {
  assert.match(pkg.scripts["dist:win:test"], /run-windows-test-build\.mjs/);
  assert.match(windowsTestBuild, /ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY: "1"/);
  assert.match(windowsTestBuild, /ADE_WINDOWS_TEST_BUILD: "1"/);
  assert.match(windowsTestBuild, /npm\.cmd.*"run", "dist:win"/s);
  assert.match(runtimeValidator, /allTargets\.includes\(hostTarget\) \? \[hostTarget\] : \[\]/);
  assert.match(winArtifactValidator, /Local test build: skipping macOS\/Linux remote runtime sidecars/);
  assert.match(whisperValidator, /Local Windows test build: Whisper CLI is not bundled/);
  assert.match(electronBuilderWrapper, /windowsHide: process\.platform === "win32"/);
  assert.match(afterPackScript, /Pruned \$\{reason\} OpenCode install shim/);
  assert.match(winArtifactValidator, /duplicate OpenCode Windows executable/);
  assert.doesNotMatch(pkg.scripts["dist:win"], /ALLOW_HOST_ONLY/);
  assert.doesNotMatch(pkg.scripts["dist:win:signed"], /ALLOW_HOST_ONLY/);
  assert.doesNotMatch(pkg.scripts["dist:win"], /WINDOWS_TEST_BUILD/);
  assert.doesNotMatch(pkg.scripts["dist:win:signed"], /WINDOWS_TEST_BUILD/);
});

test("Windows background service registration does not require administrator access", () => {
  assert.match(windowsServiceManager, /HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run/);
  assert.match(windowsServiceManager, /buildWindowsRunKeyAddArgs\(taskName, command\)/);
  assert.match(windowsServiceManager, /buildWindowsStartLauncherArgs\(launcherPath\)/);
  const installBlock = windowsServiceManager.slice(
    windowsServiceManager.indexOf("export function installWindowsService"),
    windowsServiceManager.indexOf("export function uninstallWindowsService"),
  );
  assert.doesNotMatch(installBlock, /buildWindowsCreateTaskArgs\(/);
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
  assert.match(windowsRelease, /WINDOWS_CSC_KEY_PASSWORD/);
  assert.doesNotMatch(windowsRelease, /WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD/);
  assert.match(windowsRelease, /WINDOWS_SIGNING_EXPECTED_SUBJECT/);
  assert.match(windowsRelease, /WINDOWS_SIGNING_EXPECTED_THUMBPRINT/);
  assert.doesNotMatch(windowsRelease, /ADE_WINDOWS_EXPECTED_PUBLISHER_SUBJECT|ADE_WINDOWS_EXPECTED_CERTIFICATE_THUMBPRINT/);
  assert.match(windowsRelease, /ADE_POSTHOG_PROJECT_TOKEN:\s*\$\{\{ secrets\.ADE_POSTHOG_PROJECT_TOKEN \}\}/);
  assert.match(windowsRelease, /ADE_POSTHOG_HOST:\s*\$\{\{ secrets\.ADE_POSTHOG_HOST \}\}/);
  assert.match(
    fs.readFileSync(path.join(desktopRoot, "scripts", "validate-win-artifacts.mjs"), "utf8"),
    /installerIdentity\.thumbprint !== appIdentity\.thumbprint/,
  );
});

test("signed packaging stops before electron-builder when credentials are absent", () => {
  const wrapper = path.join(desktopRoot, "scripts", "run-electron-builder.mjs");
  const env = { ...process.env };
  delete env.WINDOWS_CSC_LINK;
  delete env.WINDOWS_CSC_KEY_PASSWORD;
  const result = spawnSync(process.execPath, [wrapper, "--require-signing", "--win", "--x64"], {
    cwd: desktopRoot,
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Signed Windows packaging requires WINDOWS_CSC_LINK and WINDOWS_CSC_KEY_PASSWORD/);
});

test("Windows packaging accepts signing material only through canonical inputs", () => {
  assert.match(electronBuilderWrapper, /canonicalWindowsCscLink = process\.env\.WINDOWS_CSC_LINK/);
  assert.match(electronBuilderWrapper, /canonicalWindowsCscKeyPassword = process\.env\.WINDOWS_CSC_KEY_PASSWORD/);
  assert.match(electronBuilderWrapper, /delete baseChildEnv\.CSC_LINK/);
  assert.match(electronBuilderWrapper, /delete baseChildEnv\.CSC_KEY_PASSWORD/);
  assert.match(electronBuilderWrapper, /delete baseChildEnv\.WINDOWS_CSC_LINK/);
  assert.match(electronBuilderWrapper, /delete baseChildEnv\.WINDOWS_CSC_KEY_PASSWORD/);
  assert.match(electronBuilderWrapper, /CSC_LINK: canonicalWindowsCscLink/);
  assert.match(electronBuilderWrapper, /CSC_KEY_PASSWORD: canonicalWindowsCscKeyPassword/);
});

test("Windows packaging rejects unknown channels before electron-builder", () => {
  const wrapper = path.join(desktopRoot, "scripts", "run-electron-builder.mjs");
  const result = spawnSync(process.execPath, [wrapper, "--win", "--x64"], {
    cwd: desktopRoot,
    env: { ...process.env, ADE_PACKAGE_CHANNEL: "betaa" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Unsupported ADE_PACKAGE_CHANNEL 'betaa'/);
});

test("Beta validation selects only Beta artifacts when Stable files are retained", () => {
  const beta = resolveWindowsPackageIdentity("beta");
  const artifacts = [
    "ADE-1.2.3-win-x64.exe",
    "ADE Beta-1.2.3-win-x64.exe",
  ];
  assert.equal(beta.executableName, "ADE Beta.exe");
  assert.deepEqual(artifacts.filter((name) => windowsInstallerPattern(beta).test(name)), [
    "ADE Beta-1.2.3-win-x64.exe",
  ]);
  assert.match(winArtifactValidator, /windowsInstallerPattern\(packageIdentity\)/);
});

test("standalone Windows runtime signing uses only canonical credentials and validates publisher identity", () => {
  const runtimeBuild = jobBlock(releaseWorkflow, "build-runtime-binaries", "publish-release");
  const windowsSignStep = runtimeBuild.slice(
    runtimeBuild.indexOf("- name: Sign and validate standalone Windows runtime"),
    runtimeBuild.indexOf("- name: Materialize runtime notarization API key"),
  );
  assert.match(runtimeBuild, /target: win32-x64[\s\S]*os: windows-latest[\s\S]*binary: ade-win32-x64\.exe/);
  assert.match(windowsSignStep, /matrix\.target == 'win32-x64'/);
  assert.match(windowsSignStep, /ADE_WINDOWS_SIGNED_BUILD_ENABLED == '1'/);
  assert.match(windowsSignStep, /WINDOWS_CSC_LINK: \$\{\{ secrets\.WINDOWS_CSC_LINK \}\}/);
  assert.match(windowsSignStep, /WINDOWS_CSC_KEY_PASSWORD: \$\{\{ secrets\.WINDOWS_CSC_KEY_PASSWORD \}\}/);
  assert.match(windowsSignStep, /WINDOWS_SIGNING_EXPECTED_SUBJECT/);
  assert.match(windowsSignStep, /WINDOWS_SIGNING_EXPECTED_THUMBPRINT/);
  assert.doesNotMatch(windowsSignStep, /(?:^|\s)(?:WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD|CSC_LINK|CSC_KEY_PASSWORD):/m);
  assert.match(windowsSignStep, /sign-windows-runtime\.ps1/);
  assert.match(windowsRuntimeSigner, /Set-AuthenticodeSignature/);
  assert.match(windowsRuntimeSigner, /Get-AuthenticodeSignature/);
  assert.match(windowsRuntimeSigner, /TimeStamperCertificate/);
  assert.match(windowsRuntimeSigner, /WINDOWS_SIGNING_EXPECTED_SUBJECT/);
  assert.match(windowsRuntimeSigner, /WINDOWS_SIGNING_EXPECTED_THUMBPRINT/);
  assert.match(windowsRuntimeSigner, /X509KeyStorageFlags\]::EphemeralKeySet/);
  assert.doesNotMatch(windowsRuntimeSigner, /Write-Output.*(?:certificateSource|certificatePassword|expectedSubject|expectedThumbprint)/);
});

test("standalone Windows release assets remain behind every publication and proof gate", () => {
  const publish = jobBlock(releaseWorkflow, "publish-release", null);
  const runtimeBuild = jobBlock(releaseWorkflow, "build-runtime-binaries", "publish-release");
  const installer = fs.readFileSync(
    path.join(repoRoot, "apps", "ade-cli", "scripts", "install-runtime.ps1"),
    "utf8",
  );
  const releaseFiles = publish.slice(publish.indexOf("files=("), publish.indexOf("if [ \"$BUILD_WINDOWS\"", publish.indexOf("files=(")));
  assert.doesNotMatch(releaseFiles, /install\.ps1|ade-win32-x64/);
  assert.match(publish, /runtime_assets\+=\(install\.ps1 ade-win32-x64\.exe ade-win32-x64\.native\.tar\.gz\)/);
  assert.match(publish, /test -s release-assets\/runtime\/install\.ps1/);
  assert.match(publish, /test -s release-assets\/runtime\/ade-win32-x64\.exe/);
  assert.match(publish, /test -s release-assets\/runtime\/ade-win32-x64\.native\.tar\.gz/);
  assert.match(publish, /release-assets\/runtime\/install\.ps1[\s\S]*release-assets\/runtime\/ade-win32-x64\.exe[\s\S]*release-assets\/runtime\/ade-win32-x64\.native\.tar\.gz/);
  assert.ok(
    (publish.match(/\[ "\$BUILD_WINDOWS" = "1" \] && \[ "\$PUBLISH_WINDOWS" = "1" \] && \[ "\$WINDOWS_UPDATE_PROOF_APPROVED" = "1" \]/g) ?? []).length >= 3,
    "copying, checksumming, and publishing standalone Windows assets must all require every gate",
  );
  assert.match(publish, /install\.ps1\|ade-win32-x64\.exe\|ade-win32-x64\.native\.tar\.gz/);
  assert.match(publish, /gh release delete-asset "\$TAG_NAME" "\$asset" --repo "\$GH_REPO" --yes/);
  assert.match(publish, /"\$BUILD_WINDOWS" != "1"[\s\S]*"\$PUBLISH_WINDOWS" != "1"[\s\S]*"\$WINDOWS_UPDATE_PROOF_APPROVED" != "1"/);
  assert.match(runtimeBuild, /name: Assemble signed Windows standalone proof bundle/);
  assert.match(runtimeBuild, /matrix\.target == 'win32-x64' && vars\.ADE_WINDOWS_SIGNED_BUILD_ENABLED == '1'/);
  assert.match(runtimeBuild, /sha256sum install\.ps1 ade-win32-x64\.exe ade-win32-x64\.native\.tar\.gz/);
  assert.match(runtimeBuild, /apps\/ade-cli\/dist-static\/install\.ps1/);
  assert.match(runtimeBuild, /apps\/ade-cli\/dist-static\/SHA256SUMS/);
  assert.match(installer, /Verify-Checksum/);
  assert.match(installer, /ADE_RELEASE_ASSET_DIR/);
  assert.match(installer, /Copy-Item -LiteralPath \$source -Destination \$Destination -Force/);
  assert.match(installer, /ade-win32-x64\.exe|\$binaryAsset/);
  assert.match(installer, /serve --install-service/);
  assert.match(installer, /serve --service-status --json/);
  assert.match(installer, /if \(\$serviceStatus\.installed\)/);
  assert.match(installer, /Install-UserPath/);
  assert.match(installer, /Recovery files were retained at \$tempRoot/);
  assert.match(installer, /if \(-not \$preserveTempForRecovery\)/);
});

test("Windows release assets are validated and published as one release set", () => {
  const publish = jobBlock(releaseWorkflow, "publish-release", null);
  const verify = jobBlock(releaseWorkflow, "verify", "build-mac-release");
  const workflowHeader = releaseWorkflow.slice(0, releaseWorkflow.indexOf("\njobs:\n"));
  assert.match(workflowHeader, /contents: read/);
  assert.doesNotMatch(workflowHeader, /contents: write/);
  assert.match(releaseTriggerWorkflow, /permissions:\s*\n\s+actions: read\s*\n\s+checks: read\s*\n\s+contents: write/);
  assert.match(publish, /- build-win-release/);
  assert.match(publish, /permissions:\s*\n\s+actions: read\s*\n\s+contents: write/);
  assert.match(publish, /name: ade-win-release-/);
  assert.match(publish, /vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED != '1'[\s\S]*needs\.build-win-release\.result == 'success'/);
  assert.match(verify, /ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1 requires ADE_WINDOWS_SIGNED_BUILD_ENABLED=1/);
  assert.match(verify, /ADE_WINDOWS_INSTALLED_UPDATE_PROOF_APPROVED/);
  assert.match(verify, /requires approved two-version installed-update proof/);
  assert.match(publish, /ADE_WINDOWS_SIGNED_BUILD_ENABLED == '1' && vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED == '1'/);
  assert.match(publish, /ADE_WINDOWS_INSTALLED_UPDATE_PROOF_APPROVED == '1'/);
  assert.match(publish, /BUILD_WINDOWS: \$\{\{ vars\.ADE_WINDOWS_SIGNED_BUILD_ENABLED \}\}/);
  assert.match(publish, /PUBLISH_WINDOWS: \$\{\{ vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED \}\}/);
  assert.match(publish, /if \[ "\$BUILD_WINDOWS" = "1" \] && \[ "\$PUBLISH_WINDOWS" = "1" \] && \[ "\$WINDOWS_UPDATE_PROOF_APPROVED" = "1" \]; then/);
  assert.match(publish, /release-assets\/win\/\*\.exe/);
  assert.match(publish, /release-assets\/win\/\*\.exe\.blockmap/);
  assert.match(publish, /release-assets\/win\/latest\.yml/);
  assert.match(publish, /--json isDraft/);
  assert.match(publish, /Refusing to overwrite published assets/);
  assert.match(publish, /if \[ "\$is_draft" != "true" \]; then/);
});

test("Windows NSIS install and uninstall own only their per-user channel integration", () => {
  assert.equal(pkg.build.nsis.include, "build/installer.nsh");
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.allowElevation, false);
  assert.equal(pkg.build.nsis.runAfterFinish, false);
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.ok(
    pkg.build.win.extraResources.some((entry) => entry.to === "ade-cli/windows-install-setup.ps1"),
    "Windows package must carry the install setup script",
  );
  assert.ok(
    pkg.build.win.extraResources.some((entry) => entry.to === "ade-cli/windows-uninstall-cleanup.ps1"),
    "Windows package must carry the uninstall cleanup script",
  );
  const nsis = fs.readFileSync(path.join(desktopRoot, "build", "installer.nsh"), "utf8");
  const cleanup = fs.readFileSync(
    path.join(desktopRoot, "scripts", "windows-uninstall-cleanup.ps1"),
    "utf8",
  );
  const setup = fs.readFileSync(
    path.join(desktopRoot, "scripts", "windows-install-setup.ps1"),
    "utf8",
  );
  assert.match(nsis, /!macro customInstall/);
  assert.match(nsis, /windows-install-setup\.ps1/);
  assert.match(nsis, /!macro customUnInstall/);
  assert.match(nsis, /windows-uninstall-cleanup\.ps1/);
  assert.match(nsis, /-AppExecutableName "\$\{APP_EXECUTABLE_FILENAME\}"/);
  assert.match(nsis, /-PackageChannel "\$2"/);
  assert.match(nsis, /Abort/);
  assert.match(cleanup, /"serve", "--uninstall-service"/);
  assert.match(cleanup, /Start-Process/);
  assert.match(cleanup, /-Wait/);
  assert.match(cleanup, /cleanupProcess\.ExitCode/);
  assert.match(cleanup, /ADE_PACKAGE_CHANNEL = \$normalizedPackageChannel/);
  assert.match(cleanup, /\$env:ADE_HOME = \$channelAdeHome/);
  assert.match(cleanup, /app\.asar\.unpacked\\node_modules/);
  assert.match(cleanup, /NODE_PATH = \$nodePathEntries/);
  assert.match(cleanup, /SetEnvironmentVariable\("Path"/);
  assert.match(cleanup, /Remove-OwnedStableProtocolRegistration/);
  assert.match(setup, /install-path\.cmd/);
  assert.match(setup, /serve --install-service/);
  assert.match(setup, /ade-\$PackageChannel\.cmd/);
  assert.match(electronBuilderWrapper, /resolveWindowsPackageIdentity/);
  assert.match(electronBuilderWrapper, /--config\.fileAssociations\.name=\$\{channelIdentity\.fileClass\}/);
  assert.doesNotMatch(electronBuilderWrapper, /--config\.win\.fileAssociations/);
});

test("release preflight validates the exact approved commit", () => {
  assert.match(prepareWorkflow, /target_sha:\s*\n\s+description: Exact 40-character commit SHA/);
  assert.match(prepareWorkflow, /ref: \$\{\{ inputs\.target_sha \}\}/);
  assert.match(prepareWorkflow, /target_sha must be the exact 40-character commit SHA approved for release/);
  assert.match(prepareWorkflow, /target_ref: \$\{\{ needs\.resolve\.outputs\.target_sha \}\}/);
  assert.doesNotMatch(prepareWorkflow, /ref: main/);
});

test("pull requests build and smoke an unsigned Windows installer", () => {
  const packageJob = jobBlock(ciWorkflow, "package-win", "validate-docs");
  assert.match(packageJob, /runs-on: windows-latest/);
  assert.match(packageJob, /npm run dist:win/);
  assert.match(packageJob, /ADE_PACKAGE_CHANNEL: beta/);
  assert.match(packageJob, /windows-installed-product-smoke\.ps1/);
  assert.match(packageJob, /-CompanionInstallerPath/);
  assert.match(packageJob, /ADE_STABLE_INSTALLER/);
  const installedSmoke = fs.readFileSync(
    path.join(desktopRoot, "scripts", "windows-installed-product-smoke.ps1"),
    "utf8",
  );
  assert.match(installedSmoke, /Stop-InstalledProductProcesses/);
  assert.match(installedSmoke, /ExecutablePath/);
  assert.match(installedSmoke, /missing-executable repair/);
  assert.match(packageJob, /Test Stable and Beta installed-product lifecycles/);
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

test("download page gates the Windows release and enables dedicated analytics", () => {
  assert.match(downloadPage, /VITE_ADE_WINDOWS_DOWNLOAD_ENABLED/);
  assert.match(downloadPage, /signed Windows release is approved/);
  assert.match(downloadPage, /MARKETING_FEATURES\.DOWNLOAD_WINDOWS/);
  assert.match(downloadPage, /WINDOWS_DOWNLOAD_ENABLED \? LINKS\.releasesLatest : LINKS\.releases/);
});
