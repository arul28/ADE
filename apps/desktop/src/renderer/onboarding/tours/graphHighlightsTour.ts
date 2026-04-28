import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const graphHighlightsTour: Tour = {
  id: "graph",
  title: "Graph · essentials",
  variant: "highlights",
  route: "/graph",
  steps: [
    {
      id: "h.graph.what",
      target: "",
      title: "Workspace graph",
      body: "Every lane, mission, and PR as a node. Edges show parent and child branches and stack relationships.",
      docUrl: docs.workspaceGraph,
    },
    {
      id: "h.graph.canvas",
      target: '[data-tour="graph.canvas"]',
      title: "Zoom and pan",
      body: "Scroll to zoom, drag to pan. Click a node to see its lane or PR details.",
      docUrl: docs.workspaceGraph,
      placement: "top",
    },
    {
      id: "h.graph.next",
      target: "",
      title: "Want the whole thing?",
      body: "The full walkthrough covers filters, the legend, and keyboard shortcuts. Replay from the ? menu.",
    },
  ],
};

registerTour(graphHighlightsTour);
export default graphHighlightsTour;
