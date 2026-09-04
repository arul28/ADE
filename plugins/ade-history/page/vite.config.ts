/**
 * The page build.
 *
 * Three settings are load-bearing and none is a preference:
 *
 * - `base: "./"` — the guest loads from `ade-plugin://ade-linear/dist/index.html`,
 *   so every asset reference has to be relative to that file. An absolute `/assets/…`
 *   would resolve to the plugin root and 404.
 * - `outDir: "../dist"` with `emptyOutDir` — `dist/` is COMMITTED and is what the
 *   installer copies. `npm run build` in this directory is the only thing that
 *   writes it.
 * - Tailwind runs HERE, at build time, and emits one same-origin stylesheet. The
 *   ported components carry the app's own utility class names, and the page's
 *   content policy allows `style-src 'self'`; a runtime Tailwind would need a CDN
 *   script the policy forbids.
 *
 * There is no inline script: `index.html` links the built module and nothing else,
 * because `script-src 'self'` has no `'unsafe-inline'`.
 */
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Drop the `crossorigin` attribute Vite stamps on the entry tags.
 *
 * Every asset the page loads is served from its OWN origin
 * (`ade-plugin://ade-linear/…`) by ADE's protocol handler, which answers no
 * `Access-Control-Allow-Origin` because it never needs to: the requests are
 * same-origin. `crossorigin` asks the browser to fetch them in CORS mode
 * anyway, and a custom scheme is exactly where a browser's same-origin
 * short-circuit is least worth betting a blank page on.
 */
function stripCrossorigin(): Plugin {
  return {
    name: "ade-strip-crossorigin",
    transformIndexHtml: {
      order: "post",
      handler: (html) => html.replace(/\s+crossorigin(?==|>|\s)/g, ""),
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), stripCrossorigin()],
  /**
   * One React, one markdown stack, one icon set.
   *
   * `@ade-dev/ui` is linked with `file:`, so it carries its own `node_modules`
   * with its own copy of React beside it. A second copy is not a size problem,
   * it is a broken page: the kit's components would call hooks against a
   * different dispatcher than the page's tree renders with, and every one of
   * them throws "Cannot read properties of null (reading 'useContext')". These
   * are the packages both halves import, so all of them are pinned to this
   * directory's copy.
   */
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "@phosphor-icons/react",
      "clsx",
      "tailwind-merge",
      "zustand",
      "motion",
    ],
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // One chunk. A guest is destroyed when its placement hides, so every open
    // pays the request cost again; a split bundle turns one fetch into six.
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
    target: "chrome120",
    sourcemap: false,
  },
});
