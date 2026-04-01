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

export default defineWorkspace([
  {
    resolve: { alias: { "@emoji-mart/data": emojiDataStub, "@lobehub/icons": lobeIconsStub } },
    test: {
      ...shared,
      name: "unit-main",
      include: ["src/main/**/*.test.{ts,tsx}"],
    },
  },
  {
    resolve: { alias: { "@emoji-mart/data": emojiDataStub, "@lobehub/icons": lobeIconsStub } },
    test: {
      ...shared,
      name: "unit-renderer",
      include: ["src/renderer/**/*.test.{ts,tsx}"],
    },
  },
  {
    resolve: { alias: { "@emoji-mart/data": emojiDataStub, "@lobehub/icons": lobeIconsStub } },
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
