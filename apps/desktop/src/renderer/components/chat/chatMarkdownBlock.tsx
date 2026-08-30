import React, { useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileCode } from "@phosphor-icons/react";

import { MOSAIC_FENCE_LANGUAGE } from "../../../shared/chatMosaic";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { cn } from "../ui/cn";
import { useChatChromeTint } from "./chatAppearance";
import { chatMarkdownUrlTransform } from "./chatMarkdown";
import {
  looksLikeWorkspacePath,
  parseWorkspacePathLocation,
  resolveWorkspacePathFromHref,
  type WorkspacePathLocation,
} from "./chatWorkspacePaths";
import { HighlightedCode } from "./CodeHighlighter";
import { MosaicCard } from "./MosaicCard";

/**
 * Threaded into MarkdownBlock only for Claude-family sessions. When present, a
 * ```mosaic fence renders as an interactive card instead of a plain code block.
 * `scope` is the transcript row's stable key so byte-identical cards at
 * different positions keep independent answered state.
 */
export type MosaicRenderContext = {
  cardKeyFor: (source: string, scope: string) => string;
  onSubmit: (submission: { text: string; displayText: string }) => void | Promise<void>;
};

function WorkspacePathLink({
  children,
  code,
  neutral,
  onOpen,
}: {
  children: React.ReactNode;
  code: boolean;
  neutral: boolean;
  onOpen: () => void;
}) {
  const content = (
    <>
      <FileCode size={12} aria-hidden className="shrink-0 self-center" />
      <span className="min-w-0 break-all">{children}</span>
    </>
  );
  let className: string;
  if (code) {
    className = neutral
      ? "inline-flex max-w-full cursor-pointer items-baseline gap-1 break-all whitespace-normal rounded-md border border-white/14 bg-white/[0.06] px-1.5 py-0.5 align-baseline font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-white/88 underline decoration-white/25 underline-offset-2 transition-colors hover:border-white/22 hover:bg-white/[0.1] hover:text-white"
      : "inline-flex max-w-full cursor-pointer items-baseline gap-1 break-all whitespace-normal rounded-md border border-sky-400/16 bg-sky-500/[0.08] px-1.5 py-0.5 align-baseline font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-sky-200 underline decoration-sky-300/30 underline-offset-2 transition-colors hover:border-sky-400/24 hover:bg-sky-500/[0.12] hover:text-sky-100";
  } else {
    className = neutral
      ? "inline-flex max-w-full cursor-pointer items-baseline gap-1 break-all whitespace-normal rounded-sm border border-white/12 bg-white/[0.06] px-1.5 py-0.5 align-baseline font-sans text-[length:calc(var(--chat-font-size)*12/14)] text-left text-white/88 underline decoration-white/25 underline-offset-2 transition-colors hover:border-white/20 hover:bg-white/[0.1] hover:text-white"
      : "inline-flex max-w-full cursor-pointer items-baseline gap-1 break-all whitespace-normal rounded-sm border border-sky-400/12 bg-sky-500/[0.06] px-1.5 py-0.5 align-baseline font-sans text-[length:calc(var(--chat-font-size)*12/14)] text-left text-sky-200 underline decoration-sky-300/30 underline-offset-2 transition-colors hover:border-sky-400/22 hover:bg-sky-500/[0.1] hover:text-sky-100";
  }

  return code ? (
    <span
      role="button"
      tabIndex={0}
      className={className}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      title="Open file in Files"
    >
      {content}
    </span>
  ) : (
    <button type="button" className={className} onClick={onOpen} title="Open file in Files">
      {content}
    </button>
  );
}

/* ── Markdown renderer ── */

type MarkdownComponents = React.ComponentProps<typeof ReactMarkdown>["components"];

/** Module-level so the plugin array never changes identity between renders. */
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

/**
 * A single markdown parse+render, memoized on `(markdown, components)`.
 *
 * Split out of `MarkdownBlock` for the paced reveal: while a message streams,
 * the settled prefix and the growing tail render as two bodies inside ONE
 * prose container. The settled body's props are unchanged frame to frame, so
 * this memo bails out and only the short tail is re-parsed at 60 Hz — the
 * whole-message re-parse per paint is what made pacing unaffordable.
 */
const MarkdownBody = React.memo(function MarkdownBody({
  markdown,
  components,
}: {
  markdown: string;
  components: MarkdownComponents;
}) {
  if (markdown.length === 0) return null;
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      urlTransform={chatMarkdownUrlTransform}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  );
});

