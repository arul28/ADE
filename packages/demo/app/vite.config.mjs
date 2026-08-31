import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: appRoot,
  plugins: [react()],
  server: { host: "127.0.0.1", port: Number(process.env.DATADESK_WEB_PORT ?? 4317), strictPort: true },
  resolve: {
    // The workspace packages are consumed from their built `dist`, exactly as a
    // published install would be — this demo is proof of the shipped artifact,
    // not of the source tree.
    alias: {
      "@ade-dev/chat-ui": path.resolve(appRoot, "../node_modules/@ade-dev/chat-ui/dist/index.js"),
    },
    dedupe: ["react", "react-dom"],
  },
});
