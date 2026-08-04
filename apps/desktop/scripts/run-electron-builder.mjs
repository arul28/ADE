import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveWindowsPackageIdentity,
  windowsInstallerArtifactName,
} from "./windows-package-identity.mjs";
import { ensureIcnsPng } from "./extract-icns-png.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const requireSigningIndex = process.argv.indexOf("--require-signing");
const requireSigning = requireSigningIndex >= 0;
const builderArgs = process.argv.slice(2).filter((arg) => arg !== "--require-signing");
const configuredRepository = (
  process.env.ADE_RELEASE_REPOSITORY?.trim()
  || `${pkg.build?.publish?.owner ?? ""}/${pkg.build?.publish?.repo ?? ""}`
).replace(/^\/+|\/+$/g, "");
const repositoryMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(configuredRepository);
const channelIdentity = resolveWindowsPackageIdentity(process.env.ADE_PACKAGE_CHANNEL);
const { packageChannel } = channelIdentity;
// Windows code signing runs against Azure Artifact Signing (the service
// formerly called Trusted Signing). There is no PFX to carry: CA/Browser Forum
// rules have required code-signing private keys to live on FIPS-validated
// hardware since June 2023, and this service never releases the certificate -
// it is held in the service and reachable only at the moment of signing. The
// only signing material the build sees is a Microsoft Entra service principal.
const AZURE_SIGNING_CREDENTIAL_ENV = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
// Non-secret account coordinates. They are pinned here, not in CI, so the same
// values are used by a maintainer running dist:win:signed locally; each one is
// still overridable for a fork or a migrated account.
const azureSigningEndpoint =
  process.env.WINDOWS_SIGNING_ENDPOINT?.trim() || "https://eus.codesigning.azure.net";
const azureSigningAccountName =
  process.env.WINDOWS_SIGNING_ACCOUNT_NAME?.trim() || "arulsigning";
const azureCertificateProfileName =
  process.env.WINDOWS_SIGNING_CERTIFICATE_PROFILE?.trim() || "adePublicTrust";
// One pinned publisher value serves two jobs: electron-builder writes it into
// app-update.yml as the publisherName electron-updater checks before it runs a
// downloaded installer, and validate-win-artifacts.mjs asserts the same string
// against the Authenticode signer of the built artifacts. electron-updater
// parses it as a Distinguished Name and warns when it is given only a CN, so
// this must be the complete Subject.
const expectedSigningSubject = process.env.WINDOWS_SIGNING_EXPECTED_SUBJECT?.trim() ?? "";
const configuredFileAssociation = Array.isArray(pkg.build?.fileAssociations)
  ? pkg.build.fileAssociations[0]
  : pkg.build?.fileAssociations;
if (!configuredFileAssociation || !Array.isArray(configuredFileAssociation.ext)) {
  throw new Error("Windows packaging requires the configured ADE file association extension list.");
}
// CSC_LINK/CSC_KEY_PASSWORD are the macOS Developer ID secrets. electron-builder
// reads them on Windows too, so they are stripped unconditionally rather than
// left to be picked up as an unexpected Windows signing identity. The Azure
// credentials are stripped from the base environment for the same reason and
// handed back only on the signed path, so an unsigned dist:win can never reach
// the signing service.
const baseChildEnv = { ...process.env };
delete baseChildEnv.CSC_LINK;
delete baseChildEnv.CSC_KEY_PASSWORD;
for (const name of AZURE_SIGNING_CREDENTIAL_ENV) {
  delete baseChildEnv[name];
}

if (!repositoryMatch) {
  throw new Error(
    `ADE_RELEASE_REPOSITORY must be a GitHub owner/repo pair, received: ${configuredRepository || "empty"}`,
  );
}