export const MarkdownBlock = React.memo(function MarkdownBlock({
  markdown,
  tailMarkdown,
  onOpenWorkspacePath,
  mosaic,
  mosaicScopeKey,
}: {
  markdown: string;
  /**
   * Growing tail of a paced reveal, rendered as a second body in the same
   * prose flow. Absent on every settled row — which then renders exactly one
   * body, identical to the pre-pacing output.
   */
  tailMarkdown?: string;
  onOpenWorkspacePath?: (path: string | WorkspacePathLocation) => void;
  mosaic?: MosaicRenderContext;
  /** Stable transcript-row key scoping mosaic answered state per message. */
  mosaicScopeKey?: string;
}) {
  const chromeTint = useChatChromeTint();
  const neu = chromeTint === "neutral";
  const openWorkspacePath = useCallback((path: WorkspacePathLocation) => {
    onOpenWorkspacePath?.(path);
  }, [onOpenWorkspacePath]);

  const components: MarkdownComponents = useMemo(() => ({
    h1: ({ children }) => <h1 className="text-[1rem]">{children}</h1>,
    h2: ({ children }) => <h2 className="text-[0.95rem]">{children}</h2>,
    h3: ({ children }) => <h3 className="text-[0.9rem]">{children}</h3>,
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
    li: ({ children }) => (
      <li className={neu ? "pl-1 text-white/86" : "pl-1 text-fg/88"}>{children}</li>
    ),
    blockquote: ({ children }) => (
      <blockquote
        className={neu ? "border-l-2 border-white/20 pl-4 italic text-white/74" : "border-l-2 border-white/20 pl-4 italic text-fg/72"}
      >
        {children}
      </blockquote>
    ),
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto rounded-xl border border-white/[0.06] bg-[#0A090E]/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <table className="min-w-full border-separate border-spacing-0 text-[length:calc(var(--chat-font-size)*12/14)]">{children}</table>
      </div>
    ),
    thead: ({ children, node: _, ...props }) => <thead className="bg-white/[0.04]" {...props}>{children}</thead>,
    tbody: ({ children, node: _, ...props }) => <tbody {...props}>{children}</tbody>,
    tr: ({ children, node: _, ...props }) => <tr className="align-top" {...props}>{children}</tr>,
    th: ({ children, node: _, ...props }) => (
      <th
        className={
          neu
            ? "break-words border-b border-white/[0.06] px-3 py-2 text-left font-medium text-white/88 first:rounded-tl-xl last:rounded-tr-xl"
            : "break-words border-b border-white/[0.06] px-3 py-2 text-left font-medium text-fg/82 first:rounded-tl-xl last:rounded-tr-xl"
        }
        {...props}
      >
        {children}
      </th>
    ),
    td: ({ children, node: _, ...props }) => (
      <td
        className={
          neu
            ? "break-words border-b border-white/[0.05] px-3 py-2 align-top text-white/82 last:border-r-0"
            : "break-words border-b border-white/[0.05] px-3 py-2 align-top text-fg/76 last:border-r-0"
        }
        {...props}
      >
        {children}
      </td>
    ),
    pre: ({ children }) => (
      <>{children}</>
    ),
    code: ({ className, children }) => {
      const text = String(children ?? "");
      const isBlock = /\n/.test(text) || (typeof className === "string" && className.length > 0);
      const workspacePath = !isBlock ? parseWorkspacePathLocation(text) : null;
      const pathIsClickable = Boolean(workspacePath && looksLikeWorkspacePath(text));
      const language = typeof className === "string"
        ? (className.match(/language-([^\s]+)/)?.[1] ?? "text")
        : "text";
      if (isBlock && language === MOSAIC_FENCE_LANGUAGE && mosaic) {
        return <MosaicCard source={text} cardKey={mosaic.cardKeyFor(text, mosaicScopeKey ?? "")} onSubmit={mosaic.onSubmit} />;
      }
      return isBlock ? (
        <HighlightedCode code={text} language={language} />
      ) : pathIsClickable ? (
        <WorkspacePathLink code neutral={neu} onOpen={() => openWorkspacePath(workspacePath!)}>
          {children}
        </WorkspacePathLink>
      ) : (
        <code
          className={
            neu
              ? "break-all whitespace-normal rounded-md border border-white/[0.1] bg-black/30 px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-white/90"
              : "break-all whitespace-normal rounded-md border border-white/[0.08] bg-black/30 px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/90"
          }
        >
          {children}
        </code>
      );
    },
    a: ({ children, href }) => {
      const workspacePath = resolveWorkspacePathFromHref(href);
      if (workspacePath) {
        return (
          <WorkspacePathLink code={false} neutral={neu} onOpen={() => openWorkspacePath(workspacePath)}>
            {children}
          </WorkspacePathLink>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            event.preventDefault();
            openUrlInAdeBrowser(href);
          }}
          className={
            neu
              ? "text-white/85 underline decoration-white/28 underline-offset-2 transition-colors hover:text-white hover:decoration-white/45"
              : "text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:text-accent/80 hover:decoration-accent/50"
          }
        >
          {children}
        </a>
      );
    },
  }), [mosaic, mosaicScopeKey, neu, openWorkspacePath]);

  return (
    <div
      className={cn(
        "ade-prose-themed prose prose-invert min-w-0 max-w-full break-words text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.8]",
        neu
          ? "text-white/92 prose-headings:text-white/95 prose-p:text-white/88 prose-li:text-white/86 prose-strong:text-white prose-blockquote:text-white/76"
          : "text-fg/96 prose-headings:text-fg prose-p:text-fg/88 prose-li:text-fg/86 prose-strong:text-fg prose-blockquote:text-fg/76",
        "prose-headings:mb-3 prose-headings:mt-6 prose-headings:font-sans prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-p:my-3 prose-p:break-words prose-ul:my-3 prose-ul:pl-5 prose-ol:my-3 prose-ol:pl-5 prose-li:my-1.5 prose-li:break-words prose-li:pl-1",
        "prose-blockquote:border-l-2 prose-blockquote:border-l-white/20 prose-blockquote:pl-4 prose-hr:my-5 prose-hr:border-white/[0.08]",
      )}
    >
      <MarkdownBody markdown={markdown} components={components} />
      {tailMarkdown ? <MarkdownBody markdown={tailMarkdown} components={components} /> : null}
    </div>
  );
});
