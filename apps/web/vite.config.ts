import fs from "node:fs/promises";
import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { assertPublicPostHogToken } from "../../scripts/posthog/publicPostHogToken";

/**
 * Inlines small imported SVGs (the provider logos) as data URLs. Vite 4 emits
 * every SVG as its own file whatever its size, and each file is one edge
 * request on Vercel for every page view: the home page's logos alone were 49.
 * Base64, because the logos also go into unquoted CSS `url()`.
 */
function inlineSmallSvgs(limit = 12 * 1024): Plugin {
  return {
    name: "ade-inline-small-svgs",
    enforce: "pre",
    async load(id) {
      if (!id.endsWith(".svg")) return null;
      const content = await fs.readFile(id);
      if (content.length > limit) return null;
      return `export default ${JSON.stringify(`data:image/svg+xml;base64,${content.toString("base64")}`)};`;
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const posthogProjectToken = env.VITE_POSTHOG_PROJECT_TOKEN?.trim() ?? "";
  assertPublicPostHogToken(posthogProjectToken, "VITE_POSTHOG_PROJECT_TOKEN");
  return {
    plugins: [react(), inlineSmallSvgs()],
    server: {
      port: 4180,
      allowedHosts: [".trycloudflare.com"],
      // The pricing facts come from the account directory's plan files
      // (`src/lib/cloudPricing.ts`), outside this app's folder.
      fs: { allow: [searchForWorkspaceRoot(process.cwd()), "../account-directory/src/cloud"] },
    },
    build: { sourcemap: true },
  };
});
