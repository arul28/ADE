import React, { useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkCachedParse } from "./remarkCachedParse";
import { FileCode } from "@phosphor-icons/react";

import { MOSAIC_FENCE_LANGUAGE } from "../../../shared/chatMosaic";
import { openFence, SCENE_FENCE_LANGUAGE, sceneScopeKeyFor } from "../../../shared/chatScene";
import { MermaidDiagram } from "../shared/MermaidDiagram";
import {
  parseProofCitationUrl,
  parseProofCompareBlock,
  PROOF_COMPARE_FENCE_LANGUAGE,
} from "../../../shared/proofCitation";
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
import { ProofCitationFigure, ProofCompareFigure } from "./ChatProofCitation";
import { SceneFrame } from "./SceneFrame";
import { TranscriptChip } from "./ChipText";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { useChatLinkContextMenu } from "./useChatLinkContextMenu";
import { chipFromDeeplinkTarget } from "../../../shared/chips";
import { parseDeeplink } from "../../../shared/deeplinks";
import {
  remarkThreadEntities,
  ThreadEntityNode,
  THREAD_ENTITY_TAG,
  useThreadEntityLookup,
} from "./threadEntities";

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

// File links read as code that happens to be clickable: a quiet tint, the
// file glyph, and an underline only on hover. A border plus an underline plus
// a glyph on every path made a dense paragraph look like a form.
const PATH_LINK_BASE =
  "inline-flex max-w-full cursor-pointer items-baseline gap-1 whitespace-normal [overflow-wrap:anywhere] rounded-md align-baseline"
  + " decoration-1 underline-offset-[3px] transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1";
const PATH_LINK_TONE = {
  neutral: "bg-(color:--chat-ink)/[0.06] text-(color:--chat-ink)/88 decoration-(color:--chat-ink)/40 hover:bg-(color:--chat-ink)/[0.1] hover:text-(color:--chat-ink) focus-visible:ring-(color:--chat-ink)/30",
  accent: "bg-sky-400/[0.08] text-sky-200/95 decoration-sky-300/45 hover:bg-sky-400/[0.14] hover:text-sky-100 focus-visible:ring-sky-300/40",
} as const;

function WorkspacePathLink({
  children,
  code,
  neutral,
  onOpen,
  lineRef = false,
  title = "Open file in Files",
}: {
  children: React.ReactNode;
  code: boolean;
  neutral: boolean;
  onOpen: () => void;
  /** A bare `3461-3468` that refers back to the file before it: no glyph, tighter. */
  lineRef?: boolean;
  title?: string;
}) {
  const content = lineRef ? (
    <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
  ) : (
    <>
      <FileCode size={12} aria-hidden className="shrink-0 self-center opacity-75" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </>
  );
  const className = cn(
    PATH_LINK_BASE,
    PATH_LINK_TONE[neutral ? "neutral" : "accent"],
    code || lineRef
      ? "px-1.5 py-px font-mono text-[length:calc(var(--chat-font-size)*11/14)]"
      : "px-1.5 py-px text-left font-sans text-[length:calc(var(--chat-font-size)*12/14)]",
    lineRef && "px-1",
  );

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
      title={title}
    >
      {content}
    </span>
  ) : (
    <button type="button" className={className} onClick={onOpen} title={title}>
      {content}
    </button>
  );
}

/* ── Markdown renderer ── */

type MarkdownComponents = React.ComponentProps<typeof ReactMarkdown>["components"];

/** A hast node, as react-markdown hands it to a component override. */
type MarkdownNode = { type?: string; tagName?: string; properties?: Record<string, unknown>; children?: MarkdownNode[] };

/**
 * True when a paragraph holds an `ade-proof://` image. The proof figure is
 * block content, and a paragraph cannot contain it.
 */
function paragraphHasProofCitation(node: MarkdownNode | undefined): boolean {
  return (node?.children ?? []).some((child) =>
    child.type === "element"
    && child.tagName === "img"
    && parseProofCitationUrl(typeof child.properties?.src === "string" ? child.properties.src : null) !== null);
}

