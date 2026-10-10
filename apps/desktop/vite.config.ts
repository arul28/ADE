import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `browserMock.ts` imports the generated snapshot of the project database
 * (`browser-mock-ade-snapshot.generated.json`, tens of MB when it exists) for
 * the browser preview. The dev app window loads the same modules from this
 * server and never installs the mock, so it gets an empty module instead of a
 * file it would parse and hold for the life of the window. The window marks
 * its user agent (`DEV_APP_WINDOW_USER_AGENT_MARK` in `src/main/main.ts`); a
 * preview in the built-in browser or any other browser has no mark and gets
 * the snapshot. Dev server only; builds are untouched.
 */
function skipBrowserMockSnapshotForAppWindow(): Plugin {
  return {
    name: "ade-skip-browser-mock-snapshot-for-app-window",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        const fromAppWindow = String(req.headers["user-agent"] ?? "").includes("ADEDevShell");
        if (fromAppWindow && pathname.endsWith("/browser-mock-ade-snapshot.generated.json")) {
          res.setHeader("Content-Type", "text/javascript");
          res.setHeader("Cache-Control", "no-store");
          res.end("export default null;\n");
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), skipBrowserMockSnapshotForAppWindow()],
  optimizeDeps: {
    // Loaded lazily by the first terminal, so the dep scan misses it; found at
    // runtime, Vite re-optimizes and the open page's import fails with
    // "504 Outdated Optimize Dep" until a reload, leaving terminals on the
    // DOM renderer.
    include: ["@xterm/addon-webgl"],
  },
  server: {
    // Default `localhost` can bind ::1 only on macOS; then http://127.0.0.1:5173
    // refuses. Listening on all interfaces fixes 127.0.0.1 and "localhost" equally.
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/ade-dev-rpc": {
        target: "http://127.0.0.1:18765",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ade-dev-rpc/, ""),
      },
    },
    fs: {
      // Keep Vite's default workspace/node_modules access and additionally allow src/.
      // Monaco's ESM runtime pulls CSS/assets from node_modules at dev-time.
      allow: [path.resolve(__dirname), path.resolve(__dirname, "src")]
    }
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    cssMinify: "lightningcss",
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, "/");
          if (!normalized.includes("/node_modules/")) return undefined;
          if (normalized.includes("/node_modules/monaco-editor/")) return "vendor-monaco";
          if (
            normalized.includes("/node_modules/@xyflow/react/")
            || normalized.includes("/node_modules/framer-motion/")
            || normalized.includes("/node_modules/motion/")
          ) {
            return "vendor-graph";
          }
          if (
            normalized.includes("/node_modules/@xterm/")
            || normalized.includes("/node_modules/xterm/")
          ) {
            return "vendor-terminal";
          }
          if (
            normalized.includes("/node_modules/react-markdown/")
            || normalized.includes("/node_modules/remark-gfm/")
          ) {
            return "vendor-markdown";
          }
          return undefined;
        }
      }
    }
  }
});
