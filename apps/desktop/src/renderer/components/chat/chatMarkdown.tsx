import React, { type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { HighlightedCode } from "./CodeHighlighter";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export const SAFE_PREVIEW_SCHEMA = {
  ...defaultSchema,
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

type Tone = "sky" | "amber";

type Overrides = Partial<Components>;

function extractPlainText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractPlainText).join("");
  if (node && typeof node === "object" && "props" in (node as object)) {
    const props = (node as { props: { children?: ReactNode } }).props;
    return extractPlainText(props?.children);
  }
  return "";
}

function toneAccents(tone: Tone) {
  return tone === "amber"
    ? {
        headerText: "text-amber-300/80",
        blockquoteBorder: "border-amber-300/25",
        hr: "border-amber-300/15",
      }
    : {
        headerText: "text-sky-200/85",
        blockquoteBorder: "border-sky-300/25",
        hr: "border-sky-300/15",
      };
}

export function buildChatMarkdownComponents(tone: Tone = "sky", overrides: Overrides = {}): Components {
  const accent = toneAccents(tone);
  return {
    p: ({ children }) => <p className="mb-3 whitespace-pre-wrap last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    h1: ({ children }) => (
      <h1 className={`mb-2 mt-3 font-mono text-[12px] font-bold uppercase tracking-[0.14em] ${accent.headerText} first:mt-0`}>
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className={`mb-2 mt-3 font-mono text-[11px] font-bold uppercase tracking-[0.14em] ${accent.headerText} first:mt-0`}>
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className={`mb-2 mt-3 font-mono text-[10px] font-bold uppercase tracking-[0.14em] ${accent.headerText} first:mt-0`}>
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className={`mb-2 mt-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] ${accent.headerText} first:mt-0`}>
        {children}
      </h4>
    ),
    hr: () => <hr className={`my-3 ${accent.hr}`} />,
    pre: ({ children }) => {
      const first = Array.isArray(children) ? children[0] : children;
      if (first && typeof first === "object" && "props" in (first as object)) {
        const props = (first as { props?: { className?: string; children?: ReactNode } }).props;
        const className = props?.className ?? "";
        const match = /language-([\w-]+)/.exec(className);
        const language = match ? match[1] : "text";
        const codeText = extractPlainText(props?.children).replace(/\n$/, "");
        return <HighlightedCode code={codeText} language={language} />;
      }
      return (
        <pre
          className="mb-3 overflow-auto rounded-sm p-3 font-mono text-[11px] leading-5 last:mb-0"
          style={{
            background: "var(--chat-block-bg)",
            border: "1px solid var(--chat-block-border)",
          }}
        >
          {children}
        </pre>
      );
    },
    code: ({ children, className }) => {
      if (className && /language-/.test(className)) {
        return <code className={className}>{children}</code>;
      }
      return (
        <code
          className={className ?? "rounded-sm px-1 py-0.5 font-mono text-[11px]"}
          style={className ? undefined : { background: "var(--chat-inline-code-bg)" }}
        >
          {children}
        </code>
      );
    },
    blockquote: ({ children }) => (
      <blockquote className={`mb-3 border-l-2 pl-3 text-muted-fg/72 last:mb-0 ${accent.blockquoteBorder}`}>
        {children}
      </blockquote>
    ),
    strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sky-300/90 underline underline-offset-2 transition-colors hover:text-sky-200"
      >
        {children}
      </a>
    ),
    table: ({ children }) => <table className="mb-3 w-full border-collapse text-left last:mb-0">{children}</table>,
    th: ({ children }) => (
      <th
        className="px-2 py-1 font-semibold"
        style={{ border: "1px solid var(--chat-table-border)" }}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td
        className="px-2 py-1 align-top"
        style={{ border: "1px solid var(--chat-table-border)" }}
      >
        {children}
      </td>
    ),
    ...overrides,
  } satisfies Components;
}

type ChatMarkdownProps = {
  children: string;
  tone?: Tone;
  componentOverrides?: Overrides;
};

export function ChatMarkdown({ children, tone = "sky", componentOverrides }: ChatMarkdownProps): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, SAFE_PREVIEW_SCHEMA]]}
      components={buildChatMarkdownComponents(tone, componentOverrides)}
    >
      {children}
    </ReactMarkdown>
  );
}
