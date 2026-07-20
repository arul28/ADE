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
