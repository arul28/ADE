import { defineWorkspace } from "vitest/config";

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

export default defineWorkspace([
  {
    test: {
      ...shared,
      name: "unit-main",
      include: ["src/main/**/*.test.{ts,tsx}"],
    },
  },
  {
    test: {
      ...shared,
      name: "unit-renderer",
      include: ["src/renderer/**/*.test.{ts,tsx}"],
    },
  },
  {
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
