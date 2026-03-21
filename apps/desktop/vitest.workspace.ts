import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["src/**/*.test.{ts,tsx}"],
      exclude: ["src/**/*.integration.{ts,tsx}", "src/**/*.component.{ts,tsx}"],
      environment: "node",
    },
  },
  {
    test: {
      name: "integration",
      include: ["src/**/*.integration.{ts,tsx}"],
      environment: "node",
    },
  },
  {
    test: {
      name: "component",
      include: ["src/**/*.component.{ts,tsx}"],
      environment: "jsdom",
    },
  },
]);
