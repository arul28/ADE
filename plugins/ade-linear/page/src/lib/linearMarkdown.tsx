/**
 * The issue-description markdown stack.
 *
 * A port of the app's `buildChatMarkdownComponents("neutral", …)` with the
 * Linear overrides the compiled browser applied, and two deliberate changes:
 *
 * - Code blocks draw as plain `<pre><code>` rather than through Shiki. The
 *   highlighter is a renderer component with its own worker and theme registry,
 *   and a guest cannot reach it. The block keeps the same box, background and
 *   metrics, so the difference is syntax colour inside a fenced block.
 * - Links go through `openLink`, which is the bridge's `openDeeplink`. The host
 *   decides between ADE's own browser and the system one, exactly as it does for
 *   a socket's `{openUrl}` answer. A workspace path is not a URL, so it stays
 *   inert text — the same rule `ChatMarkdownAnchor` keeps.
 *
 * The sanitize schema and the URL transform come from `@ade-dev/ui/markdown`, the
 * app's own copy: a page rendering agent text has to make the same decision about
 * what markup survives as the app does.
 */

import React, { type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { cn } from "@ade-dev/ui";
// The react-markdown stack has its own entry point so the barrel stays free of
// remark/rehype for the pages that never draw markdown.
import { SAFE_PREVIEW_SCHEMA, markdownUrlTransform } from "@ade-dev/ui/markdown";

import { openLink } from "../host/ui";

function isExternalHref(href: string): boolean {
  return /^(https?|ade):/i.test(href.trim());
}

function LinearAnchor({ href, children }: { href?: string; children: ReactNode }): React.ReactElement {
  const target = (href ?? "").trim();
  if (!target || !isExternalHref(target)) {
    return <span className="break-words">{children}</span>;
  }
  return (
    <a
      href={target}
      className="font-medium text-[color:var(--color-accent,#A78BFA)] underline underline-offset-2 transition-opacity hover:opacity-80"
      onClick={(event) => {
        event.preventDefault();
        void openLink(target);
      }}
    >
      {children}
    </a>
  );
}

export const LINEAR_MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => (
    <p className="mb-3 max-w-full whitespace-pre-wrap break-words last:mb-0">{children}</p>
  ),
  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="break-words [overflow-wrap:anywhere]">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 text-[15px] font-semibold leading-snug text-fg/95 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-4 text-[13.5px] font-semibold leading-snug text-fg/90 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-3 text-[12.5px] font-semibold leading-snug text-fg/85 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-3 text-[12px] font-semibold leading-snug text-fg/80 first:mt-0">{children}</h4>
  ),
  hr: () => <hr className="my-3 border-white/10" />,
  pre: ({ children }) => (
    <pre
      className="mb-3 overflow-auto rounded-sm p-3 font-mono text-[length:calc(var(--chat-font-size,13px)*11/14)] leading-5 last:mb-0"
      style={{ background: "var(--chat-block-bg)", border: "1px solid var(--chat-block-border)" }}
    >
      {children}
    </pre>
  ),
  code: ({ children, className }) => {
    if (className && /language-/.test(className)) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code
        className={cn(
          className ??
            "rounded-sm px-1 py-0.5 font-mono text-[length:calc(var(--chat-font-size,13px)*11/14)] break-words [overflow-wrap:anywhere]",
        )}
        style={className ? undefined : { background: "var(--chat-inline-code-bg)" }}
      >
        {children}
      </code>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-white/18 pl-3 text-muted-fg/72 last:mb-0">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ children, href }) => <LinearAnchor href={href}>{children}</LinearAnchor>,
  table: ({ children }) => (
    <div className="mb-3 max-w-full overflow-x-auto last:mb-0">
      <table className="w-full min-w-0 border-collapse text-left">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="break-words px-2 py-1 font-semibold" style={{ border: "1px solid var(--chat-table-border)" }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="break-words px-2 py-1 align-top" style={{ border: "1px solid var(--chat-table-border)" }}>
      {children}
    </td>
  ),
  img: (props) => {
    const { src, alt, title } = props as { src?: string; alt?: string; title?: string };
    if (!src) return null;
    return (
      <img
        src={src}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        className="my-2 max-w-full rounded-md border border-white/10"
      />
    );
  },
};

/** An issue description or a comment body, drawn the way the compiled pane drew it. */
export function LinearMarkdown({ children }: { children: string }): React.ReactElement {
  return (
    <div className="text-[12.5px] leading-relaxed text-fg/85 [--chat-font-size:13px] [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, SAFE_PREVIEW_SCHEMA]]}
        urlTransform={markdownUrlTransform}
        components={LINEAR_MARKDOWN_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
