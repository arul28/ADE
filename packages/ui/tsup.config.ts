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
    lanes: "src/lanes/index.ts",
    dialog: "src/dialog/index.ts",
    attachments: "src/attachments/index.ts",
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
  /**
   * The dialog's two dependencies are BUNDLED, and that is not a preference.
   *
   * Every other external is resolved by the consumer, from the consumer's own
   * `node_modules`, so there is one copy of it in the graph. These two are not:
   * they are declared by the kit alone, so a consumer resolves them from
   * `packages/ui/node_modules` — and `@radix-ui/react-dialog` then resolves its
   * own `react` from the copy sitting beside it, which is the kit's
   * devDependency and NOT the consumer's React.
   *
   * The result is a second dispatcher inside one tree: every hook Radix calls
   * throws "Cannot read properties of null (reading 'useRef')". Bundling them
   * leaves `react` as the only bare import in `dist/dialog.js`, which the
   * consumer resolves and de-duplicates like every other kit module.
   */
  noExternal: ["@radix-ui/react-dialog", "border-beam"],
});
