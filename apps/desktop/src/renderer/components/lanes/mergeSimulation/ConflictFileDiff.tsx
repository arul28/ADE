import React from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import type { MergeSimulationResult } from "../../../../shared/types";
import { MONO_FONT } from "../laneDesignTokens";
import { useAppStore, type ThemeId } from "../../../state/appStore";
import { extensionToLanguage } from "./extensionToLanguage";

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

function buildDecorations(
  monaco: typeof import("monaco-editor"),
  model: MonacoEditor.ITextModel
): MonacoEditor.IModelDeltaDecoration[] {
  const lines = model.getLinesContent();
  const decorations: MonacoEditor.IModelDeltaDecoration[] = [];

  let oursStart: number | null = null;
  let theirsStart: number | null = null;
  let splitLine: number | null = null;

  const decorateRange = (startLine: number, endLine: number, className: string) => {
    if (startLine > endLine) return;
    decorations.push({
      range: new monaco.Range(startLine, 1, endLine, 1),
      options: {
        isWholeLine: true,
        className
      }
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const content = lines[i]!.trim();

    if (content.startsWith("<<<<<<<")) {
      oursStart = lineNumber + 1;
      splitLine = null;
      theirsStart = null;
      decorations.push({
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: {
          isWholeLine: true,
          className: "ade-conflict-marker-line",
          linesDecorationsClassName: "ade-conflict-marker-glyph"
        }
      });
      continue;
    }

    if (content.startsWith("=======") && oursStart != null) {
      splitLine = lineNumber;
      decorateRange(oursStart, lineNumber - 1, "ade-conflict-ours-line");
      theirsStart = lineNumber + 1;
      decorations.push({
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: {
          isWholeLine: true,
          className: "ade-conflict-marker-line",
          linesDecorationsClassName: "ade-conflict-marker-glyph"
        }
      });
      continue;
    }

    if (content.startsWith(">>>>>>>") && oursStart != null) {
      if (theirsStart != null) {
        decorateRange(theirsStart, lineNumber - 1, "ade-conflict-theirs-line");
      } else if (splitLine != null) {
        decorateRange(splitLine + 1, lineNumber - 1, "ade-conflict-theirs-line");
      }
      decorations.push({
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: {
          isWholeLine: true,
          className: "ade-conflict-marker-line",
          linesDecorationsClassName: "ade-conflict-marker-glyph"
        }
      });
      oursStart = null;
      splitLine = null;
      theirsStart = null;
    }
  }

  return decorations;
}

function isDarkTheme(theme: ThemeId): boolean {
  return theme === "dark";
}

export function ConflictFileDiff({
  result,
  selectedPath,
  onSelectPath
}: {
  result: MergeSimulationResult | null;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}) {
  const theme = useAppStore((s) => s.theme);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const modelRef = React.useRef<MonacoEditor.ITextModel | null>(null);
  const decorationIdsRef = React.useRef<string[]>([]);
  const [editorReady, setEditorReady] = React.useState(false);
  const [editorFailed, setEditorFailed] = React.useState(false);

  const current = React.useMemo(() => {
    if (!result || result.conflictingFiles.length === 0) return null;
    return result.conflictingFiles.find((item) => item.path === selectedPath) ?? result.conflictingFiles[0]!;
  }, [result, selectedPath]);

  React.useEffect(() => {
    let disposed = false;
    loadMonaco()
      .then((monaco) => {
        if (disposed || !containerRef.current) return;
        const editor = monaco.editor.create(containerRef.current, {
          value: "",
          language: "plaintext",
          readOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          lineNumbers: "on",
          wordWrap: "on",
          scrollBeyondLastLine: false,
          fontFamily: MONO_FONT,
          fontSize: 12,
          lineHeight: 18,
          folding: true,
          glyphMargin: true,
          renderWhitespace: "selection"
        });
        editorRef.current = editor;
        setEditorReady(true);
        setEditorFailed(false);
      })
      .catch(() => {
        if (!disposed) setEditorFailed(true);
      });

    return () => {
      disposed = true;
      if (editorRef.current) {
        try {
          editorRef.current.setModel(null);
        } catch {
          // ignore
        }
      }
      if (editorRef.current) {
        try {
          editorRef.current.dispose();
        } catch {
          // ignore
        }
      }
      editorRef.current = null;
      if (modelRef.current) {
        try {
          modelRef.current.dispose();
        } catch {
          // ignore
        }
      }
      modelRef.current = null;
      decorationIdsRef.current = [];
    };
  }, []);

  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!current) {
      try {
        editor.setModel(null);
      } catch {
        // ignore
      }
      if (modelRef.current) {
        try {
          modelRef.current.dispose();
        } catch {
          // ignore
        }
      }
      modelRef.current = null;
      decorationIdsRef.current = [];
      return;
    }

    let disposed = false;
    loadMonaco()
      .then((monaco) => {
        if (disposed || !editorRef.current) return;
        if (modelRef.current) {
          try {
            editorRef.current.setModel(null);
          } catch {
            // ignore
          }
          try {
            modelRef.current.dispose();
          } catch {
            // ignore
          }
        }

        const content =
          current.conflictMarkers?.trim().length
            ? current.conflictMarkers
            : `No marker preview available for ${current.path}.`;
        const model = monaco.editor.createModel(content, extensionToLanguage(current.path));
        modelRef.current = model;
        editorRef.current.setModel(model);
        decorationIdsRef.current = model.deltaDecorations(
          decorationIdsRef.current,
          buildDecorations(monaco, model)
        );
      })
      .catch(() => {
        if (!disposed) setEditorFailed(true);
      });

    return () => {
      disposed = true;
    };
  }, [current]);

  React.useEffect(() => {
    loadMonaco()
      .then((monaco) => {
        monaco.editor.setTheme(isDarkTheme(theme) ? "vs-dark" : "vs");
      })
      .catch(() => {
        // ignore theme updates in fallback mode
      });
  }, [theme]);

  if (!result || result.conflictingFiles.length === 0) {
    return (
      <div className="rounded shadow-card bg-card/40 p-3 text-xs text-muted-fg">
        No conflicting files to preview.
      </div>
    );
  }

  return (
    <div className="grid min-h-[220px] grid-cols-[220px_1fr] overflow-hidden rounded shadow-card bg-card/30">
      <div className="overflow-auto bg-card/50">
        {result.conflictingFiles.map((file) => {
          const selected = file.path === current?.path;
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => onSelectPath(file.path)}
              className={`block w-full truncate border-b border-border/10 px-2 py-2 text-left text-xs ${
                selected ? "bg-accent/20 text-fg" : "text-muted-fg hover:bg-muted/60"
              }`}
              title={file.path}
            >
              {file.path}
            </button>
          );
        })}
      </div>
      <div className="relative overflow-hidden">
        <div ref={containerRef} className={editorFailed ? "hidden" : "h-full w-full"} />
        {!editorReady && !editorFailed ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-fg">
            Loading editor…
          </div>
        ) : null}
        {editorFailed && current ? (
          <pre className="h-full overflow-auto p-3 text-xs text-fg">
            {current.conflictMarkers?.trim().length
              ? current.conflictMarkers
              : `No marker preview available for ${current.path}.`}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
