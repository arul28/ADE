import type * as PdfjsModule from "pdfjs-dist";

/**
 * Lazy pdf.js loader with worker wiring (mirrors the Monaco loader pattern). The
 * worker is set via `workerPort` from a Vite `?worker` import so it resolves to
 * a same-origin worker bundle under Electron CSP. pdf.js renders to a canvas,
 * which is compatible with `object-src 'none'` (no `<embed>`/plugin needed).
 */
let pdfjsInit: Promise<typeof PdfjsModule> | null = null;

export async function loadPdfjs(): Promise<typeof PdfjsModule> {
  if (!pdfjsInit) {
    pdfjsInit = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const { default: PdfWorker } = await import("pdfjs-dist/build/pdf.worker.min.mjs?worker");
      pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
      return pdfjs;
    })();
  }
  return pdfjsInit;
}
