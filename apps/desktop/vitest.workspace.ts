import path from "node:path";
import { defineWorkspace } from "vitest/config";

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

const shared = {
  testTimeout: 20_000,
  hookTimeout: 20_000,
  setupFiles: ["src/test/setup.ts"],
  pool: "forks" as const,
  poolOptions: {
    forks: { maxForks: 4 },
  },
  environment: "node" as const,
  deps: {
    inline: [/@emoji-mart\//, /@lobehub\//],
  },
  server: {
    deps: {
      inline: [/@emoji-mart\//, /@lobehub\//],
    },
  },
};

const sharedResolveAlias = {
  "@emoji-mart/data": emojiDataStub,
  "@lobehub/icons": lobeIconsStub,
  "lottie-react": lottieReactStub,
};

export default defineWorkspace([
  {
    resolve: { alias: sharedResolveAlias },
    test: {
      ...shared,
      name: "unit-main",
      include: ["src/main/**/*.test.{ts,tsx}"],
    },
  },
  {
    resolve: { alias: sharedResolveAlias },
    test: {
      ...shared,
      name: "unit-renderer",
      include: ["src/renderer/**/*.test.{ts,tsx}"],
    },
  },
  {
    resolve: { alias: sharedResolveAlias },
    test: {
      ...shared,
      name: "unit-shared",
      include: [
        "src/shared/**/*.test.{ts,tsx}",
        "src/preload/**/*.test.{ts,tsx}",
      ],
    },
  },
]);
