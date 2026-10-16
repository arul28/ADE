import React, { useEffect, useState } from "react";

/**
 * One TeX formula in a chat reply, typeset by KaTeX.
 *
 * KaTeX (~270 KB plus its stylesheet) is a lazy chunk: it loads the first time
 * a reply with math is drawn, and a session with no math never fetches it.
 * Until it arrives, and whenever a formula cannot be typeset (bad or half-
 * streamed TeX, or past the length cap), the formula shows as its source in
 * the code face rather than as KaTeX's red error text. A wrong-looking
 * render is worse than honest source.
 *
 * Rendering is synchronous on the main thread, so it is bounded and cached:
 * one render per distinct formula per session (a streaming reply re-renders
 * its tail many times a second, and settled formulas must cost nothing), a
 * cap on formula length, and a cap on macro expansion so `\def` loops cannot
 * spin.
 */

type Katex = typeof import("katex").default;

let katex: Katex | null = null;
let loadFailed = false;
let loading: Promise<void> | null = null;

function loadKatex(): Promise<void> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")])
    .then(([module]) => {
      katex = module.default;
    })
    .catch(() => {
      loadFailed = true;
    });
  return loading;
}

/** Past this, a formula is shown as source: typesetting it would stall a frame. */
const MAX_TEX_LENGTH = 4_000;
const CACHE_LIMIT = 600;
/** Insertion-ordered; the first key is the least recently used. */
const cache = new Map<string, string | null>();

function typeset(tex: string, display: boolean): string | null {
  if (!katex || tex.length > MAX_TEX_LENGTH) return null;
  const key = `${display ? "D" : "I"}${tex}`;
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let html: string | null;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      // `\href`, `\url`, `\includegraphics` and friends stay off.
      trust: false,
      strict: "ignore",
      maxSize: 50,
      maxExpand: 1_000,
      output: "htmlAndMathml",
    });
  } catch {
    html = null;
  }
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return html;
}

export const MathFormula = React.memo(function MathFormula({ tex, display }: { tex: string; display: boolean }) {
  const [ready, setReady] = useState(() => katex !== null);
  useEffect(() => {
    if (ready || loadFailed) return;
    let cancelled = false;
    void loadKatex().then(() => {
      if (!cancelled && katex) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ready]);

  const source = tex.trim();
  const html = ready ? typeset(source, display) : null;
  if (html === null) {
    return display ? (
      <code data-chat-math-source="" className="my-3 block whitespace-pre-wrap font-mono text-[length:calc(var(--chat-font-size)*12/14)] opacity-80">
        {source}
      </code>
    ) : (
      <code data-chat-math-source="" className="font-mono text-[0.92em] opacity-80">{source}</code>
    );
  }
  return display ? (
    <div
      data-chat-math="display"
      className="my-3 max-w-full overflow-x-auto overflow-y-hidden py-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <span data-chat-math="inline" dangerouslySetInnerHTML={{ __html: html }} />
  );
});
