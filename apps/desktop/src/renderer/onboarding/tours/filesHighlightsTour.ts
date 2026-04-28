import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const filesHighlightsTour: Tour = {
  id: "files",
  title: "Files · essentials",
  variant: "highlights",
  route: "/files",
  steps: [
    {
      id: "h.files.what",
      target: "",
      title: "Files",
      body: "A full-project editor with a workspace selector — switch between primary and any lane's worktree.",
      docUrl: docs.filesEditor,
    },
    {
      id: "h.files.tree",
      target: '[data-tour="files.explorerPane"]',
      title: "Tree and modes",
      body: "Change badges mark modified, added, and deleted files. Toggle Code, Changes, and Merge at the top.",
      docUrl: docs.filesEditor,
      placement: "right",
    },
    {
      id: "h.files.next",
      target: "",
      title: "Want the whole thing?",
      body: "The full walkthrough covers full-text search, git actions, and the external editor picker. Replay from the ? menu.",
    },
  ],
};

registerTour(filesHighlightsTour);
export default filesHighlightsTour;
