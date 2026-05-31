import React, { useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor";
import { resolveLanguageId } from "../../filePresentation";
import { loadMonaco } from "../monacoLoader";
import { takePendingReveal } from "../pendingReveals";
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
  onBufferChange,
  onEdit,
  onRegisterEditorApi,
}: ViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const changeSubRef = useRef<Monaco.IDisposable | null>(null);
  const dirtyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest props for use inside long-lived Monaco callbacks.
  const ctxRef = useRef({ workspaceId, tab, registry, onDirtyChange, onBufferChange, onEdit, onRegisterEditorApi, readOnly });
  ctxRef.current = { workspaceId, tab, registry, onDirtyChange, onBufferChange, onEdit, onRegisterEditorApi, readOnly };

  const apiRef = useRef<EditorApi | null>(null);
  const registeredPathRef = useRef<string | null>(null);

  const save = useRef(async () => {
    const { workspaceId: ws, tab: t, registry: reg, onDirtyChange: onDirty } = ctxRef.current;
    const editor = editorRef.current;
    if (!editor) return;
    if (!ctxRef.current.readOnly) {
      try {
        await editor.getAction("editor.action.formatDocument")?.run();
      } catch {
        // formatter may be unavailable for this language — save unformatted
      }
    }
    const text = reg.getValue(t.path) ?? editor.getValue();
    await window.ade.files.writeText({ workspaceId: ws, path: t.path, text });
    reg.markSaved(t.path);
    onDirty?.(t.path, false);
  }).current;

  // This editor instance is reused across tab switches (no per-path remount), so
  // the editor API must be (re)registered under whichever path is now active and
  // unregistered from the previous one.
  const registerApiForActivePath = useRef(() => {
    const api = apiRef.current;
    if (!api) return;
    const { tab: t, onRegisterEditorApi: register } = ctxRef.current;
    if (registeredPathRef.current && registeredPathRef.current !== t.path) {
      register?.(registeredPathRef.current, null);
    }
    register?.(t.path, api);
    registeredPathRef.current = t.path;
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
        void save();
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
      registerApiForActivePath();

      attachModel(monaco, editor);
    });

    return () => {
      disposed = true;
      changeSubRef.current?.dispose();
      changeSubRef.current = null;
      if (registeredPathRef.current) {
        ctxRef.current.onRegisterEditorApi?.(registeredPathRef.current, null);
        registeredPathRef.current = null;
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
    registerApiForActivePath();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.path, content.content]);

  // React to readOnly / theme without recreating the editor.
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);
  useEffect(() => {
    monacoRef.current?.editor.setTheme(theme === "light" ? "vs" : "vs-dark");
  }, [theme]);

  function attachModel(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor) {
    const language = resolveLanguageId(tab.path, content.languageId);
    const model = registry.getOrCreate(monaco, tab.path, content.content, language);
    if (editor.getModel() !== model) {
      editor.setModel(model);
    }
    changeSubRef.current?.dispose();
    changeSubRef.current = model.onDidChangeContent(() => {
      const { tab: t, registry: reg, onDirtyChange: onDirty, onBufferChange: onBuffer, onEdit: onEditCb } =
        ctxRef.current;
      onEditCb?.(t.path); // first edit promotes a preview tab to permanent
      onBuffer?.(t.path);
      if (dirtyTimerRef.current) clearTimeout(dirtyTimerRef.current);
      dirtyTimerRef.current = setTimeout(() => {
        onDirty?.(t.path, reg.isDirty(t.path));
      }, 120);
    });
    // Jump to a line requested by the search overlay (one-shot).
    const revealLine = takePendingReveal(tab.path);
    if (revealLine && revealLine > 0) {
      requestAnimationFrame(() => {
        try {
          editor.revealLineInCenter(revealLine);
          editor.setPosition({ lineNumber: revealLine, column: 1 });
        } catch {
          /* model swapped out before reveal */
        }
      });
    }
  }

  return <div ref={hostRef} className="h-full w-full min-h-0" data-testid="files-v2-code-editor" />;
}
