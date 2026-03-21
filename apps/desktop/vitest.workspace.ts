import { defineWorkspace } from "vitest/config";

const shared = {
  testTimeout: 20_000,
  hookTimeout: 20_000,
  setupFiles: ["src/test/setup.ts"],
  pool: "forks" as const,
  poolOptions: {
    forks: { maxForks: 4 },
  },
};

export default defineWorkspace([
  {
    test: {
      ...shared,
      name: "unit",
      include: ["src/**/*.test.{ts,tsx}"],
      exclude: ["src/**/*.integration.{ts,tsx}", "src/**/*.component.{ts,tsx}"],
      environment: "node",
    },
  },
  {
    test: {
      ...shared,
      name: "integration",
      include: ["src/**/*.integration.{ts,tsx}"],
      environment: "node",
    },
  },
  {
    test: {
      ...shared,
      name: "component",
      include: ["src/**/*.component.{ts,tsx}"],
      environment: "jsdom",
    },
  },
]);
