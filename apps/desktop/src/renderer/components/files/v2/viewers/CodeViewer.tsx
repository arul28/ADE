import React, { useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor";
import { resolveLanguageId } from "../../filePresentation";
import { loadMonaco } from "../monacoLoader";
import { takePendingReveal } from "../pendingReveals";
import { updateCachedFileContentText } from "../useFileContent";
import type { EditorApi, ViewerProps } from "./types";

/**
 * The code/text editor: a Monaco instance bound to the shared model registry so
 * tab switches reuse models (instant, undo preserved). Enables the IDE feature
 * set (find/replace, multi-cursor, bracket matching, minimap, sticky scroll,
 * go-to-symbol) and owns its own Cmd+S (format-on-save + write + mark clean).
 */
export function CodeViewer({
  workspaceId,
  tab,
  content,
  readOnly,
  theme,
  registry,
  onDirtyChange,
  onEdit,
  onRegisterEditorApi,
  onError,
}: ViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const changeSubRef = useRef<Monaco.IDisposable | null>(null);
  const dirtyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest props for use inside long-lived Monaco callbacks.
  const ctxRef = useRef({ workspaceId, tab, registry, onDirtyChange, onEdit, onRegisterEditorApi, onError, readOnly });
  ctxRef.current = { workspaceId, tab, registry, onDirtyChange, onEdit, onRegisterEditorApi, onError, readOnly };

  const apiRef = useRef<EditorApi | null>(null);
  const registeredTabIdRef = useRef<string | null>(null);

  const save = useRef(async () => {
    const { workspaceId: ws, tab: t, registry: reg, onDirtyChange: onDirty } = ctxRef.current;
    const editor = editorRef.current;
    if (!editor) return;
    if (ctxRef.current.readOnly) return;
    try {
      await editor.getAction("editor.action.formatDocument")?.run();
    } catch {
      // formatter may be unavailable for this language — save unformatted
    }
    const text = reg.getValue(t.id) ?? editor.getValue();
    await window.ade.files.writeText({ workspaceId: ws, path: t.path, text });
    reg.markSaved(t.id);
    // Sync the cached payload so clean-model consumers (markdown preview,
    // CSV table) show the saved text before the watcher echoes the write.
    updateCachedFileContentText(ws, t.path, text);
    onDirty?.(t.id, false);
  }).current;

  const registerApiForActiveTab = useRef(() => {
    const api = apiRef.current;
    if (!api) return;
    const { tab: t, onRegisterEditorApi: register } = ctxRef.current;
    if (registeredTabIdRef.current && registeredTabIdRef.current !== t.id) {
      register?.(registeredTabIdRef.current, null);
    }
    register?.(t.id, api);
    registeredTabIdRef.current = t.id;
  }).current;

  // Create the editor once per mount.
  useEffect(() => {
    let disposed = false;
    void loadMonaco().then((monaco) => {
      if (disposed || !hostRef.current) return;
      monacoRef.current = monaco;
      const editor = monaco.editor.create(hostRef.current, {
        value: "",
        language: "plaintext",
        automaticLayout: true,
        readOnly,
        theme: theme === "light" ? "vs" : "vs-dark",
        fontSize: 13,
        minimap: { enabled: true },
        stickyScroll: { enabled: true },
        bracketPairColorization: { enabled: true },
        renderWhitespace: "selection",
        smoothScrolling: true,
        scrollBeyondLastLine: false,
        tabSize: 2,
      });
      editorRef.current = editor;

      // Cmd/Ctrl+S → format + save on the focused editor.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void save().catch((err) => {
          ctxRef.current.onError?.(err instanceof Error ? err.message : String(err));
        });
      });

      const api: EditorApi = {
        save,
        format: async () => {
          try {
            await editor.getAction("editor.action.formatDocument")?.run();
          } catch {
            /* no formatter */
          }
        },
        revealLine: (line: number) => {
          editor.revealLineInCenter(line);
          editor.setPosition({ lineNumber: line, column: 1 });
          editor.focus();
        },
      };
      apiRef.current = api;
      registerApiForActiveTab();

      attachModel(monaco, editor);
    });

    return () => {
      disposed = true;
      changeSubRef.current?.dispose();
      changeSubRef.current = null;
      if (registeredTabIdRef.current) {
        ctxRef.current.onRegisterEditorApi?.(registeredTabIdRef.current, null);
        registeredTabIdRef.current = null;
      }
      apiRef.current = null;
      try {
        editorRef.current?.setModel(null);
        editorRef.current?.dispose();
      } catch {
        /* ignore */
      }
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (Re)bind the model and re-register the editor API when the active tab changes.
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    attachModel(monaco, editor);
    registerApiForActiveTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, content.content, content.languageId]);

  // React to readOnly / theme without recreating the editor.
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);
  useEffect(() => {
    monacoRef.current?.editor.setTheme(theme === "light" ? "vs" : "vs-dark");
  }, [theme]);

  function attachModel(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor) {
    const language = resolveLanguageId(tab.path, content.languageId);
    registry.refreshClean(monaco, tab.id, content.content, language);
    const model = registry.getOrCreate(monaco, tab.id, content.content, language);
    if (editor.getModel() !== model) {
      editor.setModel(model);
    }
    changeSubRef.current?.dispose();
    changeSubRef.current = model.onDidChangeContent(() => {
      const { tab: t, registry: reg, onDirtyChange: onDirty, onEdit: onEditCb } = ctxRef.current;
      onEditCb?.(t.id); // first edit promotes a preview tab to permanent
      if (dirtyTimerRef.current) clearTimeout(dirtyTimerRef.current);
      dirtyTimerRef.current = setTimeout(() => {
        onDirty?.(t.id, reg.isDirty(t.id));
      }, 120);
    });
    // Jump to a line requested by the search overlay (one-shot).
    const reveal = takePendingReveal(tab.path);
    if (reveal && reveal.line > 0) {
      requestAnimationFrame(() => {
        try {
          editor.revealLineInCenter(reveal.line);
          editor.setPosition({ lineNumber: reveal.line, column: reveal.column ?? 1 });
        } catch {
          /* model swapped out before reveal */
        }
      });
    }
  }

  return <div ref={hostRef} className="h-full w-full min-h-0" data-testid="files-v2-code-editor" />;
}
