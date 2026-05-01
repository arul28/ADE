import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts"
  },
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  outExtension: () => ({
    js: ".cjs"
  }),
  external: ["node-pty", "sql.js", "node:sqlite", "@cursor/sdk", "sqlite3"],
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      sqlite: "node:sqlite",
    };
  },
});
