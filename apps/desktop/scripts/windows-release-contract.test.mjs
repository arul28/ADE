import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  isGithubSafeAssetName,
  resolveWindowsPackageIdentity,
  windowsInstallerArtifactName,
  windowsInstallerPattern,
} from "./windows-package-identity.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const releaseWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release-core.yml"), "utf8").replace(/\r\n/g, "\n");
const releaseTriggerWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8").replace(/\r\n/g, "\n");
const releasePublishWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release-publish.yml"), "utf8").replace(/\r\n/g, "\n");
const prepareWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "prepare-release.yml"), "utf8").replace(/\r\n/g, "\n");
const ciWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
const appUpdate = parseYaml(fs.readFileSync(path.join(desktopRoot, "resources", "app-update.yml"), "utf8"));
// Downloads moved out of a dedicated page and into the home hero, one button
// per platform. The gate disclosure moved with them, so this reads the hero.
const downloadPage = fs.readFileSync(path.join(repoRoot, "apps", "web", "src", "components", "editorial", "Lede.tsx"), "utf8");
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

const remoteTargets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];

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
    const binary = target === "win32-x64" ? `ade-${target}.exe` : `ade-${target}`;
    assert.ok(runtimeFilter.includes(binary), target);
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
  assert.match(windowsRelease, /ADE_WINDOWS_PUBLIC_RELEASE_ENABLED == '1' \|\| inputs\.windows_proof/);
  assert.match(windowsRelease, /npm run dist:win:signed/);
  assert.match(windowsRelease, /ADE_RELEASE_REPOSITORY:\s*\$\{\{ github\.repository \}\}/);
  // Azure Artifact Signing holds the private key and never releases the
  // certificate, so the only signing material the job carries is a Microsoft
  // Entra service principal. No PFX secret exists to reference any more.
  assert.match(windowsRelease, /AZURE_TENANT_ID: \$\{\{ secrets\.AZURE_TENANT_ID \}\}/);
  assert.match(windowsRelease, /AZURE_CLIENT_ID: \$\{\{ secrets\.AZURE_CLIENT_ID \}\}/);
  assert.match(windowsRelease, /AZURE_CLIENT_SECRET: \$\{\{ secrets\.AZURE_CLIENT_SECRET \}\}/);
  assert.doesNotMatch(releaseWorkflow, /WIN_CSC_LINK|WINDOWS_CSC_LINK|WINDOWS_CSC_KEY_PASSWORD/);
  assert.match(windowsRelease, /WINDOWS_SIGNING_EXPECTED_SUBJECT/);
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
  delete env.AZURE_TENANT_ID;
  delete env.AZURE_CLIENT_ID;
  delete env.AZURE_CLIENT_SECRET;
  const result = spawnSync(process.execPath, [wrapper, "--require-signing", "--win", "--x64"], {
    cwd: desktopRoot,
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Signed Windows packaging requires AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET/,
  );
});

