import { type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { HighlightedCode } from "./CodeHighlighter";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { cn } from "../ui/cn";
import {
  isWindowsAbsolutePath,
} from "../../lib/pathUtils";
import {
  isExternalHref,
  resolveWorkspacePathFromHref,
  useChatWorkspacePathOpener,
} from "./chatWorkspacePaths";

/**
 * A Windows absolute path (`C:\repo\x.ts`) is indistinguishable from a URL
 * scheme to the sanitizer, which sees `C:`. Allow the single-letter "schemes"
 * so drive paths survive to `ChatMarkdownAnchor`, which decides what they
 * actually are. Both cases are listed because the sanitizer compares protocols
 * case-sensitively. A single letter cannot collide with a real dangerous scheme
 * (`javascript:`, `data:`, `vbscript:` all stay blocked — covered by a test).
 */
const WINDOWS_DRIVE_LETTER_SCHEMES = Array.from({ length: 26 }, (_unused, index) => [
  String.fromCharCode(97 + index),
  String.fromCharCode(65 + index),
]).flat();

export const SAFE_PREVIEW_SCHEMA = {
  ...defaultSchema,
  // `rehypeSanitize` runs BEFORE `urlTransform`, and the default href allowlist
  // is http/https/irc/ircs/mailto/xmpp — so a `file:` href, and a Windows
  // `C:\repo\x.ts` (whose "scheme" parses as `c:`), had their href stripped
  // before anything could linkify them. That made absolute paths dead on
  // Windows while the same path worked on macOS/Linux, which arrive as `/…`
  // and are kept as relative. Allowing these two is safe here because
  // `ChatMarkdownAnchor` never renders a live href for a resolved workspace
  // path — it renders a button that routes through the Files tab.
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

export function chatMarkdownUrlTransform(value: string): string {
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

type Tone = "sky" | "amber" | "neutral";

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
  if (tone === "amber") {
    return {
      headerText: "text-amber-300/80",
      blockquoteBorder: "border-amber-300/25",
      hr: "border-amber-300/15",
      link: "text-amber-200/90 underline underline-offset-2 transition-colors hover:text-amber-100",
    };
  }
  if (tone === "neutral") {
    return {
      headerText: "text-zinc-200/95",
      blockquoteBorder: "border-white/18",
      hr: "border-white/10",
      link: "text-zinc-200/90 underline underline-offset-2 transition-colors hover:text-white",
    };
  }
  return {
    headerText: "text-sky-200/85",
    blockquoteBorder: "border-sky-300/25",
    hr: "border-sky-300/15",
    link: "text-sky-300/90 underline underline-offset-2 transition-colors hover:text-sky-200",
  };
}

/**
 * A markdown link, routed by what it actually points at.
 *
 * A file path is NOT a URL: handing `laneService.ts` to the browser opener gets
 * it normalized to `https://laneService.ts` and navigates ADE's built-in browser
 * to a garbage host, and a multi-segment `apps/foo.ts` dead-clicks instead. So
 * workspace paths go to the Files tab via the chat's opener, and when no chat
 * surface is hosting this markdown (Settings preview, PR body) they render as
 * inert text — never as a guessed URL.
 */
function ChatMarkdownAnchor({
  href,
  className,
  children,
}: {
  href: string | undefined;
  className: string;
  children: ReactNode;
}): ReactNode {
  const openWorkspacePath = useChatWorkspacePathOpener();
  const workspacePath = resolveWorkspacePathFromHref(href);

  // Allowing `file:` and drive schemes past the sanitizer (above) means an href
  // that is NEITHER a resolvable workspace path NOR a real URL — `file:///tmp`,
  // say — would otherwise reach the browser opener, which accepts `file:` and
  // would load it in-app. Before the schema widening the sanitizer stripped
  // those, so keep them inert rather than opening arbitrary local files from
  // whatever text an agent echoed into chat.
  if (!workspacePath && !isExternalHref(href ?? "")) {
    return <span className="break-words">{children}</span>;
  }

  if (workspacePath) {
    if (!openWorkspacePath) return <span className="break-words">{children}</span>;
    return (
      <button
        type="button"
        title={workspacePath.path}
        className={cn(className, "cursor-pointer break-words text-left")}
        onClick={(event) => {
          event.preventDefault();
          openWorkspacePath(workspacePath);
        }}
      >
        {children}
      </button>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={(event) => {
        event.preventDefault();
        openUrlInAdeBrowser(href);
      }}
    >
      {children}
    </a>
  );
}

export function buildChatMarkdownComponents(tone: Tone = "sky", overrides: Overrides = {}): Components {
  const accent = toneAccents(tone);
  return {
    p: ({ children }) => (
      <p className="mb-3 max-w-full whitespace-pre-wrap break-words last:mb-0">{children}</p>
    ),
    ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
    li: ({ children }) => <li className="break-words [overflow-wrap:anywhere]">{children}</li>,
    h1: ({ children }) => (
      <h1 className="mb-2 mt-5 font-sans text-[length:calc(var(--chat-font-size)*19/14)] font-semibold leading-snug tracking-[-0.015em] text-fg/92 first:mt-0">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 mt-5 font-sans text-[length:calc(var(--chat-font-size)*16/14)] font-semibold leading-snug tracking-[-0.012em] text-fg/90 first:mt-0">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-1.5 mt-4 font-sans text-[length:calc(var(--chat-font-size)*14/14)] font-semibold leading-snug tracking-[-0.008em] text-fg/88 first:mt-0">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-1.5 mt-3 font-sans text-[length:calc(var(--chat-font-size)*12.5/14)] font-semibold leading-snug text-fg/82 first:mt-0">
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
          className="mb-3 overflow-auto rounded-sm p-3 font-mono text-[length:calc(var(--chat-font-size)*11/14)] leading-5 last:mb-0"
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
          className={cn(
            className ?? "rounded-sm px-1 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*11/14)] break-words [overflow-wrap:anywhere]",
          )}
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
    a: ({ children, href }) => <ChatMarkdownAnchor href={href} className={accent.link}>{children}</ChatMarkdownAnchor>,
    table: ({ children }) => (
      <div className="mb-3 max-w-full overflow-x-auto last:mb-0">
        <table className="w-full min-w-0 border-collapse text-left">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th
        className="break-words px-2 py-1 font-semibold"
        style={{ border: "1px solid var(--chat-table-border)" }}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td
        className="break-words px-2 py-1 align-top"
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
      // Keep `file:` and Windows drive hrefs intact — the default transform
      // drops them, which would hide exactly the paths we want to linkify.
      urlTransform={chatMarkdownUrlTransform}
      components={buildChatMarkdownComponents(tone, componentOverrides)}
    >
      {children}
    </ReactMarkdown>
  );
}
