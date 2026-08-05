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
};

const sharedResolveAlias = [
  { find: /^@emoji-mart\/data(?:\/.*)?$/, replacement: emojiDataStub },
  { find: "@lobehub/icons", replacement: lobeIconsStub },
];

const unitExcludes = ["**/*.integration.test.{ts,tsx}"];

export default defineWorkspace([
  {
    resolve: { alias: sharedResolveAlias },
    test: {
      ...shared,
      name: "integration-main",
      // Scoped to the cross-service integration suite. Widening this to
      // src/main/**/*.integration.test.* would resurrect the long-dormant
      // remoteRuntime.offlineRpc.integration.test.ts, which predates this
      // project and no longer passes — fix or delete it before broadening.
      include: ["src/main/services/__tests__/*.integration.test.{ts,tsx}"],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
  {
    resolve: { alias: sharedResolveAlias },
    test: {
      ...shared,
      name: "unit-main",
      include: ["src/main/**/*.test.{ts,tsx}"],
      exclude: unitExcludes,
    },
  },
  {
    resolve: { alias: sharedResolveAlias },
    test: {
      ...shared,
      name: "unit-renderer",
      include: ["src/renderer/**/*.test.{ts,tsx}"],
      exclude: unitExcludes,
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
      exclude: unitExcludes,
    },
  },
]);
