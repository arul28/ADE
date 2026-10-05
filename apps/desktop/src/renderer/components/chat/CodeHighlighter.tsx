import React, { Suspense, useEffect, useMemo, useState, useRef, type CSSProperties } from "react";
import { CopySimple, Checks } from "@phosphor-icons/react";
import { useAppStore, type CodeBlockCopyButtonPosition } from "../../state/appStore";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { codeThemeFingerprint, shikiThemeData, shikiThemeName, usesStockCodeColors, type ShikiThemeData } from "../../theme/codeTheme";
import { useActiveResolvedTheme } from "../../theme/useActiveTheme";
import type { Element as HastElement, Root as HastRoot } from "hast";
import type { GrammarState as ShikiGrammarState } from "shiki";

/* ── LRU cache for highlighted HTML ── */

class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Delete the oldest (first) entry
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }
}

const highlightCache = new LRUCache<string, string>(300);

/* ── Shiki highlighter (lazy singleton) ── */

const SUPPORTED_LANGUAGES = [
  "typescript", "javascript", "jsx", "tsx", "python", "rust", "go",
  "java", "bash", "shell", "json", "yaml", "html", "css", "sql",
  "markdown", "diff", "c", "cpp", "ruby", "php", "swift", "kotlin",
];

const THEME = "github-dark-dimmed";

type ShikiHighlighter = {
  codeToHtml(code: string, options: { lang: string; theme: string }): string;
  codeToHast(code: string, options: { lang: string; theme: string; grammarState?: ShikiGrammarState }): HastRoot;
  getLastGrammarState(element: HastRoot): ShikiGrammarState | undefined;
  loadTheme(theme: ShikiThemeData): Promise<void>;
  /** Shiki's serializer, carried with the highlighter that produced the trees. */
  hastToHtml(node: HastRoot | HastElement): string;
};

/**
 * The colours a block is highlighted with. The stock themes keep Shiki's
 * `github-dark-dimmed`; every other theme brings its own, keyed by a string
 * that changes whenever its syntax colours do so a cached block never outlives
 * an edit to the theme.
 */
type CodeTheme = { key: string; data: ShikiThemeData | null };

const STOCK_CODE_THEME: CodeTheme = { key: "stock", data: null };

const loadedThemeNames = new Set<string>();

let highlighterPromise: Promise<ShikiHighlighter> | null = null;

function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(async (shiki) => {
      const highlighter = await shiki.createHighlighter({
        themes: [THEME],
        langs: SUPPORTED_LANGUAGES,
        engine: shiki.createJavaScriptRegexEngine(),
      });
      return Object.assign(highlighter, { hastToHtml: shiki.hastToHtml });
    }).catch((error) => {
      highlighterPromise = null;
      throw error;
    });
  }
  return highlighterPromise;
}

/* ── Incremental highlighting for a growing block ── */

/*
 * A streaming code block re-renders with a longer string every frame, and
 * highlighting each string from scratch re-tokenizes every earlier line: a
 * block costs O(lines²) over its stream. TextMate tokenization runs line by line
 * with a carried rule stack, so the HTML of the complete lines and the grammar
 * state after them can be kept, and only the new lines tokenized. The output is
 * byte-identical to `codeToHtml` (checked frame by frame across languages);
 * CRLF text and plain text take the whole-block path.
 */
type StreamingHighlight = {
  lang: string;
  themeName: string;
  /** The complete lines already tokenized, each ending in "\n". */
  settled: string;
  linesHtml: string[];
  state: ShikiGrammarState | undefined;
};

const MAX_STREAMING_HIGHLIGHTS = 4;
const streamingHighlights: StreamingHighlight[] = [];

function findCodeElement(root: HastRoot): HastElement | null {
  const pre = root.children.find((node): node is HastElement => node.type === "element" && node.tagName === "pre");
  const code = pre?.children.find((node): node is HastElement => node.type === "element" && node.tagName === "code");
  return code ?? null;
}

function lineElements(root: HastRoot): HastElement[] | null {
  const code = findCodeElement(root);
  return code ? code.children.filter((node): node is HastElement => node.type === "element") : null;
}

