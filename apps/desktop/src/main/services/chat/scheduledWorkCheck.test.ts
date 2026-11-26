import os from "node:os";
import { describe, expect, it } from "vitest";
import { runScheduledWorkCheck } from "./scheduledWorkCheck";

describe("runScheduledWorkCheck", () => {
  it("hashes a passing line's stdout, reports a failing one's exit code, and passes the extra env", async () => {
    const cwd = os.tmpdir();
    const [first, again, other, failing, signedIn] = await Promise.all([
      runScheduledWorkCheck("echo one", cwd),
      runScheduledWorkCheck("echo one", cwd),
      runScheduledWorkCheck("echo two", cwd),
      runScheduledWorkCheck("exit 3", cwd),
      // The account's sign-in reaches the check the way it reaches a chat.
      runScheduledWorkCheck(`node -e "process.stdout.write(String(process.env.ADE_CHECK_PROBE))"`, cwd, {
        extraEnv: () => ({ ADE_CHECK_PROBE: "signed-in" }),
      }),
    ]);

    expect(first).toEqual(expect.objectContaining({ ok: true, exitCode: 0 }));
    expect(first.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(again.outputHash).toBe(first.outputHash);
    expect(other.outputHash).not.toBe(first.outputHash);
    expect(failing).toEqual(expect.objectContaining({ ok: false, exitCode: 3 }));
    expect(failing.outputHash).toBeUndefined();
    expect(signedIn).toEqual(expect.objectContaining({ ok: true, detail: "signed-in" }));
  }, 30_000);
});
