import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cloudflare Pages serves the site from the outDir root: the entry must be
 * index.html, and _headers/_redirects (CSP + SPA fallback) must sit beside it.
 * The entry html lives at src/renderer/webclient.html (sibling of the desktop
 * renderer's index.html), so rename it and copy the Pages config on close.
 */
function cloudflarePagesOutput(): Plugin {
  const outDir = path.resolve(__dirname, "dist/web-client");
  const pagesDir = path.resolve(__dirname, "src/renderer/webclient/public");
  return {
    name: "ade-cloudflare-pages-output",
    apply: "build",
    closeBundle() {
      const entry = path.join(outDir, "webclient.html");
      if (fs.existsSync(entry)) fs.renameSync(entry, path.join(outDir, "index.html"));
      for (const name of ["_headers", "_redirects"]) {
        const source = path.join(pagesDir, name);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(outDir, name));
      }
    }
  };
}

/**
 * In dev, Vite's root (src/renderer) also contains the desktop renderer's
 * index.html, which would otherwise be served at `/` and `/work` (the desktop
 * app + browserMock), shadowing the web client. Rewrite every HTML navigation
 * request to webclient.html so dev matches the production SPA fallback: any
 * deep route (/, /work, /pair, …) loads the web client, and its router takes
 * over. Asset requests (with a file extension) are left untouched.
 */
function webClientDevEntry(): Plugin {
  return {
    name: "ade-web-client-dev-entry",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "/";
        const pathname = url.split("?")[0];
        const accepts = String(req.headers.accept ?? "");
        const isNavigation = accepts.includes("text/html");
        const isAsset = pathname.includes(".") && !pathname.endsWith(".html");
        if (isNavigation && !isAsset && pathname !== "/webclient.html") {
          req.url = "/webclient.html";
        }
        next();
      });
    }
  };
}

/**
 * Local dev against the real account directory.
 *
 * The directory Worker answers a browser only from the one hosted origin it is
 * configured with (https://app.ade-app.dev) and 403s any other `Origin` — but
 * it treats a request with no `Origin` at all as a native/daemon caller, which
 * is how the desktop app and the CLI reach it. So the dev server proxies the
 * account routes and strips `Origin` on the way out: the browser sees a
 * same-origin request (no CORS at all), the Worker sees a native caller, and
 * nothing about production config changes. `server.proxy` exists only on the
 * dev server, so builds are untouched.
 *
 * Recipe — the hosted client uses production Clerk, so dev must too, or the
 * production directory rejects the token:
 *
 *   VITE_ADE_ACCOUNT_DIRECTORY_URL=http://localhost:5174 \
 *   VITE_ADE_CLERK_ISSUER=https://clerk.ade-app.dev \
 *   VITE_ADE_CLERK_OAUTH_CLIENT_ID=Az7TbviBocyXjZk1 \ (public client id — gitleaks:allow)
 *   npm --prefix apps/desktop run dev:webclient
 *
 * `http://localhost:5174` is accepted as a directory base because
 * `parseTrustedAccountDirectoryBaseUrl` allows loopback HTTP; the client then
 * requests `/account/machines` on it, which lands here. Signing in also needs
 * `http://localhost:5174/account/callback` registered as a redirect URI on that
 * Clerk OAuth client. Point somewhere else (the development Worker, a `wrangler
 * dev` instance) with ADE_DEV_DIRECTORY_PROXY_TARGET.
 */
const DEV_DIRECTORY_PROXY_TARGET =
  process.env.ADE_DEV_DIRECTORY_PROXY_TARGET?.trim()
  || "https://ade-account-directory-production.arulsharma1028.workers.dev";

/**
 * The directory's account routes, and only those: `/account/callback` is the
 * OAuth landing route owned by the web client's own router, so proxying the
 * whole `/account` prefix would send sign-in returns to the Worker.
 */
const DEV_DIRECTORY_PROXY_ROUTE = "^/account/machines(?:[/?]|$)";

/**
 * Same treatment for the push relay, which the Activity surface calls straight
 * from the browser and which applies the same browser-origin gate as the
 * directory. Without this a dev origin is rejected at CORS PREFLIGHT, so the
 * failure never even reaches the response handler — it surfaces as an endless
 * "preflight 403" in the console.
 *
 * Recipe mirrors the directory one:
 *
 *   VITE_ADE_PUSH_RELAY_URL=http://localhost:5174 \
 *   VITE_ADE_ACCOUNT_DIRECTORY_URL=http://localhost:5174 \
 *   npm --prefix apps/desktop run dev:webclient
 */
const DEV_PUSH_RELAY_PROXY_TARGET =
  process.env.ADE_DEV_PUSH_RELAY_PROXY_TARGET?.trim()
  || "https://ade-push-relay.arulsharma1028.workers.dev";

// Matches `/attention`, `/attention?…` and any `/attention/…` path, but not a
// sibling like `/attentionfoo`. The previous pattern required a trailing slash
// followed by another character, so a bare `/attention` request was not proxied.
const DEV_PUSH_RELAY_PROXY_ROUTE = "^/attention(?:[/?]|$)";

export default defineConfig({
  root: "src/renderer",
  base: "/",
  plugins: [react(), webClientDevEntry(), cloudflarePagesOutput()],
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    fs: {
      allow: [path.resolve(__dirname), path.resolve(__dirname, "src")]
    },
    proxy: {
      [DEV_DIRECTORY_PROXY_ROUTE]: {
        target: DEV_DIRECTORY_PROXY_TARGET,
        changeOrigin: true,
        // The whole point: no Origin reaches the Worker, so its browser-origin
        // gate never fires. Vite's `headers` option can only add or overwrite,
        // never delete, so remove it on the outgoing request itself.
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.removeHeader("origin");
            proxyReq.removeHeader("referer");
          });
        }
      },
      [DEV_PUSH_RELAY_PROXY_ROUTE]: {
        target: DEV_PUSH_RELAY_PROXY_TARGET,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.removeHeader("origin");
            proxyReq.removeHeader("referer");
          });
        }
      }
    }
  },
  build: {
    outDir: "../../dist/web-client",
    emptyOutDir: true,
    cssMinify: "lightningcss",
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "src/renderer/webclient.html"),
      }
    }
  }
});