if (requireSigning) {
  const missingSecrets = AZURE_SIGNING_CREDENTIAL_ENV.filter((name) => !process.env[name]?.trim());
  if (missingSecrets.length > 0) {
    throw new Error(
      `Signed Windows packaging requires ${missingSecrets.join(", ")}. `
      + "Unsigned artifacts are allowed only through npm run dist:win.",
    );
  }
  if (!expectedSigningSubject) {
    throw new Error(
      "Signed Windows packaging requires WINDOWS_SIGNING_EXPECTED_SUBJECT, the complete certificate "
      + "Subject of the Azure Artifact Signing certificate profile, so the packaged updater and the "
      + "release validator pin the same publisher.",
    );
  }
  // Azure Artifact Signing renews its certificate daily and expires it after 72
  // hours, so a pinned thumbprint stops matching within days. Reject the name
  // instead of ignoring it, so nobody sets it and believes it pinned something.
  if (process.env.WINDOWS_SIGNING_EXPECTED_THUMBPRINT?.trim()) {
    throw new Error(
      "WINDOWS_SIGNING_EXPECTED_THUMBPRINT is not supported by the Azure Artifact Signing pipeline. "
      + "The service renews its certificate daily and expires it after 72 hours, so a pinned thumbprint "
      + "would fail every release within days. Unset it and pin WINDOWS_SIGNING_EXPECTED_SUBJECT instead.",
    );
  }
}

const [, owner, repo] = repositoryMatch;

// Channel branding. The icon is derived from the committed `.icns` rather than
// committed alongside it, and it has to be a CLI override rather than a
// package.json edit: validate-win-artifacts.mjs asserts that
// `build.win.icon` is exactly "build/icon.ico", so writing the channel icon
// into the config would fail the release contract.
// electron-builder converts a >=256px PNG into a multi-resolution .ico itself.
const channelWinIconArgs = (() => {
  if (packageChannel === "stable") return [];
  const icns = path.join(desktopRoot, "build", `icon.${packageChannel}.icns`);
  if (!fs.existsSync(icns)) {
    throw new Error(
      `Channel packaging needs build/icon.${packageChannel}.icns to brand the ${packageChannel} installer.`,
    );
  }
  const png = path.join(desktopRoot, "build", `icon.${packageChannel}.png`);
  const result = ensureIcnsPng(icns, png);
  if (result.regenerated) {
    console.log(`[windows-package] Extracted ${result.width}px ${result.type} icon -> build/icon.${packageChannel}.png`);
  }
  return [`--config.win.icon=build/icon.${packageChannel}.png`];
})();

