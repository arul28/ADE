import { afterEach, describe, expect, it, vi } from "vitest";
import { runReapedCommand } from "./runReapedCommand";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * gh exits but leaves its `/usr/bin/security` helper waiting on a keychain
 * that does not answer; one leaked helper per poll filled the Mac's process
 * limit on 2026-11-01. Here `sh` plays gh: it starts a long-lived helper in
 * the background and prints its pid.
 */
describe.skipIf(process.platform === "win32")("runReapedCommand", () => {
  const helpers: number[] = [];

  afterEach(() => {
    for (const pid of helpers.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, which is the point.
      }
    }
  });

  it.each([
    { name: "exits on its own", script: "sleep 30 & echo $!", timeoutMs: 10_000, timedOut: false, exitCode: 0 },
    { name: "hits its timeout", script: "sleep 30 & echo $!; sleep 30", timeoutMs: 500, timedOut: true, exitCode: null },
  ])("leaves no helper behind when the command $name", async ({ script, timeoutMs, timedOut, exitCode }) => {
    const result = await runReapedCommand("/bin/sh", ["-c", script], { timeoutMs });

    const helperPid = Number.parseInt(result.stdout.trim(), 10);
    expect(Number.isInteger(helperPid), `helper pid from ${JSON.stringify(result.stdout)}`).toBe(true);
    helpers.push(helperPid);
    expect(result.timedOut).toBe(timedOut);
    expect(result.exitCode).toBe(exitCode);
    // The kill is sent before the call returns; the helper's exit is the OS's.
    await vi.waitFor(() => expect(isAlive(helperPid)).toBe(false), { timeout: 2_000 });
  });
});
