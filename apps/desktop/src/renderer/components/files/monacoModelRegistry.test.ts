import { describe, expect, it, vi } from "vitest";
import { createMonacoModelRegistry } from "./monacoModelRegistry";

/**
 * A minimal stand-in for the Monaco namespace + ITextModel — enough to assert
 * the registry's lifetime contract without loading the real editor.
 */
function createFakeMonaco() {
  let created = 0;
  const setModelLanguage = vi.fn();
  const makeModel = (content: string, languageId: string) => {
    let disposed = false;
    let version = 1;
    return {
      content,
      languageId,
      isDisposed: () => disposed,
      getValue: () => content,
      getAlternativeVersionId: () => version,
      setValue: vi.fn((next: string) => {
        content = next;
        version += 1;
      }),
      // Test helper: simulate an edit bumping the version id.
      __edit: () => {
        version += 1;
      },
      dispose: vi.fn(() => {
        disposed = true;
      }),
    };
  };
  const monaco = {
    editor: {
      createModel: vi.fn((content: string, languageId: string) => {
        created += 1;
        return makeModel(content, languageId);
      }),
      setModelLanguage,
    },
  } as any;
  return { monaco, setModelLanguage, createdCount: () => created };
}

describe("monacoModelRegistry", () => {
  it("creates one model per path and reuses it on revisit", () => {
    const { monaco, createdCount } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const a1 = registry.getOrCreate(monaco, "src/a.ts", "a", "typescript");
    const b1 = registry.getOrCreate(monaco, "src/b.ts", "b", "typescript");
    // Revisit a.ts — same model instance, no new createModel call.
    const a2 = registry.getOrCreate(monaco, "src/a.ts", "ignored content", "typescript");

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(createdCount()).toBe(2);
    expect(registry.size()).toBe(2);
  });

  it("re-applies language in place instead of recreating the model", () => {
    const { monaco, setModelLanguage, createdCount } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const m1 = registry.getOrCreate(monaco, "notes", "x", "plaintext");
    const m2 = registry.getOrCreate(monaco, "notes", "x", "markdown");

    expect(m1).toBe(m2);
    expect(createdCount()).toBe(1);
    expect(setModelLanguage).toHaveBeenCalledTimes(1);
    expect(setModelLanguage).toHaveBeenCalledWith(m1, "markdown");
  });

  it("switching among many files never disposes a model", () => {
    const { monaco } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const paths = ["a", "b", "c", "d", "e"];
    const models = paths.map((p) => registry.getOrCreate(monaco, p, p, "plaintext"));
    // Simulate switching back and forth across all tabs.
    for (let round = 0; round < 3; round++) {
      for (const p of paths) registry.getOrCreate(monaco, p, "x", "plaintext");
    }

    expect(registry.size()).toBe(5);
    for (const model of models) {
      expect((model as any).dispose).not.toHaveBeenCalled();
    }
  });

  it("disposes exactly the closed model and recreates it on reopen", () => {
    const { monaco, createdCount } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const a = registry.getOrCreate(monaco, "a", "a", "plaintext");
    registry.getOrCreate(monaco, "b", "b", "plaintext");

    registry.dispose("a");
    expect((a as any).dispose).toHaveBeenCalledTimes(1);
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
    expect(registry.size()).toBe(1);

    // Reopening recreates a fresh model from the provided content.
    const a2 = registry.getOrCreate(monaco, "a", "fresh", "plaintext");
    expect(a2).not.toBe(a);
    expect(createdCount()).toBe(3);
  });

  it("disposeAll frees every model (used on workspace switch / unmount)", () => {
    const { monaco } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const models = ["a", "b", "c"].map((p) => registry.getOrCreate(monaco, p, p, "plaintext"));
    registry.disposeAll();

    expect(registry.size()).toBe(0);
    for (const model of models) {
      expect((model as any).dispose).toHaveBeenCalledTimes(1);
    }
  });

  it("tracks dirty state against the last saved baseline", () => {
    const { monaco } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const model = registry.getOrCreate(monaco, "a", "hello", "plaintext") as any;
    expect(registry.isDirty("a")).toBe(false);

    model.__edit();
    expect(registry.isDirty("a")).toBe(true);

    registry.markSaved("a");
    expect(registry.isDirty("a")).toBe(false);

    model.__edit();
    expect(registry.isDirty("a")).toBe(true);
    expect(registry.getValue("a")).toBe("hello");
  });

  it("refreshes a clean open model from disk without marking it dirty", () => {
    const { monaco } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const model = registry.getOrCreate(monaco, "a", "first", "plaintext") as any;
    const refreshed = registry.refreshClean(monaco, "a", "second", "markdown");

    expect(refreshed).toBe(true);
    expect(model.setValue).toHaveBeenCalledWith("second");
    expect(model.getValue()).toBe("second");
    expect(registry.isDirty("a")).toBe(false);
  });

  it("does not refresh a dirty open model from disk", () => {
    const { monaco } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const model = registry.getOrCreate(monaco, "a", "mine", "plaintext") as any;
    model.__edit();
    const refreshed = registry.refreshClean(monaco, "a", "theirs", "plaintext");

    expect(refreshed).toBe(false);
    expect(model.setValue).not.toHaveBeenCalled();
    expect(model.getValue()).toBe("mine");
    expect(registry.isDirty("a")).toBe(true);
  });

  it("rekey moves the live buffer, dirty state, and identity to the new key", () => {
    const { monaco, createdCount } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const model = registry.getOrCreate(monaco, "stale-ws::src/a.ts", "draft", "typescript") as any;
    model.__edit();
    registry.rekey("stale-ws::src/a.ts", "host-ws::src/a.ts");

    expect(registry.has("stale-ws::src/a.ts")).toBe(false);
    expect(registry.getValue("host-ws::src/a.ts")).toBe("draft");
    expect(registry.isDirty("host-ws::src/a.ts")).toBe(true);
    // Reopening under the new key reuses the moved model — no rebuild from disk.
    const reopened = registry.getOrCreate(monaco, "host-ws::src/a.ts", "disk content", "typescript");
    expect(reopened).toBe(model);
    expect(createdCount()).toBe(1);
    expect(model.dispose).not.toHaveBeenCalled();
  });

  it("rekey collision keeps the dirty buffer and disposes the clean one", () => {
    const { monaco } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    // Dirty incoming, clean existing → incoming wins.
    const dirtyIncoming = registry.getOrCreate(monaco, "old-a", "edited", "plaintext") as any;
    dirtyIncoming.__edit();
    const cleanExisting = registry.getOrCreate(monaco, "new-a", "disk", "plaintext") as any;
    registry.rekey("old-a", "new-a");
    expect(cleanExisting.dispose).toHaveBeenCalledTimes(1);
    expect(registry.getValue("new-a")).toBe("edited");
    expect(registry.isDirty("new-a")).toBe(true);

    // Dirty existing → existing wins, incoming disposed.
    const cleanIncoming = registry.getOrCreate(monaco, "old-b", "stale", "plaintext") as any;
    const dirtyExisting = registry.getOrCreate(monaco, "new-b", "kept edit", "plaintext") as any;
    dirtyExisting.__edit();
    registry.rekey("old-b", "new-b");
    expect(cleanIncoming.dispose).toHaveBeenCalledTimes(1);
    expect(dirtyExisting.dispose).not.toHaveBeenCalled();
    expect(registry.getValue("new-b")).toBe("kept edit");
    expect(registry.has("old-b")).toBe(false);
  });

  it("rekey is a no-op for identical or unknown keys", () => {
    const { monaco } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const model = registry.getOrCreate(monaco, "a", "x", "plaintext") as any;
    registry.rekey("a", "a");
    registry.rekey("missing", "b");

    expect(registry.has("a")).toBe(true);
    expect(registry.has("b")).toBe(false);
    expect(registry.getValue("a")).toBe("x");
    expect(model.dispose).not.toHaveBeenCalled();
  });

  it("recreates a model whose underlying instance was disposed externally", () => {
    const { monaco, createdCount } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const a = registry.getOrCreate(monaco, "a", "a", "plaintext");
    (a as any).dispose();
    // Externally disposed → getOrCreate must not hand back the dead model.
    const a2 = registry.getOrCreate(monaco, "a", "a", "plaintext");

    expect(a2).not.toBe(a);
    expect(createdCount()).toBe(2);
  });
});