const electronBuilderBin = path.join(
  desktopRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
);
const args = [
  ...builderArgs,
  `--config.publish.owner=${owner}`,
  `--config.publish.repo=${repo}`,
  `--config.extraMetadata.adeReleaseRepository=${configuredRepository}`,
  // The packaged app has to be able to tell which channel it is at RUNTIME, and
  // on Windows this is the only mechanism that survives packaging. macOS gets
  // the same value twice - here and through LSEnvironment in the plist - so the
  // omission was invisible there. Without it every lookup in
  // readBundledAdePackageChannel() (main.ts) fails: ADE_PACKAGE_CHANNEL is set
  // for THIS build process only and never reaches the shipped app;
  // `productName` lives under `build`, which electron-builder strips out of the
  // packaged package.json; and `name` stays "ade-desktop". The channel then
  // resolves to null, applyPackagedChannelDefaults() returns early, and an
  // installed Beta behaves as Stable - claiming ade://, overwriting Stable's
  // `ade` CLI shim, and driving Stable's brain and ~/.ade data.
  ...(packageChannel === "stable"
    ? []
    : [
        `--config.extraMetadata.adePackageChannel=${packageChannel}`,
        `--config.extraMetadata.adeCliName=ade-${packageChannel}`,
        // Keep each channel's installer, latest.yml, and win-unpacked/ in its
        // own tree. Installer filenames are already disambiguated, but
        // latest.yml is not, so a Beta build otherwise overwrites the updater
        // manifest a Stable build left behind in release/.
        `--config.directories.output=release-${packageChannel}`,
      ]),
  ...channelWinIconArgs,
  `--config.appId=${channelIdentity.appId}`,
  `--config.productName=${channelIdentity.productName}`,
  `--config.win.executableName=${channelIdentity.productName}`,
  // The product name carries a space on channel builds ("ADE Beta"), which
  // would leave the installer, latest.yml, and the published GitHub asset with
  // three different names. Pin the artifact name to the space-free channel base
  // so the updater feed can only ever reference the file published beside it.
  `--config.win.artifactName=${windowsInstallerArtifactName(channelIdentity)}`,
  `--config.fileAssociations.name=${channelIdentity.fileClass}`,
  `--config.fileAssociations.description=${configuredFileAssociation.description ?? "ADE files"}`,
  ...configuredFileAssociation.ext.map((extension) => `--config.fileAssociations.ext=${extension}`),
  // electron-builder 26 selects the Azure signing manager purely on the
  // presence of win.azureSignOptions, and that selection sits above the single
  // signIf() chokepoint every Windows artifact passes through - the packaged
  // channel executable and its bundled DLLs, the NSIS installer, and the
  // uninstaller. That is why the service is wired in here rather than as a
  // separate post-build workflow step: a step that ran after packaging could
  // only sign the installer, leaving the ADE.exe already embedded inside it
  // unsigned unless the installer were unpacked and rebuilt.
  ...(requireSigning
    ? [
        "--config.forceCodeSigning=true",
        `--config.win.azureSignOptions.publisherName=${expectedSigningSubject}`,
        `--config.win.azureSignOptions.endpoint=${azureSigningEndpoint}`,
        `--config.win.azureSignOptions.codeSigningAccountName=${azureSigningAccountName}`,
        `--config.win.azureSignOptions.certificateProfileName=${azureCertificateProfileName}`,
        "--config.win.azureSignOptions.fileDigest=SHA256",
        // Timestamping is not optional here. The signing certificate is valid
        // for 72 hours, so without an RFC3161 countersignature every shipped
        // installer would stop verifying three days after it was built.
        "--config.win.azureSignOptions.timestampRfc3161=http://timestamp.acs.microsoft.com",
        "--config.win.azureSignOptions.timestampDigest=SHA256",
      ]
    : []),
];

console.log(
  `[windows-package] Building ${channelIdentity.productName} for ${owner}/${repo}${requireSigning ? " with required Azure Artifact Signing" : " (unsigned allowed)"}.`,
);
const childEnv = {
  ...baseChildEnv,
  ADE_PACKAGE_CHANNEL: packageChannel === "stable" ? "" : packageChannel,
  ADE_DESKTOP_APP_NAME: channelIdentity.productName,
  // electron-builder authenticates to Microsoft Entra ID with Azure.Identity's
  // EnvironmentCredential, which reads exactly these names. It is first in the
  // credential chain, so a complete service-principal triple is resolved before
  // any managed-identity probe against the Azure IMDS endpoint - which a
  // GitHub-hosted runner does not have.
  ...(requireSigning
    ? Object.fromEntries(
        AZURE_SIGNING_CREDENTIAL_ENV.map((name) => [name, process.env[name]]),
      )
    : {}),
};
const electronBuilderCommand = process.platform === "win32" ? process.execPath : electronBuilderBin;
const electronBuilderArgs = process.platform === "win32"
  ? [path.join(desktopRoot, "node_modules", "electron-builder", "out", "cli", "cli.js"), ...args]
  : args;
const child = spawn(electronBuilderCommand, electronBuilderArgs, {
  cwd: desktopRoot,
  env: childEnv,
  stdio: "inherit",
  shell: false,
  windowsHide: process.platform === "win32",
});
child.once("error", (error) => {
  console.error(`[windows-package] Unable to start electron-builder: ${error.message}`);
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = code ?? 1;
});
