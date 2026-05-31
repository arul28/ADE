import type * as Monaco from "monaco-editor";

type Entry = {
  model: Monaco.editor.ITextModel;
  languageId: string;
  /** Alternative version id captured at last load/save; dirty = current !== this. */
  baseVersionId: number;
};

/**
 * Per-FilesPage cache of Monaco text models keyed by workspace-relative path.
 *
 * A model is created once per file and reused across tab switches, so switching
 * tabs is `editor.setModel(existing)` instead of dispose → recreate → re-tokenize.
 * That removes the per-switch cost behind the ">3 open files lag" report and
 * preserves each file's undo stack. The renderer keeps owning the
 * content-in-state contract; this registry only owns model *lifetime*.
 *
 * Callers must `dispose(path)` when a tab closes and `disposeAll()` on workspace
 * switch / unmount, otherwise detached models leak.
 */
export function createMonacoModelRegistry() {
  const models = new Map<string, Entry>();

  const safeDispose = (model: Monaco.editor.ITextModel): void => {
    try {
      if (!model.isDisposed()) model.dispose();
    } catch {
      // already disposed / monaco torn down
    }
  };

  return {
    /**
     * Return the cached model for `path`, creating it from `content` on first
     * use. An already-cached model is returned untouched (it holds the live
     * edited buffer); only its language is re-applied in place when it changes.
     */
    getOrCreate(
      monaco: typeof Monaco,
      path: string,
      content: string,
      languageId: string,
    ): Monaco.editor.ITextModel {
      const existing = models.get(path);
      if (existing && !existing.model.isDisposed()) {
        if (existing.languageId !== languageId) {
          monaco.editor.setModelLanguage(existing.model, languageId);
          existing.languageId = languageId;
        }
        return existing.model;
      }
      const model = monaco.editor.createModel(content, languageId);
      models.set(path, { model, languageId, baseVersionId: model.getAlternativeVersionId() });
      return model;
    },

    /** Mark the current buffer as the clean baseline (after load or save). */
    markSaved(path: string): void {
      const entry = models.get(path);
      if (entry && !entry.model.isDisposed()) {
        entry.baseVersionId = entry.model.getAlternativeVersionId();
      }
    },

    /** True when the buffer has unsaved edits relative to the last save baseline. */
    isDirty(path: string): boolean {
      const entry = models.get(path);
      if (!entry || entry.model.isDisposed()) return false;
      return entry.model.getAlternativeVersionId() !== entry.baseVersionId;
    },

    /** Current buffer text, or null when no model exists for the path. */
    getValue(path: string): string | null {
      const entry = models.get(path);
      if (!entry || entry.model.isDisposed()) return null;
      return entry.model.getValue();
    },

    has(path: string): boolean {
      const entry = models.get(path);
      return Boolean(entry && !entry.model.isDisposed());
    },

    dispose(path: string): void {
      const entry = models.get(path);
      if (!entry) return;
      models.delete(path);
      safeDispose(entry.model);
    },

    disposeAll(): void {
      for (const entry of models.values()) {
        safeDispose(entry.model);
      }
      models.clear();
    },

    /** Number of live cached models — used by tests to assert no leaks. */
    size(): number {
      return models.size;
    },
  };
}

export type MonacoModelRegistry = ReturnType<typeof createMonacoModelRegistry>;
