import React, { Suspense, useCallback, useEffect, useState, useRef, type CSSProperties } from "react";
import { CopySimple, Checks } from "@phosphor-icons/react";
import { useAppStore, type CodeBlockCopyButtonPosition } from "../../state/appStore";

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
};

let highlighterPromise: Promise<ShikiHighlighter> | null = null;

function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({
        themes: [THEME],
        langs: SUPPORTED_LANGUAGES,
        engine: shiki.createJavaScriptRegexEngine(),
      }),
    ).catch((error) => {
      highlighterPromise = null;
      throw error;
    });
  }
  return highlighterPromise;
}

/* ── Highlight function ── */

async function highlightCode(code: string, language: string): Promise<string> {
  const cacheKey = `${language}::${code}`;
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

  let html: string;
  try {
    html = highlighter.codeToHtml(code, { lang, theme: THEME });
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

function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    return Promise.resolve(ok);
  } catch {
    return Promise.resolve(false);
  } finally {
    if (ta.parentNode) ta.parentNode.removeChild(ta);
  }
}

function CodeCopyButton({ code, position }: { code: string; position: CodeBlockCopyButtonPosition }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(code)
      .then((ok) => {
        if (!ok) {
          setCopied(false);
          return;
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      });
  }, [code]);

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
          onClick={handleCopy}
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
      onClick={handleCopy}
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

function HighlightedCodeInner({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);

    highlightCode(code, language).then((result) => {
      if (!cancelled && mountedRef.current) {
        setHtml(result);
      }
    });

    return () => { cancelled = true; };
  }, [code, language]);

  if (!html) {
    // Loading / no highlight available — show plain code
    return (
      <code className="font-mono text-[11px] leading-[1.6] text-[var(--chat-code-fg)]">
        {code}
      </code>
    );
  }

  return (
    <div
      className="shiki-highlighted [&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0 [&_code]:!bg-transparent [&_code]:!p-0 [&_code]:font-mono [&_code]:text-[11px] [&_code]:leading-[1.6] [&_.shiki]:!bg-transparent"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/* ── Plain code fallback ── */

function PlainCodeFallback({ code }: { code: string }) {
  return (
    <code className="font-mono text-[11px] leading-[1.6] text-[var(--chat-code-fg)]">
      {code}
    </code>
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
  const trimmedCode = code.replace(/\n$/, "");
  const isDiff = language === "diff";
  // `overflow-hidden` traps `position: sticky` inside the block, so drop it when the copy button
  // needs to track the transcript scroll. The border + border-radius still render the rounded corners;
  // content naturally pads within the block so nothing visibly bleeds past them.
  const outerOverflowClass = copyButtonPosition === "auto" ? "" : "overflow-hidden";

  return (
    <div className={`group relative my-3 rounded-[10px] border border-[color:var(--chat-code-border)] bg-[var(--chat-code-bg)] ${outerOverflowClass}`.trim()}>
      {copyButtonPosition !== "auto" && (
        <CodeCopyButton code={trimmedCode} position={copyButtonPosition} />
      )}
      {copyButtonPosition === "auto" && (
        <CodeCopyButton code={trimmedCode} position={copyButtonPosition} />
      )}
      <div className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3">
        {isDiff ? (
          <DiffCodeBlock code={trimmedCode} />
        ) : (
          <CodeErrorBoundary fallback={<PlainCodeFallback code={trimmedCode} />}>
            <Suspense fallback={<PlainCodeFallback code={trimmedCode} />}>
              <HighlightedCodeInner code={trimmedCode} language={language} />
            </Suspense>
          </CodeErrorBoundary>
        )}
      </div>
    </div>
  );
});
