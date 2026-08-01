import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

if (!repositoryMatch) {
  throw new Error(
    `ADE_RELEASE_REPOSITORY must be a GitHub owner/repo pair, received: ${configuredRepository || "empty"}`,
  );
}

if (requireSigning) {
  const missingSecrets = ["CSC_LINK", "CSC_KEY_PASSWORD"].filter((name) => !process.env[name]?.trim());
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
  ...(requireSigning ? ["--config.forceCodeSigning=true"] : []),
];

console.log(
  `[windows-package] Building for ${owner}/${repo}${requireSigning ? " with required Authenticode signing" : " (unsigned allowed)"}.`,
);
const child = spawn(electronBuilderBin, args, {
  cwd: desktopRoot,
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.once("error", (error) => {
  console.error(`[windows-package] Unable to start electron-builder: ${error.message}`);
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = code ?? 1;
});
