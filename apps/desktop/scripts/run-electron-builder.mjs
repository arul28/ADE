import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveWindowsPackageIdentity,
  windowsInstallerArtifactName,
} from "./windows-package-identity.mjs";

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
const canonicalWindowsCscLink = process.env.WINDOWS_CSC_LINK;
const canonicalWindowsCscKeyPassword = process.env.WINDOWS_CSC_KEY_PASSWORD;
const configuredFileAssociation = Array.isArray(pkg.build?.fileAssociations)
  ? pkg.build.fileAssociations[0]
  : pkg.build?.fileAssociations;
if (!configuredFileAssociation || !Array.isArray(configuredFileAssociation.ext)) {
  throw new Error("Windows packaging requires the configured ADE file association extension list.");
}
const baseChildEnv = { ...process.env };
delete baseChildEnv.CSC_LINK;
delete baseChildEnv.CSC_KEY_PASSWORD;
delete baseChildEnv.WINDOWS_CSC_LINK;
delete baseChildEnv.WINDOWS_CSC_KEY_PASSWORD;

if (!repositoryMatch) {
  throw new Error(
    `ADE_RELEASE_REPOSITORY must be a GitHub owner/repo pair, received: ${configuredRepository || "empty"}`,
  );
}

if (requireSigning) {
  const missingSecrets = ["WINDOWS_CSC_LINK", "WINDOWS_CSC_KEY_PASSWORD"]
    .filter((name) => !process.env[name]?.trim());
  if (missingSecrets.length > 0) {
    throw new Error(
      `Signed Windows packaging requires ${missingSecrets.join(" and ")}. `
      + "Unsigned artifacts are allowed only through npm run dist:win.",
    );
  }
}

const [, owner, repo] = repositoryMatch;
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
  ...(requireSigning ? ["--config.forceCodeSigning=true"] : []),
];

console.log(
  `[windows-package] Building ${channelIdentity.productName} for ${owner}/${repo}${requireSigning ? " with required Authenticode signing" : " (unsigned allowed)"}.`,
);
const childEnv = {
  ...baseChildEnv,
  ADE_PACKAGE_CHANNEL: packageChannel === "stable" ? "" : packageChannel,
  ADE_DESKTOP_APP_NAME: channelIdentity.productName,
  ...(requireSigning
    ? {
        CSC_LINK: canonicalWindowsCscLink,
        CSC_KEY_PASSWORD: canonicalWindowsCscKeyPassword,
      }
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
