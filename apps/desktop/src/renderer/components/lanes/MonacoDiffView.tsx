import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FileDiff } from "../../../shared/types";
import { MONO_FONT } from "./laneDesignTokens";
import { cn } from "../ui/cn";

export type MonacoDiffHandle = {
  getModifiedValue: () => string | null;
  revealLineInCenter: (line: number) => void;
};

let monacoInit: Promise<typeof import("monaco-editor")> | null = null;

async function loadMonaco(): Promise<typeof import("monaco-editor")> {
  if (!monacoInit) {
    monacoInit = (async () => {
      const [{ default: EditorWorker }, { default: TsWorker }] = await Promise.all([
        import("monaco-editor/esm/vs/editor/editor.worker?worker"),
        import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
      ]);
      const globalAny = globalThis as typeof globalThis & {
        MonacoEnvironment?: {
          getWorker?: (workerId: string, label: string) => Worker;
        };
      };
      const existing = globalAny.MonacoEnvironment;
      globalAny.MonacoEnvironment = {
        ...existing,
        getWorker: existing?.getWorker ?? ((_workerId: string, label: string) => {
          if (label === "typescript" || label === "javascript") {
            return new TsWorker();
          }
          return new EditorWorker();
        })
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
    const monacoTheme = theme === "light" ? "vs" : "vs-dark";

    useImperativeHandle(ref, () => ({
      getModifiedValue: () => diffEditorRef.current?.getModel()?.modified.getValue() ?? null,
      revealLineInCenter: (line: number) => {
        try {
          const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
          modifiedEditor?.revealLineInCenter(line);
        } catch {
          /* ignore */
        }
      },
    }));

    useEffect(() => {
      let cancelled = false;
      loadMonaco()
        .then((monaco) => {
          if (cancelled) return;
          if (!containerRef.current) return;

          const editor = monaco.editor.createDiffEditor(containerRef.current, {
            readOnly: !editable,
            automaticLayout: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            fontFamily: MONO_FONT,
            fontSize: 13,
            lineHeight: 18,
            scrollBeyondLastLine: false,
            theme: monacoTheme
          });

          diffEditorRef.current = editor;
          setFailed(false);
          setReady(true);
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

    return (
      <div className={cn("relative h-full w-full overflow-hidden rounded-lg border border-border bg-card/60", className)}>
        <div ref={containerRef} className={cn("h-full w-full", failed && "hidden")} />
        {!ready && !failed ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-sm text-muted-fg">
            Loading diff editor…
          </div>
        ) : null}
        {failed ? (
          <div className="h-full w-full overflow-auto p-3 text-xs">
            <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900">
              Monaco failed to load in dev mode. Showing plain-text diff fallback.
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
