import { runAdb, type AdbRunOptions } from "./adb";

/*
 * Commands on the emulator's own shell.
 *
 * `adb shell a b c` joins its arguments with spaces into ONE command line and
 * the device's shell (`sh`, mksh or toybox) splits it again. So an argument
 * with a space, a `&` or a quote reaches the device split or cut short, on
 * every host (P0 found this). The host side needs no quoting: `runAdb` passes
 * an argument list, and Node quotes it for `CreateProcess` on Windows. What
 * must be quoted is the device side, so every word here is single-quoted for
 * `sh`, and the whole line goes to adb as one argument.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** One word for the device's `sh`: single-quoted, with each `'` written as `'\''`. */
function deviceShellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(word)) return word;
  return `'${word.replace(/'/gu, "'\\''")}'`;
}

/** The words as one device command line. */
function deviceShellLine(words: readonly string[]): string {
  return words.map(deviceShellQuote).join(" ");
}

/**
 * `dumpsys window displays`, cut to the default display (id 0). A viewer's
 * scrcpy stream adds a virtual display that dumps first (seen as display 10,
 * 986x1024 at 1 dpi, on API 37), so a plain `grep -m1` read that display's
 * rotation and size. Toybox `sed` only, so it runs on every image.
 */
export const DEFAULT_DISPLAY_DUMP =
  "dumpsys window displays | sed -e 's/mDisplayId=0$/mDisplayId=0 /' | sed -n '/Display: mDisplayId=0 /,/Display: mDisplayId=[1-9]/p'";

/** Prints the default display's rotation as `mRotation=<0..3>`. */
export const ROTATION_PROBE = `${DEFAULT_DISPLAY_DUMP} | grep -m1 -oE 'mRotation=[0-9]'`;

/** The rotation (0 to 3) in `ROTATION_PROBE`'s output, or null. */
export function parseRotation(text: string): number | null {
  const digit = /mRotation=(\d)/u.exec(text)?.[1];
  return digit === undefined ? null : Number(digit);
}

/** Parses `wm size`; the override size wins because it is what the screen shows. */
export function parseWmSize(text: string): { width: number; height: number } | null {
  const pick = (label: string) => {
    const match = new RegExp(`${label} size:\\s*(\\d+)x(\\d+)`, "u").exec(text);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  };
  return pick("Override") ?? pick("Physical");
}

/** The lane's booted emulator: what every device command needs. */
export type BootedDevice = { serial: string; adbPath: string };

export type DeviceShellResult = { exitCode: number; stdout: string; stderr: string; text: string };

/** One adb command's exit code, its stdout, and stdout and stderr as one trimmed text. */
export type AdbOutput = { exitCode: number; stdout: string; text: string };

/**
 * Runs one adb command on the device and never throws on a non-zero exit
 * (the caller reads `exitCode`). `text` is stdout then stderr, trimmed: many
 * commands say what went wrong on either one.
 */
export async function runAdbOutput(
  booted: BootedDevice,
  args: readonly string[],
  options: Omit<AdbRunOptions, "serial" | "allowFailure"> = {},
): Promise<AdbOutput> {
  const result = await runAdb(booted.adbPath, args, { ...options, serial: booted.serial, allowFailure: true });
  const stdout = result.stdout.toString("utf8");
  return { exitCode: result.exitCode, stdout, text: `${stdout}${result.stderr}`.trim() };
}

/**
 * Runs one emulator console command (`adb emu <args>`). The console answers
 * `KO: …` or an error line, not an exit code, so both count as a refusal.
 * Throws `<what>: <the console's answer>`.
 */
export async function runEmulatorConsole(
  booted: BootedDevice,
  args: readonly string[],
  what: string,
  options: Omit<AdbRunOptions, "serial" | "allowFailure"> = {},
): Promise<void> {
  const result = await runAdbOutput(booted, ["emu", ...args], { timeoutMs: 15_000, ...options });
  if (result.exitCode !== 0 || /KO|error/iu.test(result.text)) {
    throw new Error(`${what}: ${result.text.slice(0, 200) || `exit ${result.exitCode}`}`);
  }
}

/**
 * Runs one command on the device and never throws on a non-zero exit (the
 * caller reads `exitCode`). Many `pm` and `am` commands exit 0 and print
 * `Error:` or `Failure`, so callers check `text` too.
 */
export async function runDeviceShell(
  adbPath: string,
  serial: string,
  words: readonly string[],
  options: Omit<AdbRunOptions, "serial" | "allowFailure"> = {},
): Promise<DeviceShellResult> {
  const result = await runAdb(adbPath, ["shell", deviceShellLine(words)], { ...options, serial, allowFailure: true });
  const stdout = result.stdout.toString("utf8");
  return { exitCode: result.exitCode, stdout, stderr: result.stderr, text: `${stdout}${result.stderr}`.trim() };
}

/**
 * Runs a shell script on the device (`sh -c <script>`), quoted as one word,
 * and never throws on a non-zero exit. For a pipe, a `;` list or a redirect.
 */
export function runDeviceScript(
  booted: BootedDevice,
  script: string,
  options: Omit<AdbRunOptions, "serial" | "allowFailure"> = {},
): Promise<DeviceShellResult> {
  return runDeviceShell(booted.adbPath, booted.serial, ["sh", "-c", script], options);
}
