import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sceneThreePlugin } from "./vite.sceneThree";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cloudflare Pages serves the site from the outDir root: the entry must be
 * index.html, and _headers/_redirects (CSP + SPA fallback) must sit beside it,
 * with _worker.js/_routes.json (a 404 for a removed `/assets/*` file).
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
      for (const name of ["_headers", "_redirects", "_routes.json", "_worker.js"]) {
        const source = path.join(pagesDir, name);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(outDir, name));
      }
    }
  };
}

/**
 * Dev only: a test sign-in for agents that check the web client on screen.
 * When `ADE_DEV_TEST_SESSION_FILE` names a Clerk client session file
 * (`{ clientAuth, sessionId }`), `GET /__ade_dev/session-token` mints a fresh
 * session token for that account here in Node. The web client reads it only
 * in a dev build (`account/devTestSession.ts`). The route answers loopback
 * callers only, and never logs the token. `vite build` never has it.
 */
function devTestSession(): Plugin | null {
  const file = process.env.ADE_DEV_TEST_SESSION_FILE?.trim();
  if (!file) return null;
  const fapiBase = (() => {
    const key = process.env.CLERK_PROD_PUBLISHABLE_KEY?.trim();
    if (key) {
      try {
        const host = Buffer.from(key.replace(/^pk_(live|test)_/, ""), "base64").toString("utf8").replace(/\$$/, "");
        if (/^[a-z0-9.-]+$/i.test(host)) return `https://${host}`;
      } catch {
        // Fall back to the production Clerk host.
      }
    }
    return "https://clerk.ade-app.dev";
  })();
  let kept: { token: string; expiresAtMs: number } | null = null;
  const expiresAtOf = (token: string): number => {
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
      return typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + 30_000;
    } catch {
      return Date.now() + 30_000;
    }
  };
  const mint = async (): Promise<string> => {
    if (kept && kept.expiresAtMs - Date.now() > 15_000) return kept.token;
    const session = JSON.parse(fs.readFileSync(file, "utf8")) as { clientAuth?: unknown; sessionId?: unknown };
    if (typeof session.clientAuth !== "string" || typeof session.sessionId !== "string" || !/^sess_[A-Za-z0-9]+$/.test(session.sessionId)) {
      throw new Error("The test session file has no client session. Run testaccount.mjs token once.");
    }
    const response = await fetch(`${fapiBase}/v1/client/sessions/${session.sessionId}/tokens?_is_native=1`, {
      method: "POST",
      headers: { authorization: session.clientAuth },
    });
    const body = await response.json().catch(() => null) as { jwt?: unknown } | null;
    if (!response.ok || typeof body?.jwt !== "string") {
      throw new Error(`Clerk did not give a session token (${response.status}). Run testaccount.mjs token once.`);
    }
    kept = { token: body.jwt, expiresAtMs: expiresAtOf(body.jwt) };
    return body.jwt;
  };
  return {
    name: "ade-web-client-dev-test-session",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__ade_dev/session-token", (req, res) => {
        const remote = req.socket.remoteAddress ?? "";
        const send = (status: number, value: unknown) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(value));
        };
        if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
          send(403, { error: "loopback only" });
          return;
        }
        if (req.method !== "GET") {
          send(405, { error: "GET only" });
          return;
        }
        void mint().then(
          (token) => send(200, { token }),
          (error: unknown) => send(503, { error: error instanceof Error ? error.message : "no token" }),
        );
      });
    },
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
        // The scene frame is a real page of its own (public/scene-frame.html).
        // So is the link page's status frame, which Pages serves at
        // `/link-status` from link-status.html.
        if (pathname === "/link-status") {
          req.url = "/link-status.html";
          next();
          return;
        }
        if (
          isNavigation
          && !isAsset
          && pathname !== "/webclient.html"
          && pathname !== "/scene-frame.html"
          && pathname !== "/link-status.html"
        ) {
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
 * The directory's routes the web client calls: the account routes (machines
 * and the project list), ADE Cloud (`/cloud/…`: launches, computers,
 * sign-ins, models) and the GitHub reads (`/github/…`). Not the whole
 * `/account` prefix: `/account/callback` is the OAuth landing route owned by
 * the web client's own router, so proxying it would send sign-in returns to
 * the Worker.
 */
const DEV_DIRECTORY_PROXY_ROUTE = "^/(?:account/(?:machines|projects|lanes)|cloud|github)(?:[/?]|$)";

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

// The deploy passes the tag-derived version (deploy-web.yml); package.json's
// version is a placeholder that releases never bump.
const desktopPackageVersion = process.env.ADE_WEB_VERSION?.trim()
  || (JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version?: string }).version
  || "";

export default defineConfig({
  root: "src/renderer",
  base: "/",
  plugins: [react(), webClientDevEntry(), devTestSession(), cloudflarePagesOutput(), sceneThreePlugin()],
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
  define: {
    // Sentry's release name: the desktop version this client was built from.
    __ADE_WEB_VERSION__: JSON.stringify(desktopPackageVersion),
  },
  build: {
    outDir: "../../dist/web-client",
    emptyOutDir: true,
    // Hidden maps for Sentry: written only when the release pipeline asks,
    // uploaded, then deleted before deploy (see deploy-web.yml).
    sourcemap: process.env.ADE_BUILD_SOURCEMAPS === "1" ? "hidden" : false,
    cssMinify: "lightningcss",
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "src/renderer/webclient.html"),
        // Framed by ade-app.dev/open; its own small entry (see webclient/linkStatus).
        "link-status": path.resolve(__dirname, "src/renderer/link-status.html"),
      }
    }
  }
});
