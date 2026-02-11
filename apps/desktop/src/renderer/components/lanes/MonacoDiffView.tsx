import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
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
      (self as any).MonacoEnvironment = {
        getWorker: () => new EditorWorker()
      };

      return await import("monaco-editor");
    })();
  }
  return await monacoInit;
}

export const MonacoDiffView = forwardRef<MonacoDiffHandle, { diff: FileDiff; editable?: boolean; className?: string }>(
  function MonacoDiffView({ diff, editable = false, className }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const diffEditorRef = useRef<import("monaco-editor").editor.IStandaloneDiffEditor | null>(null);
    const modelsRef = useRef<{ original: import("monaco-editor").editor.ITextModel; modified: import("monaco-editor").editor.ITextModel } | null>(
      null
    );
    const [ready, setReady] = useState(false);

    useImperativeHandle(ref, () => ({
      getModifiedValue: () => diffEditorRef.current?.getModel()?.modified.getValue() ?? null
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
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 13,
            lineHeight: 18,
            scrollBeyondLastLine: false
          });

          diffEditorRef.current = editor;
          setReady(true);
        })
        .catch(() => {
          // ignore; UI will show fallback message
        });

      return () => {
        cancelled = true;
        try {
          diffEditorRef.current?.dispose();
        } catch {
          // ignore
        }
        diffEditorRef.current = null;

        try {
          modelsRef.current?.original.dispose();
          modelsRef.current?.modified.dispose();
        } catch {
          // ignore
        }
        modelsRef.current = null;
      };
    }, []);

    useEffect(() => {
      let cancelled = false;
      loadMonaco()
        .then((monaco) => {
          if (cancelled) return;
          const editor = diffEditorRef.current;
          if (!editor) return;

          try {
            modelsRef.current?.original.dispose();
            modelsRef.current?.modified.dispose();
          } catch {
            // ignore
          }

          const lang = diff.language ?? undefined;
          const original = monaco.editor.createModel(diff.original.text ?? "", lang);
          const modified = monaco.editor.createModel(diff.modified.text ?? "", lang);
          modelsRef.current = { original, modified };
          editor.setModel({ original, modified });
          editor.getModifiedEditor().updateOptions({ readOnly: !editable });
          editor.getOriginalEditor().updateOptions({ readOnly: true });
        })
        .catch(() => {
          // ignore
        });

      return () => {
        cancelled = true;
      };
    }, [diff, editable]);

    return (
      <div className={cn("h-full w-full overflow-hidden rounded-lg border border-border bg-card/60", className)}>
        {!ready ? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-fg">Loading diff editor…</div>
        ) : (
          <div ref={containerRef} className="h-full w-full" />
        )}
      </div>
    );
  }
);

