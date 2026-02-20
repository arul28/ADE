import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts"
  },
  format: ["cjs"],
  platform: "node",
  target: "node18",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  outExtension: () => ({
    js: ".cjs"
  }),
  external: ["node-pty", "sql.js"]
});
