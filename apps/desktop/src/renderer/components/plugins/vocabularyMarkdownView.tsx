import React from "react";

import { COLORS, MONO_FONT, RADII, SANS_FONT } from "../lanes/laneDesignTokens";
import { openPluginExternalUrl } from "./pluginActionOpenUrl";
import type { VocabRenderContext } from "./vocabularyPrimitives";
import {
  parseVocabMarkdown,
  type VocabMarkdownBlock,
  type VocabMarkdownNode,
  type VocabMarkdownSpan,
} from "../../../shared/plugins/vocabulary";

/**
 * The desktop and web renderer for the `markdown` node.
 *
 * ## What it reuses, and the one thing it deliberately does not
 *
 * The parse is reused completely: `parseVocabMarkdown` in `shared/plugins` is
 * the subset, and this file only decides what a heading looks like. The web
 * client renders through this same component, so "desktop and web" is one
 * implementation rather than a promise about two.
 *
 * What it does NOT reuse is the transcript's `react-markdown` pipeline. That was
 * the obvious candidate — the app already ships `react-markdown`, `remark-gfm`
 * and a `rehype-sanitize` schema — and it is the wrong tool here for the reason
 * written at the top of `vocabularyComponents.tsx`, twice over:
 *
 * 1. **It would define a second subset.** remark-gfm autolinks bare URLs and
 *    draws tables; Apple's parser does neither and a terminal has no concept of
 *    either. A panel would then render one document three ways, which is the
 *    exact failure the vocabulary exists to prevent.
 * 2. **Its output is styled by the transcript.** `chatMarkdown` and
 *    `HighlightedCode` resolve `--chat-code-bg`, `--chat-font-size` and
 *    `--chat-accent`, which the chat surface sets inline on its own root. Inside
 *    a plugin panel those variables do not exist and the markup renders
 *    unstyled — the same trap that kept `chatCardPrimitives` out of this folder.
 *
 * So the colours here come from `laneDesignTokens` like every other panel leaf,
 * and there is no `dangerouslySetInnerHTML` anywhere in the file: a span carries
 * text and boolean flags, and React escapes the text. A `<script>` in an issue
 * body is characters on the screen.
 */

const HEADING_STYLE: Record<number, React.CSSProperties> = {
  1: { fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em", color: COLORS.textPrimary },
  2: { fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em", color: COLORS.textPrimary },
  3: { fontSize: 12.5, fontWeight: 600, color: COLORS.textPrimary },
  4: { fontSize: 12, fontWeight: 600, color: COLORS.textSecondary },
  5: { fontSize: 12, fontWeight: 600, color: COLORS.textSecondary },
  6: { fontSize: 11.5, fontWeight: 600, color: COLORS.textMuted },
};

const BODY_STYLE: React.CSSProperties = {
  margin: 0,
  fontFamily: SANS_FONT,
  fontSize: 12,
  lineHeight: 1.55,
  color: COLORS.textSecondary,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

/** One inline run. Flags nest as elements; the text itself is never markup. */
function MarkdownSpan({ span, pluginId }: { span: VocabMarkdownSpan; pluginId: string }) {
  let content: React.ReactNode = span.text;

  if (span.code) {
    content = (
      <code
        style={{
          fontFamily: MONO_FONT,
          fontSize: 11,
          padding: "1px 4px",
          borderRadius: RADII.sm,
          background: COLORS.recessedBg,
          color: COLORS.textPrimary,
        }}
      >
        {content}
      </code>
    );
  }
  if (span.strike) content = <s>{content}</s>;
  if (span.italic) content = <em>{content}</em>;
  if (span.bold) content = <strong style={{ fontWeight: 600, color: COLORS.textPrimary }}>{content}</strong>;

  if (span.href === undefined) return <>{content}</>;

  const href = span.href;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: COLORS.accent, textDecoration: "underline", textUnderlineOffset: 2 }}
      onClick={(event) => {
        // The href is here for the affordance — hover preview, copy link — and
        // never for the navigation: a real navigation would move the whole
        // renderer to a plugin's page. Every open goes out through the same
        // function the `{openUrl}` action verb uses.
        event.preventDefault();
        openPluginExternalUrl(href, { pluginId, source: "markdown" });
      }}
      onAuxClick={(event) => {
        event.preventDefault();
        openPluginExternalUrl(href, { pluginId, source: "markdown" });
      }}
    >
      {content}
    </a>
  );
}

function MarkdownSpans({ spans, pluginId }: { spans: readonly VocabMarkdownSpan[]; pluginId: string }) {
  return (
    <>
      {spans.map((span, index) => (
        <MarkdownSpan key={index} span={span} pluginId={pluginId} />
      ))}
    </>
  );
}

