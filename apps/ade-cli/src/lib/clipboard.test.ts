import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { copyToClipboard, type CopyToClipboardSpawnOptions } from "./clipboard";

describe("copyToClipboard", () => {
  it("discards the helper's stdout/stderr so a daemonizing wl-copy cannot hold our pipes", () => {
    const seen: CopyToClipboardSpawnOptions[] = [];
    const ok = copyToClipboard("ade://lane/x", {
      platform: "linux",
      commandExists: (cmd) => cmd === "wl-copy",
      spawn: (cmd, args, opts) => {
        expect(cmd).toBe("wl-copy");
        expect(args).toEqual([]);
        seen.push(opts);
        return { status: 0 };
      },
    });
    expect(ok).toBe(true);
    expect(seen[0]?.stdio).toEqual(["pipe", "ignore", "ignore"]);
    expect(seen[0]?.timeout).toBeGreaterThan(0);
    expect(seen[0]?.input).toBe("ade://lane/x");
  });

  it("returns the fallback result instead of hanging when the helper never exits", () => {
    // The real Wayland failure: the helper keeps running after taking the text.
    // Production hands spawnSync a bounded timeout, so the call must come back
    // (as `false`, which callers surface as "here's the URL") rather than block.
    const started = Date.now();
    const ok = copyToClipboard("ade://lane/x", {
      platform: "linux",
      commandExists: () => true,
      timeoutMs: 300,
      // Real child, real spawnSync, production's own options: reads stdin then
      // lingers the way a clipboard daemon does.
      spawn: (_cmd, _args, opts) => spawnSync("sh", ["-c", "cat >/dev/null; sleep 30"], opts),
    });
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reports failure when no Linux clipboard tool is installed", () => {
    expect(
      copyToClipboard("x", {
        platform: "linux",
        commandExists: () => false,
        spawn: () => {
          throw new Error("must not spawn");
        },
      }),
    ).toBe(false);
  });

  it("treats a throwing spawn as a copy failure", () => {
    expect(
      copyToClipboard("x", {
        platform: "darwin",
        spawn: () => {
          throw new Error("EPERM");
        },
      }),
    ).toBe(false);
  });
});
