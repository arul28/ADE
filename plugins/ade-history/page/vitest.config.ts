/**
 * The seam test's own config.
 *
 * Separate from `vite.config.ts` because the build config has no `test` key —
 * Vite's own types refuse one, and a config that only typechecks under Vitest's
 * augmentation is a config the build cannot read.
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  /**
   * One React, one markdown stack, one icon set.
   *
   * `@ade-dev/ui` is linked with `file:`, so it carries its own `node_modules`
   * with its own copy of React beside it. A second copy is not a size problem,
   * it is a broken page: the kit's components would call hooks against a
   * different dispatcher than the page's tree renders with, and every one of
   * them throws "Cannot read properties of null (reading 'useContext')". These
   * are the packages both halves import, so all of them are pinned to this
   * directory's copy.
   */
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "@phosphor-icons/react",
      "clsx",
      "tailwind-merge",
      "zustand",
      "motion",
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
