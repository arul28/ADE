import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { findAndReplace } from "mdast-util-find-and-replace";
import type { Root } from "mdast";
import { CaretRight, ArrowSquareOut } from "@phosphor-icons/react";

import {
  buildChatMarkdownComponents,
  SAFE_PREVIEW_SCHEMA,
} from "../../chat/chatMarkdown";
import { HighlightedCode } from "../../chat/CodeHighlighter";
import { COLORS } from "../../lanes/laneDesignTokens";

type PrMarkdownTone = "neutral" | "sky" | "amber";

export type PrMarkdownProps = {
  children: string;
  repoOwner: string;
  repoName: string;
  tone?: PrMarkdownTone;
  dense?: boolean;
};

/* ── Extended sanitization schema ──────────────────────────────────── */

const PR_SAFE_SCHEMA = (() => {
  const baseTagNames = SAFE_PREVIEW_SCHEMA.tagNames ?? defaultSchema.tagNames ?? [];
  const baseAttributes = {
    ...(defaultSchema.attributes ?? {}),
    ...(SAFE_PREVIEW_SCHEMA.attributes ?? {}),
  };

  return {
    ...SAFE_PREVIEW_SCHEMA,
    tagNames: Array.from(
      new Set([
        ...baseTagNames,
        "details",
        "summary",
        "img",
        "input",
        "del",
        "span",
        "div",
      ]),
    ),
    attributes: {
      ...baseAttributes,
      a: [...(baseAttributes.a ?? []), "href", "title"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      input: [
        ["type", "checkbox"],
        ["disabled", true],
        ["checked", true],
        "checked",
        "disabled",
      ],
      details: ["open"],
      summary: [],
      code: [...(baseAttributes.code ?? []), ["className", /^language-/]],
      span: [["className", /^pr-md-/]],
      div: [["className", /^pr-md-/]],
      th: [...(baseAttributes.th ?? []), "align"],
      td: [...(baseAttributes.td ?? []), "align"],
    },
    protocols: {
      ...(defaultSchema.protocols ?? {}),
      href: ["http", "https", "mailto"],
      src: ["http", "https", "data"],
    },
  } as typeof SAFE_PREVIEW_SCHEMA;
})();

/* ── Remark plugin: autolink #123 and @user ────────────────────────── */

function remarkPrAutolinks({
  repoOwner,
  repoName,
}: {
  repoOwner: string;
  repoName: string;
}) {
  return (tree: Root) => {
    findAndReplace(
      tree,
      [
        [
          /(^|[\s(\[{>])#(\d+)\b/g,
          (_full: string, prefix: string, num: string) =>
            [
              { type: "text", value: prefix },
              {
                type: "link",
                url: `https://github.com/${repoOwner}/${repoName}/pull/${num}`,
                children: [{ type: "text", value: `#${num}` }],
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ] as any,
        ],
        [
          /(^|[\s(\[{>])@([A-Za-z0-9][A-Za-z0-9-]{0,38})\b/g,
          (_full: string, prefix: string, user: string) =>
            [
              { type: "text", value: prefix },
              {
                type: "link",
                url: `https://github.com/${user}`,
                children: [{ type: "text", value: `@${user}` }],
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ] as any,
        ],
      ],
      { ignore: ["link", "linkReference", "code", "inlineCode"] },
    );
  };
}

/* ── <details>/<summary> accordion ─────────────────────────────────── */

function PrSummaryMarker(props: { children?: ReactNode }) {
  return <>{props.children}</>;
}
PrSummaryMarker.displayName = "PrSummaryMarker";

function isSummaryElement(node: unknown): node is { props: { children?: ReactNode } } {
  if (!node || typeof node !== "object") return false;
  const type = (node as { type?: unknown }).type;
  if (type === PrSummaryMarker) return true;
  // React-markdown wraps component overrides in an anonymous arrow that
  // forwards props — detect by the display name attached to that arrow.
  if (typeof type === "function" && (type as { displayName?: string }).displayName === "PrSummaryMarker") {
    return true;
  }
  return false;
}

function PrDetails({
  open: openProp,
  children,
}: {
  open?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(!!openProp);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);

  const childArray = Array.isArray(children) ? children : [children];
  let summaryNode: ReactNode = null;
  const rest: ReactNode[] = [];
  for (const child of childArray) {
    if (
      summaryNode === null &&
      isSummaryElement(child)
    ) {
      summaryNode = (child as { props: { children?: ReactNode } }).props.children;
      continue;
    }
    if (typeof child === "string" && child.trim() === "") {
      // Drop whitespace-only text nodes between <details> and <summary>.
      continue;
    }
    rest.push(child);
  }

  useEffect(() => {
    if (!bodyRef.current) return;
    const next = bodyRef.current.scrollHeight;
    setBodyHeight(next);
  }, [open, children]);

  const onToggle = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      setOpen((prev) => !prev);
    },
    [],
  );

  return (
    <div
      className="pr-md-details mb-3 overflow-hidden rounded-[8px] border last:mb-0"
      style={{ borderColor: COLORS.border, background: COLORS.recessedBg }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium transition-colors hover:bg-white/[0.04]"
        style={{ color: COLORS.textPrimary }}
      >
        <CaretRight
          size={12}
          weight="bold"
          className="shrink-0 transition-transform"
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            color: COLORS.textSecondary,
          }}
        />
        <span className="min-w-0 flex-1 truncate">{summaryNode ?? "Details"}</span>
      </button>
      <div
        aria-hidden={!open}
        style={{
          height: open ? bodyHeight ?? "auto" : 0,
          transition: "height 160ms ease-out",
        }}
      >
        <div ref={bodyRef} className="border-t px-3 py-2" style={{ borderColor: COLORS.border }}>
          {rest}
        </div>
      </div>
    </div>
  );
}

/* ── External-link handling ────────────────────────────────────────── */

function openExternalUrl(url: string | undefined) {
  if (!url) return;
  const bridge = typeof window !== "undefined" ? window.ade?.app?.openExternal : undefined;
  if (bridge) {
    void bridge(url).catch(() => {});
  }
}

/* ── Image with click-to-open ──────────────────────────────────────── */

function PrImage({
  src,
  alt,
  title,
}: {
  src?: string;
  alt?: string;
  title?: string;
}) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLImageElement>) => {
      event.preventDefault();
      openExternalUrl(src);
    },
    [src],
  );
  if (!src) return null;
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <img
      src={src}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
      onClick={handleClick}
      className="my-2 block max-w-full cursor-zoom-in rounded-[6px] border"
      style={{ borderColor: COLORS.border, maxHeight: 520 }}
    />
  );
}

/* ── Link with external-open handling ─────────────────────────────── */

type LinkFlavor = "default" | "pr" | "mention";

function classifyLink(
  href: string | undefined,
  children: ReactNode,
  repoOwner: string,
  repoName: string,
): LinkFlavor {
  if (!href) return "default";
  const text = extractLinkText(children);
  if (
    text.startsWith("#") &&
    href.includes(`/${repoOwner}/${repoName}/pull/`)
  ) {
    return "pr";
  }
  if (text.startsWith("@") && /^https:\/\/github\.com\/[^/]+\/?$/.test(href)) {
    return "mention";
  }
  return "default";
}

function extractLinkText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractLinkText).join("");
  if (node && typeof node === "object" && "props" in (node as object)) {
    const props = (node as { props: { children?: ReactNode } }).props;
    return extractLinkText(props?.children);
  }
  return "";
}

