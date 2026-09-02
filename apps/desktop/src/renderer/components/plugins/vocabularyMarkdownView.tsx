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

/**
 * A markdown image, with the affordance that survives a refused load.
 *
 * A markdown image is the one picture in a panel whose URL the plugin did not
 * author: it comes from a remote document body — an issue, a comment thread —
 * and points at whatever host that tracker stores attachments on. The two
 * clients that share this file do not agree about loading it. The hosted web
 * client's policy admits `https:` for plugin media on purpose (see its
 * `_headers`), while the desktop renderer's `img-src` is a scoped allowlist
 * with an explicit "no blanket `https:`" rule — and that rule is not an
 * oversight to be relaxed here: the desktop renderer is a privileged document,
 * and a blanket image allowance would let a panel turn any URL into an
 * outbound request the plugin's declared `network.hosts` never authorised.
 *
 * So the load is attempted and the FAILURE is designed, rather than the load
 * being refused up front on one client. Where the picture can be fetched it is
 * drawn; where it cannot — a refused policy, a dead link, a host that answers
 * with something that is not an image — the reader gets the alt text as a link
 * that opens the picture in their browser, which is the one place the request
 * is not ADE's to make. Both clients run this same rule, so neither shows a
 * broken frame and neither silently drops the picture.
 *
 * Mirrors the avatar fallback in `vocabularyComponents.tsx`, which learned the
 * same lesson about a remote `src` in a panel.
 */
function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => { setFailed(false); }, [src]);
  if (failed) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          verticalAlign: "middle",
          fontSize: 11.5,
          color: COLORS.textMuted,
        }}
      >
        {alt.trim() || "Image"}
        <span aria-hidden="true">↗</span>
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{
        display: "inline-block",
        maxWidth: "100%",
        maxHeight: 280,
        verticalAlign: "middle",
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: RADII.md,
      }}
    />
  );
}

/** One inline run. Flags nest as elements; the text itself is never markup. */
function MarkdownSpan({ span, pluginId }: { span: VocabMarkdownSpan; pluginId: string }) {
  if (span.src !== undefined) {
    const src = /^https:/i.test(span.src) ? span.src : undefined;
    const image = src ? <MarkdownImage src={src} alt={span.text} /> : <>{span.text}</>;
    // An image with no link of its own still needs somewhere to go when the
    // load is refused, so the picture's own URL becomes that link. `href` wins
    // when the document named one — that is the destination the author chose.
    if (span.href === undefined && src) {
      return (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            event.preventDefault();
            openPluginExternalUrl(src, { pluginId, source: "markdown" });
          }}
          onAuxClick={(event) => {
            event.preventDefault();
            openPluginExternalUrl(src, { pluginId, source: "markdown" });
          }}
        >
          {image}
        </a>
      );
    }
    if (span.href === undefined) return image;
    const href = span.href;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          openPluginExternalUrl(href, { pluginId, source: "markdown" });
        }}
        onAuxClick={(event) => {
          event.preventDefault();
          openPluginExternalUrl(href, { pluginId, source: "markdown" });
        }}
      >
        {image}
      </a>
    );
  }

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
          case "table": {
            const alignCss = (value: (typeof block.align)[number] | undefined): React.CSSProperties["textAlign"] => {
              if (value === "center") return "center";
              if (value === "right") return "right";
              return "left";
            };
            const cellStyle = (column: number, header: boolean): React.CSSProperties => ({
              padding: "4px 8px",
              textAlign: alignCss(block.align[column]),
              fontFamily: SANS_FONT,
              fontSize: header ? 11 : 12,
              fontWeight: header ? 600 : 400,
              color: header ? COLORS.textPrimary : COLORS.textSecondary,
              borderBottom: `1px solid ${COLORS.borderMuted}`,
              verticalAlign: "top",
            });
            return (
              <div key={index} style={{ overflowX: "auto", minWidth: 0 }}>
                <table
                  style={{
                    borderCollapse: "collapse",
                    width: "100%",
                    fontFamily: SANS_FONT,
                    fontSize: 12,
                  }}
                >
                  <thead>
                    <tr>
                      {block.header.map((cell, column) => (
                        <th key={column} style={cellStyle(column, true)}>
                          <MarkdownSpans spans={cell} pluginId={pluginId} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, column) => (
                          <td key={column} style={cellStyle(column, false)}>
                            <MarkdownSpans spans={cell} pluginId={pluginId} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          default: {
            const _exhaustive: never = block;
            void _exhaustive;
            return null;
          }
        }
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
  compact = false,
}: {
  node: VocabMarkdownNode;
  context: VocabRenderContext;
  /** Tighter spacing for a list row's body. */
  compact?: boolean;
}) {
  // The parse is memoized on the source, not on the node: the host hands back a
  // fresh record on every poll, and re-parsing 16 KB of prose several times a
  // minute for an unchanged document is work nobody asked for.
  const document = React.useMemo(
    () => parseVocabMarkdown(node.text),
    [node.text],
  );

  if (document.blocks.length === 0 && !node.truncated) return null;

  return (
    <div
      data-tour={`plugin:${context.pluginId}.markdown`}
      style={{ display: "grid", gap: compact ? 4 : 8, minWidth: 0 }}
    >
      {document.blocks.length > 0 ? (
        <MarkdownBlocks blocks={document.blocks} pluginId={context.pluginId} />
      ) : null}
      {node.truncated || document.truncated ? (
        <TruncationNote text="The rest of this text is not shown." />
      ) : null}
    </div>
  );
}
