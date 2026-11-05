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
export function deviceShellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(word)) return word;
  return `'${word.replace(/'/gu, "'\\''")}'`;
}

/** The words as one device command line. */
export function deviceShellLine(words: readonly string[]): string {
  return words.map(deviceShellQuote).join(" ");
}

export type DeviceShellResult = { exitCode: number; stdout: string; stderr: string; text: string };

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
