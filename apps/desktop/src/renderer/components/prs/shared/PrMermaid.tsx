import { useEffect, useId, useMemo, useRef, useState } from "react";

import { COLORS } from "../../lanes/laneDesignTokens";

/* ── Lazy-loaded mermaid singleton ─────────────────────────────────────
 * mermaid is heavy (~hundreds of KB). We only pull it in the first time a
 * PR body actually contains a ```mermaid fence, and we initialize it once.
 */

type MermaidModule = typeof import("mermaid")["default"];

let mermaidPromise: Promise<MermaidModule> | null = null;

async function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid")
      .then((mod) => {
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",
          // Keep diagrams from overflowing thread cards; the wrapper scrolls.
          fontFamily: "inherit",
        });
        return mermaid;
      })
      .catch((err) => {
        // Don't cache a rejected promise — reset so a later render can retry.
        mermaidPromise = null;
        throw err;
      });
  }
  return mermaidPromise;
}

export type PrMermaidProps = {
  source: string;
};

/* ── Mermaid diagram renderer ──────────────────────────────────────────
 * Renders the mermaid source to an SVG string (sanitized by mermaid's
 * `securityLevel: "strict"`) and injects it. On any parse/render failure we
 * fall back to the raw source in a <pre> — we never throw.
 */

export function PrMermaid({ source }: PrMermaidProps) {
  const reactId = useId();
  // mermaid requires a DOM-id-safe, deterministic id. useId() can contain
  // characters mermaid rejects (":"), so normalize to [A-Za-z0-9_-].
  const renderId = useMemo(
    () => `pr-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );

  const trimmed = useMemo(() => source.replace(/\n$/, ""), [source]);

  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);

    if (!trimmed.trim()) {
      setFailed(true);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const mermaid = await loadMermaid();
        // `parse` throws on invalid syntax — surface that as the raw fallback
        // rather than letting `render` leave a stray error node in the DOM.
        await mermaid.parse(trimmed);
        const { svg: rendered } = await mermaid.render(renderId, trimmed);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [trimmed, renderId]);

  if (failed) {
    return (
      <pre
        className="pr-md-mermaid-fallback mb-3 overflow-auto rounded-[6px] border p-3 font-mono text-[11px] leading-5 last:mb-0"
        style={{ borderColor: COLORS.border, background: "rgba(0,0,0,0.25)", color: COLORS.textPrimary }}
      >
        {trimmed}
      </pre>
    );
  }

  if (svg == null) {
    return (
      <div
        className="pr-md-mermaid-loading mb-3 rounded-[6px] border px-3 py-2 text-[11px] last:mb-0"
        style={{ borderColor: COLORS.border, background: "rgba(0,0,0,0.18)", color: COLORS.textMuted }}
      >
        Rendering diagram…
      </div>
    );
  }

  return (
    <MermaidSvg svg={svg} />
  );
}

/* The SVG produced by mermaid (strict mode) is already sanitized; we inject it
 * and constrain it to the container width with horizontal scroll for wide
 * diagrams. */
function MermaidSvg({ svg }: { svg: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Make the SVG responsive to the card width: drop fixed px width/height so
    // the diagram scales down, keep aspect ratio via viewBox.
    const el = node.querySelector("svg");
    if (el) {
      el.style.maxWidth = "100%";
      el.style.height = "auto";
      el.removeAttribute("width");
    }
  }, [svg]);

  return (
    <div
      ref={ref}
      className="pr-md-mermaid mb-3 overflow-x-auto rounded-[6px] border p-3 last:mb-0"
      style={{ borderColor: COLORS.border, background: "rgba(0,0,0,0.18)" }}
      // SVG is sanitized by mermaid's strict securityLevel.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default PrMermaid;