function PrLink({
  href,
  children,
  repoOwner,
  repoName,
}: {
  href?: string;
  children?: ReactNode;
  repoOwner: string;
  repoName: string;
}) {
  const flavor = classifyLink(href, children, repoOwner, repoName);
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      openExternalUrl(href);
    },
    [href],
  );

  if (flavor === "pr" || flavor === "mention") {
    return (
      <a
        href={href}
        onClick={handleClick}
        className="rounded-[4px] px-[3px] transition-colors"
        style={{
          color: COLORS.accent,
          background: COLORS.accentSubtle,
          textDecoration: "none",
        }}
        data-pr-link-kind={flavor}
      >
        {children}
      </a>
    );
  }

  return (
    <a
      href={href}
      onClick={handleClick}
      className="inline-flex items-center gap-0.5 underline underline-offset-2 transition-colors"
      style={{ color: COLORS.textPrimary }}
    >
      {children}
      <ArrowSquareOut size={10} weight="regular" style={{ color: COLORS.textMuted }} />
    </a>
  );
}

/* ── Task-list checkbox ────────────────────────────────────────────── */

function PrTaskCheckbox({ checked }: { checked?: boolean }) {
  return (
    <input
      type="checkbox"
      checked={!!checked}
      readOnly
      disabled
      aria-readonly
      className="pr-md-task-checkbox relative mr-1.5 inline-block h-[12px] w-[12px] shrink-0 appearance-none rounded-[3px] border align-middle"
      style={{
        borderColor: checked ? COLORS.accent : COLORS.outlineBorder,
        background: checked ? COLORS.accent : "transparent",
        cursor: "default",
      }}
    />
  );
}

/* ── Component overrides ───────────────────────────────────────────── */

function toneAccent(tone: PrMarkdownTone): string {
  switch (tone) {
    case "amber":
      return COLORS.warning;
    case "sky":
      return COLORS.info;
    default:
      return COLORS.textSecondary;
  }
}

