import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  // React stays external — it is a peer dependency, and bundling a second copy
  // would break hooks in every host.
  external: ["react", "react-dom", "react/jsx-runtime", "@ade-dev/sdk"],
});
