import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/relay.test.ts", "test/smoke-url.test.mjs"],
  },
});
