/**
 * `@ade-dev/ui/markdown` — the react-markdown stack, on its own entry point.
 *
 * `react-markdown`, `remark-gfm`, `rehype-raw` and `rehype-sanitize` are a
 * large graph that most pages never render, so they stay out of the barrel.
 */
export {
  Markdown,
  SAFE_PREVIEW_SCHEMA,
  buildMarkdownComponents,
  isWindowsAbsolutePath,
  markdownUrlTransform,
} from "./primitives/Markdown";
export type { MarkdownProps } from "./primitives/Markdown";
