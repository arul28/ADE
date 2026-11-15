import path from "node:path";
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import { createDurationShardSequencer } from "../../scripts/ci/test-shards.mjs";
import { windowsScaledTimeout } from "./vitest.timeouts";

// Windows runners do real file, SQLite and pipe work several times slower than
// macOS/Linux, so the 5 s default times out there on tests that pass. Assertion
// failures still fail; only the clock is loosened, and only on Windows.
// Factor 3 keeps the 15 s Windows default this config used before the helper.
const timeoutMs = windowsScaledTimeout(5_000, 3);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    testTimeout: timeoutMs,
    hookTimeout: timeoutMs,
    // `--shard=N/M` splits the files by their recorded durations instead of
    // by a hash of their paths.
    sequence: {
      sequencer: createDurationShardSequencer(BaseSequencer, {
        durationsFile: path.resolve(__dirname, "vitest.durations.json"),
        // The recorded durations leave out import and setup time; this
        // adds a small fixed cost for each file.
        perFileMs: 300,
      }),
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts", "src/test/**"],
    },
  }
});
