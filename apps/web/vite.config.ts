import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { assertPublicPostHogToken } from "../../scripts/posthog/publicPostHogToken";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const posthogProjectToken = env.VITE_POSTHOG_PROJECT_TOKEN?.trim() ?? "";
  assertPublicPostHogToken(posthogProjectToken, "VITE_POSTHOG_PROJECT_TOKEN");
  return {
    plugins: [react()],
    server: { port: 4180, allowedHosts: [".trycloudflare.com"] },
    build: { sourcemap: true },
  };
});
