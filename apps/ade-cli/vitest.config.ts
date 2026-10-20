import { defineConfig } from "vitest/config";

// Windows runners do real file, SQLite and pipe work several times slower than
// macOS/Linux, so the 5 s default times out there on tests that pass. Assertion
// failures still fail; only the clock is loosened, and only on Windows.
const timeoutMs = process.platform === "win32" ? 15_000 : 5_000;

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    testTimeout: timeoutMs,
    hookTimeout: timeoutMs,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts", "src/test/**"],
    },
  }
});
