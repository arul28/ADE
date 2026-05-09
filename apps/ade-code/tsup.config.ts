import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.tsx",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: {
    js: "import { createRequire as __adeCreateRequire } from 'node:module'; const require = __adeCreateRequire(import.meta.url);",
  },
  external: ["node-pty", "sql.js", "node:sqlite", "@cursor/sdk", "sqlite3"],
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      sqlite: "node:sqlite",
    };
  },
});
