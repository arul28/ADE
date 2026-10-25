/**
 * The system packages a Linux lane screen needs, and installing them.
 *
 * A Linux machine running ADE's headless brain is usually a plain server: no
 * X server, no window manager, no accessibility bus, often no ffmpeg. ADE
 * does not ship any of them (an X server and a codec are not things to bundle
 * into a CLI download); the helper reports which are missing on `ping`, the
 * status names the one command that installs them, and `ade screen setup`
 * runs it when the machine allows a non-interactive sudo (most cloud VMs and
 * dev boxes) or ADE already runs as root.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LinuxDesktopHostFacts, LinuxDesktopSetupResult } from "../../../shared/types/macDesktop";

/** The helper's names for what it needs, in the order they are installed. */
export const LINUX_DESKTOP_REQUIREMENTS = ["xvfb", "openbox", "dbus", "at-spi2-core", "ffmpeg"] as const;
export type LinuxDesktopRequirement = (typeof LINUX_DESKTOP_REQUIREMENTS)[number];

type PackageManager = {
  id: "apt" | "dnf" | "pacman" | "zypper" | "apk";
  binary: string;
  install: string[];
  packages: Record<LinuxDesktopRequirement, string>;
};

const PACKAGE_MANAGERS: PackageManager[] = [
  {
    id: "apt",
    binary: "apt-get",
    install: ["install", "-y", "--no-install-recommends"],
    packages: { xvfb: "xvfb", openbox: "openbox", dbus: "dbus", "at-spi2-core": "at-spi2-core", ffmpeg: "ffmpeg" },
  },
  {
    id: "dnf",
    binary: "dnf",
    install: ["install", "-y"],
    // Fedora's ffmpeg-free encodes H.264 through Cisco's OpenH264.
    packages: { xvfb: "xorg-x11-server-Xvfb", openbox: "openbox", dbus: "dbus-daemon", "at-spi2-core": "at-spi2-core", ffmpeg: "ffmpeg-free" },
  },
  {
    id: "pacman",
    binary: "pacman",
    install: ["-S", "--noconfirm", "--needed"],
    packages: { xvfb: "xorg-server-xvfb", openbox: "openbox", dbus: "dbus", "at-spi2-core": "at-spi2-core", ffmpeg: "ffmpeg" },
  },
  {
    id: "zypper",
    binary: "zypper",
    install: ["--non-interactive", "install"],
    packages: { xvfb: "xorg-x11-server-Xvfb", openbox: "openbox", dbus: "dbus-1", "at-spi2-core": "at-spi2-core", ffmpeg: "ffmpeg" },
  },
  {
    id: "apk",
    binary: "apk",
    install: ["add"],
    packages: { xvfb: "xvfb", openbox: "openbox", dbus: "dbus", "at-spi2-core": "at-spi2-core", ffmpeg: "ffmpeg" },
  },
];

function onPath(binary: string): string | null {
  for (const dir of (process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin").split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

function packageManager(): PackageManager | null {
  return PACKAGE_MANAGERS.find((pm) => onPath(pm.binary)) ?? null;
}

const isRoot = (): boolean => typeof process.getuid === "function" && process.getuid() === 0;

/** The helper's `ping.linux` reply, read loosely: an older helper sends none. */
export function readLinuxHostFacts(value: unknown): LinuxDesktopHostFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const missing = Array.isArray(record.missing)
    ? record.missing.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    missing,
    encoder: typeof record.encoder === "string" ? record.encoder : null,
    installCommand: linuxDesktopInstallCommand(missing),
  };
}

/** The one shell command that installs what is missing, or null when nothing is. */
export function linuxDesktopInstallCommand(missing: readonly string[]): string | null {
  const wanted = LINUX_DESKTOP_REQUIREMENTS.filter((req) => missing.includes(req));
  if (!wanted.length) return null;
  const pm = packageManager();
  if (!pm) return `Install these packages with your distribution's package manager: ${wanted.join(", ")}`;
  const args = [pm.binary, ...pm.install, ...wanted.map((req) => pm.packages[req])];
  return `${isRoot() ? "" : "sudo "}${args.join(" ")}`;
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Installs the missing packages. Never prompts: with no root and no
 * passwordless sudo it answers with the command for the user to run.
 */
export async function installLinuxDesktopPackages(missing: readonly string[]): Promise<LinuxDesktopSetupResult> {
  const command = linuxDesktopInstallCommand(missing);
  const wanted = LINUX_DESKTOP_REQUIREMENTS.filter((req) => missing.includes(req));
  if (!wanted.length || !command) {
    return { installed: true, alreadyInstalled: true, command: null, needsUser: false, message: "Everything a Linux lane screen needs is installed." };
  }
  const pm = packageManager();
  if (!pm) {
    return { installed: false, alreadyInstalled: false, command, needsUser: true, message: `No supported package manager was found. ${command}.` };
  }
  const argv = [pm.binary, ...pm.install, ...wanted.map((req) => pm.packages[req])];
  const runner = isRoot() ? argv : onPath("sudo") ? ["sudo", "-n", ...argv] : null;
  if (!runner) {
    return {
      installed: false,
      alreadyInstalled: false,
      command,
      needsUser: true,
      message: `ADE cannot install system packages here (not root, and no sudo). Run as root: ${argv.join(" ")}`,
    };
  }
  const env = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
  const refreshFirst = pm.id === "apt" ? [isRoot() ? ["apt-get", "update"] : ["sudo", "-n", "apt-get", "update"]] : [];
  let output = "";
  const run = (cmd: string[]): Promise<number> => new Promise((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), INSTALL_TIMEOUT_MS);
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => {
      output += `\n${error.message}`;
      clearTimeout(timer);
      resolve(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  for (const cmd of refreshFirst) await run(cmd);
  const code = await run(runner);
  if (code === 0) {
    return { installed: true, alreadyInstalled: false, command, needsUser: false, message: `Installed ${wanted.join(", ")}.` };
  }
  const needsPassword = /a password is required|a terminal is required/i.test(output);
  return {
    installed: false,
    alreadyInstalled: false,
    command,
    needsUser: needsPassword,
    message: needsPassword
      ? `sudo needs a password on this machine, so ADE cannot install the packages itself. Run on that machine: ${command}`
      : `The install failed (exit ${code}): ${output.trim().split("\n").slice(-3).join(" ")}`,
  };
}