function buildPrOverrides({
  tone,
  dense,
  repoOwner,
  repoName,
}: {
  tone: PrMarkdownTone;
  dense: boolean;
  repoOwner: string;
  repoName: string;
}): Partial<Components> {
  const mb = dense ? "mb-2" : "mb-3";
  const headerTone = toneAccent(tone);

  return {
    p: ({ children }) => (
      <p className={`${mb} whitespace-pre-wrap last:mb-0`} style={{ color: COLORS.textPrimary }}>
        {children}
      </p>
    ),
    h1: ({ children }) => (
      <h1
        className={`${mb} mt-3 text-[15px] font-semibold leading-snug first:mt-0`}
        style={{ color: headerTone }}
      >
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2
        className={`${mb} mt-3 text-[13px] font-semibold leading-snug first:mt-0`}
        style={{ color: headerTone }}
      >
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3
        className={`${mb} mt-3 text-[12px] font-semibold leading-snug first:mt-0`}
        style={{ color: headerTone }}
      >
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4
        className={`${mb} mt-3 text-[12px] font-medium leading-snug first:mt-0`}
        style={{ color: headerTone }}
      >
        {children}
      </h4>
    ),
    a: ({ href, children }) => (
      <PrLink href={href} repoOwner={repoOwner} repoName={repoName}>
        {children}
      </PrLink>
    ),
    // Route fenced code blocks through the shared Shiki highlighter.
    pre: ({ children }) => {
      const first = Array.isArray(children) ? children[0] : children;
      if (
        first &&
        typeof first === "object" &&
        "props" in (first as object)
      ) {
        const props = (first as {
          props?: { className?: string; children?: ReactNode };
        }).props;
        const className = props?.className ?? "";
        const match = /language-([\w-]+)/.exec(className);
        const language = match ? match[1] : "text";
        const codeText = extractLinkText(props?.children).replace(/\n$/, "");
        return <HighlightedCode code={codeText} language={language} />;
      }
      return (
        <pre
          className={`${mb} overflow-auto rounded-[6px] border p-3 font-mono text-[11px] leading-5 last:mb-0`}
          style={{ borderColor: COLORS.border, background: "rgba(0,0,0,0.25)" }}
        >
          {children}
        </pre>
      );
    },
    code: ({ className, children }) => {
      // Fenced blocks are handled by `pre`. Inline code stays small & mono.
      if (className && /language-/.test(className)) {
        return <code className={className}>{children}</code>;
      }
      return (
        <code
          className="rounded-[4px] px-1 py-0.5 font-mono text-[11px]"
          style={{ background: "rgba(0,0,0,0.3)", color: COLORS.textPrimary }}
        >
          {children}
        </code>
      );
    },
    // GFM: task-list checkbox inputs.
    input: (props) => {
      const { type, checked } = props as { type?: string; checked?: boolean };
      if (type === "checkbox") return <PrTaskCheckbox checked={checked} />;
      return null;
    },
    // GFM: tables need horizontal scroll with sticky header.
    table: ({ children }) => (
      <div
        className={`${mb} overflow-x-auto rounded-[6px] border last:mb-0`}
        style={{ borderColor: COLORS.border }}
      >
        <table className="w-full border-collapse text-left text-[12px]">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead
        className="pr-md-thead sticky top-0 z-10"
        style={{ background: COLORS.cardBgSolid }}
      >
        {children}
      </thead>
    ),
    th: ({ children }) => (
      <th
        className="border-b px-3 py-1.5 font-semibold"
        style={{ borderColor: COLORS.border, color: COLORS.textPrimary }}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td
        className="border-b px-3 py-1.5 align-top"
        style={{ borderColor: COLORS.borderMuted, color: COLORS.textPrimary }}
      >
        {children}
      </td>
    ),
    blockquote: ({ children }) => (
      <blockquote
        className={`${mb} border-l-2 pl-3 last:mb-0`}
        style={{ borderColor: COLORS.accentBorder, color: COLORS.textSecondary }}
      >
        {children}
      </blockquote>
    ),
    img: (props) => (
      <PrImage
        src={(props as { src?: string }).src}
        alt={(props as { alt?: string }).alt}
        title={(props as { title?: string }).title}
      />
    ),
    // Route <details>/<summary> through our accordion. The summary is
    // tagged with a sentinel component so `PrDetails` can peel it out from
    // the rest of the body (the collapsed content).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    details: (props: any) => <PrDetails open={!!props.open}>{props.children}</PrDetails>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summary: PrSummaryMarker as any,
  };
}

/* ── Main exported component ───────────────────────────────────────── */

export const PrMarkdown = memo(function PrMarkdown({
  children,
  repoOwner,
  repoName,
  tone = "neutral",
  dense = false,
}: PrMarkdownProps) {
  const overrides = useMemo(
    () => buildPrOverrides({ tone, dense, repoOwner, repoName }),
    [tone, dense, repoOwner, repoName],
  );

  const components = useMemo<Components>(() => {
    const chatTone = tone === "amber" ? "amber" : "sky";
    // `buildChatMarkdownComponents` signature only accepts "sky" | "amber".
    const base = buildChatMarkdownComponents(chatTone, overrides);
    return base;
  }, [tone, overrides]);

  const remarkPlugins = useMemo(
    () => [
      remarkGfm,
      [remarkPrAutolinks, { repoOwner, repoName }] as [
        typeof remarkPrAutolinks,
        { repoOwner: string; repoName: string },
      ],
    ],
    [repoOwner, repoName],
  );

  return (
    <div
      className={`pr-md-root text-[13px] leading-[1.55] ${dense ? "pr-md-dense" : ""}`}
      style={{ color: COLORS.textPrimary }}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, PR_SAFE_SCHEMA]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

export default PrMarkdown;
