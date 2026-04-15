import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
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
    pre: ({ children }) => (
      <pre className="mb-3 overflow-auto rounded-sm border border-white/[0.06] bg-black/25 p-3 font-mono text-[11px] leading-5 last:mb-0">
        {children}
      </pre>
    ),
    code: ({ children, className }) => (
      <code className={className ?? "rounded-sm bg-black/30 px-1 py-0.5 font-mono text-[11px]"}>
        {children}
      </code>
    ),
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
    th: ({ children }) => <th className="border border-white/[0.08] px-2 py-1 font-semibold">{children}</th>,
    td: ({ children }) => <td className="border border-white/[0.08] px-2 py-1 align-top">{children}</td>,
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
