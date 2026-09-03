/**
 * The markdown stack: `react-markdown` + `remark-gfm` + `rehype-raw` +
 * `rehype-sanitize`, with ADE's sanitize schema.
 *
 * The schema and the URL transform are the parts the desktop app and a plugin
 * page must agree on exactly — they decide what markup and which hrefs survive
 * — so they live here and the app imports them from here. The app keeps its own
 * component map, because its links route into the Files tab and its code blocks
 * go through the renderer's syntax highlighter; neither exists in a webview.
 *
 * Styling is plain `ade-markdown-*` classes from the injected stylesheet. There
 * is no Tailwind at runtime.
 */

import { type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/**
 * A Windows absolute path (`C:\repo\x.ts`) is indistinguishable from a URL
 * scheme to the sanitizer, which sees `C:`. Allow the single-letter "schemes"
 * so drive paths survive to the anchor renderer, which decides what they
 * actually are. Both cases are listed because the sanitizer compares protocols
 * case-sensitively. A single letter cannot collide with a real dangerous scheme
 * (`javascript:`, `data:`, `vbscript:` all stay blocked — covered by a test).
 */
const WINDOWS_DRIVE_LETTER_SCHEMES = Array.from({ length: 26 }, (_unused, index) => [
  String.fromCharCode(97 + index),
  String.fromCharCode(65 + index),
]).flat();

export const SAFE_PREVIEW_SCHEMA: typeof defaultSchema = {
  ...defaultSchema,
  // `rehypeSanitize` runs BEFORE `urlTransform`, and the default href allowlist
  // is http/https/irc/ircs/mailto/xmpp — so a `file:` href, and a Windows
  // `C:\repo\x.ts` (whose "scheme" parses as `c:`), had their href stripped
  // before anything could linkify them. That made absolute paths dead on
  // Windows while the same path worked on macOS/Linux, which arrive as `/…`
  // and are kept as relative. Allowing these two is safe because a resolved
  // workspace path never renders as a live href — the host renders a control
  // that routes through its own file surface.
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", ...WINDOWS_DRIVE_LETTER_SCHEMES],
  },
  tagNames: [
    "p",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "code",
    "pre",
    "blockquote",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "a",
  ],
};

function isWindowsDrivePath(value: string): boolean {
  const trimmed = value.trim();
  return /^\/?[A-Za-z]:[\\/]/.test(trimmed) || /^[A-Za-z]:$/.test(trimmed);
}

function isWindowsUncPath(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:\\\\|\/\/)[^/\\]/.test(trimmed);
}

/** Ported from the desktop's `pathUtils` so the kit stays dependency-free. */
export function isWindowsAbsolutePath(value: string): boolean {
  return isWindowsDrivePath(value) || isWindowsUncPath(value);
}

export function markdownUrlTransform(value: string): string {
  // The markdown pipeline percent-encodes link destinations, so a Windows path
  // reaches here as `C:%5Crepo%5Cx.ts`. Test the decoded form or the drive
  // check misses and `defaultUrlTransform` blanks the href for an unknown `C:`
  // scheme — the exact dead-click this transform exists to prevent.
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Partially-encoded href — fall back to the raw value.
  }
  if (/^file:/i.test(value) || isWindowsAbsolutePath(value) || isWindowsAbsolutePath(decoded)) {
    return value;
  }
  return defaultUrlTransform(value);
}

export type MarkdownProps = {
  children: string;
  className?: string;
  /**
   * Replace or extend the element map. A plugin page uses this to route link
   * clicks through `openDeeplink` instead of letting the webview navigate.
   */
  componentOverrides?: Partial<Components>;
};

export function buildMarkdownComponents(overrides: Partial<Components> = {}): Components {
  return {
    p: ({ children }) => <p className="ade-markdown-p">{children}</p>,
    ul: ({ children }) => <ul className="ade-markdown-ul">{children}</ul>,
    ol: ({ children }) => <ol className="ade-markdown-ol">{children}</ol>,
    li: ({ children }) => <li className="ade-markdown-li">{children}</li>,
    h1: ({ children }) => <h1 className="ade-markdown-h1">{children}</h1>,
    h2: ({ children }) => <h2 className="ade-markdown-h2">{children}</h2>,
    h3: ({ children }) => <h3 className="ade-markdown-h3">{children}</h3>,
    h4: ({ children }) => <h4 className="ade-markdown-h4">{children}</h4>,
    hr: () => <hr className="ade-markdown-hr" />,
    pre: ({ children }) => <pre className="ade-markdown-pre">{children}</pre>,
    code: ({ children, className }) => (
      <code className={className ? `${className} ade-markdown-code-block` : "ade-markdown-code"}>
        {children}
      </code>
    ),
    blockquote: ({ children }) => <blockquote className="ade-markdown-quote">{children}</blockquote>,
    strong: ({ children }) => <strong className="ade-markdown-strong">{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    a: ({ children, href }) => (
      <a className="ade-markdown-a" href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    table: ({ children }) => (
      <div className="ade-markdown-table-wrap">
        <table className="ade-markdown-table">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="ade-markdown-th">{children}</th>,
    td: ({ children }) => <td className="ade-markdown-td">{children}</td>,
    ...overrides,
  } satisfies Components;
}

export function Markdown({ children, className, componentOverrides }: MarkdownProps): ReactNode {
  return (
    <div className={className ? `ade-markdown ${className}` : "ade-markdown"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, SAFE_PREVIEW_SCHEMA]]}
        // Keep `file:` and Windows drive hrefs intact — the default transform
        // drops them, which would hide exactly the paths we want to linkify.
        urlTransform={markdownUrlTransform}
        components={buildMarkdownComponents(componentOverrides)}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
