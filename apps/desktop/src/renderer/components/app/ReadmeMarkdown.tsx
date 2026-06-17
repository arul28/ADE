import type { CSSProperties } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

// READMEs frequently center their logo/badges with `<p align="center">`,
// `<div align="center">`, or `<h1 align="center">`. `rehype-sanitize`'s default
// schema strips `align`, so allow it (plus the legacy `<center>` tag and a few
// image sizing attributes) without opening the door to arbitrary HTML. README
// images are rendered as alt text so previews don't make passive network or data
// URL loads while the user browses folders.
const README_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "center"],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "align"],
    img: [...(defaultSchema.attributes?.img ?? []), "align", "width", "height"],
  },
};

// Maps an HTML `align` attribute to a CSS text-align so the overridden block
// components (which otherwise drop their props) honor centered content. Read
// off the props object via a cast because React's typings for <p>/<h*> don't
// declare the legacy `align` attribute. Plain `<div>`/`<center>` elements are
// not overridden and center natively once the attribute survives sanitization.
function alignStyle(props: unknown): CSSProperties | undefined {
  const align = (props as { align?: unknown } | null)?.align;
  return align === "center" || align === "right" || align === "left"
    ? { textAlign: align }
    : undefined;
}

const README_COMPONENTS: Components = {
  h1: (props) => (
    <h3
      className="mt-3 mb-1.5 text-[13px] font-semibold text-[var(--color-fg)] first:mt-0"
      style={alignStyle(props)}
    >
      {props.children}
    </h3>
  ),
  h2: (props) => (
    <h4
      className="mt-3 mb-1.5 text-[12px] font-semibold text-[var(--color-fg)] first:mt-0"
      style={alignStyle(props)}
    >
      {props.children}
    </h4>
  ),
  h3: (props) => (
    <h5
      className="mt-2.5 mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-fg)] first:mt-0"
      style={alignStyle(props)}
    >
      {props.children}
    </h5>
  ),
  h4: (props) => (
    <h6
      className="mt-2 mb-1 text-[11px] font-semibold text-[var(--color-muted-fg)] first:mt-0"
      style={alignStyle(props)}
    >
      {props.children}
    </h6>
  ),
  p: (props) => (
    <p className="mb-2 last:mb-0" style={alignStyle(props)}>
      {props.children}
    </p>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 list-disc pl-5 last:mb-0 marker:text-[var(--color-muted-fg)]">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal pl-5 last:mb-0 marker:text-[var(--color-muted-fg)]">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) void window.ade?.app?.openExternal?.(href).catch(() => {});
      }}
      className="text-[var(--color-accent)] underline decoration-[var(--color-accent)]/40 underline-offset-2 hover:decoration-[var(--color-accent)]"
    >
      {children}
    </a>
  ),
  code: ({ children, className }) => {
    if (className && /language-/.test(className)) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px] text-[var(--color-accent)]/90">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed last:mb-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-[var(--color-accent)]/40 pl-3 text-[var(--color-muted-fg)] last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-t border-[var(--color-border)]" />,
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto rounded-md border border-[var(--color-border)] last:mb-0">
      <table className="w-full text-left text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-[var(--color-border)] bg-black/20 px-2 py-1 font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-[var(--color-border)] px-2 py-1 align-top">
      {children}
    </td>
  ),
  img: ({ alt }) => {
    return alt ? (
      <span className="text-[11px] italic text-[var(--color-muted-fg)]">
        {alt}
      </span>
    ) : null;
  },
};

export function ReadmeMarkdown({ content }: { content: string }) {
  return (
    <div className="text-[13px] leading-relaxed text-[var(--color-fg)]/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // `rehypeRaw` must run before `rehypeSanitize` so parsed raw README HTML
        // is sanitized. The custom schema keeps `align` (and <center>) so centered
        // text/logo placeholders keep their layout without loading remote images.
        rehypePlugins={[rehypeRaw, [rehypeSanitize, README_SANITIZE_SCHEMA]]}
        components={README_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
