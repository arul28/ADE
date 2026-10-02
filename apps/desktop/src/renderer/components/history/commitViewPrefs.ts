import { create } from "zustand";
import type { GitCommitListScope } from "../../../shared/types";

/**
 * How the Commits view is drawn: which refs it walks, whether linear runs are
 * folded, and which optional columns show. Kept per machine (localStorage), so
 * it survives restarts. The search query lives here too, but is not saved.
 */
export type CommitFoldMode = "all" | "tips";
export type CommitColumnId = "author" | "date" | "sha";
export type CommitColumns = Record<CommitColumnId, boolean>;

type CommitViewPrefs = {
  scope: GitCommitListScope;
  fold: CommitFoldMode;
  columns: CommitColumns;
  search: string;
  setScope: (scope: GitCommitListScope) => void;
  setFold: (fold: CommitFoldMode) => void;
  toggleColumn: (column: CommitColumnId) => void;
  setSearch: (search: string) => void;
};

const STORAGE_KEY = "ade.history.commitView.v1";
const DEFAULT_COLUMNS: CommitColumns = { author: true, date: true, sha: true };

function readSaved(): Pick<CommitViewPrefs, "scope" | "fold" | "columns"> {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<CommitViewPrefs> : {};
    return {
      scope: parsed.scope === "lanes" ? "lanes" : "lane",
      fold: parsed.fold === "tips" ? "tips" : "all",
      columns: { ...DEFAULT_COLUMNS, ...(parsed.columns ?? {}) },
    };
  } catch {
    return { scope: "lane", fold: "all", columns: { ...DEFAULT_COLUMNS } };
  }
}

function save(state: Pick<CommitViewPrefs, "scope" | "fold" | "columns">): void {
  try {
    window.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ scope: state.scope, fold: state.fold, columns: state.columns }),
    );
  } catch {
    // Preferences are best effort.
  }
}

export const useCommitViewPrefs = create<CommitViewPrefs>((set, get) => ({
  ...readSaved(),
  search: "",
  setScope: (scope) => {
    set({ scope });
    save(get());
  },
  setFold: (fold) => {
    set({ fold });
    save(get());
  },
  toggleColumn: (column) => {
    set({ columns: { ...get().columns, [column]: !get().columns[column] } });
    save(get());
  },
  setSearch: (search) => set({ search }),
}));