/**
 * A task-list box, drawn and never pressable.
 *
 * A `<span>` rather than a disabled `<input type="checkbox">`: a disabled input
 * is still a control in the accessibility tree, and this is a picture of what
 * the source document says, not a control the panel forgot to wire. The plugin
 * declared no action for it, so a reader who could press it would change nothing
 * and be told nothing.
 */
function TaskBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 11,
        height: 11,
        marginRight: 6,
        marginBottom: -1,
        borderRadius: 3,
        border: `1px solid ${checked ? COLORS.accent : COLORS.borderMuted}`,
        background: checked ? COLORS.accent : "transparent",
        color: COLORS.recessedBg,
        fontSize: 9,
        lineHeight: "10px",
        textAlign: "center",
      }}
    >
      {checked ? "✓" : ""}
    </span>
  );
}

function MarkdownBlocks({
  blocks,
  pluginId,
}: {
  blocks: readonly VocabMarkdownBlock[];
  pluginId: string;
}) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading": {
            const Tag = `h${block.level}` as "h1";
            return (
              <Tag
                key={index}
                style={{ margin: 0, fontFamily: SANS_FONT, ...HEADING_STYLE[block.level] }}
              >
                <MarkdownSpans spans={block.spans} pluginId={pluginId} />
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={index} style={BODY_STYLE}>
                <MarkdownSpans spans={block.spans} pluginId={pluginId} />
              </p>
            );
          case "code":
            return (
              <pre
                key={index}
                style={{
                  margin: 0,
                  padding: "8px 10px",
                  background: COLORS.recessedBg,
                  border: `1px solid ${COLORS.borderMuted}`,
                  borderRadius: RADII.md,
                  overflowX: "auto",
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: COLORS.textPrimary,
                }}
              >
                <code {...(block.language ? { "data-language": block.language } : {})}>
                  {block.text}
                </code>
              </pre>
            );
          case "quote":
            return (
              <blockquote
                key={index}
                style={{
                  margin: 0,
                  paddingLeft: 10,
                  borderLeft: `2px solid ${COLORS.borderMuted}`,
                  display: "grid",
                  gap: 6,
                }}
              >
                <MarkdownBlocks blocks={block.blocks} pluginId={pluginId} />
              </blockquote>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag
                key={index}
                {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  display: "grid",
                  gap: 4,
                  ...BODY_STYLE,
                  whiteSpace: "normal",
                  // A task list draws its own boxes, so the bullets would be a
                  // second marker saying nothing.
                  ...(block.items.some((item) => item.task !== undefined)
                    ? { listStyle: "none", paddingLeft: 2 }
                    : {}),
                }}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    {item.task !== undefined ? <TaskBox checked={item.task === "checked"} /> : null}
                    <MarkdownBlocks blocks={item.blocks} pluginId={pluginId} />
                  </li>
                ))}
              </Tag>
            );
          }
          case "rule":
            return (
              <hr
                key={index}
                style={{ margin: 0, border: "none", borderTop: `1px solid ${COLORS.borderMuted}` }}
              />
            );
        }
        return null;
      })}
    </>
  );
}

/** The dim line that says a document did not fit. Never a silent stop. */
function TruncationNote({ text }: { text: string }) {
  return (
    <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>{text}</p>
  );
}

export function VocabMarkdown({
  node,
  context,
}: {
  node: VocabMarkdownNode;
  context: VocabRenderContext;
}) {
  // The parse is memoized on the source, not on the node: the host hands back a
  // fresh record on every poll, and re-parsing 4 KB of prose several times a
  // minute for an unchanged document is work nobody asked for.
  const document = React.useMemo(
    () => (node.truncated ? null : parseVocabMarkdown(node.text)),
    [node.text, node.truncated],
  );

  if (document === null) {
    // Clamped at the node ceiling: the cut lands wherever it lands, regularly
    // inside a fence or a link, so the markdown of this string is not the
    // document's markdown. The source, plainly, plus a line saying why.
    return (
      <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
        <p style={{ ...BODY_STYLE, fontFamily: MONO_FONT, fontSize: 11 }}>{node.text}</p>
        <TruncationNote text="This text was too long to format, so it is shown as written." />
      </div>
    );
  }

  if (document.blocks.length === 0) return null;

  return (
    <div
      data-tour={`plugin:${context.pluginId}.markdown`}
      style={{ display: "grid", gap: 8, minWidth: 0 }}
    >
      <MarkdownBlocks blocks={document.blocks} pluginId={context.pluginId} />
      {document.truncated ? <TruncationNote text="The rest of this text is not shown." /> : null}
    </div>
  );
}