function renderHighlightedHtml(highlighter: ShikiHighlighter, code: string, lang: string, themeName: string): string {
  if (lang !== "text" && !code.includes("\r")) {
    try {
      const html = renderIncrementally(highlighter, code, lang, themeName);
      if (html !== null) return html;
    } catch {
      // Incremental output is only a faster route to the same HTML; start over.
      streamingHighlights.length = 0;
    }
  }
  return highlighter.codeToHtml(code, { lang, theme: themeName });
}

/** The same HTML as `codeToHtml`, or null when Shiki's tree is not the expected shape. */
function renderIncrementally(highlighter: ShikiHighlighter, code: string, lang: string, themeName: string): string | null {
  const lastNewline = code.lastIndexOf("\n");
  const settled = code.slice(0, lastNewline + 1);
  const tail = code.slice(lastNewline + 1);

  let base: StreamingHighlight | null = null;
  for (const entry of streamingHighlights) {
    if (entry.lang !== lang || entry.themeName !== themeName || !settled.startsWith(entry.settled)) continue;
    if (!base || entry.settled.length > base.settled.length) base = entry;
  }

  let linesHtml = base?.linesHtml ?? [];
  let state = base?.state;
  const fresh = settled.slice(base?.settled.length ?? 0);
  if (fresh) {
    const hast = highlighter.codeToHast(fresh.slice(0, -1), { lang, theme: themeName, grammarState: state });
    const lines = lineElements(hast);
    if (!lines) return null;
    state = highlighter.getLastGrammarState(hast);
    linesHtml = linesHtml.concat(lines.map((line) => highlighter.hastToHtml(line)));
  }

  if (base) streamingHighlights.splice(streamingHighlights.indexOf(base), 1);
  streamingHighlights.push({ lang, themeName, settled, linesHtml, state });
  if (streamingHighlights.length > MAX_STREAMING_HIGHLIGHTS) streamingHighlights.shift();

  const tailHast = highlighter.codeToHast(tail, { lang, theme: themeName, grammarState: state });
  const tailLine = lineElements(tailHast)?.[0];
  const codeElement = findCodeElement(tailHast);
  if (!tailLine || !codeElement) return null;
  // The <pre>/<code> wrapper carries the theme colours; serialize it empty and
  // splice the lines in where its children go.
  const tailLineHtml = highlighter.hastToHtml(tailLine);
  codeElement.children = [];
  const shell = highlighter.hastToHtml(tailHast);
  const closeAt = shell.lastIndexOf("</code>");
  if (closeAt < 0) return null;
  return `${shell.slice(0, closeAt)}${linesHtml.concat(tailLineHtml).join("\n")}${shell.slice(closeAt)}`;
}

/* ── Highlight function ── */

function highlightCacheKey(code: string, language: string, themeKey: string): string {
  return `${themeKey}::${language}::${code}`;
}

/** Cached highlight for this exact block, if one was produced before; synchronous. */
function readCachedHighlight(code: string, language: string, themeKey: string): string | undefined {
  return highlightCache.get(highlightCacheKey(code, language, themeKey));
}

async function highlightCode(code: string, language: string, codeTheme: CodeTheme): Promise<string> {
  const cacheKey = highlightCacheKey(code, language, codeTheme.key);
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let highlighter: ShikiHighlighter;
  try {
    highlighter = await getHighlighter();
  } catch {
    highlightCache.set(cacheKey, "");
    return "";
  }
  const lang = SUPPORTED_LANGUAGES.includes(language) ? language : "text";

  let themeName = THEME;
  if (codeTheme.data) {
    themeName = codeTheme.data.name;
    if (!loadedThemeNames.has(themeName)) {
      try {
        await highlighter.loadTheme(codeTheme.data);
        loadedThemeNames.add(themeName);
      } catch {
        highlightCache.set(cacheKey, "");
        return "";
      }
    }
  }

  let html: string;
  try {
    html = renderHighlightedHtml(highlighter, code, lang, themeName);
  } catch {
    // If highlighting fails for the language, render as plain text
    html = "";
  }

  if (html) {
    highlightCache.set(cacheKey, html);
  }
  return html;
}

