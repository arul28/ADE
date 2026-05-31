import { describe, expect, it, vi } from "vitest";
import { createMonacoModelRegistry } from "./monacoModelRegistry";

/**
 * A minimal stand-in for the Monaco namespace + ITextModel — enough to assert
 * the registry's lifetime contract without loading the real editor.
 */
function createFakeMonaco() {
  let created = 0;
  const setModelLanguage = vi.fn();
  const makeModel = (initialContent: string, languageId: string) => {
    let disposed = false;
    let version = 1;
    let content = initialContent;
    return {
      languageId,
      isDisposed: () => disposed,
      getValue: () => content,
      setValue: (next: string) => {
        content = next;
        version += 1;
      },
      getAlternativeVersionId: () => version,
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

  it("replaces buffer text on revisit when clean and disk content changed", () => {
    const { monaco } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    registry.getOrCreate(monaco, "a", "v1", "plaintext");
    registry.getOrCreate(monaco, "a", "v2", "plaintext");

    expect(registry.getValue("a")).toBe("v2");
    expect(registry.isDirty("a")).toBe(false);
  });

  it("does not overwrite buffer text on revisit when the tab is dirty", () => {
    const { monaco } = createFakeMonaco();
    const registry = createMonacoModelRegistry();

    const model = registry.getOrCreate(monaco, "a", "v1", "plaintext") as any;
    model.__edit();
    registry.getOrCreate(monaco, "a", "v2", "plaintext");

    expect(registry.getValue("a")).not.toBe("v2");
    expect(registry.isDirty("a")).toBe(true);
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
