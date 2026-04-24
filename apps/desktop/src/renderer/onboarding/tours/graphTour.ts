import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const graphTour: Tour = {
  id: "graph",
  title: "Graph walkthrough",
  route: "/graph",
  steps: [
    {
      target: '[data-tour="graph.focusedLane"], [data-tour="graph.canvas"]',
      title: "Lane nodes",
      body: "The graph maps lanes as nodes and branches as edges. When a lane is focused, this summary gives you the lane state and the next actions.",
      docUrl: docs.workspaceGraph,
      placement: "bottom",
    },
    {
      target: '[data-tour="graph.zoom"]',
      title: "Zoom and pan",
      body: "Scroll to zoom, drag to pan. The graph redraws as you create, rebase, or archive lanes.",
      docUrl: docs.workspaceGraph,
      placement: "left",
    },
    {
      target: '[data-tour="graph.legend"]',
      title: "Legend",
      body: "The legend explains node colors and edge types. Use it when a lane state looks unfamiliar.",
      docUrl: docs.workspaceGraph,
      placement: "left",
    },
  ],
};

registerTour(graphTour);

export default graphTour;
