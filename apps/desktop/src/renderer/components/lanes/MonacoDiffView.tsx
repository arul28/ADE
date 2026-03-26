import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FileDiff } from "../../../shared/types";
import { cn } from "../ui/cn";

export type MonacoDiffHandle = {
  getModifiedValue: () => string | null;
};

let monacoInit: Promise<typeof import("monaco-editor")> | null = null;

async function loadMonaco(): Promise<typeof import("monaco-editor")> {
  if (!monacoInit) {
    monacoInit = (async () => {
      // Configure the base editor worker (good enough for plain text + basic languages).
      const EditorWorker = (await import("monaco-editor/esm/vs/editor/editor.worker?worker")).default;
      const globalAny = globalThis as typeof globalThis & {
        MonacoEnvironment?: {
          getWorker?: (workerId: string, label: string) => Worker;
        };
      };
      const existing = globalAny.MonacoEnvironment;
      globalAny.MonacoEnvironment = {
        ...existing,
        getWorker: existing?.getWorker ?? (() => new EditorWorker())
      };

      return await import("monaco-editor");
    })();
  }
  return await monacoInit;
}

function disposeDiffModels(editor: import("monaco-editor").editor.IStandaloneDiffEditor | null, models: {
  original: import("monaco-editor").editor.ITextModel;
  modified: import("monaco-editor").editor.ITextModel;
} | null): void {
  try {
    editor?.setModel(null);
  } catch {
    // ignore
  }
  if (!models) return;
  try {
    models.original.dispose();
  } catch {
    // ignore
  }
  try {
    models.modified.dispose();
  } catch {
    // ignore
  }
}

const DIFF_EDITOR_BASE_OPTIONS = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 13,
  lineHeight: 18,
  scrollBeyondLastLine: false,
} as const;

export const MonacoDiffView = forwardRef<MonacoDiffHandle, { diff: FileDiff; editable?: boolean; className?: string; theme?: "dark" | "light" }>(
  function MonacoDiffView({ diff, editable = false, className, theme = "dark" }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const diffEditorRef = useRef<import("monaco-editor").editor.IStandaloneDiffEditor | null>(null);
    const modelsRef = useRef<{ original: import("monaco-editor").editor.ITextModel; modified: import("monaco-editor").editor.ITextModel } | null>(
      null
    );
    const modelIdentityRef = useRef<string | null>(null);
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState(false);
    const [sideBySide, setSideBySide] = useState(true);

    const monacoTheme = theme === "light" ? "vs" : "vs-dark";

    useImperativeHandle(ref, () => ({
      getModifiedValue: () => diffEditorRef.current?.getModel()?.modified.getValue() ?? null
    }));

    const initEditor = (monaco: typeof import("monaco-editor")) => {
      if (!containerRef.current) return;
      const editor = monaco.editor.createDiffEditor(containerRef.current, {
        ...DIFF_EDITOR_BASE_OPTIONS,
        readOnly: !editable,
        renderSideBySide: sideBySide,
        theme: monacoTheme,
      });
      diffEditorRef.current = editor;
      setFailed(false);
      setReady(true);
    };

    useEffect(() => {
      let cancelled = false;
      loadMonaco()
        .then((monaco) => {
          if (cancelled) return;
          initEditor(monaco);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });

      return () => {
        cancelled = true;
        disposeDiffModels(diffEditorRef.current, modelsRef.current);
        modelsRef.current = null;
        modelIdentityRef.current = null;
        try {
          diffEditorRef.current?.dispose();
        } catch {
          // ignore
        }
        diffEditorRef.current = null;
      };
    }, []);

    useEffect(() => {
      let cancelled = false;
      loadMonaco()
        .then((monaco) => {
          if (cancelled) return;
          const editor = diffEditorRef.current;
          if (!editor) return;

          const identity = `${diff.path}::${diff.language ?? ""}::${diff.original.text ?? ""}::${diff.modified.text ?? ""}`;
          if (modelIdentityRef.current === identity) {
            editor.getModifiedEditor().updateOptions({ readOnly: !editable });
            editor.getOriginalEditor().updateOptions({ readOnly: true });
            return;
          }

          disposeDiffModels(editor, modelsRef.current);

          const lang = diff.language ?? undefined;
          const original = monaco.editor.createModel(diff.original.text ?? "", lang);
          const modified = monaco.editor.createModel(diff.modified.text ?? "", lang);
          modelsRef.current = { original, modified };
          modelIdentityRef.current = identity;
          editor.setModel({ original, modified });
          editor.getModifiedEditor().updateOptions({ readOnly: !editable });
          editor.getOriginalEditor().updateOptions({ readOnly: true });
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });

      return () => {
        cancelled = true;
      };
    }, [diff, editable]);

    useEffect(() => {
      let cancelled = false;
      loadMonaco()
        .then((monaco) => {
          if (cancelled) return;
          monaco.editor.setTheme(monacoTheme);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
      return () => {
        cancelled = true;
      };
    }, [monacoTheme]);

    useEffect(() => {
      const editor = diffEditorRef.current;
      if (editor) {
        editor.updateOptions({ renderSideBySide: sideBySide });
      }
    }, [sideBySide]);

    const retryLoadMonaco = () => {
      monacoInit = null;
      setFailed(false);
      setReady(false);
      loadMonaco()
        .then((monaco) => initEditor(monaco))
        .catch(() => setFailed(true));
    };

    return (
      <div className={cn("relative h-full w-full overflow-hidden rounded-lg border border-border bg-card/60", className)}>
        {ready && !failed ? (
          <div className="absolute top-1 right-2 z-10">
            <button
              type="button"
              onClick={() => setSideBySide((prev) => !prev)}
              className="text-xs text-white/50 hover:text-white/70 px-2 py-1 rounded focus-visible:ring-2 focus-visible:ring-purple-400/50 focus-visible:ring-offset-0"
              title="Toggle side-by-side / inline diff"
              aria-label={sideBySide ? "Switch to inline diff" : "Switch to side-by-side diff"}
            >
              {sideBySide ? "Inline" : "Side by side"}
            </button>
          </div>
        ) : null}
        <div ref={containerRef} className={cn("h-full w-full", failed && "hidden")} />
        {!ready && !failed ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-sm text-muted-fg">
            Loading diff editor…
          </div>
        ) : null}
        {failed ? (
          <div className="h-full w-full overflow-auto p-3 text-xs">
            <div className="mb-2 flex items-center justify-between rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900">
              <span>Monaco failed to load in dev mode. Showing plain-text diff fallback.</span>
              <button
                type="button"
                onClick={retryLoadMonaco}
                className="ml-2 text-xs text-amber-700 hover:text-amber-900 underline focus-visible:ring-2 focus-visible:ring-purple-400/50 focus-visible:ring-offset-0"
                aria-label="Retry loading diff editor"
              >
                Retry
              </button>
            </div>
            <div className="grid h-[calc(100%-36px)] grid-cols-1 gap-2 md:grid-cols-2">
              <div className="min-h-0 overflow-auto rounded border border-border bg-bg p-2">
                <div className="mb-1 text-[11px] font-semibold text-muted-fg">Original</div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{diff.original.text ?? ""}</pre>
              </div>
              <div className="min-h-0 overflow-auto rounded border border-border bg-bg p-2">
                <div className="mb-1 text-[11px] font-semibold text-muted-fg">{editable ? "Modified (editable in Monaco only)" : "Modified"}</div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{diff.modified.text ?? ""}</pre>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }
);
