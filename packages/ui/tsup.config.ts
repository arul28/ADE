import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  // React stays external — it is a peer dependency, and a second copy would
  // break hooks in every host. The markdown stack and the icon set stay
  // external too: the desktop app already has one copy of each, and bundling
  // duplicates into the kit would double the renderer's payload.
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@phosphor-icons/react",
    "react-markdown",
    "rehype-raw",
    "rehype-sanitize",
    "remark-gfm",
    "clsx",
    "tailwind-merge",
  ],
});
