import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { createPackagedTreeAssertions, findNodePtyAddon } from "./validate-packaged-tree.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const channel = (process.env.ADE_PACKAGE_CHANNEL || "").toLowerCase();
const suffix = channel === "alpha" || channel === "beta" ? `-${channel}` : "";
const release = path.join(root, `release${suffix}`);
const arch = process.arch;
if (process.platform !== "linux" || !["x64", "arm64"].includes(arch)) {
  throw new Error("Linux artifact validation requires a Linux x64 or arm64 host.");
}
const unpacked = path.join(release, arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked");
const resources = path.join(unpacked, "resources");
const runtime = path.join(resources, "app.asar.unpacked");
const assertions = createPackagedTreeAssertions({ fail: (message) => { throw new Error(`[validate-linux-artifacts] ${message}`); } });
const required = [
  [path.join(unpacked, `ade-desktop${suffix}`), "desktop executable"],
  [path.join(unpacked, "chrome-sandbox"), "Chromium sandbox"],
  [path.join(resources, "app.asar"), "application archive"],
  [path.join(resources, "ade-cli/bin/ade"), "CLI wrapper"],
  [path.join(resources, "runtime", `ade-linux-${arch}`), "runtime binary"],
  [path.join(resources, "runtime", `ade-linux-${arch}.native.tar.gz`), "runtime native archive"],
  [path.join(resources, "native/ade-desktop-driver"), "Linux desktop driver"],
  [path.join(resources, "whisper/transcribe-cli"), "transcription helper"],
  [path.join(resources, "voice/voice-glossary.json"), "voice glossary"],
  [path.join(resources, "android/scrcpy-server"), "scrcpy server"],
  [path.join(runtime, "vendor/crsqlite", `linux-${arch}`, "crsqlite.so"), "SQLite extension"],
];
for (const [file, description] of required) await assertions.assertPathExists(file, description);
await assertions.assertBundledAgentSkills(path.join(resources, "agent-skills"));
await assertions.assertAsarEmbedsNoRuntimeFetchedToolPayload(path.join(resources, "app.asar"));
const pty = path.join(runtime, "node_modules/node-pty");
if (!await findNodePtyAddon(pty, { prebuildDirNames: [`linux-${arch}`] })) throw new Error("[validate-linux-artifacts] Missing node-pty native addon");
// Linux uses forkpty, but ship an executable helper for node-pty payload parity.
await assertions.assertPathExists(path.join(pty, "build/Release/spawn-helper"), "node-pty spawn helper");
fs.accessSync(path.join(pty, "build/Release/spawn-helper"), fs.constants.X_OK);
for (const extension of ["AppImage", "deb"]) {
  if (!fs.readdirSync(release).some((name) => name.endsWith(`-linux-${arch}.${extension}`))) throw new Error(`[validate-linux-artifacts] Missing ${extension} artifact for ${arch}`);
}
// Verify the wrapper inside the final image: AppRun itself can inject a flag,
// so the packaged executable must remove it unless the user opted in.
const imageName = fs.readdirSync(release).find((name) => name.endsWith(`-linux-${arch}.AppImage`));
const feedName = arch === "x64" ? "latest-linux.yml" : `latest-linux-${arch}.yml`;
const feed = parseYaml(fs.readFileSync(path.join(release, feedName), "utf8"));
if (feed?.path !== imageName || !feed?.files?.some((file) => file.url === imageName && file.sha512)) {
  throw new Error(`[validate-linux-artifacts] ${feedName} does not identify the published AppImage`);
}
const scratch = fs.mkdtempSync(path.join(release, ".validate-appimage-"));
try {
  const executable = `ade-desktop${suffix}`;
  for (const entry of ["AppRun", executable]) {
    const extract = spawnSync(path.join(release, imageName), ["--appimage-extract", entry], { cwd: scratch, encoding: "utf8" });
    if (extract.error || extract.status !== 0) throw new Error(`Cannot inspect AppImage ${entry}: ${extract.error?.message || extract.stderr}`);
  }
  const launcher = fs.readFileSync(path.join(scratch, "squashfs-root", "AppRun"), "utf8");
  const wrapper = fs.readFileSync(path.join(scratch, "squashfs-root", executable));
  if (!launcher.includes(`BIN="$APPDIR/${executable}"`) || !wrapper.equals(fs.readFileSync(path.join(root, "scripts/linux-appimage-launcher.sh")))) {
    throw new Error("AppImage does not route through the sandbox launcher");
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`[validate-linux-artifacts] Validated ${arch} packaged tree and artifacts`);
