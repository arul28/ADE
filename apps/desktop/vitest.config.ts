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

const lottieReactStub = path.resolve(
  __dirname,
  "src/test/__mocks__/lottie-react.js",
);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@emoji-mart\/data(?:\/.*)?$/, replacement: emojiDataStub },
      { find: "@lobehub/icons", replacement: lobeIconsStub },
      { find: "lottie-react", replacement: lottieReactStub },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["src/test/setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts", "src/test/**"],
    },
  },
});
