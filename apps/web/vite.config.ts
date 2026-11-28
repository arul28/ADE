import fs from "node:fs/promises";
import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { assertPublicPostHogToken } from "../../scripts/posthog/publicPostHogToken";
import { CLOUD_PUBLIC_PRICING_PATH } from "../account-directory/src/cloud/contract";

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

/**
 * Starts the account server's answer for Pricing v3 (`src/lib/siteOffer.ts`)
 * in the page's head on `/` and `/pricing`, so it runs beside the download of
 * the site's code instead of after it. The answer carries no personal data,
 * and the request sends no cookie.
 */
function siteOfferEarlyScript(accountDirectory: string): Plugin {
  const url = `${accountDirectory.replace(/\/+$/, "")}${CLOUD_PUBLIC_PRICING_PATH}`;
  return {
    name: "ade-site-offer-early",
    transformIndexHtml(html) {
      const script = `<script>(function(){try{var p=location.pathname.replace(/\\/+$/,"");if(p!==""&&p!=="/pricing")return;window.__daexSiteOffer=fetch(${JSON.stringify(url)},{credentials:"omit"}).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}catch(e){}})();</script>`;
      return html.replace("</head>", `    ${script}\n  </head>`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const posthogProjectToken = env.VITE_POSTHOG_PROJECT_TOKEN?.trim() ?? "";
  assertPublicPostHogToken(posthogProjectToken, "VITE_POSTHOG_PROJECT_TOKEN");
  return {
    plugins: [react(), inlineSmallSvgs(), siteOfferEarlyScript(env.VITE_ADE_ACCOUNT_DIRECTORY_URL?.trim() || "https://ade-account-directory-production.arulsharma1028.workers.dev")],
    server: {
      port: 4180,
      allowedHosts: [".trycloudflare.com"],
      // The pricing facts come from the account directory's plan files
      // (`src/lib/cloudPricing.ts`), and the product names from the desktop
      // app's brand file, both outside this app's folder.
      fs: { allow: [searchForWorkspaceRoot(process.cwd()), "../account-directory/src/cloud", "../desktop/src/shared/brand.ts"] },
    },
    build: { sourcemap: true },
  };
});
