import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per public subpath. Splitting them is what keeps
  // `@ade-dev/ui/tokens` free of React, `@phosphor-icons/react` and the
  // markdown stack: a bundler following the barrel would otherwise retain the
  // whole icon set, which is what blew the web client's entry graph past its
  // budget.
  entry: {
    index: "src/index.ts",
    tokens: "src/tokens.ts",
    theme: "src/theme/index.ts",
    icons: "src/icons.ts",
    markdown: "src/markdown.ts",
  },
  splitting: true,
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
