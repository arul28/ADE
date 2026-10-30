import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The config's top level is what deploys (`production`); tests must not
      // report to Sentry, and `development` turns the client off.
      miniflare: { bindings: { SENTRY_ENVIRONMENT: "development" } },
    }),
  ],
  test: {
    include: ["test/**/*.workerd.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 10_000,
  },
});
