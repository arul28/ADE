import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

// Curated to selectors that render before any file is opened. Mode toggle and
// breadcrumb actions only mount once a file is active in the editor — they're
// intentionally not in this tour to avoid a hang when a fresh user lands here.
export const filesTour: Tour = {
  id: "files",
  title: "Files tab walkthrough",
  route: "/files",
  steps: [
    {
      target: '[data-tour="files.workspaceSelector"]',
      title: "Pick which copy to look at",
      body: "Each lane has its own copy of the files (we call that a **worktree** — basically *\"this lane's folder\"*). Use this dropdown to switch between your main project and any lane.",
      docUrl: docs.filesEditor,
      placement: "bottom",
    },
    {
      target: '[data-tour="files.fileTree"], [data-tour="files.explorerPane"]',
      title: "Browse and spot changes",
      body: "Click a folder to expand it, click a file to open it. Files with changes show a colored letter: **M** = edited, **A** = new, **D** = deleted — so you can see what this lane changed without opening anything.",
      docUrl: docs.filesEditor,
      placement: "right",
    },
    {
      target: '[data-tour="files.searchBar"]',
      title: "Search every file",
      body: "Type anything — a function name, a word you remember, anything — and ADE searches every file in this lane. Click a result to jump to that line.",
      docUrl: docs.filesEditor,
      placement: "bottom",
    },
    {
      target: '[data-tour="files.openIn"]',
      title: "Open in your favorite editor",
      body: "Already use VS Code, Cursor, or another code editor? This button hands the file (or the whole lane folder) over in one click. Keep ADE as your home base while editing wherever you like.",
      docUrl: docs.filesEditor,
      placement: "bottom",
    },
  ],
};

registerTour(filesTour);

export default filesTour;
