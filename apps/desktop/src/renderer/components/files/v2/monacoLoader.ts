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
      return await import("monaco-editor");
    })();
  }
  return monacoInit;
}
