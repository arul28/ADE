import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWindowsPackageIdentity } from "./windows-package-identity.mjs";
import { ensureIcnsPng } from "./extract-icns-png.mjs";
import { retryTransient } from "./release-retry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identity = resolveWindowsPackageIdentity(process.env.ADE_PACKAGE_CHANNEL);
const channel = identity.packageChannel;
if (channel === "beta") throw new Error("Beta is an update track of the normal app, not a separate Linux package. Build the normal package with ADE_RELEASE_TAG set to a beta tag.");
const executable = channel === "stable" ? "ade-desktop" : `ade-desktop-${channel}`;
const repository = process.env.ADE_RELEASE_REPOSITORY?.trim() || "arul28/ADE";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("ADE_RELEASE_REPOSITORY must be an owner/repo pair");
const [owner, repo] = repository.split("/");
const iconChannel = channel !== "stable" ? channel : (/^v?\d+\.\d+\.\d+-beta\./.test(process.env.ADE_RELEASE_TAG || "") ? "beta" : null);
if (iconChannel) ensureIcnsPng(path.join(root, "build", `icon.${iconChannel}.icns`), path.join(root, "build", `icon.${iconChannel}.png`));
const args = ["--publish", "never", `--config.appId=${identity.appId}`,
  `--config.productName=${identity.productName}`, `--config.linux.executableName=${executable}`,
  `--config.extraMetadata.desktopName=${executable}.desktop`, "--config.linux.syncDesktopName=true",
  // electron-builder's ${arch} turns x64 into x86_64 for AppImage and amd64 for
  // deb. Every consumer (validator, release publish, download routes) expects
  // x64, and a release job packages only its host architecture.
  `--config.linux.artifactName=${identity.artifactBaseName}-\${version}-linux-${process.arch}.\${ext}`,
  `--config.publish.owner=${owner}`, `--config.publish.repo=${repo}`,
  `--config.extraMetadata.adeReleaseRepository=${repository}`,
  ...(channel === "stable" ? [] : [`--config.extraMetadata.adePackageChannel=${channel}`, `--config.extraMetadata.adeCliName=ade-${channel}`, `--config.directories.output=release-${channel}`]),
  ...(iconChannel ? [`--config.linux.icon=build/icon.${iconChannel}.png`] : []),
  ...(process.env.ADE_DESKTOP_VERSION ? [`--config.extraMetadata.version=${process.env.ADE_DESKTOP_VERSION}`] : []),
];
const outputDir = path.join(root, channel === "stable" ? "release" : `release-${channel}`);
// electron-builder downloads its packaging tools mid-build and gives up on one
// bad response, which used to fail the whole release for a GitHub hiccup.
const DOWNLOAD_FAILURE = /Response code (?:429|5\d\d)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|Premature close/;

function runElectronBuilder(target) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/electron-builder/out/cli/cli.js"), "--linux", target, ...args], {
      cwd: root,
      env: { ...process.env, ADE_LINUX_APPIMAGE_BUILD: target === "AppImage" ? "1" : "0" },
      stdio: ["inherit", "pipe", "pipe"],
    });
    let outputTail = "";
    const forward = (stream, sink) => stream.on("data", (chunk) => {
      sink.write(chunk);
      outputTail = `${outputTail}${chunk}`.slice(-8192);
    });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`electron-builder ${target} exited with ${code ?? signal}`), { stderr: outputTail }));
    });
  });
}

let appImageManifests = new Map();
for (const target of ["AppImage", "deb"]) {
  await retryTransient(`electron-builder ${target}`, () => runElectronBuilder(target), {
    attempts: 4,
    delayMs: 20_000,
    isTransient: DOWNLOAD_FAILURE,
  });
  if (target === "AppImage") {
    appImageManifests = new Map(fs.readdirSync(outputDir)
      .filter((name) => /-linux(?:-[a-z0-9]+)?\.yml$/.test(name))
      .map((name) => [name, fs.readFileSync(path.join(outputDir, name))]));
  } else {
    // A separate deb build may overwrite the feed with a deb URL. AppImage
    // updates must always point to the AppImage that can update itself.
    for (const [name, contents] of appImageManifests) fs.writeFileSync(path.join(outputDir, name), contents);
  }
}
