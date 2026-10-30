import { describe, expect, it } from "vitest";
import { execFileOffThread, spawnOffThread } from "./offThreadSpawn";

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

  it("lays an env patch over the live environment, and over a full env when one is given", async () => {
    const print = "process.stdout.write(JSON.stringify([process.env.ADE_OFFTHREAD_LIVE ?? null, process.env.ADE_OFFTHREAD_PATCH ?? null, Boolean(process.env.PATH ?? process.env.Path)]))";
    process.env.ADE_OFFTHREAD_LIVE = "live";
    try {
      // The patch adds one key; the rest of the live environment still reaches the child.
      const patched = await execFileOffThread(process.execPath, ["-e", print], { timeoutMs: 20_000, envPatch: { ADE_OFFTHREAD_PATCH: "patched" } });
      expect(patched.error).toBeNull();
      expect(JSON.parse(patched.stdout)).toEqual(["live", "patched", true]);

      // A full env replaces the live one, and the patch still lands on top of it.
      const replaced = await execFileOffThread(process.execPath, ["-e", print], {
        timeoutMs: 20_000,
        env: { ...process.env, ADE_OFFTHREAD_LIVE: "replaced" },
        envPatch: { ADE_OFFTHREAD_PATCH: "patched" },
      });
      expect(JSON.parse(replaced.stdout)).toEqual(["replaced", "patched", true]);

      const plain = await execFileOffThread(process.execPath, ["-e", print], { timeoutMs: 20_000 });
      expect(JSON.parse(plain.stdout)).toEqual(["live", null, true]);
    } finally {
      delete process.env.ADE_OFFTHREAD_LIVE;
    }
  });
});

describe("spawnOffThread stdin", () => {
  // Echoes each stdin line, then reports how many it saw when stdin closes.
  const echo = [
    "let n = 0;",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (d) => { for (const l of d.split('\\n').filter(Boolean)) { n += 1; process.stdout.write('got:' + l + ';'); } });",
    "process.stdin.on('end', () => process.stdout.write('eof:' + n));",
  ].join("\n");
  const run = (keepStdinOpen: boolean, drive: (child: ReturnType<typeof spawnOffThread>, output: () => string) => void) =>
    new Promise<string>((resolve, reject) => {
      const child = spawnOffThread(process.execPath, ["-e", echo], { keepStdinOpen });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      drive(child, () => out);
      child.on("error", reject);
      child.on("close", () => resolve(out));
    });

  it("keeps stdin open across replies until end() when asked, and closes it at start by default", async () => {
    // A request/reply child (the Codex app-server): the second write waits for
    // the first reply, and EOF before it would drop the request.
    const conversed = await run(true, (child, output) => {
      child.stdin.write("one\n");
      child.stdout.on("data", () => {
        if (output() === "got:one;") child.stdin.write("two\n");
        else if (output() === "got:one;got:two;") child.stdin.end();
      });
    });
    expect(conversed).toBe("got:one;got:two;eof:2");

    // By default, text written before the start lands, then stdin closes.
    expect(await run(false, (child) => child.stdin.end("early\n"))).toBe("got:early;eof:1");
    expect(await run(false, () => {})).toBe("eof:0");
  });
});
