import type { FileContent } from "../../../../../shared/types";
import type { MonacoModelRegistry } from "../../monacoModelRegistry";
import type { EditorTab } from "../editorGroupsStore";

export type EditorThemeMode = "light" | "dark";

/** Imperative handle a code editor exposes so the group toolbar can drive it. */
export type EditorApi = {
  save: () => Promise<void>;
  format: () => Promise<void>;
  revealLine: (line: number) => void;
};

/**
 * Common contract every viewer receives. `content` is the initial `readFile`
 * result (the first chunk when `content.isPartial`). Viewers that need the whole
 * file (PDF/CSV) or more text (largeText) stream additional bytes themselves via
 * `window.ade.files.readFileRange`.
 */
export type ViewerProps = {
  workspaceId: string;
  /** Absolute workspace root path (for "open externally" actions). */
  rootPath: string;
  tab: EditorTab;
  content: FileContent;
  readOnly: boolean;
  theme: EditorThemeMode;
  /** Shared per-workbench Monaco model cache (code + markdown source use it). */
  registry: MonacoModelRegistry;
  /** Notify the shell that the in-editor buffer became dirty/clean (code viewer only). */
  onDirtyChange?: (path: string, dirty: boolean) => void;
  /** Notify the shell on each buffer edit (agent dirty-buffer sync; code viewer only). */
  onBufferChange?: (path: string) => void;
  /** Promote a preview tab to permanent on first edit. */
  onEdit?: (path: string) => void;
  /** Register/unregister the editor's imperative API for toolbar actions. */
  onRegisterEditorApi?: (path: string, api: EditorApi | null) => void;
};
