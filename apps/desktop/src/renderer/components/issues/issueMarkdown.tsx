import { useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { PR_SAFE_SCHEMA } from "../prs/shared/PrMarkdown";
import { openLinkFromUi } from "../../lib/openExternal";
import { buildChatMarkdownComponents } from "../chat/chatMarkdown";
import { cn } from "../ui/cn";

// Reuse the app's chat markdown stack (Shiki code, scrollable tables, wrapped
// text) for issue descriptions, but with clean document-style headings instead
// of the chat surface's mono/uppercase ones, and accent links that route
// through ADE's link handling (an issue link opens the issue viewer).
const LINEAR_MARKDOWN_COMPONENTS: Components = buildChatMarkdownComponents("neutral", {
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
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (typeof href === "string" && href.trim() !== "") {
          openLinkFromUi(href, event);
        }
      }}
      className="font-medium text-[color:var(--color-accent,#A78BFA)] underline underline-offset-2 transition-opacity hover:opacity-80"
    >
      {children}
    </a>
  ),
  img: (props) => {
    const { src, alt, title } = props as { src?: string; alt?: string; title?: string };
    if (!src) return null;
    return <IssueImage src={src} alt={alt ?? ""} title={title} />;
  },
});

const IMAGE_RETRY_DELAYS_MS = [1_500, 4_000, 10_000];

/**
 * A picture GitHub or Linear just took fails for a few seconds before the
 * host serves it, and the browser keeps that failure for the same URL. So a
 * failed load tries again a few times with a marker query, then stays broken.
 */
function IssueImage({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
  }, []);
  useEffect(() => setAttempt(0), [src]);
  const retryable = /^https:\/\//i.test(src);
  const shown = attempt === 0 || !retryable ? src : `${src}${src.includes("?") ? "&" : "?"}ade-retry=${attempt}`;
  return (
    <img
      src={shown}
      alt={alt}
      title={title}
      loading="lazy"
      className="my-2 max-w-full rounded-md border border-fg/10"
      onError={() => {
        const delay = IMAGE_RETRY_DELAYS_MS[attempt];
        if (!retryable || delay == null) return;
        timer.current = window.setTimeout(() => setAttempt((value) => value + 1), delay);
      }}
    />
  );
}

// Issue bodies and comments carry GitHub HTML (`<details>`, `<img>`, a bot's
// `<p><a>`). Parse it, then sanitize with the PR view's schema; without the
// raw step an HTML-only comment rendered as nothing.
const ISSUE_REHYPE_PLUGINS = [rehypeRaw, [rehypeSanitize, PR_SAFE_SCHEMA]] as React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"];

export function IssueMarkdown({ children, size = "body" }: { children: string; size?: "body" | "comment" }) {
  return (
    <div
      className={cn(
        "leading-relaxed text-fg/85 [overflow-wrap:anywhere]",
        size === "body" ? "text-[12.5px] [--chat-font-size:13px]" : "text-[12px] [--chat-font-size:12px]",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={ISSUE_REHYPE_PLUGINS} components={LINEAR_MARKDOWN_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

