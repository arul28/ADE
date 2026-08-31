import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  platform: "node",
  // The package must stay dependency-free: nothing but node builtins may be
  // bundled, so an accidental import of a third-party module fails the build
  // rather than silently shipping a vendored copy.
  noExternal: [],
  splitting: false,
});