/** The workspace file a code span names, or null. One rule for file chips and line follow-ups. */
function workspaceFilePathOf(code: string): string | null {
  if (/\n/.test(code) || !looksLikeWorkspacePath(code)) return null;
  return parseWorkspacePathLocation(code)?.path ?? null;
}

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
  remarkPlugins,
}: {
  markdown: string;
  components: MarkdownComponents;
  remarkPlugins: React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"];
}) {
  if (markdown.length === 0) return null;
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
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
  sceneScopeKey,
  sceneLive,
  tone,
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
  /**
   * What names the ROW a scene in this body belongs to, on disk.
   *
   * Separate from `mosaicScopeKey` because the two need different things from
   * a key. Mosaic answers live in this window and die with it, so the render
   * key is fine; a scene's still is a file in the project, looked up again on
   * every reopen, and the render key moves when the transcript is rebuilt from
   * a different window of events. See `sceneRowIdentity`.
   *
   * Absent means this body's scenes leave no picture behind — the honest answer
   * for a caller with no row identity. It is never the mosaic key: the two
   * would be silently interchangeable, and one of them is wrong on disk.
   */
  sceneScopeKey?: string;
  /**
   * True while the turn that produced this body is still streaming. A scene
   * runs only while its own turn is live; afterwards it is snapshotted so
   * scrollback never re-executes generated code.
   */
  sceneLive?: boolean;
  /**
   * `thought`: reasoning text (Thought rows, the live thinking block). Smaller
   * and muted, and a thematic break draws as a paragraph gap rather than a
   * rule: reasoning fragments are joined with `---`
   * (`mergeReasoningTextFragments`), and a full-width rule between each one
   * read as a divider instead of one continuous thought.
   *
   * `bubble`: a markdown brief inside the user's message bubble. Always the
   * neutral white palette (the bubble is the accent colour), body-sized.
   */
  tone?: "thought" | "bubble";
}) {
  const thought = tone === "thought";
  const bubble = tone === "bubble";
  // This component knows both halves of "still arriving", so it answers the
  // question once instead of handing the frame two flags to combine. Fence
  // state is read over the WHOLE body — settled prose plus the growing tail —
  // so a fence that opens in one and closes in the other is read as one fence.
  // Every scene in the body is held while the last one is open; a message with
  // two scenes mounts both a tick later rather than mounting one against a
  // document that is still arriving.
  const openTail = sceneLive ? openFence(tailMarkdown ? `${markdown}${tailMarkdown}` : markdown) : null;
  const sceneStreaming = openTail?.language === SCENE_FENCE_LANGUAGE;
  // A mermaid fence still arriving is shown as its source: half a diagram
  // either fails to parse or draws the wrong graph. Only that fence holds;
  // the diagrams above it, already closed, stay drawn.
  const streamingMermaidBody = openTail?.language === "mermaid" ? openTail.body.trimEnd() : null;
  const chromeTint = useChatChromeTint();
  const neu = bubble || chromeTint === "neutral";
  const openWorkspacePath = useCallback((path: WorkspacePathLocation) => {
    onOpenWorkspacePath?.(path);
  }, [onOpenWorkspacePath]);
  // A `localhost` link in this reply means the chat's machine.
  const runtimePin = useChatRuntimeScope().pin;
  // Right-click on a link: copy it, or send it to a browser of your choosing.
  const { onContextMenu: onLinkContextMenu, menu: linkContextMenu } = useChatLinkContextMenu(runtimePin);
  // Lanes, chats, models and the rest that this reply names. The lookup only
  // changes identity when an id or name changes, so settled bodies stay memoized.
  const entityLookup = useThreadEntityLookup();
  const remarkPlugins = useMemo(
    () => [remarkCachedParse, remarkGfm, [remarkThreadEntities, { lookup: entityLookup, filePathOf: workspaceFilePathOf }]] as React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"],
    [entityLookup],
  );

  const components: MarkdownComponents = useMemo(() => ({
    ...(thought
      ? { hr: () => <div aria-hidden data-thought-fragment-gap="" className="h-[0.6lh]" /> }
      : {}),
    p: ({ children, node }) => (
      paragraphHasProofCitation(node as MarkdownNode | undefined)
        ? <div data-proof-citation-paragraph="" className="my-3">{children}</div>
        : <p>{children}</p>
    ),
    img: ({ src, alt }) => {
      const artifactId = parseProofCitationUrl(typeof src === "string" ? src : null);
      if (artifactId) return <ProofCitationFigure artifactId={artifactId} caption={alt ?? null} />;
      return <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} />;
    },
    // Sized from the chat font, not the root font, and spaced here rather than
    // by `prose-headings:*`: a section heading must read as one at every chat
    // font size, and must never sit flush against the paragraph above it.
    h1: ({ children }) => (
      <h1 className="mb-2.5 mt-7 font-sans text-[length:calc(var(--chat-font-size)*17/14)] font-semibold leading-snug tracking-[-0.015em] first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 mt-6 font-sans text-[length:calc(var(--chat-font-size)*15.5/14)] font-semibold leading-snug tracking-[-0.012em] first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-1.5 mt-5 font-sans text-[length:calc(var(--chat-font-size)*14.5/14)] font-semibold leading-snug first:mt-0">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-1.5 mt-4 font-sans text-[length:calc(var(--chat-font-size)*13.5/14)] font-semibold leading-snug first:mt-0">{children}</h4>
    ),
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
    li: ({ children }) => (
      <li className={neu ? "pl-1 text-(color:--chat-ink)/86" : "pl-1 text-fg/88"}>{children}</li>
    ),
    blockquote: ({ children }) => (
      <blockquote
        className={neu ? "border-l-2 border-(color:--chat-ink)/20 pl-4 italic text-(color:--chat-ink)/74" : "border-l-2 border-(color:--chat-ink)/20 pl-4 italic text-fg/72"}
      >
        {children}
      </blockquote>
    ),
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto rounded-xl border border-(color:--chat-ink)/[0.06] bg-(color:--chat-table-bg) shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <table className="min-w-full border-separate border-spacing-0 text-[length:calc(var(--chat-font-size)*12/14)]">{children}</table>
      </div>
    ),
    thead: ({ children, node: _, ...props }) => <thead className="bg-(color:--chat-ink)/[0.04]" {...props}>{children}</thead>,
    tbody: ({ children, node: _, ...props }) => <tbody {...props}>{children}</tbody>,
    tr: ({ children, node: _, ...props }) => <tr className="align-top" {...props}>{children}</tr>,
    th: ({ children, node: _, ...props }) => (
      <th
        className={
          neu
            ? "break-words border-b border-(color:--chat-ink)/[0.06] px-3 py-2 text-left font-medium text-(color:--chat-ink)/88 first:rounded-tl-xl last:rounded-tr-xl"
            : "break-words border-b border-(color:--chat-ink)/[0.06] px-3 py-2 text-left font-medium text-fg/82 first:rounded-tl-xl last:rounded-tr-xl"
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
            ? "break-words border-b border-(color:--chat-ink)/[0.05] px-3 py-2 align-top text-(color:--chat-ink)/82 last:border-r-0"
            : "break-words border-b border-(color:--chat-ink)/[0.05] px-3 py-2 align-top text-fg/76 last:border-r-0"
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
      if (isBlock && language === PROOF_COMPARE_FENCE_LANGUAGE) {
        const block = parseProofCompareBlock(text);
        // A block that names no pair renders as the code it is.
        if (block) return <ProofCompareFigure block={block} />;
      }
      // Scenes are not gated on a render context: any agent may draw, and the
      // sandbox rather than the caller is what makes that safe.
      if (isBlock && language === SCENE_FENCE_LANGUAGE) {
        // Per FENCE, not per row: two scenes in one message are two pictures,
        // and a shared key made them overwrite each other's still.
        return (
          <SceneFrame
            source={text}
            scopeKey={sceneScopeKey ? sceneScopeKeyFor(sceneScopeKey, text) : null}
            live={sceneLive}
            streaming={sceneStreaming}
          />
        );
      }
      // Replies draw their diagrams; a fence in the user's own message stays the
      // source they wrote (and a diagram has no background that suits the
      // accent bubble). Tool calls render elsewhere and are untouched.
      if (isBlock && language === "mermaid" && !bubble && text.trimEnd() !== streamingMermaidBody) {
        return (
          <MermaidDiagram
            source={text}
            variant="chat"
            renderCode={(code) => <HighlightedCode code={code} language="mermaid" />}
          />
        );
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
              // Wrap at the token, not inside it: `break-all` split identifiers
              // mid-word ("technic|alDetail"). `anywhere` breaks only a token
              // too long for a line of its own.
              ? "whitespace-normal [overflow-wrap:anywhere] rounded-md border border-(color:--chat-ink)/[0.1] bg-(color:--chat-inline-code-bg) px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-(color:--chat-ink)/90"
              : "whitespace-normal [overflow-wrap:anywhere] rounded-md border border-(color:--chat-ink)/[0.08] bg-(color:--chat-inline-code-bg) px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/90"
          }
        >
          {children}
        </code>
      );
    },
    [THREAD_ENTITY_TAG]: ({ node, children }: { node?: unknown; children?: React.ReactNode }) => (
      <ThreadEntityNode
        node={node}
        fallback={children}
        renderFileLine={(entity) => (
          <WorkspacePathLink
            code
            lineRef
            neutral={neu}
            title={`Open ${entity.path.split("/").pop() ?? entity.path} at line ${entity.line}`}
            onOpen={() => openWorkspacePath({ path: entity.path, startLine: entity.line })}
          >
            {entity.raw}
          </WorkspacePathLink>
        )}
      />
    ),
    a: ({ children, href }) => {
      // An `ade://` link is a typed pointer (a lane, a PR, a chat). Draw it as
      // the same chip the composer and the sent bubble use.
      const deeplink = typeof href === "string" ? parseDeeplink(href) : null;
      if (deeplink?.ok && typeof href === "string") {
        return <TranscriptChip chip={chipFromDeeplinkTarget(href, deeplink.target)} />;
      }
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
            openUrlInAdeBrowser(href, { runtimePin });
          }}
          onContextMenu={(event) => onLinkContextMenu(event, href)}
          className={
            neu
              ? "text-(color:--chat-ink)/85 underline decoration-(color:--chat-ink)/28 underline-offset-2 transition-colors hover:text-(color:--chat-ink) hover:decoration-(color:--chat-ink)/45"
              : "text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:text-accent/80 hover:decoration-accent/50"
          }
        >
          {children}
        </a>
      );
    },
  }), [mosaic, mosaicScopeKey, sceneScopeKey, neu, openWorkspacePath, runtimePin, sceneLive, sceneStreaming, streamingMermaidBody, bubble, thought, onLinkContextMenu]);

  return (
    <div
      className={cn(
        "ade-prose-themed prose prose-invert min-w-0 max-w-full break-words",
        thought
          ? "ade-thought-text text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.65]"
          : bubble
            ? "ade-bubble-prose text-[length:var(--chat-font-size)] leading-[1.7]"
            : "text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.8]",
        neu
          ? "text-(color:--chat-ink)/92 prose-headings:text-(color:--chat-ink)/95 prose-p:text-(color:--chat-ink)/88 prose-li:text-(color:--chat-ink)/86 prose-strong:text-(color:--chat-ink) prose-blockquote:text-(color:--chat-ink)/76"
          : "text-fg/96 prose-headings:text-fg prose-p:text-fg/88 prose-li:text-fg/86 prose-strong:text-fg prose-blockquote:text-fg/76",
        "prose-headings:mb-3 prose-headings:mt-6 prose-headings:font-sans prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-p:my-3 prose-p:break-words prose-ul:my-3 prose-ul:pl-5 prose-ol:my-3 prose-ol:pl-5 prose-li:my-1.5 prose-li:break-words prose-li:pl-1",
        "prose-blockquote:border-l-2 prose-blockquote:border-l-(color:--chat-ink)/20 prose-blockquote:pl-4 prose-hr:my-5 prose-hr:border-(color:--chat-ink)/[0.08]",
      )}
    >
      <MarkdownBody markdown={markdown} components={components} remarkPlugins={remarkPlugins} />
      {tailMarkdown ? <MarkdownBody markdown={tailMarkdown} components={components} remarkPlugins={remarkPlugins} /> : null}
      {linkContextMenu}
    </div>
  );
});
