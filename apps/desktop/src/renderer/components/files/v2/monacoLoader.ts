import type * as Monaco from "monaco-editor";

/**
 * Lazy Monaco loader with worker wiring, shared by the v2 code editor and any
 * other Monaco surface. Mirrors the proven worker setup used elsewhere in the
 * app so language services (TS/JS) and the editor worker resolve correctly under
 * Vite + Electron CSP (workers are `'self'` / blob).
 */
let monacoInit: Promise<typeof Monaco> | null = null;

export async function loadMonaco(): Promise<typeof Monaco> {
  if (!monacoInit) {
    monacoInit = (async () => {
      const [{ default: EditorWorker }, { default: TsWorker }] = await Promise.all([
        import("monaco-editor/esm/vs/editor/editor.worker?worker"),
        import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
      ]);
      const globalAny = globalThis as typeof globalThis & {
        MonacoEnvironment?: { getWorker?: (workerId: string, label: string) => Worker };
      };
      const existing = globalAny.MonacoEnvironment;
      globalAny.MonacoEnvironment = {
        ...existing,
        getWorker:
          existing?.getWorker ??
          ((_workerId: string, label: string) => {
            if (label === "typescript" || label === "javascript") return new TsWorker();
            return new EditorWorker();
          }),
      };
      const monaco = await import("monaco-editor");
      defineAdeThemes(monaco);
      return monaco;
    })();
  }
  return monacoInit;
}

/**
 * The editor's surface, in the app's own colour rather than Monaco's.
 *
 * `vs-dark` paints #1e1e1e behind the code, its gutter and its minimap, which
 * inside the Work tools pane meant the file tree, the editor and the gutter
 * were three different greys stacked in a 447px column. Only the surfaces are
 * overridden — the syntax colours are still Monaco's, inherited from the base
 * theme, because re-tokenising a language set is not what "one background"
 * means.
 */
export const ADE_MONACO_DARK_THEME = "ade-dark";
export const ADE_MONACO_LIGHT_THEME = "ade-light";

/*
  The two surfaces, as literals rather than as the live `--color-surface` token.

  `defineAdeThemes` runs once, inside the memoized `monacoInit` promise, so a
  theme defined from the live token would freeze BOTH themes to whichever one
  happened to be active when the first editor opened — a light editor then
  paints `vs` syntax tokens on a near-black background. These are the same two
  values `index.css` gives `--color-surface` under `[data-theme="dark"]` (:46)
  and `[data-theme="light"]` (:243); keep them in step with that file.
*/
const DARK_SURFACE = "#16141E";
const LIGHT_SURFACE = "#faf8f5";

function defineAdeThemes(monaco: typeof Monaco): void {
  const surfaces = (background: string) => ({
    "editor.background": background,
    "editorGutter.background": background,
    "editorStickyScroll.background": background,
    "editorStickyScrollHover.background": background,
    "minimap.background": background,
    "editorOverviewRuler.background": background,
  });
  monaco.editor.defineTheme(ADE_MONACO_DARK_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: surfaces(DARK_SURFACE),
  });
  monaco.editor.defineTheme(ADE_MONACO_LIGHT_THEME, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: surfaces(LIGHT_SURFACE),
  });
}

export function adeMonacoTheme(theme: "light" | "dark"): string {
  return theme === "light" ? ADE_MONACO_LIGHT_THEME : ADE_MONACO_DARK_THEME;
}