test("signed packaging stops before electron-builder when the publisher is unpinned", () => {
  const wrapper = path.join(desktopRoot, "scripts", "run-electron-builder.mjs");
  const env = {
    ...process.env,
    AZURE_TENANT_ID: "tenant",
    AZURE_CLIENT_ID: "client",
    AZURE_CLIENT_SECRET: "secret",
  };
  delete env.WINDOWS_SIGNING_EXPECTED_SUBJECT;
  const result = spawnSync(process.execPath, [wrapper, "--require-signing", "--win", "--x64"], {
    cwd: desktopRoot,
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Signed Windows packaging requires WINDOWS_SIGNING_EXPECTED_SUBJECT/,
  );
});

// Azure Artifact Signing renews the certificate daily and expires it after 72
// hours, so thumbprint pinning would fail every release within days. Every
// layer that could accept the name must reject it instead of ignoring it.
test("thumbprint pinning is rejected everywhere rather than silently ignored", () => {
  const wrapper = path.join(desktopRoot, "scripts", "run-electron-builder.mjs");
  const result = spawnSync(process.execPath, [wrapper, "--require-signing", "--win", "--x64"], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      AZURE_TENANT_ID: "tenant",
      AZURE_CLIENT_ID: "client",
      AZURE_CLIENT_SECRET: "secret",
      WINDOWS_SIGNING_EXPECTED_SUBJECT: "CN=Example",
      WINDOWS_SIGNING_EXPECTED_THUMBPRINT: "0123456789ABCDEF",
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /WINDOWS_SIGNING_EXPECTED_THUMBPRINT is not supported/,
  );
  assert.match(winArtifactValidator, /WINDOWS_SIGNING_EXPECTED_THUMBPRINT is not supported/);
  assert.match(windowsRuntimeSigner, /WINDOWS_SIGNING_EXPECTED_THUMBPRINT is not supported/);
  assert.match(releaseWorkflow, /WINDOWS_SIGNING_EXPECTED_THUMBPRINT is not supported/);
  assert.match(prepareWorkflow, /WINDOWS_SIGNING_EXPECTED_THUMBPRINT is not supported/);
  // The subject is now the only pin, so the validator must require it outright
  // rather than accepting either name.
  assert.doesNotMatch(
    winArtifactValidator,
    /WINDOWS_SIGNING_EXPECTED_SUBJECT\s*"?\s*\+?\s*"?\s*or WINDOWS_SIGNING_EXPECTED_THUMBPRINT/,
  );
  assert.doesNotMatch(winArtifactValidator, /expectedIdentity\.thumbprint &&/);
});

test("Windows packaging signs through Azure Artifact Signing and no local key material", () => {
  // electron-builder 26 picks the Azure signing manager purely on the presence
  // of win.azureSignOptions, above the single chokepoint that signs the
  // packaged executable, its DLLs, the NSIS installer, and the uninstaller.
  assert.match(electronBuilderWrapper, /--config\.win\.azureSignOptions\.publisherName=\$\{expectedSigningSubject\}/);
  assert.match(electronBuilderWrapper, /--config\.win\.azureSignOptions\.endpoint=\$\{azureSigningEndpoint\}/);
  assert.match(
    electronBuilderWrapper,
    /--config\.win\.azureSignOptions\.codeSigningAccountName=\$\{azureSigningAccountName\}/,
  );
  assert.match(
    electronBuilderWrapper,
    /--config\.win\.azureSignOptions\.certificateProfileName=\$\{azureCertificateProfileName\}/,
  );
  // The certificate lives for 72 hours, so an RFC3161 countersignature is what
  // keeps a shipped installer verifiable afterwards.
  assert.match(
    electronBuilderWrapper,
    /--config\.win\.azureSignOptions\.timestampRfc3161=http:\/\/timestamp\.acs\.microsoft\.com/,
  );
  assert.match(electronBuilderWrapper, /--config\.forceCodeSigning=true/);
  // The macOS Developer ID secrets must never become a Windows signing
  // identity, and an unsigned dist:win must never reach the signing service.
  assert.match(electronBuilderWrapper, /delete baseChildEnv\.CSC_LINK/);
  assert.match(electronBuilderWrapper, /delete baseChildEnv\.CSC_KEY_PASSWORD/);
  assert.match(
    electronBuilderWrapper,
    /AZURE_SIGNING_CREDENTIAL_ENV = \["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"\]/,
  );
  assert.match(electronBuilderWrapper, /for \(const name of AZURE_SIGNING_CREDENTIAL_ENV\) \{\s*\n\s*delete baseChildEnv\[name\];/);
  assert.doesNotMatch(electronBuilderWrapper, /CSC_LINK:|CSC_KEY_PASSWORD:|\.pfx|WINDOWS_CSC_/);
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
  const stable = resolveWindowsPackageIdentity("stable");
  const beta = resolveWindowsPackageIdentity("beta");
  const artifacts = [
    "ADE-1.2.3-win-x64.exe",
    "ADE-Beta-1.2.3-win-x64.exe",
  ];
  assert.equal(beta.executableName, "ADE Beta.exe");
  assert.deepEqual(artifacts.filter((name) => windowsInstallerPattern(beta).test(name)), [
    "ADE-Beta-1.2.3-win-x64.exe",
  ]);
  assert.deepEqual(artifacts.filter((name) => windowsInstallerPattern(stable).test(name)), [
    "ADE-1.2.3-win-x64.exe",
  ]);
  assert.match(winArtifactValidator, /windowsInstallerPattern\(packageIdentity\)/);
});

test("Windows installer names stay GitHub-safe so latest.yml matches the published asset", () => {
  const stable = resolveWindowsPackageIdentity("stable");
  const beta = resolveWindowsPackageIdentity("beta");
  const alpha = resolveWindowsPackageIdentity("alpha");
  // electron-builder writes the installer from ${productName} but rewrites
  // latest.yml's url/path to a space-free "safe" name for GitHub, and
  // release-publish.yml publishes the on-disk file through `gh release upload`,
  // where GitHub normalizes disallowed characters again. Any space in the
  // artifact name therefore points the updater feed at a file nobody published.
  for (const identity of [stable, beta, alpha]) {
    const rendered = windowsInstallerArtifactName(identity)
      .replace("${version}", "1.2.3")
      .replace("${arch}", "x64")
      .replace("${ext}", "exe");
    assert.ok(
      isGithubSafeAssetName(rendered),
      `${identity.packageChannel} installer name must be GitHub-safe, got ${rendered}`,
    );
    assert.ok(windowsInstallerPattern(identity).test(rendered));
  }
  assert.equal(stable.artifactBaseName, "ADE");
  assert.equal(beta.artifactBaseName, "ADE-Beta");
  assert.equal(pkg.build.win.artifactName, windowsInstallerArtifactName(stable));
  assert.doesNotMatch(pkg.build.win.artifactName, /\$\{productName\}/);
  assert.match(
    electronBuilderWrapper,
    /--config\.win\.artifactName=\$\{windowsInstallerArtifactName\(channelIdentity\)\}/,
  );
  assert.match(winArtifactValidator, /isGithubSafeAssetName\(installerName\)/);
  assert.match(winArtifactValidator, /build\.win\.artifactName must be/);
  // The Stable glob must not depend on step ordering to avoid selecting the
  // Beta installer once both live in apps/desktop/release.
  const packageJob = jobBlock(ciWorkflow, "package-win", "validate-docs");
  assert.match(packageJob, /release\/ADE-\[0-9\]\*-win-x64\.exe/);
  assert.match(packageJob, /release\/ADE-Beta-\[0-9\]\*-win-x64\.exe/);
  assert.doesNotMatch(packageJob, /ADE Beta-/);
  assert.match(releaseWorkflow, /release\/ADE-\[0-9\]\*-win-x64\.exe/);
});

test("standalone Windows runtime signing uses only canonical credentials and validates publisher identity", () => {
  const runtimeBuild = jobBlock(releaseWorkflow, "build-runtime-binaries", "build-results");
  const windowsSignStep = runtimeBuild.slice(
    runtimeBuild.indexOf("- name: Sign and validate standalone Windows runtime"),
    runtimeBuild.indexOf("- name: Materialize runtime notarization API key"),
  );
  assert.match(runtimeBuild, /target: win32-x64[\s\S]*os: windows-latest[\s\S]*binary: ade-win32-x64\.exe/);
  assert.match(windowsSignStep, /matrix\.target == 'win32-x64'/);
  assert.match(windowsSignStep, /ADE_WINDOWS_PUBLIC_RELEASE_ENABLED == '1' \|\| inputs\.windows_proof/);
  assert.match(windowsSignStep, /AZURE_TENANT_ID: \$\{\{ secrets\.AZURE_TENANT_ID \}\}/);
  assert.match(windowsSignStep, /AZURE_CLIENT_ID: \$\{\{ secrets\.AZURE_CLIENT_ID \}\}/);
  assert.match(windowsSignStep, /AZURE_CLIENT_SECRET: \$\{\{ secrets\.AZURE_CLIENT_SECRET \}\}/);
  assert.match(windowsSignStep, /WINDOWS_SIGNING_EXPECTED_SUBJECT/);
  assert.doesNotMatch(windowsSignStep, /(?:^|\s)(?:WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD|CSC_LINK|CSC_KEY_PASSWORD|WINDOWS_CSC_LINK|WINDOWS_CSC_KEY_PASSWORD):/m);
  assert.match(windowsSignStep, /sign-windows-runtime\.ps1/);
  // The standalone runtime signs through the same Azure Artifact Signing
  // mechanism electron-builder 26 uses, so there is one signing code path for
  // every Windows artifact ADE publishes.
  assert.match(windowsRuntimeSigner, /Invoke-TrustedSigning/);
  assert.match(windowsRuntimeSigner, /-CodeSigningAccountName \$signingAccountName/);
  assert.match(windowsRuntimeSigner, /-CertificateProfileName \$certificateProfileName/);
  assert.match(windowsRuntimeSigner, /timestamp\.acs\.microsoft\.com/);
  // Post-sign verification stays exactly as strict: valid status, a trusted
  // RFC3161 timestamp, and the pinned publisher subject.
  assert.match(windowsRuntimeSigner, /Get-AuthenticodeSignature/);
  assert.match(windowsRuntimeSigner, /SignatureStatus\]::Valid/);
  assert.match(windowsRuntimeSigner, /TimeStamperCertificate/);
  assert.match(windowsRuntimeSigner, /WINDOWS_SIGNING_EXPECTED_SUBJECT/);
  // The service never releases the certificate, so the signer must not contain
  // any local key-material handling at all.
  assert.doesNotMatch(windowsRuntimeSigner, /X509Certificate2|\.pfx|WINDOWS_CSC_|Set-AuthenticodeSignature/);
  assert.doesNotMatch(windowsRuntimeSigner, /Write-Output.*(?:AZURE_CLIENT_SECRET|expectedSubject)/);
});

test("standalone Windows release assets remain behind the publication gate", () => {
  const publish = jobBlock(releasePublishWorkflow, "publish-release", null);
  const runtimeBuild = jobBlock(releaseWorkflow, "build-runtime-binaries", "build-results");
  const installer = fs.readFileSync(
    path.join(repoRoot, "apps", "ade-cli", "scripts", "install-runtime.ps1"),
    "utf8",
  );
  const releaseFiles = publish.slice(publish.indexOf("base_files=("), publish.indexOf("if [ \"$PUBLISH_WINDOWS\"", publish.indexOf("base_files=(")));
  assert.doesNotMatch(releaseFiles, /install\.ps1|ade-win32-x64/);
  assert.match(publish, /installers=\(release-assets\/win\/ADE-\*-win-x64\.exe\)/);
  assert.match(publish, /test -s release-assets\/runtime\/install\.ps1/);
  assert.match(publish, /test -s release-assets\/runtime\/ade-win32-x64\.exe/);
  assert.match(publish, /test -s release-assets\/runtime\/ade-win32-x64\.native\.tar\.gz/);
  // The Windows standalone manifest is written by Git Bash on windows-latest,
  // where sha256sum marks binary reads with a leading '*'. It is normalized
  // before it is parsed or verified.
  assert.match(publish, /sed 's\/\^\\\(\[0-9a-f\]\\\{64\\\}\\\) \[ \*\]\/\\1  \/'/);
  assert.match(publish, /\(cd release-assets\/runtime && sha256sum -c "\$windows_sums"\)/);
  // Windows standalone assets are named only inside the publication-gated
  // branch, and every published asset is sourced from this run.
  assert.match(publish, /if \[ "\$PUBLISH_WINDOWS" = "1" \]; then[\s\S]*release-assets\/runtime\/install\.ps1[\s\S]*release-assets\/runtime\/ade-win32-x64\.exe/);
  assert.doesNotMatch(publish, /release-assets\/win\/ade-|release-assets\/win\/install\.|release-assets\/win\/SHA256SUMS/);
  assert.match(publish, /for asset in "\$\{existing_assets\[@\]\}"; do[\s\S]*gh release delete-asset/);
  assert.match(publish, /gh release delete-asset "\$TAG_NAME" "\$asset" --repo "\$GH_REPO" --yes/);
  assert.match(publish, /Draft release asset inventory differs from the exact validated set/);
  assert.match(runtimeBuild, /name: Assemble signed Windows standalone runtime bundle/);
  assert.match(runtimeBuild, /matrix\.target == 'win32-x64' && \(vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED == '1' \|\| inputs\.windows_proof\)/);
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
  const publish = jobBlock(releasePublishWorkflow, "publish-release", null);
  const verify = jobBlock(releaseWorkflow, "verify", "build-mac-release");
  const workflowHeader = releaseWorkflow.slice(0, releaseWorkflow.indexOf("\njobs:\n"));
  assert.match(workflowHeader, /contents: read/);
  assert.doesNotMatch(workflowHeader, /contents: write/);
  assert.match(releaseTriggerWorkflow, /permissions:\s*\n\s+actions: read\s*\n\s+checks: read\s*\n\s+contents: write/);
  // GitHub validates a called workflow's job permissions statically, before any
  // job-level `if:` runs, so release-core.yml must not contain a write-capable
  // job at all or the read-only prepare-release.yml caller fails to parse.
  // Publishing therefore lives in its own reusable workflow.
  assert.doesNotMatch(releaseWorkflow, /contents: write/);
  assert.equal(releaseWorkflow.includes("\n  publish-release:\n"), false);
  assert.match(publish, /permissions:\s*\n\s+actions: read\s*\n\s+contents: write/);
  assert.match(publish, /name: ade-win-release-/);
  // Only the tag-triggered release workflow may call the publishing workflow.
  assert.match(releaseTriggerWorkflow, /uses: \.\/\.github\/workflows\/release-publish\.yml/);
  assert.doesNotMatch(prepareWorkflow, /release-publish\.yml/);
  // Windows is a first-class platform: with its gate on, a failed or skipped
  // Windows build blocks the draft exactly as a failed macOS build does, and
  // always() still lets the gate evaluate when Windows is legitimately skipped.
  assert.match(releaseTriggerWorkflow, /always\(\)\s*\n\s+&& needs\.run-release\.outputs\.runtime_result == 'success'/);
  assert.match(releaseTriggerWorkflow, /needs\.run-release\.outputs\.mac_result == 'success'/);
  assert.match(
    releaseTriggerWorkflow,
    /vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED != '1'\s*\n\s+\|\| needs\.run-release\.outputs\.windows_result == 'success'/,
  );
  // The gate reads release-core.yml's outputs, so they must exist and be fed by
  // an always() job that reports every build result.
  for (const output of ["runtime_result", "mac_result", "windows_result"]) {
    assert.match(releaseWorkflow, new RegExp(`value: \\$\\{\\{ jobs\\.build-results\\.outputs\\.${output} \\}\\}`));
  }
  const buildResults = jobBlock(releaseWorkflow, "build-results", null);
  assert.match(buildResults, /if: always\(\)/);
  assert.match(buildResults, /runtime_result: \$\{\{ needs\.build-runtime-binaries\.result \}\}/);
  assert.match(buildResults, /mac_result: \$\{\{ needs\.build-mac-release\.result \}\}/);
  assert.match(buildResults, /windows_result: \$\{\{ needs\.build-win-release\.result \}\}/);
  // verify fails fast on missing signing material instead of on stale proof
  // bindings, which no longer exist.
  assert.match(verify, /Windows releases require the AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET secrets/);
  assert.match(verify, /Windows releases require the WINDOWS_SIGNING_EXPECTED_SUBJECT secret to pin the approved publisher/);
  assert.match(verify, /PUBLISH_WINDOWS: \$\{\{ vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED \}\}/);
  assert.match(publish, /if: \$\{\{ vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED == '1' \}\}/);
  assert.match(publish, /PUBLISH_WINDOWS: \$\{\{ vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED \}\}/);
  assert.match(publish, /if \[ "\$PUBLISH_WINDOWS" = "1" \]; then/);
  assert.match(publish, /release-assets\/win\/ADE-\*-win-x64\.exe/);
  assert.match(publish, /release-assets\/win\/ADE-\*-win-x64\.exe\.blockmap/);
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
  const verify = jobBlock(releaseWorkflow, "verify", "build-mac-release");
  assert.match(prepareWorkflow, /target_sha:\s*\n\s+description: Exact 40-character commit SHA/);
  assert.match(prepareWorkflow, /ref: \$\{\{ inputs\.target_sha \}\}/);
  assert.match(prepareWorkflow, /target_sha must be the exact 40-character commit SHA approved for release/);
  assert.match(prepareWorkflow, /target_ref: \$\{\{ needs\.resolve\.outputs\.target_sha \}\}/);
  assert.doesNotMatch(prepareWorkflow, /ref: main/);
  assert.match(verify, /name: Validate release tag and target binding/);
  assert.match(verify, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+/);
  assert.match(verify, /git ls-remote --exit-code --tags origin "refs\/tags\/\$RELEASE_TAG"/);
  assert.match(verify, /git rev-list -n 1 "refs\/tags\/\$RELEASE_TAG"/);
  assert.match(verify, /Release tag \$RELEASE_TAG resolves to \$tag_sha, not approved target \$target_sha/);
});

test("Windows proof collection is opt-in, non-publishing, and emits an exact-SHA manifest", () => {
  const windowsRelease = jobBlock(releaseWorkflow, "build-win-release", "build-runtime-binaries");
  assert.match(prepareWorkflow, /name: Prepare signed Windows proof/);
  assert.match(prepareWorkflow, /Signed Windows proof requires the AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET secrets/);
  assert.match(prepareWorkflow, /windows_proof: \$\{\{ inputs\.windows_proof \}\}/);
  // There is no publish input any more. The dry run cannot publish because it
  // holds a read-only token and never calls the publishing workflow, not
  // because it passes a flag the shared workflow is trusted to honour.
  assert.doesNotMatch(prepareWorkflow, /publish:/);
  assert.match(prepareWorkflow, /permissions:\s*\n\s+actions: read\s*\n\s+checks: read\s*\n\s+contents: read/);
  assert.doesNotMatch(prepareWorkflow, /contents: write/);
  // Proof collection never depends on a repository variable state, so it can
  // run before Windows is enabled and again as a regression check after.
  assert.doesNotMatch(prepareWorkflow, /vars\.ADE_WINDOWS_/);
  // The proof bundle is built only under the explicit input; ordinary releases
  // build, sign and validate Windows without it.
  for (const proofStep of [
    "Stage standalone runtime proof assets",
    "Generate exact-SHA Windows proof manifest",
    "Validate exact-SHA Windows build proof",
    "Upload validated Windows proof bundle",
  ]) {
    const stepIndex = windowsRelease.indexOf(`- name: ${proofStep}`);
    assert.notEqual(stepIndex, -1, `expected proof step ${proofStep}`);
    assert.match(
      windowsRelease.slice(stepIndex, stepIndex + 400),
      /if: \$\{\{ inputs\.windows_proof \}\}/,
      `${proofStep} must be gated on the windows_proof input`,
    );
  }
  assert.match(windowsRelease, /name: ade-win-proof-\$\{\{ inputs\.release_tag \}\}/);
  assert.match(windowsRelease, /windows-proof-manifest\.mjs create/);
  assert.match(windowsRelease, /--target-sha "\$\{\{ inputs\.target_ref \}\}"/);
  assert.match(windowsRelease, /windows-proof-manifest\.mjs validate/);
  assert.match(windowsRelease, /--phase build/);
  assert.match(windowsRelease, /--expected-sha "\$\{\{ inputs\.target_ref \}\}"/);
  assert.match(windowsRelease, /--expected-tag "\$\{\{ inputs\.release_tag \}\}"/);
  assert.match(windowsRelease, /--expected-run-id "\$\{\{ github\.run_id \}\}"/);
  assert.match(windowsRelease, /name: Stage standalone runtime proof assets/);
  assert.match(windowsRelease, /ade-win32-x64\.exe/);
  assert.match(windowsRelease, /ade-win32-x64\.native\.tar\.gz/);
  assert.match(windowsRelease, /install-runtime\.ps1/);
  assert.match(windowsRelease, /SHA256SUMS/);
  assert.match(windowsRelease, /apps\/desktop\/release\/windows-proof-manifest\.json/);
});

test("Windows builds fresh on the release tag with no approved-proof promotion", () => {
  const windowsRelease = jobBlock(releaseWorkflow, "build-win-release", "build-runtime-binaries");
  // The desktop Windows build is no longer confined to non-publishing runs, so
  // a v* tag builds, signs, validates and publishes Windows in-run.
  assert.doesNotMatch(windowsRelease, /inputs\.publish == false/);
  assert.match(windowsRelease, /runs-on: windows-latest/);
  assert.match(windowsRelease, /- verify\s*\n\s+- build-runtime-binaries/);
  assert.match(windowsRelease, /name: Upload validated Windows release artifacts/);
  assert.match(windowsRelease, /name: ade-win-release-\$\{\{ inputs\.release_tag \}\}/);
  // The published artifact carries the installer set only; standalone runtime
  // files are published from build-runtime-binaries instead.
  assert.doesNotMatch(
    windowsRelease.slice(
      windowsRelease.indexOf("- name: Upload validated Windows release artifacts"),
      windowsRelease.indexOf("- name: Stage standalone runtime proof assets"),
    ),
    /ade-darwin-|ade-linux-|install\.sh/,
  );
  // Promotion of a previously approved proof run is gone, along with every
  // repository variable that only existed to bind it.
  assert.equal(releaseWorkflow.includes("promote-approved-win-proof"), false);
  assert.doesNotMatch(
    releaseWorkflow,
    /ADE_WINDOWS_APPROVED_PROOF_SHA|ADE_WINDOWS_APPROVED_PROOF_RUN_ID|ADE_WINDOWS_APPROVED_BUILD_MANIFEST_SHA256|ADE_WINDOWS_INSTALLED_UPDATE_PROOF_APPROVED|ADE_WINDOWS_SIGNED_BUILD_ENABLED/,
  );
});

test("Windows proof and draft assembly enforce exact runtime and remote asset inventories", () => {
  const windowsRelease = jobBlock(releaseWorkflow, "build-win-release", "build-runtime-binaries");
  const publish = jobBlock(releasePublishWorkflow, "publish-release", null);
  assert.match(windowsRelease, /\$unexpectedRuntimeFiles = @\(\$actualRuntimeFiles \| Where-Object \{ \$_ -notin \$runtimeFiles \}\)/);
  assert.match(windowsRelease, /Runtime artifact inventory mismatch/);
  assert.doesNotMatch(windowsRelease, /Get-ChildItem[^\n]+-Filter "ade-\*"[^\n]+ForEach-Object \{/);
  // The cross-platform runtime allowlist now guards the ungated publish path,
  // so it holds in every flag state rather than only when Windows publishes.
  assert.match(publish, /Runtime artifacts contain an unauthorized or missing entry/);
  assert.match(publish, /Windows standalone checksum manifest does not name the exact authorized Windows runtime set/);
  assert.match(publish, /latest\.yml does not reference the published installer/);
  assert.match(publish, /gh api "repos\/\$GH_REPO\/commits\/\$TAG_NAME" --jq '\.sha'/);
  assert.match(publish, /Existing draft tag \$TAG_NAME resolves to \$release_tag_target, not approved target \$approved_target/);
  assert.match(publish, /Draft release tag \$TAG_NAME resolves to \$final_tag_target, not approved target \$approved_target/);
  assert.match(publish, /for asset in "\$\{existing_assets\[@\]\}"; do[\s\S]*gh release delete-asset/);
  assert.doesNotMatch(publish, /case "\$asset" in/);
  assert.match(publish, /Draft release asset inventory differs from the exact validated set/);
  assert.match(publish, /gh release view "\$TAG_NAME" --repo "\$GH_REPO" --json assets --jq '\.assets\[\]\.name'/);
});

test("one repository variable decides whether a release carries Windows", () => {
  const windowsRelease = jobBlock(releaseWorkflow, "build-win-release", "build-runtime-binaries");
  const publish = jobBlock(releasePublishWorkflow, "publish-release", null);
  // Exactly one maintainer-facing switch, matching the macOS bar: secrets are
  // provisioned once, the gate is flipped once, then tags just work.
  assert.match(windowsRelease, /if: \$\{\{ vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED == '1' \|\| inputs\.windows_proof \}\}/);
  assert.match(releaseTriggerWorkflow, /vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED != '1'/);
  assert.match(publish, /vars\.ADE_WINDOWS_PUBLIC_RELEASE_ENABLED == '1'/);
  const windowsVariables = new Set(
    ([releaseWorkflow, releaseTriggerWorkflow, releasePublishWorkflow]
      .join("\n")
      .match(/vars\.ADE_WINDOWS_[A-Z0-9_]+/g) ?? []).map((entry) => entry.slice("vars.".length)),
  );
  assert.deepEqual([...windowsVariables], ["ADE_WINDOWS_PUBLIC_RELEASE_ENABLED"]);
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

test("the site gates the Windows release and enables dedicated analytics", () => {
  assert.match(downloadPage, /VITE_ADE_WINDOWS_DOWNLOAD_ENABLED/);
  assert.match(downloadPage, /=== "1"/);
  // Ungated, the Windows CTA must not read as an available download, and must
  // say what has to happen first. Wording is free to change; what this pins is
  // that the disclosure exists at all, so nobody can quietly ship a Windows
  // button implying an artifact is there. The label itself is checked because
  // it is the only thing most visitors read.
  assert.match(downloadPage, /signed installer ships once the Windows release proof passes/);
  assert.match(downloadPage, /Windows \(beta\)/);
  assert.match(downloadPage, /MARKETING_FEATURES\.DOWNLOAD_WINDOWS/);
  assert.match(downloadPage, /WINDOWS_DOWNLOAD_ENABLED \? LINKS\.releasesLatest : LINKS\.releases/);
});
