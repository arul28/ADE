import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const filesTour: Tour = {
  id: "files",
  title: "Files tab walkthrough",
  route: "/files",
  steps: [
    {
      target: '[data-tour="files.header"]',
      title: "Files header",
      body: "The Files tab is your full-project editor. Switch between workspaces, manage git actions, and open files in external tools from this bar.",
      docUrl: docs.filesEditor,
      placement: "bottom",
    },
    {
      target: '[data-tour="files.workspaceSelector"]',
      title: "Workspace selector",
      body: "Each entry is a workspace — either your primary folder or a lane worktree. Switch here to browse a different lane's files without leaving the tab.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="files.explorerPane"]',
      title: "Explorer pane",
      body: "The file tree lives here. Click a folder to expand it, click a file to open it in the editor. Right-click any item for create, rename, delete, and git actions.",
      docUrl: docs.filesEditor,
      placement: "right",
    },
    {
      target: '[data-tour="files.searchBar"]',
      title: "Full-text search",
      body: "Type to search across every file in the workspace. Results appear inline; click one to jump straight to that line.",
      docUrl: docs.filesEditor,
      placement: "bottom",
    },
    {
      target: '[data-tour="files.fileTree"]',
      title: "File tree",
      body: "Files with uncommitted changes show a colored badge — M for modified, A for added, D for deleted. Colour-coded icons identify file types at a glance.",
      docUrl: docs.filesEditor,
      placement: "right",
    },
    {
      target: '[data-tour="files.editorPane"]',
      title: "Editor pane",
      body: "Open files appear as tabs here. Edit directly in Code mode, review your uncommitted changes in Changes mode, or resolve merge markers in Merge mode.",
      docUrl: docs.filesEditor,
      placement: "left",
    },
    {
      target: '[data-tour="files.modeToggle"]',
      title: "Code / Changes / Merge",
      body: "CODE edits the raw file. CHANGES shows a side-by-side diff against the last commit. MERGE lets you pick which side of a conflict to keep.",
      docUrl: docs.filesEditor,
      placement: "bottom",
    },
    {
      target: '[data-tour="files.breadcrumb"]',
      title: "Breadcrumb & git actions",
      body: "The file path sits on the left. When a lane workspace is active, Stage, Unstage, and Discard buttons appear on the right to manage individual files.",
      docUrl: docs.filesEditor,
      placement: "bottom",
    },
    {
      target: '[data-tour="files.openIn"]',
      title: "Open in external editor",
      body: "Send the active file straight to VS Code, Cursor, Zed, or the system file browser without leaving ADE.",
      docUrl: docs.filesEditor,
      placement: "bottom",
    },
  ],
};

registerTour(filesTour);

export default filesTour;
