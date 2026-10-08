import { describe, expect, it } from "vitest";
import { execFileOffThread } from "./offThreadSpawn";

/**
 * The off-thread spawner batches a child's output in its worker. What a
 * caller (git, the Machine widget's tasklist and netstat, the CLI) relies on
 * is that batching is invisible: every byte arrives, in order, per stream, and
 * the last batch lands before the close that resolves the call.
 */
describe("execFileOffThread", () => {
  it("delivers a chatty child's output whole and in order, including what it wrote just before exiting", async () => {
    // Thousands of tiny writes (how Windows console tools write), a burst far
    // over one batch, stderr in between, and a final write right before exit.
    const script = [
      "for (let i = 0; i < 3000; i += 1) process.stdout.write(i + ',');",
      "process.stderr.write('warn-1;');",
      "process.stdout.write('X'.repeat(200000));",
      "process.stderr.write('warn-2;');",
      "process.stdout.write('END');",
    ].join("\n");

    const result = await execFileOffThread(process.execPath, ["-e", script], { timeoutMs: 20_000, maxBuffer: 4 * 1024 * 1024 });

    const counted = Array.from({ length: 3000 }, (_, i) => `${i},`).join("");
    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(counted.length + 200_000 + 3);
    expect(result.stdout).toBe(`${counted}${"X".repeat(200_000)}END`);
    expect(result.stderr).toBe("warn-1;warn-2;");
  });
});
