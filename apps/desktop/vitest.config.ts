import path from "node:path";
import { defineConfig } from "vitest/config";

const emojiDataStub = path.resolve(
  __dirname,
  "src/test/__mocks__/emoji-mart-data.js",
);

const lobeIconsStub = path.resolve(
  __dirname,
  "src/test/__mocks__/lobehub-icons.js",
);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@emoji-mart\/data(?:\/.*)?$/, replacement: emojiDataStub },
      { find: "@lobehub/icons", replacement: lobeIconsStub },
        ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["src/test/setup.ts"],
    // `pool` and `poolOptions` are vitest 1.x keys. This project pins vitest
    // 0.34.6, which does not know either of them, so the maxForks: 4 cap below
    // has never actually applied — 0.34 reads `threads`/`maxThreads` instead.
    // They are kept so the intent survives a vitest upgrade; do not read them
    // as describing current behavior.
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
    // Windows only, because Windows is where the uncapped pool actually breaks.
    // vitest sizes its default pool from the CPU count (32 here), and that many
    // workers exhausts the process file-handle limit partway through a run:
    // `EMFILE: too many open files` kills the runner mid-suite, so the full
    // suite that AGENTS.md documents could not complete on Windows at all.
    // macOS and CI keep their existing concurrency and timings.
    ...(process.platform === "win32" ? { maxThreads: 4, minThreads: 1 } : {}),
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts", "src/test/**"],
    },
  },
});