/* ── Diff preview (inline, for language-diff blocks) ── */

function DiffCodeBlock({ code }: { code: string }) {
  const lines = code.split(/\r?\n/);
  return (
    <div className="overflow-x-auto whitespace-pre font-mono text-[11px] leading-[1.6] text-[var(--chat-code-fg)]">
      {lines.map((line, index) => {
        let style: CSSProperties = { color: "color-mix(in srgb, var(--chat-code-fg) 70%, transparent)" };
        if (line.startsWith("+")) {
          style = {
            color: "var(--color-diff-add)",
            background: "color-mix(in srgb, var(--color-diff-add) 8%, transparent)",
          };
        } else if (line.startsWith("-")) {
          style = {
            color: "var(--color-diff-del)",
            background: "color-mix(in srgb, var(--color-diff-del) 8%, transparent)",
          };
        } else if (line.startsWith("@@")) {
          style = { color: "color-mix(in srgb, var(--color-accent) 70%, transparent)" };
        }
        return (
          <div key={`${index}:${line}`} className="px-1 -mx-1" style={style}>
            {line}
          </div>
        );
      })}
    </div>
  );
}

/* ── Copy button ── */

function CodeCopyButton({ code, position }: { code: string; position: CodeBlockCopyButtonPosition }) {
  const { copy, copied } = useCopyToClipboard();

  // "auto" wraps the button in a sticky row so it tracks the transcript scroll; top/bottom stay absolute.
  if (position === "auto") {
    return (
      <div
        className="pointer-events-none sticky top-2 z-10 flex justify-end pr-2"
        // -mb keeps the sticky row from pushing the code text down on its first line.
        style={{ marginBottom: -24 }}
      >
        <button
          type="button"
          className="ade-chat-copy-button pointer-events-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-sans text-[9px] opacity-0 backdrop-blur-sm transition-all group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          style={{
            border: "1px solid var(--chat-copy-button-border)",
            background: "var(--chat-copy-button-bg)",
            color: "var(--chat-copy-button-fg)",
          }}
          onClick={() => void copy(code)}
          title={copied ? "Copied" : "Copy code"}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Checks size={10} weight="bold" /> : <CopySimple size={10} weight="regular" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
    );
  }

  const posClass = position === "bottom" ? "bottom-2 top-auto" : "top-2";

  return (
    <button
      type="button"
      className={`ade-chat-copy-button absolute right-2 z-10 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-sans text-[9px] opacity-0 backdrop-blur-sm transition-all group-hover:opacity-100 [@media(hover:none)]:opacity-100 ${posClass}`}
      style={{
        border: "1px solid var(--chat-copy-button-border)",
        background: "var(--chat-copy-button-bg)",
        color: "var(--chat-copy-button-fg)",
      }}
      onClick={() => void copy(code)}
      title={copied ? "Copied" : "Copy code"}
      aria-label={copied ? "Copied" : "Copy code"}
    >
      {copied ? <Checks size={10} weight="bold" /> : <CopySimple size={10} weight="regular" />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/* ── Error boundary ── */

class CodeErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: React.ReactNode; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

/* ── Inner highlighted code (async state) ── */

/*
 * The plain fallback and shiki's output lay out identically: both are a <pre>
 * with the same font, size, line height, and wrapping around a <code>. Shiki
 * emits `<pre class="shiki"><code>…</code></pre>`; a bare <pre> would not wrap
 * (and takes the UA monospace size for its line boxes), so swapping the plain
 * block for the highlighted one used to change the block's height after the
 * row had been measured — the transcript moved under the reader. Same box,
 * only the colours change.
 */
const CODE_PRE_CLASS = "m-0 whitespace-pre-wrap break-words bg-transparent p-0 font-mono text-[11px] leading-[1.6]";
const HIGHLIGHTED_PRE_CLASS = [
  "shiki-highlighted",
  "[&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:!bg-transparent [&_pre]:whitespace-pre-wrap [&_pre]:break-words",
  "[&_pre]:font-mono [&_pre]:text-[11px] [&_pre]:leading-[1.6]",
  "[&_code]:!bg-transparent [&_code]:!p-0 [&_code]:font-mono [&_code]:text-[11px] [&_code]:leading-[1.6]",
  "[&_.shiki]:!bg-transparent",
].join(" ");

function HighlightedCodeInner({ code, language, codeTheme }: { code: string; language: string; codeTheme: CodeTheme }) {
  // A cache hit renders highlighted on the first frame: a remounted row (a
  // virtualized row scrolling back in, a reopened chat) must not flash plain
  // code and then re-highlight at a different height.
  const [state, setState] = useState<{ code: string; language: string; themeKey: string; html: string | null }>(() => ({
    code,
    language,
    themeKey: codeTheme.key,
    html: readCachedHighlight(code, language, codeTheme.key) ?? null,
  }));
  const mountedRef = useRef(true);
  // New code (a streaming block growing): take the cached answer synchronously
  // when there is one, else show the new text plain until it highlights. Both
  // render the same box, so the swap never changes the row's height.
  let current = state;
  if (state.code !== code || state.language !== language || state.themeKey !== codeTheme.key) {
    current = { code, language, themeKey: codeTheme.key, html: readCachedHighlight(code, language, codeTheme.key) ?? null };
    setState(current);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (readCachedHighlight(code, language, codeTheme.key) !== undefined) return;
    let cancelled = false;
    void highlightCode(code, language, codeTheme).then((result) => {
      if (cancelled || !mountedRef.current) return;
      setState((previous) => (
        previous.code === code && previous.language === language && previous.themeKey === codeTheme.key
          ? { code, language, themeKey: codeTheme.key, html: result || null }
          : previous
      ));
    });
    return () => { cancelled = true; };
  }, [code, language, codeTheme]);

  if (!current.html) {
    return <PlainCodeFallback code={code} />;
  }

  return (
    <div
      className={HIGHLIGHTED_PRE_CLASS}
      dangerouslySetInnerHTML={{ __html: current.html }}
    />
  );
}

/* ── Plain code fallback ── */

function PlainCodeFallback({ code }: { code: string }) {
  return (
    <pre className={CODE_PRE_CLASS}>
      <code className="font-mono text-[11px] leading-[1.6] text-[var(--chat-code-fg)]">
        {code}
      </code>
    </pre>
  );
}

/* ── Exported component ── */

export const HighlightedCode = React.memo(function HighlightedCode({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const copyButtonPosition = useAppStore((s) => s.codeBlockCopyButtonPosition);
  const resolvedTheme = useActiveResolvedTheme();
  const codeTheme = useMemo<CodeTheme>(() => {
    if (usesStockCodeColors(resolvedTheme)) return STOCK_CODE_THEME;
    // The key covers every colour the Shiki theme is made from, so editing a
    // custom theme highlights fresh instead of reading a stale cached block.
    const data = shikiThemeData(resolvedTheme);
    return { key: codeThemeFingerprint(resolvedTheme), data: { ...data, name: shikiThemeName(resolvedTheme) } };
  }, [resolvedTheme]);
  const trimmedCode = code.replace(/\n$/, "");
  const isDiff = language === "diff";
  // `overflow-hidden` traps `position: sticky` inside the block, so drop it when the copy button
  // needs to track the transcript scroll. The border + border-radius still render the rounded corners;
  // content naturally pads within the block so nothing visibly bleeds past them.
  const outerOverflowClass = copyButtonPosition === "auto" ? "" : "overflow-hidden";

  return (
    <div className={`group relative my-3 rounded-[10px] border border-[color:var(--chat-code-border)] bg-[var(--chat-code-bg)] ${outerOverflowClass}`.trim()}>
      <CodeCopyButton code={trimmedCode} position={copyButtonPosition} />
      <div className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3">
        {isDiff ? (
          <DiffCodeBlock code={trimmedCode} />
        ) : (
          <CodeErrorBoundary fallback={<PlainCodeFallback code={trimmedCode} />}>
            <Suspense fallback={<PlainCodeFallback code={trimmedCode} />}>
              <HighlightedCodeInner code={trimmedCode} language={language} codeTheme={codeTheme} />
            </Suspense>
          </CodeErrorBoundary>
        )}
      </div>
    </div>
  );
});
