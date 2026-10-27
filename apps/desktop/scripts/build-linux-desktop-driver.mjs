#!/usr/bin/env node
/**
 * Builds the Linux lane-screen helper (`native/ADEDesktopDriverLinux`, Rust)
 * into `resources/native/<target>/ade-desktop-driver`, where the runtime's
 * native packager picks it up for `ade-<target>.native.tar.gz`.
 *
 * Static musl binaries: the helper links no libc, libxcb or libdbus from the
 * host (x11rb and zbus are pure Rust), so one build runs on every distribution.
 *
 *   node scripts/build-linux-desktop-driver.mjs --target linux-x64
 *   node scripts/build-linux-desktop-driver.mjs --target linux-arm64
 *
 * With no --target it builds for the host, and does nothing off Linux.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crateRoot = path.join(desktopRoot, "native", "ADEDesktopDriverLinux");

const RUST_TARGETS = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};

function hostTarget() {
  if (process.platform !== "linux") return null;
  return process.arch === "arm64" ? "linux-arm64" : process.arch === "x64" ? "linux-x64" : null;
}

function readTarget(argv) {
  const index = argv.indexOf("--target");
  if (index >= 0) return argv[index + 1] ?? null;
  const inline = argv.find((arg) => arg.startsWith("--target="));
  return inline ? inline.slice("--target=".length) : hostTarget();
}

const target = readTarget(process.argv.slice(2));
if (!target) {
  process.stdout.write("[build-linux-desktop-driver] not a Linux build; nothing to do.\n");
  process.exit(0);
}
const rustTarget = RUST_TARGETS[target];
if (!rustTarget) {
  process.stderr.write(`[build-linux-desktop-driver] unknown target ${target}; expected ${Object.keys(RUST_TARGETS).join(" or ")}.\n`);
  process.exit(1);
}

const cargo = process.env.CARGO ?? "cargo";
const result = spawnSync(cargo, ["build", "--release", "--locked", "--target", rustTarget], {
  cwd: crateRoot,
  stdio: "inherit",
  env: process.env,
});
if (result.status !== 0) {
  process.stderr.write(`[build-linux-desktop-driver] cargo build failed for ${rustTarget}.\n`);
  process.exit(result.status ?? 1);
}

const built = path.join(crateRoot, "target", rustTarget, "release", "ade-desktop-driver");
const destination = path.join(desktopRoot, "resources", "native", target, "ade-desktop-driver");
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(built, destination);
fs.chmodSync(destination, 0o755);
process.stdout.write(`[build-linux-desktop-driver] ${destination}\n`);
