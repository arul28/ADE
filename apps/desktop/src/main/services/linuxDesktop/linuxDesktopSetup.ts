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
import {
  LINUX_DESKTOP_ENCODER_REQUIREMENT,
  type LinuxDesktopSetupResult,
} from "../../../shared/types/macDesktop";

/** The helper's names for what it needs, in the order they are installed. */
export const LINUX_DESKTOP_REQUIREMENTS = ["xvfb", "openbox", "dbus", "at-spi2-core", "ffmpeg"] as const;
export type LinuxDesktopRequirement = (typeof LINUX_DESKTOP_REQUIREMENTS)[number];

/** The installer's message for that state; status names the encoder and why. */
export const LINUX_DESKTOP_ENCODER_MESSAGE =
  "The installed ffmpeg has no H.264 encoder, so lane recordings cannot be encoded. Install a full ffmpeg build, or one with libopenh264; reinstalling the same package will not add it.";

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

/** The package manager setup would use, for reports; null when none is found. */
export function linuxPackageManagerId(): PackageManager["id"] | null {
  return packageManager()?.id ?? null;
}

const isRoot = (): boolean => typeof process.getuid === "function" && process.getuid() === 0;

/**
 * The one description of an install: the argv, whether this process may run
 * it, and the sentence that names it.
 *
 * Built once, then rendered twice: `argv` is what ADE executes (non-interactive
 * `sudo -n`, so a blocked password fails instead of hanging a brain with no
 * terminal), and `command` is what a person copies into their own shell
 * (`sudo`, no `-n`, so their terminal can prompt). The two must not be
 * swapped: `-n` makes the copyable line fail on exactly the machine that needs
 * it.
 */
type LinuxDesktopInstallPlan = {
  /** The missing requirements a package manager can install. */
  wanted: LinuxDesktopRequirement[];
  /** The exact command ADE runs, or the one the user must run as root. */
  argv: [string, ...string[]] | null;
  /** The manager that would run the install, or null when none was found. */
  manager: PackageManager | null;
  /** True when only the user can run it (no package manager, or no sudo). */
  needsUser: boolean;
  /** What a person at a terminal would type for `argv`, or the instruction when no manager exists. */
  command: string | null;
};

function linuxDesktopInstallPlan(missing: readonly string[]): LinuxDesktopInstallPlan {
  const wanted = LINUX_DESKTOP_REQUIREMENTS.filter((req) => missing.includes(req));
  if (!wanted.length) {
    return { wanted, argv: null, manager: null, needsUser: false, command: null };
  }
  const manager = packageManager();
  if (!manager) {
    return {
      wanted,
      argv: null,
      manager: null,
      needsUser: true,
      command: `Install these packages with your distribution's package manager: ${wanted.join(", ")}`,
    };
  }
  const install: [string, ...string[]] = [manager.binary, ...manager.install, ...wanted.map((req) => manager.packages[req])];
  // The display form names `sudo` whenever this is not root, even when ADE's
  // own PATH has none: the brain's PATH is not the user's shell, and it is
  // their shell that will run this. Never `-n` here.
  const userCommand = isRoot() ? install.join(" ") : ["sudo", ...install].join(" ");
  if (isRoot()) return { wanted, argv: install, manager, needsUser: false, command: userCommand };
  if (!onPath("sudo")) return { wanted, argv: install, manager, needsUser: true, command: userCommand };
  const argv: [string, ...string[]] = ["sudo", "-n", ...install];
  return { wanted, argv, manager, needsUser: false, command: userCommand };
}

/**
 * The one shell command a person runs to install what is missing, or null when
 * nothing is.
 *
 * This is the copyable form (`sudo`, no `-n`), never the argv ADE executes.
 */
export function linuxDesktopInstallCommand(missing: readonly string[]): string | null {
  return linuxDesktopInstallPlan(missing).command;
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Installs the missing packages. Never prompts: with no root and no
 * passwordless sudo it answers with the command for the user to run.
 */
export async function installLinuxDesktopPackages(missing: readonly string[]): Promise<LinuxDesktopSetupResult> {
  const plan = linuxDesktopInstallPlan(missing);
  const encoderProblem = missing.includes(LINUX_DESKTOP_ENCODER_REQUIREMENT);
  if (!plan.wanted.length) {
    if (encoderProblem) {
      return { installed: false, alreadyInstalled: false, command: null, needsUser: true, message: LINUX_DESKTOP_ENCODER_MESSAGE };
    }
    return { installed: true, alreadyInstalled: true, command: null, needsUser: false, message: "Everything a Linux lane screen needs is installed." };
  }
  const manager = plan.manager;
  const argv = plan.argv;
  if (!manager || !argv) {
    return { installed: false, alreadyInstalled: false, command: plan.command, needsUser: true, message: `No supported package manager was found. ${plan.command ?? ""}` };
  }
  if (plan.needsUser) {
    return {
      installed: false,
      alreadyInstalled: false,
      command: plan.command,
      needsUser: true,
      message: `ADE cannot run the install itself here (not root, and sudo is not on ADE's own PATH). Run as root: ${argv.join(" ")}, or in your shell: ${plan.command}`,
    };
  }
  const env = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
  const aptUpdate: [string, ...string[]] = isRoot() ? ["apt-get", "update"] : ["sudo", "-n", "apt-get", "update"];
  const refreshFirst: Array<[string, ...string[]]> = manager.id === "apt" ? [aptUpdate] : [];
  let output = "";
  const run = (cmd: readonly [string, ...string[]]): Promise<number> => new Promise((resolve) => {
    const [binary, ...rest] = cmd;
    const child = spawn(binary, rest, { env, stdio: ["ignore", "pipe", "pipe"] });
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
  const code = await run(argv);
  if (code === 0) {
    return {
      installed: true,
      alreadyInstalled: false,
      command: plan.command,
      needsUser: false,
      message: `Installed ${plan.wanted.join(", ")}.${encoderProblem ? ` ${LINUX_DESKTOP_ENCODER_MESSAGE}` : ""}`,
    };
  }
  const needsPassword = /a password is required|a terminal is required/i.test(output);
  return {
    installed: false,
    alreadyInstalled: false,
    command: plan.command,
    needsUser: needsPassword,
    message: needsPassword
      ? `sudo needs a password on this machine, so ADE cannot install the packages itself. Run on that machine: ${plan.command}`
      : `The install failed (exit ${code}): ${output.trim().split("\n").slice(-3).join(" ")}`,
  };
}
