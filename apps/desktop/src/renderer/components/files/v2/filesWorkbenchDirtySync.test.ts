import { describe, expect, it } from "vitest";
import { createInitialGroupsState, openInGroup, type EditorTab } from "./editorGroupsStore";
import { buildDirtyBufferTabs, collectOpenTabPaths } from "./filesWorkbenchDirtySync";
import { createMonacoModelRegistry } from "../monacoModelRegistry";

function createFakeMonaco() {
  const makeModel = (content: string, languageId: string) => {
    let disposed = false;
    let version = 1;
    let value = content;
    return {
      languageId,
      isDisposed: () => disposed,
      getValue: () => value,
      setValue: (next: string) => {
        value = next;
        version += 1;
      },
      getAlternativeVersionId: () => version,
      dispose: () => {
        disposed = true;
      },
    };
  };
  return {
    editor: {
      createModel: (content: string, languageId: string) => makeModel(content, languageId),
      setModelLanguage: () => {},
    },
  } as any;
}

describe("filesWorkbenchDirtySync", () => {
  it("collects open tab paths from all groups", () => {
    const tab: EditorTab = {
      path: "src/a.ts",
      title: "a.ts",
      viewerKind: "code",
      languageId: "typescript",
      preview: false,
      pinned: false,
    };
    let state = createInitialGroupsState();
    state = openInGroup(state, state.activeGroupId, tab, { preview: false });
    expect(collectOpenTabPaths(state)).toEqual(["src/a.ts"]);
  });

  it("builds dirty buffer tabs from monaco registry content and saved baseline", () => {
    const monaco = createFakeMonaco();
    const registry = createMonacoModelRegistry();
    const model = registry.getOrCreate(monaco, "src/a.ts", "saved", "typescript") as {
      setValue: (next: string) => void;
    };
    model.setValue("dirty");
    const tabs = buildDirtyBufferTabs(["src/a.ts"], registry);
    expect(tabs).toEqual([{ path: "src/a.ts", content: "dirty", savedContent: "saved" }]);
  });
});
