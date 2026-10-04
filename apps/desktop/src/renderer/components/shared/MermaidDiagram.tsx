/**
 * The one mermaid renderer: chat replies, PR descriptions and comments, and
 * markdown files all draw ```mermaid fences through it.
 *
 * - Mermaid is imported the first time a diagram mounts, so a surface with no
 *   diagram pays nothing for it.
 * - Every render runs at `securityLevel: "strict"` with HTML labels off, so a
 *   `%%{init}%%` line in the source cannot turn them back on. Strict mode
 *   sanitizes labels and drops click handlers; chat text and PR bodies are
 *   untrusted input, and this is the defense for both.
 * - Results are cached per source and theme (64 settled entries; a pending
 *   render is never evicted, so a remount reuses its promise).
 * - A failed import offers Retry; a parse error shows mermaid's message above
 *   the source.
 */
import React from "react";
import { Check, Code, Copy, FlowArrow } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { MediaLightbox } from "../ui/MediaLightbox";
import { cn } from "../ui/cn";

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  parse: (source: string) => Promise<unknown>;
  render: (id: string, source: string) => Promise<{ svg: string }>;
};

type RenderResult = { ok: true; svg: string } | { ok: false; error: string; kind: "load" | "parse" };

const MAX_SETTLED_RENDERS = 64;

let mermaidPromise: Promise<MermaidApi> | null = null;
let renderSeq = 0;
let renderQueue: Promise<unknown> = Promise.resolve();
const renderCache = new Map<string, { promise: Promise<RenderResult>; settled: boolean }>();

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid")
      .then((mod) => (mod as unknown as { default: MermaidApi }).default)
      .catch((error: unknown) => {
        // Not cached: a later mount (or Retry) tries the import again.
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}

function trimCache(): void {
  if (renderCache.size <= MAX_SETTLED_RENDERS) return;
  for (const [key, entry] of renderCache) {
    if (renderCache.size <= MAX_SETTLED_RENDERS) break;
    if (entry.settled) renderCache.delete(key);
  }
}

/**
 * Mermaid's config is global, so renders run one at a time: each sets its own
 * theme and renders before the next one can change it.
 */
function renderMermaid(source: string, theme: "dark" | "light"): Promise<RenderResult> {
  const key = `${theme}\u0000${source}`;
  const cached = renderCache.get(key);
  if (cached) return cached.promise;
  const job = renderQueue.then(async (): Promise<RenderResult> => {
    let mermaid: MermaidApi;
    try {
      mermaid = await loadMermaid();
    } catch (error) {
      return { ok: false, kind: "load", error: error instanceof Error ? error.message : String(error) };
    }
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: theme === "light" ? "default" : "dark",
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        fontFamily: "inherit",
      });
      await mermaid.parse(source);
      renderSeq += 1;
      const { svg } = await mermaid.render(`ade-mermaid-${renderSeq}`, source);
      return { ok: true, svg };
    } catch (error) {
      return { ok: false, kind: "parse", error: error instanceof Error ? error.message : String(error) };
    }
  });
  renderQueue = job.catch(() => undefined);
  const entry = { promise: job, settled: false };
  renderCache.set(key, entry);
  void job.then((result) => {
    entry.settled = true;
    // A failed import is not a property of the source: drop it so Retry runs again.
    if (!result.ok && result.kind === "load") renderCache.delete(key);
    trimCache();
  });
  return job;
}

function useAppThemeMode(): "dark" | "light" {
  const theme = useAppStore((state) => state.theme);
  return theme === "light" ? "light" : "dark";
}

function MermaidSvg({ svg, onOpen }: { svg: string; onOpen?: () => void }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const element = ref.current?.querySelector("svg");
    if (!element) return;
    // Scale to the column instead of a fixed pixel size; the viewBox keeps the shape.
    element.style.maxWidth = "100%";
    element.style.height = "auto";
    element.removeAttribute("width");
  }, [svg]);
  return (
    <div
      ref={ref}
      data-mermaid-diagram=""
      className={cn("overflow-x-auto", onOpen && "cursor-zoom-in")}
      role={onOpen ? "button" : "img"}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? "Open diagram" : "Diagram"}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (onOpen && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen();
        }
      }}
      // Strict-mode mermaid output: labels sanitized, no scripts or handlers.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * One diagram. `variant` sets the frame: `chat` sits in the message with a
 * code/copy row under it and opens full-size on click; `pr` and `file` keep
 * the bordered card those surfaces already used.
 */
export function MermaidDiagram({
  source,
  variant,
  renderCode,
}: {
  source: string;
  variant: "chat" | "pr" | "file";
  /** How this surface draws a code block, for the code toggle and failures. */
  renderCode: (code: string) => React.ReactNode;
}) {
  const theme = useAppThemeMode();
  const trimmed = React.useMemo(() => source.replace(/\n+$/, ""), [source]);
  const [result, setResult] = React.useState<RenderResult | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [showCode, setShowCode] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [lightboxUrl, setLightboxUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setResult(null);
    if (!trimmed.trim()) {
      setResult({ ok: false, kind: "parse", error: "Empty diagram." });
      return;
    }
    void renderMermaid(trimmed, theme).then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, theme, trimmed]);

  // One blob URL at a time, released when the viewer closes.
  React.useEffect(() => () => {
    if (lightboxUrl) URL.revokeObjectURL(lightboxUrl);
  }, [lightboxUrl]);

  const openLightbox = React.useCallback(() => {
    if (!result?.ok) return;
    setLightboxUrl(URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" })));
  }, [result]);

  const copySource = React.useCallback(() => {
    void navigator.clipboard?.writeText(trimmed).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    });
  }, [trimmed]);

  const frame = variant === "chat"
    ? "my-3"
    : "mb-3 rounded-md border border-[color:color-mix(in_srgb,var(--color-border)_70%,transparent)] bg-[color:color-mix(in_srgb,var(--color-fg)_3%,transparent)] p-3 last:mb-0";

  if (!result) {
    return (
      <div className={cn(frame, "flex items-center gap-2 py-4 text-[11px] text-muted-fg")} role="status">
        <FlowArrow size={13} aria-hidden />
        Rendering diagram…
      </div>
    );
  }

  if (!result.ok) {
    return (
      <div className={frame}>
        <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-fg">
          <span className="min-w-0 flex-1 truncate" title={result.error}>
            {result.kind === "load" ? "Couldn't load the diagram renderer." : `Diagram error: ${result.error}`}
          </span>
          {result.kind === "load" ? (
            <button type="button" className="text-fg underline-offset-2 hover:underline" onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </button>
          ) : null}
        </div>
        {renderCode(trimmed)}
      </div>
    );
  }

  return (
    <div className={frame} data-mermaid-block="">
      {showCode ? renderCode(trimmed) : <MermaidSvg svg={result.svg} onOpen={variant === "chat" ? openLightbox : undefined} />}
      {variant === "chat" ? (
        <div className="mt-1 flex items-center justify-end gap-1 text-muted-fg">
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted hover:text-fg"
            aria-label={showCode ? "Show diagram" : "Show code"}
            title={showCode ? "Show diagram" : "Show code"}
            onClick={() => setShowCode((value) => !value)}
          >
            {showCode ? <FlowArrow size={13} /> : <Code size={13} />}
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted hover:text-fg"
            aria-label="Copy diagram source"
            title="Copy source"
            onClick={copySource}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      ) : null}
      {lightboxUrl ? (
        <MediaLightbox
          src={lightboxUrl}
          kind="image"
          title="Diagram"
          fileName="diagram.svg"
          onClose={() => setLightboxUrl(null)}
        />
      ) : null}
    </div>
  );
}
