import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const graphTour: Tour = {
  id: "graph",
  title: "Graph walkthrough",
  route: "/graph",
  steps: [
    {
      target: '[data-tour="graph.focusedLane"], [data-tour="graph.canvas"]',
      title: "How everything connects",
      body: "Every lane is a circle, every connection between lanes is a line. When you click a lane, this side panel shows what state it's in and what to do next with it.",
      docUrl: docs.workspaceGraph,
      placement: "bottom",
    },
    {
      target: '[data-tour="graph.zoom"]',
      title: "Move around the map",
      body: "Scroll to zoom in and out, drag to pan around. The map updates itself live — make a new lane, change one, and you'll see the change immediately.",
      docUrl: docs.workspaceGraph,
      placement: "left",
    },
    {
      target: '[data-tour="graph.legend"]',
      title: "What the colors mean",
      body: "Lanes change color and shape based on their state — \"has unsaved changes\", \"ready to ship\", and so on. This little key explains them.",
      docUrl: docs.workspaceGraph,
      placement: "left",
    },
  ],
};

registerTour(graphTour);

export default graphTour;
