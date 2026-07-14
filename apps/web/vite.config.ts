import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const posthogProjectToken = env.VITE_POSTHOG_PROJECT_TOKEN?.trim() ?? "";
  if (posthogProjectToken && !/^phc_[A-Za-z0-9_-]{8,}$/.test(posthogProjectToken)) {
    throw new Error("VITE_POSTHOG_PROJECT_TOKEN must be a public phc_ project token; personal API keys must never be bundled.");
  }
  return {
    plugins: [react()],
    server: { port: 4180, allowedHosts: [".trycloudflare.com"] },
    build: { sourcemap: true },
  };
});
